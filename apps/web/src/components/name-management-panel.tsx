"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  requireActivatedContract,
  type DeploymentManifest,
} from "@contour/config";
import {
  baseRegistrarAbi,
  erc20Abi,
  marketplaceAbi,
  prepareAddressPlan,
  prepareApprovalPlan,
  prepareBuyPlan,
  prepareCancelListingPlan,
  prepareInvalidateListingPlan,
  prepareListingPlan,
  prepareMarketplaceApprovalPlan,
  prepareMarketplaceTokenApprovalPlan,
  prepareMarketplaceTokenApprovalRevocationPlan,
  preparePrimaryNamePlan,
  prepareRenewalPlan,
  prepareTransferPlan,
  type UnsignedTransactionPlan,
} from "@contour/sdk";
import { requireReadableReleaseManifest } from "@/lib/manifest";
import { useWalletSession } from "@/lib/use-wallet-session";
import {
  assertArcWalletAccount,
  sendWalletPlan,
  simulateWalletPlan,
  waitForWalletReceipt,
  walletErrorMessage,
  walletMulticall,
  walletReadRequest,
} from "@/lib/wallet-protocol";

export type NameListingView = {
  seller: Address;
  price: string;
  validUntil: string;
  feeBps: number;
};

export type StaleNameListingView = {
  seller: Address;
  price: string;
  validUntil: string;
};

type NameManagementPanelProps = {
  releaseId: Hex;
  label: string;
  fullName: string;
  tokenId: string;
  node: Hex;
  owner: Address | null;
  resolvedAddress: Address | null;
  primaryName: string | null;
  lifecycle: "active" | "grace";
  expiry: string;
  annualQuote: string | null;
  listing: NameListingView | null;
  staleListing: StaleNameListingView | null;
  marketplaceTokenApproved: boolean;
  marketPaused: boolean;
  managementEnabled: boolean;
  marketplaceEnabled: boolean;
  marketplaceEscapeEnabled: boolean;
};

export type PurchaseState = {
  seller: Address;
  price: bigint;
  validUntil: bigint;
  feeBps: number;
  paused: boolean;
  owner: Address;
  active: boolean;
  expiry: bigint;
  allowance: bigint;
};

export function listingCancellationAvailable(input: {
  marketplaceEscapeEnabled: boolean;
  marketPaused: boolean;
  hasListing: boolean;
}) {
  // Cancellation is an escape path and intentionally ignores marketPaused.
  return input.marketplaceEscapeEnabled && input.hasListing;
}

const PENDING_ACTION_KEY = "contour.pending-name-action.v2";
const FINAL_ACTIONS = [
  "renew",
  "primary",
  "transfer",
  "list",
  "cancel",
  "buy",
  "revoke-market-approval",
  "invalidate",
] as const;
type FinalAction = (typeof FINAL_ACTIONS)[number];

export type PendingNameAction = {
  version: 2;
  releaseId: Hex;
  action: FinalAction;
  transactionHash: `0x${string}`;
  account: Address;
  tokenId: string;
  price?: string;
  validUntil?: string;
  seller?: Address;
  feeBps?: number;
};

type PendingNameActionDraft = Omit<
  PendingNameAction,
  "version" | "releaseId" | "transactionHash" | "account"
>;

class PendingNameActionError extends Error {
  constructor(transactionHash: string) {
    super(`Transaction ${transactionHash.slice(0, 10)}… was submitted and is still awaiting confirmation. Reload this name to check it again.`);
    this.name = "PendingNameActionError";
  }
}

function pendingActionStorageKey(releaseId: Hex, tokenId: string) {
  return `${PENDING_ACTION_KEY}:${releaseId.toLowerCase()}:${tokenId}`;
}

function isDecimal(value: unknown, positive = false): value is string {
  return typeof value === "string" && (positive ? /^[1-9]\d*$/.test(value) : /^(0|[1-9]\d*)$/.test(value));
}

export function parsePendingNameAction(
  raw: string | null,
  expectedReleaseId: Hex,
  expectedTokenId: string,
): PendingNameAction | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<PendingNameAction>;
    if (
      value.version !== 2 ||
      typeof value.releaseId !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.releaseId) ||
      value.releaseId.toLowerCase() !== expectedReleaseId.toLowerCase() ||
      !FINAL_ACTIONS.some((action) => action === value.action) ||
      typeof value.transactionHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.transactionHash) ||
      typeof value.account !== "string" ||
      !isAddress(value.account) ||
      !isDecimal(value.tokenId) ||
      value.tokenId !== expectedTokenId
    ) {
      return null;
    }
    if (
      value.action === "list" &&
      (!isDecimal(value.price, true) || !isDecimal(value.validUntil, true))
    ) {
      return null;
    }
    if (
      value.action === "buy" &&
      (
        !isDecimal(value.price, true) ||
        typeof value.seller !== "string" ||
        !isAddress(value.seller) ||
        typeof value.feeBps !== "number" ||
        !Number.isInteger(value.feeBps) ||
        value.feeBps < 0 ||
        value.feeBps > 1_000
      )
    ) {
      return null;
    }
    if (
      value.action === "invalidate" &&
      (
        typeof value.seller !== "string" ||
        !isAddress(value.seller) ||
        getAddress(value.seller) === zeroAddress
      )
    ) {
      return null;
    }
    return {
      ...value,
      account: getAddress(value.account),
      seller: value.seller ? getAddress(value.seller) : undefined,
    } as PendingNameAction;
  } catch {
    return null;
  }
}

