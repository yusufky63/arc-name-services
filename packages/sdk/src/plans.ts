import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  assertDeploymentManifest,
  requireActivatedContract,
  type DeploymentManifest,
} from "@contour/config";
import { deriveNameIdentity, NORMALIZATION_PROFILE } from "@contour/normalization";
import {
  baseRegistrarAbi,
  controllerAbi,
  erc20Abi,
  marketplaceAbi,
  publicResolverAbi,
  reverseRegistrarAbi,
} from "./abis.js";
import type { RegistrationPermit } from "./permit.js";

export interface UnsignedTransactionPlan {
  readonly kind: "approval" | "register" | "renew" | "profile" | "market" | "transfer";
  readonly chainId: typeof ARC_TESTNET_CHAIN_ID;
  /** Exact release whose contract addresses and policy produced this calldata. */
  readonly releaseId: Hex;
  readonly to: Address;
  readonly data: Hex;
  readonly value: 0n;
  readonly description: string;
}

function requireReleaseId(manifest: DeploymentManifest): Hex {
  if (!manifest.releaseId) throw new Error("deployment release is not configured");
  return manifest.releaseId;
}

function plan(
  manifest: DeploymentManifest,
  kind: UnsignedTransactionPlan["kind"],
  to: Address,
  data: Hex,
  description: string,
): UnsignedTransactionPlan {
  return Object.freeze({
    kind,
    chainId: ARC_TESTNET_CHAIN_ID,
    releaseId: requireReleaseId(manifest),
    to,
    data,
    value: 0n,
    description,
  });
}

export function resolverDataHash(resolverData: readonly Hex[]): Hex {
  return keccak256(encodeAbiParameters([{ type: "bytes[]" }], [resolverData]));
}

function assertExecutionManifest(manifest: DeploymentManifest) {
  assertDeploymentManifest(manifest);
  if (manifest.state !== "active") throw new Error("deployment manifest is not active");
}

function assertRegistrationExecutionManifest(manifest: DeploymentManifest) {
  assertExecutionManifest(manifest);
  if (
    !manifest.permitIssuer.active ||
    manifest.activationEvidence.controllerPolicy.registrationsPaused !== false
  ) {
    throw new Error("registration is not active in the deployment manifest");
  }
}

function assertMarketplaceExecutionManifest(manifest: DeploymentManifest) {
  assertExecutionManifest(manifest);
  if (manifest.activationEvidence.marketplacePolicy.paused !== false) {
    throw new Error("marketplace execution is paused in the deployment manifest");
  }
}

export function prepareApprovalPlan(manifest: DeploymentManifest, amount: bigint) {
  assertExecutionManifest(manifest);
  if (amount <= 0n) throw new Error("approval amount must be positive");
  const target = requireActivatedContract(manifest, "controller");
  return plan(
    manifest,
    "approval",
    manifest.settlement.erc20Address,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [target, amount] }),
    `Authorize exactly ${amount} USDC base units`,
  );
}

export function prepareMarketplaceApprovalPlan(manifest: DeploymentManifest, amount: bigint) {
  assertMarketplaceExecutionManifest(manifest);
  if (amount <= 0n) throw new Error("approval amount must be positive");
  const target = requireActivatedContract(manifest, "marketplace");
  return plan(
    manifest,
    "approval",
    manifest.settlement.erc20Address,
    encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [target, amount] }),
    `Authorize the marketplace for exactly ${amount} USDC base units`,
  );
}

/** Authorizes only one registrar token for the pinned marketplace. */
export function prepareMarketplaceTokenApprovalPlan(
  manifest: DeploymentManifest,
  tokenId: bigint,
) {
  assertMarketplaceExecutionManifest(manifest);
  if (tokenId < 0n) throw new Error("tokenId must be unsigned");
  const registrar = requireActivatedContract(manifest, "baseRegistrar");
  const market = requireActivatedContract(manifest, "marketplace");
  return plan(
    manifest,
    "approval",
    registrar,
    encodeFunctionData({
      abi: baseRegistrarAbi,
      functionName: "approve",
      args: [market, tokenId],
    }),
    `Authorize the marketplace for token ${tokenId}`,
  );
}

