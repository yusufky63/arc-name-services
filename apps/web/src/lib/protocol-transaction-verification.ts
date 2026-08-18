import {
  decodeFunctionData,
  getAddress,
  parseEventLogs,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
} from "viem";
import { requireActivatedContract } from "@contour/config";
import {
  baseRegistrarAbi,
  controllerAbi,
  marketplaceAbi,
} from "@contour/sdk";
import { requireReadableReleaseManifest } from "@/lib/manifest";
import {
  assertArcProtocolClient,
  getProtocolPublicClient,
} from "@/lib/protocol-read-model";

export class PendingProtocolTransactionError extends Error {
  constructor(message = "The transaction is not confirmed yet.") {
    super(message);
    this.name = "PendingProtocolTransactionError";
  }
}

export class ProtocolVerificationBusyError extends Error {
  constructor() {
    super("Transaction verification is busy. Retry shortly.");
    this.name = "ProtocolVerificationBusyError";
  }
}

export function publicVerificationError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : "";
  return /^(The Arc transaction reverted|The confirmed |The receipt |The receipt-block )/.test(message)
    ? message
    : fallback;
}

type VerifiedTransaction = {
  receipt: Awaited<ReturnType<ReturnType<typeof getProtocolPublicClient>["getTransactionReceipt"]>>;
  input: `0x${string}`;
};

const VERIFICATION_CACHE_MS = 300_000;
const MAX_VERIFICATION_CACHE_ENTRIES = 1_024;
const MAX_CONCURRENT_VERIFICATIONS = 16;
const verificationCache = new Map<
  string,
  { expiresAt: number; promise: Promise<{ verified: true; blockNumber: string }> }
>();
let activeVerifications = 0;

function cachedVerification(
  key: string,
  verify: () => Promise<{ verified: true; blockNumber: string }>,
) {
  const now = Date.now();
  const cached = verificationCache.get(key);
  if (cached && cached.expiresAt > now) return cached.promise;
  for (const [cachedKey, value] of verificationCache) {
    if (value.expiresAt <= now) verificationCache.delete(cachedKey);
  }
  if (activeVerifications >= MAX_CONCURRENT_VERIFICATIONS) {
    throw new ProtocolVerificationBusyError();
  }
  if (verificationCache.size >= MAX_VERIFICATION_CACHE_ENTRIES) {
    const oldest = verificationCache.keys().next().value as string | undefined;
    if (oldest) verificationCache.delete(oldest);
  }
  activeVerifications += 1;
  const promise = verify().finally(() => {
    activeVerifications -= 1;
  });
  verificationCache.set(key, { expiresAt: now + VERIFICATION_CACHE_MS, promise });
  promise.catch(() => {
    if (verificationCache.get(key)?.promise === promise) verificationCache.delete(key);
  });
  return promise;
}

async function verifiedTransaction(
  hash: Hash,
  sender: Address,
  target: Address,
  manifest: ReturnType<typeof requireReadableReleaseManifest>,
): Promise<VerifiedTransaction> {
  const client = getProtocolPublicClient();
  await assertArcProtocolClient(client);
  let receipt: VerifiedTransaction["receipt"];
  try {
    receipt = await client.getTransactionReceipt({ hash });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/not found|could not be found|pending/i.test(message)) {
      throw new PendingProtocolTransactionError();
    }
    throw error;
  }
  const latest = await client.getBlockNumber();
  const confirmations = latest >= receipt.blockNumber
    ? latest - receipt.blockNumber + 1n
    : 0n;
  if (confirmations < BigInt(Math.max(1, manifest.chain.confirmations))) {
    throw new PendingProtocolTransactionError();
  }
  if (receipt.status !== "success") throw new Error("The Arc transaction reverted.");
  const transaction = await client.getTransaction({ hash });
  if (
    transaction.to === null ||
    getAddress(transaction.from) !== getAddress(sender) ||
    getAddress(transaction.to) !== getAddress(target) ||
    transaction.value !== 0n
  ) {
    throw new Error("The confirmed transaction does not match the requested zero-value action.");
  }
  return { receipt, input: transaction.input };
}

function addressLogs<T extends { address: Address }>(
  logs: readonly T[],
  address: Address,
): T[] {
  return logs.filter((log) => getAddress(log.address) === getAddress(address));
}