export function isTemporaryVerifierResponse(status: number, pending: boolean | undefined) {
  return status === 202 || status === 429 || pending === true;
}

function readPendingNameAction(releaseId: Hex, tokenId: string) {
  const key = pendingActionStorageKey(releaseId, tokenId);
  try {
    const pending = parsePendingNameAction(
      sessionStorage.getItem(key),
      releaseId,
      tokenId,
    );
    if (!pending && sessionStorage.getItem(key)) sessionStorage.removeItem(key);
    return pending;
  } catch {
    return null;
  }
}

function savePendingNameAction(value: PendingNameAction) {
  try {
    sessionStorage.setItem(
      pendingActionStorageKey(value.releaseId, value.tokenId),
      JSON.stringify(value),
    );
  } catch {
    // The active flow still waits for the receipt; storage is recovery-only.
  }
}

function clearPendingNameAction(
  releaseId: Hex,
  tokenId: string,
  transactionHash?: string,
) {
  try {
    const pending = readPendingNameAction(releaseId, tokenId);
    if (!transactionHash || pending?.transactionHash === transactionHash) {
      sessionStorage.removeItem(pendingActionStorageKey(releaseId, tokenId));
    }
  } catch {
    // A completed action does not depend on storage cleanup.
  }
}

function shortAddress(address: string | null) {
  return address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "—";
}

function dateLabel(timestamp: string) {
  if (timestamp === "0") return "—";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Number(timestamp) * 1_000));
}

async function readJson<T>(response: Response): Promise<T & { error?: string; pending?: boolean }> {
  try {
    return (await response.json()) as T & { error?: string; pending?: boolean };
  } catch {
    throw new Error("The action verifier returned an invalid response.");
  }
}

function verificationRequest(pending: PendingNameAction) {
  const common = {
    releaseId: pending.releaseId,
    transactionHash: pending.transactionHash,
    tokenId: pending.tokenId,
  };
  if (pending.action === "list") {
    return {
      path: "/api/account/verify",
      body: {
        ...common,
        action: "list",
        owner: pending.account,
        price: pending.price,
        validUntil: pending.validUntil,
      },
    };
  }
  if (pending.action === "cancel") {
    return {
      path: "/api/account/verify",
      body: { ...common, action: "cancel", owner: pending.account },
    };
  }
  if (pending.action === "revoke-market-approval") {
    return {
      path: "/api/account/verify",
      body: { ...common, action: "revoke-market-approval", owner: pending.account },
    };
  }
  if (pending.action === "invalidate") {
    return {
      path: "/api/account/verify",
      body: {
        ...common,
        action: "invalidate",
        owner: pending.account,
        formerSeller: pending.seller,
      },
    };
  }
  if (pending.action === "buy") {
    return {
      path: "/api/market/verify",
      body: {
        ...common,
        buyer: pending.account,
        seller: pending.seller,
        expectedPrice: pending.price,
        expectedFeeBps: pending.feeBps,
      },
    };
  }
  return null;
}

async function verifyWithRetry(path: string, body: Record<string, unknown>) {
  const attempts = 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response;
    let payload: { verified: boolean; error?: string; pending?: boolean };
    try {
      response = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      payload = await readJson<{ verified: boolean }>(response);
    } catch (requestError) {
      if (attempt === attempts - 1) throw requestError;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 750));
      continue;
    }
    if (response.ok && payload.verified) return true;
    if (isTemporaryVerifierResponse(response.status, payload.pending)) {
      if (attempt === attempts - 1) return false;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 750));
      continue;
    }
    throw new Error(payload.error ?? "The confirmed on-chain action needs app verification.");
  }
  return false;
}