/**
 * Clears the token-specific ERC-721 approval without depending on marketplace
 * execution. This escape path intentionally remains available while the market
 * is paused.
 */
export function prepareMarketplaceTokenApprovalRevocationPlan(
  manifest: DeploymentManifest,
  tokenId: bigint,
) {
  assertExecutionManifest(manifest);
  if (tokenId < 0n) throw new Error("tokenId must be unsigned");
  const registrar = requireActivatedContract(manifest, "baseRegistrar");
  return plan(
    manifest,
    "approval",
    registrar,
    encodeFunctionData({
      abi: baseRegistrarAbi,
      functionName: "approve",
      args: [zeroAddress, tokenId],
    }),
    `Clear the token-specific ERC-721 approval for token ${tokenId}`,
  );
}

/** Concise alias for prepareMarketplaceTokenApprovalRevocationPlan. */
export const prepareMarketplaceTokenApprovalRevokePlan =
  prepareMarketplaceTokenApprovalRevocationPlan;

export interface PrepareRegistrationInput {
  manifest: DeploymentManifest;
  rawLabel: string;
  normalizationAccepted: boolean;
  permit: RegistrationPermit;
  signature: Hex;
  resolverData?: readonly Hex[];
}

export function prepareRegistrationPlan(input: PrepareRegistrationInput): UnsignedTransactionPlan {
  assertRegistrationExecutionManifest(input.manifest);
  const suffix = input.manifest.namespace.suffix;
  const releaseId = input.manifest.releaseId;
  if (!suffix || !releaseId) throw new Error("release is not configured");
  const controller = requireActivatedContract(input.manifest, "controller");
  const identity = deriveNameIdentity(input.rawLabel, suffix);
  if (identity.changed && !input.normalizationAccepted) {
    throw new Error(`normalization changed the label to ${identity.normalized}; explicit acceptance is required`);
  }
  const resolverData = input.resolverData ?? [];
  const p = input.permit;
  if (p.chainId !== BigInt(ARC_TESTNET_CHAIN_ID)) throw new Error("permit chain mismatch");
  if (getAddress(p.controller) !== getAddress(controller)) throw new Error("permit controller mismatch");
  if (p.releaseId.toLowerCase() !== releaseId.toLowerCase()) throw new Error("permit release mismatch");
  if (p.normalizationProfileHash.toLowerCase() !== NORMALIZATION_PROFILE.profileHash) throw new Error("permit profile mismatch");
  if (p.normalizedLabelHash.toLowerCase() !== identity.labelhash) throw new Error("permit labelhash mismatch");
  if (p.namehash.toLowerCase() !== identity.namehash) throw new Error("permit namehash mismatch");
  if (p.resolverDataHash.toLowerCase() !== resolverDataHash(resolverData)) throw new Error("resolver data hash mismatch");
  if (getAddress(p.settlementAsset) !== getAddress(input.manifest.settlement.erc20Address)) {
    throw new Error("permit settlement asset mismatch");
  }
  return plan(
    input.manifest,
    "register",
    controller,
    encodeFunctionData({
      abi: controllerAbi,
      functionName: "register",
      args: [identity.normalized, p, [...resolverData], input.signature],
    }),
    `Register ${identity.name}; ownership exists only after a confirmed receipt`,
  );
}