export function listingInvalidationOutcomeMatches(input: {
  tokenId: bigint;
  formerSeller: Address;
  events: readonly { tokenId: bigint; formerSeller: Address }[];
  liveSeller: Address;
  rawSeller: Address;
}) {
  if (input.liveSeller !== zeroAddress || input.rawSeller !== zeroAddress) return false;
  // invalidateListing is permissionless and intentionally idempotent. Another
  // account may win the cleanup race after submission but before this receipt;
  // in that case the exact call succeeds as a no-op and emits no event.
  return input.events.length === 0 || input.events.some(
    (event) =>
      event.tokenId === input.tokenId &&
      getAddress(event.formerSeller) === getAddress(input.formerSeller),
  );
}

export type MarketPurchaseVerificationInput = {
  releaseId: Hex;
  transactionHash: Hash;
  buyer: Address;
  seller: Address;
  tokenId: bigint;
  expectedPrice: bigint;
  expectedFeeBps: number;
};

async function verifyMarketPurchaseUncached(input: MarketPurchaseVerificationInput) {
  const manifest = requireReadableReleaseManifest(input.releaseId);
  const client = getProtocolPublicClient();
  const market = requireActivatedContract(manifest, "marketplace");
  const registrar = requireActivatedContract(manifest, "baseRegistrar");
  const { receipt, input: transactionInput } = await verifiedTransaction(
    input.transactionHash,
    input.buyer,
    market,
    manifest,
  );
  const decoded = decodeFunctionData({ abi: marketplaceAbi, data: transactionInput });
  if (decoded.functionName !== "buy" || !decoded.args) {
    throw new Error("The confirmed transaction is not a marketplace purchase.");
  }
  const [tokenId, expectedPrice, expectedFeeBps] = decoded.args;
  if (
    tokenId !== input.tokenId ||
    expectedPrice !== input.expectedPrice ||
    expectedFeeBps !== input.expectedFeeBps
  ) {
    throw new Error("The confirmed purchase guards do not match the selected listing.");
  }
  const events = parseEventLogs({
    abi: marketplaceAbi,
    logs: addressLogs(receipt.logs, market),
    eventName: "Purchased",
    strict: true,
  });
  const expectedFee = input.expectedPrice * BigInt(input.expectedFeeBps) / 10_000n;
  const purchased = events.find(
    (event) =>
      event.args.tokenId === input.tokenId &&
      getAddress(event.args.seller) === getAddress(input.seller) &&
      getAddress(event.args.buyer) === getAddress(input.buyer) &&
      event.args.price === input.expectedPrice &&
      event.args.fee === expectedFee,
  );
  if (!purchased) throw new Error("The receipt does not contain the exact Purchased event.");
  const [owner, listing] = await Promise.all([
    client.readContract({
      address: registrar,
      abi: baseRegistrarAbi,
      functionName: "ownerOf",
      args: [input.tokenId],
      blockNumber: receipt.blockNumber,
    }),
    client.readContract({
      address: market,
      abi: marketplaceAbi,
      functionName: "listingOf",
      args: [input.tokenId],
      blockNumber: receipt.blockNumber,
    }),
  ]);
  if (getAddress(owner) !== getAddress(input.buyer) || listing[0] !== zeroAddress) {
    throw new Error("The receipt-block ownership state does not confirm the purchase.");
  }
  return { verified: true as const, blockNumber: receipt.blockNumber.toString() };
}

export function verifyMarketPurchase(input: MarketPurchaseVerificationInput) {
  const key = [
    "buy",
    input.releaseId.toLowerCase(),
    input.transactionHash.toLowerCase(),
    input.buyer.toLowerCase(),
    input.seller.toLowerCase(),
    input.tokenId.toString(),
    input.expectedPrice.toString(),
    input.expectedFeeBps.toString(),
  ].join(":");
  return cachedVerification(key, () => verifyMarketPurchaseUncached(input));
}

export type AccountAction =
  | {
      releaseId: Hex;
      action: "list";
      transactionHash: Hash;
      owner: Address;
      tokenId: bigint;
      price: bigint;
      validUntil: bigint;
    }
  | {
      releaseId: Hex;
      action: "cancel";
      transactionHash: Hash;
      owner: Address;
      tokenId: bigint;
    }
  | {
      releaseId: Hex;
      action: "revoke-market-approval";
      transactionHash: Hash;
      owner: Address;
      tokenId: bigint;
    }
  | {
      releaseId: Hex;
      action: "invalidate";
      transactionHash: Hash;
      owner: Address;
      tokenId: bigint;
      formerSeller: Address;
    }
  | {
      releaseId: Hex;
      action: "claim-proceeds" | "claim-referral";
      transactionHash: Hash;
      owner: Address;
    };