async function resolvePendingNameAction(
  provider: EthereumProvider,
  pending: PendingNameAction,
): Promise<{ complete: boolean; detail?: string }> {
  await waitForWalletReceipt(provider, pending.transactionHash, pending.account);
  const request = verificationRequest(pending);
  if (!request) return { complete: true };
  try {
    const verified = await verifyWithRetry(request.path, request.body);
    return verified
      ? { complete: true }
      : { complete: false, detail: "App verification is still catching up." };
  } catch (verificationError) {
    return {
      complete: false,
      detail: verificationError instanceof Error
        ? verificationError.message
        : "App verification is still catching up.",
    };
  }
}

function receiptWasReverted(error: unknown) {
  return error instanceof Error && /transaction reverted/i.test(error.message);
}

async function latestWalletTimestamp(provider: EthereumProvider): Promise<bigint> {
  const block = await walletReadRequest(provider, {
    method: "eth_getBlockByNumber",
    params: ["latest", false],
  });
  const timestamp = block && typeof block === "object"
    ? (block as { timestamp?: unknown }).timestamp
    : null;
  if (typeof timestamp !== "string" || !/^0x[0-9a-fA-F]+$/.test(timestamp)) {
    throw new Error("The wallet returned an invalid block timestamp.");
  }
  return BigInt(timestamp);
}

async function readPurchaseState(
  provider: EthereumProvider,
  buyer: Address,
  tokenId: bigint,
  manifest: DeploymentManifest,
): Promise<PurchaseState> {
  const market = requireActivatedContract(manifest, "marketplace");
  const registrar = requireActivatedContract(manifest, "baseRegistrar");
  const [listingData, feeData, pausedData, ownerData, activeData, expiryData, allowanceData] =
    await walletMulticall(provider, buyer, [
      { target: market, callData: encodeFunctionData({ abi: marketplaceAbi, functionName: "listingOf", args: [tokenId] }) },
      { target: market, callData: encodeFunctionData({ abi: marketplaceAbi, functionName: "feeBps" }) },
      { target: market, callData: encodeFunctionData({ abi: marketplaceAbi, functionName: "paused" }) },
      { target: registrar, callData: encodeFunctionData({ abi: baseRegistrarAbi, functionName: "ownerOf", args: [tokenId] }) },
      { target: registrar, callData: encodeFunctionData({ abi: baseRegistrarAbi, functionName: "isActive", args: [tokenId] }) },
      { target: registrar, callData: encodeFunctionData({ abi: baseRegistrarAbi, functionName: "nameExpires", args: [tokenId] }) },
      {
        target: manifest.settlement.erc20Address,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [buyer, market] }),
      },
    ]);
  const currentListing = decodeFunctionResult({ abi: marketplaceAbi, functionName: "listingOf", data: listingData });
  return {
    seller: getAddress(currentListing[0]),
    price: currentListing[1],
    validUntil: BigInt(currentListing[2]),
    feeBps: decodeFunctionResult({ abi: marketplaceAbi, functionName: "feeBps", data: feeData }),
    paused: decodeFunctionResult({ abi: marketplaceAbi, functionName: "paused", data: pausedData }),
    owner: getAddress(decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "ownerOf", data: ownerData })),
    active: decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "isActive", data: activeData }),
    expiry: decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "nameExpires", data: expiryData }),
    allowance: decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: allowanceData }),
  };
}

export function assertExactPurchaseState(
  listing: NameListingView,
  state: PurchaseState,
  buyer: Address,
) {
  if (
    state.seller === zeroAddress ||
    state.seller !== getAddress(listing.seller) ||
    state.price !== BigInt(listing.price) ||
    state.validUntil !== BigInt(listing.validUntil) ||
    state.feeBps !== listing.feeBps ||
    state.owner !== state.seller ||
    !state.active ||
    state.expiry < state.validUntil ||
    state.paused
  ) {
    throw new Error("The listing changed. Refresh the page and review it again.");
  }
  if (state.seller === getAddress(buyer)) {
    throw new Error("A seller cannot buy their own name.");
  }
}