export function prepareRenewalPlan(
  manifest: DeploymentManifest,
  normalizedLabel: string,
  durationYears: bigint,
  expectedAmount: bigint,
): UnsignedTransactionPlan {
  assertExecutionManifest(manifest);
  if (!manifest.namespace.suffix) throw new Error("suffix is not configured");
  const identity = deriveNameIdentity(normalizedLabel, manifest.namespace.suffix);
  if (identity.changed) throw new Error("renewal label must already be normalized");
  if (durationYears <= 0n || expectedAmount <= 0n) throw new Error("duration and amount must be positive");
  const controller = requireActivatedContract(manifest, "controller");
  return plan(
    manifest,
    "renew",
    controller,
    encodeFunctionData({ abi: controllerAbi, functionName: "renew", args: [identity.normalized, durationYears, expectedAmount] }),
    `Renew ${identity.name} for exactly ${expectedAmount} USDC base units`,
  );
}

export function prepareTextPlan(manifest: DeploymentManifest, node: Hex, key: string, value: string) {
  assertExecutionManifest(manifest);
  if (!manifest.resolverCapabilities.text) throw new Error("text records are not active in the manifest");
  const resolver = requireActivatedContract(manifest, "publicResolver");
  return plan(
    manifest,
    "profile",
    resolver,
    encodeFunctionData({ abi: publicResolverAbi, functionName: "setText", args: [node, key, value] }),
    `Set public text record ${key}`,
  );
}

/** Transfers one active registrar token to a different non-zero recipient. */
export function prepareTransferPlan(
  manifest: DeploymentManifest,
  from: Address,
  to: Address,
  tokenId: bigint,
): UnsignedTransactionPlan {
  assertExecutionManifest(manifest);
  if (tokenId < 0n) throw new Error("tokenId must be unsigned");
  const normalizedFrom = getAddress(from);
  const normalizedTo = getAddress(to);
  if (normalizedFrom === zeroAddress || normalizedTo === zeroAddress) {
    throw new Error("transfer addresses must be non-zero");
  }
  if (normalizedFrom === normalizedTo) {
    throw new Error("transfer recipient must differ from the current owner");
  }
  const registrar = requireActivatedContract(manifest, "baseRegistrar");
  return plan(
    manifest,
    "transfer",
    registrar,
    encodeFunctionData({
      abi: baseRegistrarAbi,
      functionName: "safeTransferFrom",
      args: [normalizedFrom, normalizedTo, tokenId],
    }),
    `Safely transfer token ${tokenId} from ${normalizedFrom} to ${normalizedTo}`,
  );
}

/** Sets the canonical EVM address record for a name node. */
export function prepareAddressPlan(
  manifest: DeploymentManifest,
  node: Hex,
  address: Address,
): UnsignedTransactionPlan {
  assertExecutionManifest(manifest);
  if (!manifest.resolverCapabilities.addr) {
    throw new Error("address records are not active in the manifest");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(node) || /^0x0{64}$/i.test(node)) {
    throw new Error("node must be a non-zero bytes32 value");
  }
  const normalizedAddress = getAddress(address);
  if (normalizedAddress === zeroAddress) throw new Error("address record must be non-zero");
  const resolver = requireActivatedContract(manifest, "publicResolver");
  return plan(
    manifest,
    "profile",
    resolver,
    encodeFunctionData({
      abi: publicResolverAbi,
      functionName: "setAddr",
      args: [node, normalizedAddress],
    }),
    `Set the canonical EVM address for node ${node} to ${normalizedAddress}`,
  );
}

/** Sets a forward-confirmed Contour name as the connected account's primary name. */
export function preparePrimaryNamePlan(
  manifest: DeploymentManifest,
  fullName: string,
): UnsignedTransactionPlan {
  assertExecutionManifest(manifest);
  if (!manifest.resolverCapabilities.name) {
    throw new Error("name records are not active in the manifest");
  }
  const suffix = manifest.namespace.suffix;
  if (!suffix) throw new Error("suffix is not configured");
  const suffixMarker = `.${suffix}`;
  if (!fullName.endsWith(suffixMarker)) {
    throw new Error(`primary name must use the configured .${suffix} suffix`);
  }
  const label = fullName.slice(0, -suffixMarker.length);
  const identity = deriveNameIdentity(label, suffix);
  if (identity.name !== fullName) {
    throw new Error(`primary name must already be normalized as ${identity.name}`);
  }
  const reverseRegistrar = requireActivatedContract(manifest, "reverseRegistrar");
  return plan(
    manifest,
    "profile",
    reverseRegistrar,
    encodeFunctionData({ abi: reverseRegistrarAbi, functionName: "setName", args: [fullName] }),
    `Set ${fullName} as the connected account's forward-confirmed primary name`,
  );
}