async function verifyAccountActionUncached(input: AccountAction) {
  const manifest = requireReadableReleaseManifest(input.releaseId);
  const client = getProtocolPublicClient();
  const market = requireActivatedContract(manifest, "marketplace");
  const controller = requireActivatedContract(manifest, "controller");
  const registrar = requireActivatedContract(manifest, "baseRegistrar");
  const target = input.action === "claim-referral"
    ? controller
    : input.action === "revoke-market-approval"
      ? registrar
      : market;
  const abi = input.action === "claim-referral"
    ? controllerAbi
    : input.action === "revoke-market-approval"
      ? baseRegistrarAbi
      : marketplaceAbi;
  const { receipt, input: transactionInput } = await verifiedTransaction(
    input.transactionHash,
    input.owner,
    target,
    manifest,
  );
  const decoded = decodeFunctionData({ abi, data: transactionInput });

  if (input.action === "list") {
    if (decoded.functionName !== "list" || !decoded.args) {
      throw new Error("The confirmed transaction is not a listing action.");
    }
    const [tokenId, price, validUntil] = decoded.args;
    if (
      tokenId !== input.tokenId ||
      price !== input.price ||
      BigInt(validUntil) !== input.validUntil
    ) {
      throw new Error("The confirmed listing terms do not match the selected terms.");
    }
    const events = parseEventLogs({
      abi: marketplaceAbi,
      logs: addressLogs(receipt.logs, market),
      eventName: "Listed",
      strict: true,
    });
    if (
      !events.some(
        (event) =>
          event.args.tokenId === input.tokenId &&
          getAddress(event.args.seller) === getAddress(input.owner) &&
          event.args.price === input.price &&
          BigInt(event.args.validUntil) === input.validUntil,
      )
    ) {
      throw new Error("The receipt does not contain the exact Listed event.");
    }
    const [owner, listing] = await Promise.all([
      client.readContract({
        address: registrar,
        abi: baseRegistrarAbi,
        functionName: "ownerOf",
        args: [input.tokenId],
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: market,
        abi: marketplaceAbi,
        functionName: "listingOf",
        args: [input.tokenId],
        blockNumber: receipt.blockNumber,
      }),
    ]);
    if (
      getAddress(owner) !== getAddress(input.owner) ||
      getAddress(listing[0]) !== getAddress(input.owner) ||
      listing[1] !== input.price ||
      BigInt(listing[2]) !== input.validUntil
    ) {
      throw new Error("The receipt-block state does not confirm the listing.");
    }
  } else if (input.action === "cancel") {
    if (
      decoded.functionName !== "cancel" ||
      !decoded.args ||
      decoded.args[0] !== input.tokenId
    ) {
      throw new Error("The confirmed transaction is not the selected cancellation.");
    }
    const events = parseEventLogs({
      abi: marketplaceAbi,
      logs: addressLogs(receipt.logs, market),
      eventName: "ListingCancelled",
      strict: true,
    });
    if (
      !events.some(
        (event) =>
          event.args.tokenId === input.tokenId &&
          getAddress(event.args.seller) === getAddress(input.owner),
      )
    ) {
      throw new Error("The receipt does not contain the selected ListingCancelled event.");
    }
    const listing = await client.readContract({
      address: market,
      abi: marketplaceAbi,
      functionName: "listingOf",
      args: [input.tokenId],
      blockNumber: receipt.blockNumber,
    });
    if (listing[0] !== zeroAddress) {
      throw new Error("The receipt-block state still contains a live listing.");
    }
  } else if (input.action === "revoke-market-approval") {
    if (
      decoded.functionName !== "approve" ||
      !decoded.args ||
      decoded.args[0] !== zeroAddress ||
      decoded.args[1] !== input.tokenId
    ) {
      throw new Error("The confirmed transaction is not the selected marketplace approval removal.");
    }
    const events = parseEventLogs({
      abi: baseRegistrarAbi,
      logs: addressLogs(receipt.logs, registrar),
      eventName: "Approval",
      strict: true,
    });
    if (
      !events.some(
        (event) =>
          getAddress(event.args.owner) === getAddress(input.owner) &&
          event.args.approved === zeroAddress &&
          event.args.tokenId === input.tokenId,
      )
    ) {
      throw new Error("The receipt does not contain the selected zero-address Approval event.");
    }
    const [owner, approved] = await Promise.all([
      client.readContract({
        address: registrar,
        abi: baseRegistrarAbi,
        functionName: "ownerOf",
        args: [input.tokenId],
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: registrar,
        abi: baseRegistrarAbi,
        functionName: "getApproved",
        args: [input.tokenId],
        blockNumber: receipt.blockNumber,
      }),
    ]);
    if (getAddress(owner) !== getAddress(input.owner) || approved !== zeroAddress) {
      throw new Error("The receipt-block NFT state does not confirm marketplace approval removal.");
    }
  } else if (input.action === "invalidate") {
    if (
      decoded.functionName !== "invalidateListing" ||
      !decoded.args ||
      decoded.args[0] !== input.tokenId
    ) {
      throw new Error("The confirmed transaction is not the selected stale-listing cleanup.");
    }
    const events = parseEventLogs({
      abi: marketplaceAbi,
      logs: addressLogs(receipt.logs, market),
      eventName: "ListingInvalidated",
      strict: true,
    });
    const [liveListing, rawListing] = await Promise.all([
      client.readContract({
        address: market,
        abi: marketplaceAbi,
        functionName: "listingOf",
        args: [input.tokenId],
        blockNumber: receipt.blockNumber,
      }),
      client.readContract({
        address: market,
        abi: marketplaceAbi,
        functionName: "rawListingOf",
        args: [input.tokenId],
        blockNumber: receipt.blockNumber,
      }),
    ]);
    if (liveListing[0] !== zeroAddress || rawListing[0] !== zeroAddress) {
      throw new Error("The receipt-block marketplace state still contains the stale listing.");
    }
    if (!listingInvalidationOutcomeMatches({
      tokenId: input.tokenId,
      formerSeller: input.formerSeller,
      events: events.map((event) => ({
        tokenId: event.args.tokenId,
        formerSeller: event.args.formerSeller,
      })),
      liveSeller: liveListing[0],
      rawSeller: rawListing[0],
    })) {
      throw new Error("The receipt does not contain the selected ListingInvalidated event.");
    }
  } else if (input.action === "claim-proceeds") {
    if (decoded.functionName !== "claimProceeds") {
      throw new Error("The confirmed transaction is not a proceeds claim.");
    }
    const events = parseEventLogs({
      abi: marketplaceAbi,
      logs: addressLogs(receipt.logs, market),
      eventName: "ProceedsClaimed",
      strict: true,
    });
    if (
      !events.some(
        (event) => getAddress(event.args.seller) === getAddress(input.owner) && event.args.amount > 0n,
      )
    ) {
      throw new Error("The receipt does not contain a positive ProceedsClaimed event.");
    }
    const remaining = await client.readContract({
      address: market,
      abi: marketplaceAbi,
      functionName: "proceeds",
      args: [input.owner],
      blockNumber: receipt.blockNumber,
    });
    if (remaining !== 0n) {
      throw new Error("The receipt-block proceeds state was not cleared by the claim.");
    }
  } else {
    if (decoded.functionName !== "claimReferral") {
      throw new Error("The confirmed transaction is not a referral claim.");
    }
    const events = parseEventLogs({
      abi: controllerAbi,
      logs: addressLogs(receipt.logs, controller),
      eventName: "ReferralClaimed",
      strict: true,
    });
    if (
      !events.some(
        (event) => getAddress(event.args.referrer) === getAddress(input.owner) && event.args.amount > 0n,
      )
    ) {
      throw new Error("The receipt does not contain a positive ReferralClaimed event.");
    }
    const remaining = await client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "referralCredits",
      args: [input.owner],
      blockNumber: receipt.blockNumber,
    });
    if (remaining !== 0n) {
      throw new Error("The receipt-block referral state was not cleared by the claim.");
    }
  }
  return { verified: true as const, blockNumber: receipt.blockNumber.toString() };
}

export function verifyAccountAction(input: AccountAction) {
  const key = [
    input.releaseId.toLowerCase(),
    input.action,
    input.transactionHash.toLowerCase(),
    input.owner.toLowerCase(),
    "tokenId" in input ? input.tokenId.toString() : "",
    "price" in input ? input.price.toString() : "",
    "validUntil" in input ? input.validUntil.toString() : "",
    "formerSeller" in input ? input.formerSeller.toLowerCase() : "",
  ].join(":");
  return cachedVerification(key, () => verifyAccountActionUncached(input));
}