export function NameManagementPanel({
  releaseId,
  label,
  fullName,
  tokenId,
  node,
  owner,
  resolvedAddress,
  primaryName,
  lifecycle,
  expiry,
  annualQuote,
  listing,
  staleListing,
  marketplaceTokenApproved,
  marketPaused,
  managementEnabled,
  marketplaceEnabled,
  marketplaceEscapeEnabled,
}: NameManagementPanelProps) {
  const executionManifest = requireReadableReleaseManifest(releaseId);
  const router = useRouter();
  const wallet = useWalletSession();
  const walletAccount = wallet.account;
  const walletOnArc = wallet.onArc;
  const requireWalletConnection = wallet.requireConnection;
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const recoveryHashRef = useRef<string | null>(null);
  const connectedOwner = Boolean(
    wallet.account && owner && getAddress(wallet.account) === getAddress(owner),
  );
  const isPrimary = primaryName === fullName;
  const cancellationAvailable = listingCancellationAvailable({
    marketplaceEscapeEnabled,
    marketPaused,
    hasListing: listing !== null,
  });

  useEffect(() => {
    const account = walletAccount;
    if (!account || !walletOnArc) return;
    const pending = readPendingNameAction(releaseId, tokenId);
    if (
      !pending ||
      getAddress(pending.account) !== getAddress(account) ||
      recoveryHashRef.current === pending.transactionHash
    ) {
      return;
    }
    recoveryHashRef.current = pending.transactionHash;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setBusy("pending");
      setError(null);
      setMessage(`Checking the pending ${pending.action} transaction…`);
      void requireWalletConnection()
        .then(async (current) => {
          if (getAddress(current.account) !== getAddress(pending.account)) {
            throw new Error("Reconnect the wallet that submitted the pending transaction.");
          }
          await assertArcWalletAccount(current.provider, pending.account);
          return resolvePendingNameAction(current.provider, pending);
        })
        .then((resolution) => {
          if (cancelled) return;
          if (resolution.complete) {
            clearPendingNameAction(releaseId, tokenId, pending.transactionHash);
            setMessage("The pending transaction is confirmed.");
            setBusy(null);
          } else {
            setMessage(`Transaction confirmed on-chain. ${resolution.detail ?? "App verification is still catching up."}`);
            setBusy("pending");
          }
          router.refresh();
        })
        .catch((recoveryError) => {
          if (cancelled) return;
          if (receiptWasReverted(recoveryError)) {
            clearPendingNameAction(releaseId, tokenId, pending.transactionHash);
            setError(walletErrorMessage(recoveryError, "The pending transaction reverted."));
            setBusy(null);
            return;
          }
          setMessage("The transaction was submitted and is still awaiting confirmation. Reload this name to check it again.");
          setBusy("pending");
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    releaseId,
    requireWalletConnection,
    router,
    tokenId,
    walletAccount,
    walletOnArc,
  ]);

  async function connection() {
    const current = await wallet.requireConnection();
    if (!wallet.onArc) await wallet.switchToArc();
    await assertArcWalletAccount(current.provider, current.account);
    return current;
  }

  async function ownerConnection() {
    const current = await connection();
    if (!owner || getAddress(current.account) !== getAddress(owner)) {
      throw new Error("Connect the wallet that owns this name.");
    }
    return current;
  }

  async function confirmPlan(
    provider: EthereumProvider,
    account: Address,
    plan: UnsignedTransactionPlan,
  ) {
    await simulateWalletPlan(provider, account, plan);
    const transactionHash = await sendWalletPlan(provider, account, plan);
    await waitForWalletReceipt(provider, transactionHash, account);
    return transactionHash;
  }

  async function confirmFinalPlan(
    provider: EthereumProvider,
    account: Address,
    plan: UnsignedTransactionPlan,
    draft: PendingNameActionDraft,
  ) {
    await simulateWalletPlan(provider, account, plan);
    const transactionHash = await sendWalletPlan(provider, account, plan);
    const pending: PendingNameAction = {
      ...draft,
      version: 2,
      releaseId,
      transactionHash,
      account: getAddress(account),
    };
    savePendingNameAction(pending);
    let resolution: Awaited<ReturnType<typeof resolvePendingNameAction>>;
    try {
      resolution = await resolvePendingNameAction(provider, pending);
    } catch (receiptError) {
      if (receiptWasReverted(receiptError)) {
        clearPendingNameAction(releaseId, tokenId, transactionHash);
        throw receiptError;
      }
      throw new PendingNameActionError(transactionHash);
    }
    if (!resolution.complete) {
      setMessage(`Transaction confirmed on-chain. ${resolution.detail ?? "App verification is still catching up."}`);
      setBusy("pending");
      router.refresh();
      return false;
    }
    clearPendingNameAction(releaseId, tokenId, transactionHash);
    return true;
  }

  function begin(action: string) {
    const pending = readPendingNameAction(releaseId, tokenId);
    if (pending) {
      setBusy("pending");
      setError(null);
      setMessage(`A ${pending.action} transaction is already pending for this name. Reload this name to check it.`);
      return false;
    }
    setBusy(action);
    setMessage(null);
    setError(null);
    return true;
  }

  function fail(actionError: unknown, fallback: string) {
    if (actionError instanceof PendingNameActionError) {
      setError(null);
      setMessage(actionError.message);
      setBusy("pending");
      return;
    }
    setError(walletErrorMessage(actionError, fallback));
    setBusy(null);
  }

  async function renew(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!begin("renew")) return;
    try {
      if (!managementEnabled || annualQuote === null) throw new Error("Renewal price is unavailable.");
      const form = new FormData(event.currentTarget);
      const years = BigInt(String(form.get("years") ?? "1"));
      if (years < 1n || years > 10n) throw new Error("Choose a renewal term between 1 and 10 years.");
      const amount = BigInt(annualQuote) * years;
      const { provider, account } = await ownerConnection();
      const manifest = executionManifest;
      const controller = requireActivatedContract(manifest, "controller");
      const [allowanceData] = await walletMulticall(provider, account, [{
        target: manifest.settlement.erc20Address,
        callData: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [account, controller] }),
      }]);
      const allowance = decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: allowanceData });
      if (allowance < amount) {
        setMessage("Approve the renewal amount in your wallet.");
        await confirmPlan(provider, account, prepareApprovalPlan(manifest, amount));
      }
      setMessage("Confirm renewal in your wallet.");
      if (!await confirmFinalPlan(
        provider,
        account,
        prepareRenewalPlan(manifest, label, years, amount),
        { action: "renew", tokenId },
      )) return;
      setMessage(`${fullName} was renewed.`);
      router.refresh();
    } catch (renewError) {
      fail(renewError, "Renewal stopped.");
      return;
    }
    setBusy(null);
  }

  async function makePrimary() {
    if (!begin("primary")) return;
    try {
      if (!managementEnabled || lifecycle !== "active") throw new Error("Only an active name can be primary.");
      const { provider, account } = await ownerConnection();
      const manifest = executionManifest;
      if (!resolvedAddress || getAddress(resolvedAddress) !== account) {
        setMessage("Set the name's wallet address first.");
        await confirmPlan(provider, account, prepareAddressPlan(manifest, node, account));
      }
      setMessage("Confirm the primary-name update.");
      if (!await confirmFinalPlan(
        provider,
        account,
        preparePrimaryNamePlan(manifest, fullName),
        { action: "primary", tokenId },
      )) return;
      setMessage(`${fullName} is now your primary name.`);
      router.refresh();
    } catch (primaryError) {
      fail(primaryError, "Primary-name update stopped.");
      return;
    }
    setBusy(null);
  }

  async function transfer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!begin("transfer")) return;
    try {
      if (!managementEnabled || lifecycle !== "active") throw new Error("Only an active name can be transferred.");
      if (listing) throw new Error("Cancel the listing before transferring this name.");
      const recipientText = String(new FormData(event.currentTarget).get("recipient") ?? "").trim();
      if (!isAddress(recipientText) || getAddress(recipientText) === zeroAddress) {
        throw new Error("Enter a valid non-zero recipient address.");
      }
      const { provider, account } = await ownerConnection();
      const recipient = getAddress(recipientText);
      setMessage("Confirm the ownership transfer in your wallet.");
      if (!await confirmFinalPlan(
        provider,
        account,
        prepareTransferPlan(executionManifest, account, recipient, BigInt(tokenId)),
        { action: "transfer", tokenId },
      )) return;
      setMessage(`${fullName} was transferred to ${shortAddress(recipient)}.`);
      router.refresh();
    } catch (transferError) {
      fail(transferError, "Transfer stopped.");
      return;
    }
    setBusy(null);
  }

  async function listName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!begin("listing")) return;
    try {
      if (!marketplaceEnabled || marketPaused || lifecycle !== "active") {
        throw new Error("New marketplace listings are unavailable right now.");
      }
      const form = new FormData(event.currentTarget);
      const priceText = String(form.get("price") ?? "").trim();
      const daysText = String(form.get("days") ?? "").trim();
      if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(priceText)) {
        throw new Error("Enter a USDC price with at most six decimals.");
      }
      if (!/^[1-9]\d{0,2}$/.test(daysText)) throw new Error("Enter a listing duration from 1 to 365 days.");
      const price = parseUnits(priceText, 6);
      const days = Number(daysText);
      if (price <= 0n || days > 365) throw new Error("Listing terms must be positive and no longer than 365 days.");
      const { provider, account } = await ownerConnection();
      const manifest = executionManifest;
      const registrar = requireActivatedContract(manifest, "baseRegistrar");
      const market = requireActivatedContract(manifest, "marketplace");
      const currentTime = await latestWalletTimestamp(provider);
      const validUntil = currentTime + BigInt(days) * 86_400n;
      if (validUntil > BigInt(expiry)) throw new Error("The listing deadline must be before the name expires.");
      const [ownerData, activeData, approvedData, operatorData, pausedData] = await walletMulticall(provider, account, [
        { target: registrar, callData: encodeFunctionData({ abi: baseRegistrarAbi, functionName: "ownerOf", args: [BigInt(tokenId)] }) },
        { target: registrar, callData: encodeFunctionData({ abi: baseRegistrarAbi, functionName: "isActive", args: [BigInt(tokenId)] }) },
        { target: registrar, callData: encodeFunctionData({ abi: baseRegistrarAbi, functionName: "getApproved", args: [BigInt(tokenId)] }) },
        { target: registrar, callData: encodeFunctionData({ abi: baseRegistrarAbi, functionName: "isApprovedForAll", args: [account, market] }) },
        { target: market, callData: encodeFunctionData({ abi: marketplaceAbi, functionName: "paused" }) },
      ]);
      const currentOwner = getAddress(decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "ownerOf", data: ownerData }));
      const active = decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "isActive", data: activeData });
      const approved = getAddress(decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "getApproved", data: approvedData }));
      const approvedForAll = decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "isApprovedForAll", data: operatorData });
      const paused = decodeFunctionResult({ abi: marketplaceAbi, functionName: "paused", data: pausedData });
      if (currentOwner !== account || !active || paused) throw new Error("This name cannot be listed from the current wallet state.");
      if (approved !== market && !approvedForAll) {
        setMessage("Approve this name for the marketplace.");
        await confirmPlan(provider, account, prepareMarketplaceTokenApprovalPlan(manifest, BigInt(tokenId)));
      }
      setMessage(listing ? "Confirm the updated listing." : "Confirm the new listing.");
      if (!await confirmFinalPlan(
        provider,
        account,
        prepareListingPlan(manifest, BigInt(tokenId), price, validUntil),
        {
          action: "list",
          tokenId,
          price: price.toString(),
          validUntil: validUntil.toString(),
        },
      )) return;
      setMessage(listing ? "Listing updated." : `${fullName} is now listed.`);
      router.refresh();
    } catch (listingError) {
      fail(listingError, "Listing stopped.");
      return;
    }
    setBusy(null);
  }

  async function cancelListing() {
    if (!begin("cancel")) return;
    try {
      if (!cancellationAvailable) throw new Error("Marketplace cancellation is unavailable.");
      if (!listing) throw new Error("There is no live listing to cancel.");
      const { provider, account } = await ownerConnection();
      if (!await confirmFinalPlan(
        provider,
        account,
        prepareCancelListingPlan(executionManifest, BigInt(tokenId)),
        { action: "cancel", tokenId },
      )) return;
      setMessage("Listing cancelled.");
      router.refresh();
    } catch (cancelError) {
      fail(cancelError, "Cancellation stopped.");
      return;
    }
    setBusy(null);
  }

  async function revokeMarketplaceApproval() {
    if (!begin("revoke-market-approval")) return;
    try {
      if (!marketplaceEscapeEnabled) throw new Error("Marketplace approval management is unavailable.");
      if (!marketplaceTokenApproved) throw new Error("This name has no token-level marketplace approval.");
      const { provider, account } = await ownerConnection();
      const manifest = executionManifest;
      const registrar = requireActivatedContract(manifest, "baseRegistrar");
      const market = requireActivatedContract(manifest, "marketplace");
      const [ownerData, approvedData] = await walletMulticall(provider, account, [
        {
          target: registrar,
          callData: encodeFunctionData({
            abi: baseRegistrarAbi,
            functionName: "ownerOf",
            args: [BigInt(tokenId)],
          }),
        },
        {
          target: registrar,
          callData: encodeFunctionData({
            abi: baseRegistrarAbi,
            functionName: "getApproved",
            args: [BigInt(tokenId)],
          }),
        },
      ]);
      const currentOwner = getAddress(
        decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "ownerOf", data: ownerData }),
      );
      const currentApproval = getAddress(
        decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "getApproved", data: approvedData }),
      );
      if (currentOwner !== account) throw new Error("The connected wallet no longer owns this name.");
      if (currentApproval !== market) {
        throw new Error("The token-level marketplace approval has already changed.");
      }
      setMessage("Confirm removal of the marketplace NFT approval.");
      if (!await confirmFinalPlan(
        provider,
        account,
        prepareMarketplaceTokenApprovalRevocationPlan(manifest, BigInt(tokenId)),
        { action: "revoke-market-approval", tokenId },
      )) return;
      setMessage("Marketplace NFT approval removed.");
      router.refresh();
    } catch (revokeError) {
      fail(revokeError, "Marketplace approval removal stopped.");
      return;
    }
    setBusy(null);
  }

  async function invalidateStaleListing() {
    if (!begin("invalidate")) return;
    try {
      if (!marketplaceEscapeEnabled) throw new Error("Marketplace cleanup is unavailable.");
      if (!staleListing) throw new Error("There is no stale listing to clean up.");
      const { provider, account } = await connection();
      const manifest = executionManifest;
      const market = requireActivatedContract(manifest, "marketplace");
      const [liveData, rawData] = await walletMulticall(provider, account, [
        {
          target: market,
          callData: encodeFunctionData({
            abi: marketplaceAbi,
            functionName: "listingOf",
            args: [BigInt(tokenId)],
          }),
        },
        {
          target: market,
          callData: encodeFunctionData({
            abi: marketplaceAbi,
            functionName: "rawListingOf",
            args: [BigInt(tokenId)],
          }),
        },
      ]);
      const live = decodeFunctionResult({
        abi: marketplaceAbi,
        functionName: "listingOf",
        data: liveData,
      });
      const raw = decodeFunctionResult({
        abi: marketplaceAbi,
        functionName: "rawListingOf",
        data: rawData,
      });
      if (
        getAddress(live[0]) !== zeroAddress ||
        getAddress(raw[0]) === zeroAddress ||
        getAddress(raw[0]) !== getAddress(staleListing.seller)
      ) {
        throw new Error("The stale listing changed. Refresh the page and review it again.");
      }
      setMessage("Confirm removal of the stale marketplace record.");
      if (!await confirmFinalPlan(
        provider,
        account,
        prepareInvalidateListingPlan(manifest, BigInt(tokenId)),
        {
          action: "invalidate",
          tokenId,
          seller: getAddress(staleListing.seller),
        },
      )) return;
      setMessage("Stale marketplace listing removed.");
      router.refresh();
    } catch (invalidateError) {
      fail(invalidateError, "Stale listing cleanup stopped.");
      return;
    }
    setBusy(null);
  }

  async function buyName() {
    if (!begin("buy")) return;
    try {
      if (!marketplaceEnabled || !listing) throw new Error("This name is not available to buy.");
      const { provider, account: buyer } = await connection();
      let state = await readPurchaseState(
        provider,
        buyer,
        BigInt(tokenId),
        executionManifest,
      );
      assertExactPurchaseState(listing, state, buyer);
      const manifest = executionManifest;
      if (state.allowance < state.price) {
        setMessage("Approve the exact purchase price in USDC.");
        await confirmPlan(provider, buyer, prepareMarketplaceApprovalPlan(manifest, state.price));
        state = await readPurchaseState(
          provider,
          buyer,
          BigInt(tokenId),
          executionManifest,
        );
        assertExactPurchaseState(listing, state, buyer);
        if (state.allowance < state.price) throw new Error("Marketplace allowance was not confirmed.");
      }
      setMessage("Confirm the purchase in your wallet.");
      if (!await confirmFinalPlan(
        provider,
        buyer,
        prepareBuyPlan(manifest, BigInt(tokenId), state.price, state.feeBps),
        {
          action: "buy",
          tokenId,
          seller: state.seller,
          price: state.price.toString(),
          feeBps: state.feeBps,
        },
      )) return;
      setMessage(`${fullName} is now yours.`);
      router.refresh();
    } catch (buyError) {
      fail(buyError, "Purchase stopped.");
      return;
    }
    setBusy(null);
  }

  return (
    <section id="management" className="name-management-surface">
      <div className="name-management content-shell">
        <header className="name-management__heading">
          <span>01 / NAME MANAGEMENT</span>
          <h1>{connectedOwner ? "Manage your name." : listing ? "This name is for sale." : "Name ownership."}</h1>
          <p>
            {connectedOwner
              ? "Renew, set your primary name, transfer ownership, or manage its fixed-price listing."
              : `Owned by ${shortAddress(owner)}${listing ? "; review the listing below." : "."}`}
          </p>
        </header>

        <div className="name-management__summary">
          <div><span>Status</span><strong>{lifecycle.toUpperCase()}</strong></div>
          <div><span>Expiry</span><strong>{dateLabel(expiry)}</strong></div>
          <div><span>Primary</span><strong>{isPrimary ? "YES" : "NO"}</strong></div>
          <div><span>Market</span><strong>{listing ? `${formatUnits(BigInt(listing.price), 6)} USDC` : "NOT LISTED"}</strong></div>
        </div>

        {!wallet.account ? (
          <div className="name-management__connect">
            <p>Connect a wallet to see the actions available to that account.</p>
            <button type="button" onClick={wallet.openWalletOptions} disabled={wallet.busy}>
              {wallet.busy ? "Connecting…" : "Choose wallet"}
            </button>
          </div>
        ) : null}

        {connectedOwner ? (
          <div className="name-action-grid">
            <form className="name-action-card" onSubmit={renew}>
              <span>RENEW</span><h2>Extend ownership</h2>
              <p>Renew during the active period or grace period.</p>
              <label>Term<select name="years" defaultValue="1"><option value="1">1 year</option><option value="2">2 years</option><option value="5">5 years</option><option value="10">10 years</option></select></label>
              <strong>{annualQuote ? `${formatUnits(BigInt(annualQuote), 6)} USDC / year` : "Price unavailable"}</strong>
              <button type="submit" disabled={busy !== null || !annualQuote}>{busy === "renew" ? "Renewing…" : "Renew name"}</button>
            </form>

            <div className="name-action-card">
              <span>PRIMARY</span><h2>Use as primary</h2>
              <p>{isPrimary ? "This is already your primary name." : "Sets the forward address when needed, then updates your primary name."}</p>
              <strong>{resolvedAddress ? shortAddress(resolvedAddress) : "Address will be set"}</strong>
              <button type="button" onClick={() => void makePrimary()} disabled={busy !== null || isPrimary || lifecycle !== "active"}>{busy === "primary" ? "Updating…" : isPrimary ? "Primary name" : "Make primary"}</button>
            </div>

            <form className="name-action-card" onSubmit={transfer}>
              <span>TRANSFER</span><h2>Send to another wallet</h2>
              <p>{listing ? "Cancel the current listing before transferring ownership." : "The recipient becomes the new owner after confirmation."}</p>
              <label>Recipient<input name="recipient" placeholder="0x…" autoComplete="off" /></label>
              <button type="submit" disabled={busy !== null || lifecycle !== "active" || Boolean(listing)}>{busy === "transfer" ? "Transferring…" : "Transfer name"}</button>
            </form>

            <form className="name-action-card name-action-card--market" onSubmit={listName}>
              <span>MARKET</span><h2>{listing ? "Update listing" : "List for sale"}</h2>
              <p>{!marketplaceEscapeEnabled ? "Marketplace transactions are unavailable on this deployment." : !marketplaceEnabled || marketPaused ? "New listings are temporarily unavailable; cancellation and approval removal remain open." : "Choose a fixed USDC price and deadline."}</p>
              <div className="name-action-card__fields">
                <label>Price<input name="price" inputMode="decimal" defaultValue={listing ? formatUnits(BigInt(listing.price), 6) : ""} placeholder="25.00" /></label>
                <label>Days<input name="days" inputMode="numeric" defaultValue="30" /></label>
              </div>
              <div className="name-action-card__buttons">
                <button type="submit" disabled={busy !== null || !marketplaceEnabled || marketPaused || lifecycle !== "active"}>{busy === "listing" ? "Saving…" : listing ? "Update listing" : "List name"}</button>
                {listing ? <button type="button" onClick={() => void cancelListing()} disabled={busy !== null || !cancellationAvailable}>{busy === "cancel" ? "Cancelling…" : "Cancel listing"}</button> : null}
                {marketplaceTokenApproved ? <button type="button" onClick={() => void revokeMarketplaceApproval()} disabled={busy !== null || !marketplaceEscapeEnabled}>{busy === "revoke-market-approval" ? "Removing approval…" : "Remove market approval"}</button> : null}
              </div>
            </form>
          </div>
        ) : listing ? (
          <div className="name-purchase-card">
            <div><span>FIXED PRICE</span><strong>{formatUnits(BigInt(listing.price), 6)} USDC</strong><p>Listed by {shortAddress(listing.seller)} · valid until {dateLabel(listing.validUntil)}</p></div>
            <button type="button" onClick={() => void buyName()} disabled={busy !== null || !marketplaceEnabled || marketPaused}>{busy === "buy" ? "Buying…" : marketplaceEnabled ? "Buy this name" : "Purchases unavailable"}</button>
          </div>
        ) : wallet.account ? (
          <div className="name-management__connect"><p>This wallet does not own the name, and the name is not listed for sale.</p></div>
        ) : null}

        {staleListing && marketplaceEscapeEnabled ? (
          <div className="name-purchase-card">
            <div>
              <span>STALE LISTING</span>
              <strong>Cleanup available</strong>
              <p>
                The {formatUnits(BigInt(staleListing.price), 6)} USDC raw listing from {shortAddress(staleListing.seller)},
                dated until {dateLabel(staleListing.validUntil)}, is no longer purchasable.
                Anyone can remove this expired or invalid marketplace record, including while the market is paused.
              </p>
            </div>
            <button type="button" onClick={() => void invalidateStaleListing()} disabled={busy !== null}>
              {busy === "invalidate" ? "Cleaning up…" : "Remove stale listing"}
            </button>
          </div>
        ) : null}

        {wallet.message ? <p className="name-action-feedback" role="status">{wallet.message}</p> : null}
        {message ? <p className="name-action-feedback" role="status">{message}</p> : null}
        {error ? <p className="name-action-feedback name-action-feedback--error" role="alert">{error}</p> : null}
      </div>
    </section>
  );
}