export function prepareListingPlan(manifest: DeploymentManifest, tokenId: bigint, price: bigint, validUntil: bigint) {
  assertMarketplaceExecutionManifest(manifest);
  if (price <= 0n || validUntil <= 0n || validUntil > 18_446_744_073_709_551_615n) throw new Error("invalid listing terms");
  const market = requireActivatedContract(manifest, "marketplace");
  return plan(
    manifest,
    "market",
    market,
    encodeFunctionData({ abi: marketplaceAbi, functionName: "list", args: [tokenId, price, validUntil] }),
    `List token ${tokenId} at exactly ${price} USDC base units`,
  );
}

export function prepareBuyPlan(manifest: DeploymentManifest, tokenId: bigint, expectedPrice: bigint, expectedFeeBps: number) {
  assertMarketplaceExecutionManifest(manifest);
  if (tokenId < 0n || expectedPrice <= 0n || !Number.isInteger(expectedFeeBps) || expectedFeeBps < 0 || expectedFeeBps > 1_000) {
    throw new Error("invalid purchase guard");
  }
  const market = requireActivatedContract(manifest, "marketplace");
  return plan(
    manifest,
    "market",
    market,
    encodeFunctionData({ abi: marketplaceAbi, functionName: "buy", args: [tokenId, expectedPrice, expectedFeeBps] }),
    `Buy token ${tokenId} only at ${expectedPrice} base units and ${expectedFeeBps} bps fee`,
  );
}

export function prepareCancelListingPlan(manifest: DeploymentManifest, tokenId: bigint) {
  assertExecutionManifest(manifest);
  if (tokenId < 0n) throw new Error("tokenId must be unsigned");
  const market = requireActivatedContract(manifest, "marketplace");
  return plan(
    manifest,
    "market",
    market,
    encodeFunctionData({ abi: marketplaceAbi, functionName: "cancel", args: [tokenId] }),
    `Cancel the listing for token ${tokenId}`,
  );
}

/**
 * Permissionlessly removes a stale marketplace listing. Live listings are a
 * safe no-op, and this cleanup path intentionally remains available while the
 * market is paused.
 */
export function prepareInvalidateListingPlan(manifest: DeploymentManifest, tokenId: bigint) {
  assertExecutionManifest(manifest);
  if (tokenId < 0n) throw new Error("tokenId must be unsigned");
  const market = requireActivatedContract(manifest, "marketplace");
  return plan(
    manifest,
    "market",
    market,
    encodeFunctionData({ abi: marketplaceAbi, functionName: "invalidateListing", args: [tokenId] }),
    `Invalidate the stale listing for token ${tokenId}`,
  );
}

export function prepareClaimProceedsPlan(manifest: DeploymentManifest) {
  assertExecutionManifest(manifest);
  const market = requireActivatedContract(manifest, "marketplace");
  return plan(
    manifest,
    "market",
    market,
    encodeFunctionData({ abi: marketplaceAbi, functionName: "claimProceeds" }),
    "Claim marketplace seller proceeds",
  );
}

export function prepareClaimReferralPlan(manifest: DeploymentManifest) {
  assertExecutionManifest(manifest);
  const controller = requireActivatedContract(manifest, "controller");
  return plan(
    manifest,
    "market",
    controller,
    encodeFunctionData({ abi: controllerAbi, functionName: "claimReferral" }),
    "Claim registration referral credits",
  );
}

export const NO_REFERRER = zeroAddress;
