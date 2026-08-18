"use client";

import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  encodePacked,
  formatUnits,
  getAddress,
  isAddress,
  isHex,
  keccak256,
  parseAbi,
  parseUnits,
  toBytes,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  registrarVersionOf,
  requireActivatedContract,
  type DeploymentManifest,
  type RegistrarVersion,
} from "@contour/config";
import {
  getReadableReleases,
  type ReadableReleaseKey,
} from "./manifest";
import {
  assertArcWalletAccount,
  walletMulticall,
  walletReadRequest,
  waitForWalletReceipt,
} from "./wallet-protocol";

export const adminControllerAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function releaseId() view returns (bytes32)",
  "function treasury() view returns (address)",
  "function permitSigner() view returns (address)",
  "function pendingPermitSigner() view returns (address)",
  "function pendingPermitSignerValidAfter() view returns (uint64)",
  "function signerPolicyVersion() view returns (uint64)",
  "function referralBps() view returns (uint16)",
  "function registrationsPaused() view returns (bool)",
  "function totalReferralLiability() view returns (uint256)",
  "function PRICE_ONE_CODEPOINT() view returns (uint256)",
  "function PRICE_TWO_CODEPOINTS() view returns (uint256)",
  "function PRICE_THREE_CODEPOINTS() view returns (uint256)",
  "function PRICE_FOUR_PLUS_CODEPOINTS() view returns (uint256)",
  "function MAX_REFERRAL_BPS() view returns (uint256)",
  "function SIGNER_ACTIVATION_DELAY() view returns (uint256)",
  "function setRegistrationsPaused(bool paused)",
  "function setReferralBps(uint16 newReferralBps)",
  "function setTreasury(address newTreasury)",
  "function withdrawTreasurySurplus(uint256 amount)",
  "function proposePermitSigner(address newSigner)",
  "function activatePermitSigner()",
  "function revokePermitSigner()",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
  "event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)",
  "event NameRenewed(string name, bytes32 indexed label, uint256 cost, uint256 expires)",
  "event PermitConsumed(bytes32 indexed permitId, address indexed requester, uint256 indexed nonce)",
  "event ReferralAccrued(address indexed referrer, uint256 amount)",
  "event ReferralClaimed(address indexed referrer, uint256 amount)",
  "event TreasuryWithdrawal(address indexed treasury, uint256 amount)",
  "event PermitSignerProposed(address indexed currentSigner, address indexed pendingSigner, uint64 validAfter, uint64 policyVersion)",
  "event PermitSignerChanged(address indexed oldSigner, address indexed newSigner, uint64 policyVersion)",
  "event PermitSignerRevoked(address indexed oldSigner, uint64 policyVersion)",
  "event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury)",
  "event ReferralBpsChanged(uint16 oldReferralBps, uint16 newReferralBps)",
  "event RegistrationPauseChanged(bool paused)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
]);

export const adminMarketplaceAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function treasury() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function paused() view returns (bool)",
  "function totalSellerLiability() view returns (uint256)",
  "function MAX_FEE_BPS() view returns (uint16)",
  "function setPaused(bool paused)",
  "function setFeeBps(uint16 newFeeBps)",
  "function setTreasury(address newTreasury)",
  "function withdrawFeeSurplus(uint256 amount)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
  "event Listed(uint256 indexed tokenId, address indexed seller, uint256 price, uint64 validUntil)",
  "event ListingCancelled(uint256 indexed tokenId, address indexed seller)",
  "event ListingInvalidated(uint256 indexed tokenId, address indexed formerSeller)",
  "event Purchased(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee)",
  "event ProceedsClaimed(address indexed seller, uint256 amount)",
  "event FeeWithdrawal(address indexed treasury, uint256 amount)",
  "event FeeChangedEvent(uint16 oldFeeBps, uint16 newFeeBps)",
  "event TreasuryChanged(address indexed oldTreasury, address indexed newTreasury)",
  "event PauseChanged(bool paused)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
]);

export const adminRegistrarAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function controllers(address controller) view returns (bool)",
  "function setController(address controller, bool enabled)",
  "function transferOwnership(address newOwner)",
  "function acceptOwnership()",
  "event ControllerChanged(address indexed controller, bool enabled)",
  "event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)",
  "event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)",
]);

const adminRegistryAbi = parseAbi([
  "function owner(bytes32 node) view returns (address)",
  "function resolver(bytes32 node) view returns (address)",
]);

const balanceAbi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);

const ZERO_NODE = `0x${"00".repeat(32)}` as Hex;
const reverseLabel = keccak256(toBytes("reverse"));
const addrLabel = keccak256(toBytes("addr"));
const reverseRoot = keccak256(
  encodePacked(["bytes32", "bytes32"], [ZERO_NODE, reverseLabel]),
);
const reverseNode = keccak256(
  encodePacked(["bytes32", "bytes32"], [reverseRoot, addrLabel]),
);

export const ADMIN_CANONICAL_NODES = Object.freeze({
  root: ZERO_NODE,
  reverseRoot,
  reverseNode,
});

type OwnedContractState = {
  address: Address;
  owner: Address;
  pendingOwner: Address | null;
};

export type AdminSnapshot = {
  blockNumber: bigint;
  blockTimestamp: bigint;
  governance: Address;
  productLive: boolean;
  releaseId: Hex;
  releaseKey: ReadableReleaseKey;
  registrarVersion: RegistrarVersion;
  canonical: boolean;
  controller: OwnedContractState & {
    releaseId: Hex;
    treasury: Address;
    permitSigner: Address;
    pendingPermitSigner: Address | null;
    pendingPermitSignerValidAfter: bigint;
    signerPolicyVersion: bigint;
    referralBps: number;
    registrationsPaused: boolean;
    balance: bigint;
    liability: bigint;
    surplus: bigint | null;
    prices: readonly [bigint, bigint, bigint, bigint];
    maxReferralBps: number;
    signerActivationDelay: bigint;
  };
  marketplace: OwnedContractState & {
    treasury: Address;
    feeBps: number;
    paused: boolean;
    balance: bigint;
    liability: bigint;
    surplus: bigint | null;
    maxFeeBps: number;
  };
  registrar: OwnedContractState & {
    canonicalControllerEnabled: boolean;
  };
  registry: {
    address: Address;
    rootOwner: Address;
    baseNodeOwner: Address;
    reverseRootOwner: Address;
    reverseNodeOwner: Address;
    baseNodeResolver: Address | null;
  };
};

export type AdminRole =
  | "governance"
  | "controller-owner"
  | "controller-pending-owner"
  | "marketplace-owner"
  | "marketplace-pending-owner"
  | "registrar-owner"
  | "registrar-pending-owner"
  | "registry-root-owner";

export type AdminAccess = {
  authorized: boolean;
  roles: AdminRole[];
  isControllerOwner: boolean;
  isMarketplaceOwner: boolean;
  isRegistrarOwner: boolean;
  isControllerPendingOwner: boolean;
  isMarketplacePendingOwner: boolean;
  isRegistrarPendingOwner: boolean;
};

export type AdminContractTarget = "controller" | "marketplace" | "registrar";

export type AdminTransactionPlan = {
  releaseId: Hex;
  target: AdminContractTarget;
  to: Address;
  data: Hex;
  value: 0n;
  description: string;
};

export type AdminPostStateExpectation =
  | { kind: "registration-pause"; paused: boolean }
  | { kind: "marketplace-pause"; paused: boolean }
  | { kind: "referral-bps"; bps: number }
  | { kind: "marketplace-fee-bps"; bps: number }
  | { kind: "treasury"; target: "controller" | "marketplace"; treasury: Address }
  | { kind: "withdrawal"; target: "controller" | "marketplace"; treasury: Address }
  | { kind: "signer-proposal"; signer: Address; policyVersion: string }
  | { kind: "signer-activation"; signer: Address; policyVersion: string }
  | { kind: "signer-revocation" }
  | { kind: "registrar-controller"; enabled: boolean }
  | { kind: "owner"; target: AdminContractTarget; owner: Address }
  | { kind: "pending-owner"; target: AdminContractTarget; owner: Address };

function optionalAddress(value: Address): Address | null {
  return value === zeroAddress ? null : value;
}

function sameAddress(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function ownedState(snapshot: AdminSnapshot, target: AdminContractTarget): OwnedContractState {
  return target === "controller"
    ? snapshot.controller
    : target === "marketplace"
      ? snapshot.marketplace
      : snapshot.registrar;
}

export function adminPostStateMatches(
  snapshot: AdminSnapshot,
  expectation: AdminPostStateExpectation,
): boolean {
  switch (expectation.kind) {
    case "registration-pause":
      return snapshot.controller.registrationsPaused === expectation.paused;
    case "marketplace-pause":
      return snapshot.marketplace.paused === expectation.paused;
    case "referral-bps":
      return snapshot.controller.referralBps === expectation.bps;
    case "marketplace-fee-bps":
      return snapshot.marketplace.feeBps === expectation.bps;
    case "treasury": {
      const state = expectation.target === "controller" ? snapshot.controller : snapshot.marketplace;
      return sameAddress(state.treasury, expectation.treasury);
    }
    case "withdrawal": {
      const state = expectation.target === "controller" ? snapshot.controller : snapshot.marketplace;
      return sameAddress(state.treasury, expectation.treasury) && state.surplus !== null;
    }
    case "signer-proposal":
      return sameAddress(snapshot.controller.pendingPermitSigner, expectation.signer)
        && snapshot.controller.signerPolicyVersion.toString() === expectation.policyVersion;
    case "signer-activation":
      return sameAddress(snapshot.controller.permitSigner, expectation.signer)
        && snapshot.controller.pendingPermitSigner === null
        && snapshot.controller.signerPolicyVersion.toString() === expectation.policyVersion;
    case "signer-revocation":
      return snapshot.controller.registrationsPaused
        && snapshot.controller.permitSigner === zeroAddress
        && snapshot.controller.pendingPermitSigner === null;
    case "registrar-controller":
      return snapshot.registrar.canonicalControllerEnabled === expectation.enabled;
    case "owner":
      return sameAddress(ownedState(snapshot, expectation.target).owner, expectation.owner);
    case "pending-owner":
      return sameAddress(ownedState(snapshot, expectation.target).pendingOwner, expectation.owner);
  }
}

export function parseAdminPostStateExpectation(value: unknown): AdminPostStateExpectation | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const target = candidate.target;
  const address = (key: string) => {
    const item = candidate[key];
    return typeof item === "string" && isAddress(item) ? getAddress(item) : null;
  };
  switch (candidate.kind) {
    case "registration-pause":
    case "marketplace-pause":
      return typeof candidate.paused === "boolean"
        ? { kind: candidate.kind, paused: candidate.paused }
        : null;
    case "referral-bps":
    case "marketplace-fee-bps":
      return typeof candidate.bps === "number" && Number.isSafeInteger(candidate.bps) && candidate.bps >= 0
        ? { kind: candidate.kind, bps: candidate.bps }
        : null;
    case "treasury":
    case "withdrawal": {
      const treasury = address("treasury");
      return (target === "controller" || target === "marketplace") && treasury
        ? { kind: candidate.kind, target, treasury }
        : null;
    }
    case "signer-proposal":
    case "signer-activation": {
      const signer = address("signer");
      return signer && typeof candidate.policyVersion === "string" && /^\d+$/.test(candidate.policyVersion)
        ? { kind: candidate.kind, signer, policyVersion: candidate.policyVersion }
        : null;
    }
    case "signer-revocation":
      return { kind: "signer-revocation" };
    case "registrar-controller":
      return typeof candidate.enabled === "boolean"
        ? { kind: "registrar-controller", enabled: candidate.enabled }
        : null;
    case "owner":
    case "pending-owner": {
      const owner = address("owner");
      return (target === "controller" || target === "marketplace" || target === "registrar") && owner
        ? { kind: candidate.kind, target, owner }
        : null;
    }
    default:
      return null;
  }
}

function decode<T>(abi: readonly unknown[], functionName: string, data: Hex): T {
  return decodeFunctionResult({ abi, functionName, data } as never) as T;
}

function asAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value)) {
    throw new Error("The Arc contract returned an invalid address.");
  }
  return getAddress(value);
}

function parseQuantity(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    throw new Error(`The wallet returned an invalid ${label}.`);
  }
  return BigInt(value);
}

export type AdminReleaseContext = Readonly<{
  manifest: DeploymentManifest;
  releaseId: Hex;
  releaseKey: ReadableReleaseKey;
  registrarVersion: RegistrarVersion;
  canonical: boolean;
  controller: Address;
  marketplace: Address;
  registrar: Address;
  registry: Address;
}>;

export function getAdminReleaseContext(releaseId: string): AdminReleaseContext {
  const release = getReadableReleases().find(
    (candidate) =>
      candidate.manifest.releaseId?.toLowerCase() === releaseId.toLowerCase(),
  );
  if (!release || !release.manifest.releaseId) {
    throw new Error("The requested Contour admin release is not trusted.");
  }
  const manifest = release.manifest;
  const trustedReleaseId = release.manifest.releaseId;
  return {
    manifest,
    releaseId: trustedReleaseId,
    releaseKey: release.key,
    registrarVersion: registrarVersionOf(manifest),
    canonical: release.canonical,
    controller: requireActivatedContract(manifest, "controller"),
    marketplace: requireActivatedContract(manifest, "marketplace"),
    registrar: requireActivatedContract(manifest, "baseRegistrar"),
    registry: requireActivatedContract(manifest, "registry"),
  };
}

export async function readAdminSnapshot(
  provider: EthereumProvider,
  account: Address,
  releaseId: string,
): Promise<AdminSnapshot> {
  await assertArcWalletAccount(provider, account);
  const context = getAdminReleaseContext(releaseId);
  const {
    manifest,
    controller,
    marketplace,
    registrar,
    registry,
  } = context;
  const baseNode = manifest.namespace.baseNode;
  if (!baseNode) throw new Error("The canonical base node is unavailable.");

  const calls = [
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "owner" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "pendingOwner" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "releaseId" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "treasury" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "permitSigner" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "pendingPermitSigner" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "pendingPermitSignerValidAfter" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "signerPolicyVersion" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "referralBps" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "registrationsPaused" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "totalReferralLiability" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "PRICE_ONE_CODEPOINT" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "PRICE_TWO_CODEPOINTS" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "PRICE_THREE_CODEPOINTS" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "PRICE_FOUR_PLUS_CODEPOINTS" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "MAX_REFERRAL_BPS" }) },
    { target: controller, callData: encodeFunctionData({ abi: adminControllerAbi, functionName: "SIGNER_ACTIVATION_DELAY" }) },
    { target: marketplace, callData: encodeFunctionData({ abi: adminMarketplaceAbi, functionName: "owner" }) },
    { target: marketplace, callData: encodeFunctionData({ abi: adminMarketplaceAbi, functionName: "pendingOwner" }) },
    { target: marketplace, callData: encodeFunctionData({ abi: adminMarketplaceAbi, functionName: "treasury" }) },
    { target: marketplace, callData: encodeFunctionData({ abi: adminMarketplaceAbi, functionName: "feeBps" }) },
    { target: marketplace, callData: encodeFunctionData({ abi: adminMarketplaceAbi, functionName: "paused" }) },
    { target: marketplace, callData: encodeFunctionData({ abi: adminMarketplaceAbi, functionName: "totalSellerLiability" }) },
    { target: marketplace, callData: encodeFunctionData({ abi: adminMarketplaceAbi, functionName: "MAX_FEE_BPS" }) },
    { target: registrar, callData: encodeFunctionData({ abi: adminRegistrarAbi, functionName: "owner" }) },
    { target: registrar, callData: encodeFunctionData({ abi: adminRegistrarAbi, functionName: "pendingOwner" }) },
    { target: registrar, callData: encodeFunctionData({ abi: adminRegistrarAbi, functionName: "controllers", args: [controller] }) },
    { target: registry, callData: encodeFunctionData({ abi: adminRegistryAbi, functionName: "owner", args: [ZERO_NODE] }) },
    { target: registry, callData: encodeFunctionData({ abi: adminRegistryAbi, functionName: "owner", args: [baseNode] }) },
    { target: registry, callData: encodeFunctionData({ abi: adminRegistryAbi, functionName: "owner", args: [reverseRoot] }) },
    { target: registry, callData: encodeFunctionData({ abi: adminRegistryAbi, functionName: "owner", args: [reverseNode] }) },
    { target: registry, callData: encodeFunctionData({ abi: adminRegistryAbi, functionName: "resolver", args: [baseNode] }) },
    { target: manifest.settlement.erc20Address, callData: encodeFunctionData({ abi: balanceAbi, functionName: "balanceOf", args: [controller] }) },
    { target: manifest.settlement.erc20Address, callData: encodeFunctionData({ abi: balanceAbi, functionName: "balanceOf", args: [marketplace] }) },
  ] as const;

  const values = await walletMulticall(provider, account, calls);
  const block = await walletReadRequest(provider, {
    method: "eth_getBlockByNumber",
    params: ["latest", false],
  });
  if (!block || typeof block !== "object") {
    throw new Error("The wallet returned an invalid Arc block.");
  }
  const blockRecord = block as { number?: unknown; timestamp?: unknown };

  const controllerLiability = decode<bigint>(adminControllerAbi, "totalReferralLiability", values[10]);
  const controllerBalance = decode<bigint>(balanceAbi, "balanceOf", values[32]);
  const marketplaceLiability = decode<bigint>(adminMarketplaceAbi, "totalSellerLiability", values[22]);
  const marketplaceBalance = decode<bigint>(balanceAbi, "balanceOf", values[33]);
  const configuredGovernance = manifest.activationEvidence.governance.account;
  if (!configuredGovernance) throw new Error("The canonical governance account is unavailable.");
  if (!manifest.releaseId) throw new Error("The selected release ID is unavailable.");
  const controllerReleaseId = decode<Hex>(adminControllerAbi, "releaseId", values[2]);
  if (controllerReleaseId.toLowerCase() !== manifest.releaseId.toLowerCase()) {
    throw new Error("The live controller release ID does not match the selected trusted release.");
  }

  return {
    blockNumber: parseQuantity(blockRecord.number, "Arc block number"),
    blockTimestamp: parseQuantity(blockRecord.timestamp, "Arc block timestamp"),
    governance: getAddress(configuredGovernance),
    productLive: manifest.activationEvidence.productLive,
    releaseId: manifest.releaseId,
    releaseKey: context.releaseKey,
    registrarVersion: context.registrarVersion,
    canonical: context.canonical,
    controller: {
      address: controller,
      owner: asAddress(decode(adminControllerAbi, "owner", values[0])),
      pendingOwner: optionalAddress(asAddress(decode(adminControllerAbi, "pendingOwner", values[1]))),
      releaseId: controllerReleaseId,
      treasury: asAddress(decode(adminControllerAbi, "treasury", values[3])),
      permitSigner: asAddress(decode(adminControllerAbi, "permitSigner", values[4])),
      pendingPermitSigner: optionalAddress(asAddress(decode(adminControllerAbi, "pendingPermitSigner", values[5]))),
      pendingPermitSignerValidAfter: decode<bigint>(adminControllerAbi, "pendingPermitSignerValidAfter", values[6]),
      signerPolicyVersion: decode<bigint>(adminControllerAbi, "signerPolicyVersion", values[7]),
      referralBps: Number(decode<number>(adminControllerAbi, "referralBps", values[8])),
      registrationsPaused: decode<boolean>(adminControllerAbi, "registrationsPaused", values[9]),
      balance: controllerBalance,
      liability: controllerLiability,
      surplus: controllerBalance >= controllerLiability ? controllerBalance - controllerLiability : null,
      prices: [
        decode<bigint>(adminControllerAbi, "PRICE_ONE_CODEPOINT", values[11]),
        decode<bigint>(adminControllerAbi, "PRICE_TWO_CODEPOINTS", values[12]),
        decode<bigint>(adminControllerAbi, "PRICE_THREE_CODEPOINTS", values[13]),
        decode<bigint>(adminControllerAbi, "PRICE_FOUR_PLUS_CODEPOINTS", values[14]),
      ],
      maxReferralBps: Number(decode<bigint>(adminControllerAbi, "MAX_REFERRAL_BPS", values[15])),
      signerActivationDelay: decode<bigint>(adminControllerAbi, "SIGNER_ACTIVATION_DELAY", values[16]),
    },
    marketplace: {
      address: marketplace,
      owner: asAddress(decode(adminMarketplaceAbi, "owner", values[17])),
      pendingOwner: optionalAddress(asAddress(decode(adminMarketplaceAbi, "pendingOwner", values[18]))),
      treasury: asAddress(decode(adminMarketplaceAbi, "treasury", values[19])),
      feeBps: Number(decode<number>(adminMarketplaceAbi, "feeBps", values[20])),
      paused: decode<boolean>(adminMarketplaceAbi, "paused", values[21]),
      balance: marketplaceBalance,
      liability: marketplaceLiability,
      surplus: marketplaceBalance >= marketplaceLiability ? marketplaceBalance - marketplaceLiability : null,
      maxFeeBps: Number(decode<number>(adminMarketplaceAbi, "MAX_FEE_BPS", values[23])),
    },
    registrar: {
      address: registrar,
      owner: asAddress(decode(adminRegistrarAbi, "owner", values[24])),
      pendingOwner: optionalAddress(asAddress(decode(adminRegistrarAbi, "pendingOwner", values[25]))),
      canonicalControllerEnabled: decode<boolean>(adminRegistrarAbi, "controllers", values[26]),
    },
    registry: {
      address: registry,
      rootOwner: asAddress(decode(adminRegistryAbi, "owner", values[27])),
      baseNodeOwner: asAddress(decode(adminRegistryAbi, "owner", values[28])),
      reverseRootOwner: asAddress(decode(adminRegistryAbi, "owner", values[29])),
      reverseNodeOwner: asAddress(decode(adminRegistryAbi, "owner", values[30])),
      baseNodeResolver: optionalAddress(asAddress(decode(adminRegistryAbi, "resolver", values[31]))),
    },
  };
}

export function resolveAdminAccess(account: Address, snapshot: AdminSnapshot): AdminAccess {
  const roles: AdminRole[] = [];
  if (sameAddress(account, snapshot.governance)) roles.push("governance");
  if (sameAddress(account, snapshot.controller.owner)) roles.push("controller-owner");
  if (sameAddress(account, snapshot.controller.pendingOwner)) roles.push("controller-pending-owner");
  if (sameAddress(account, snapshot.marketplace.owner)) roles.push("marketplace-owner");
  if (sameAddress(account, snapshot.marketplace.pendingOwner)) roles.push("marketplace-pending-owner");
  if (sameAddress(account, snapshot.registrar.owner)) roles.push("registrar-owner");
  if (sameAddress(account, snapshot.registrar.pendingOwner)) roles.push("registrar-pending-owner");
  if (sameAddress(account, snapshot.registry.rootOwner)) roles.push("registry-root-owner");
  return {
    authorized: roles.length > 0,
    roles,
    isControllerOwner: roles.includes("controller-owner"),
    isMarketplaceOwner: roles.includes("marketplace-owner"),
    isRegistrarOwner: roles.includes("registrar-owner"),
    isControllerPendingOwner: roles.includes("controller-pending-owner"),
    isMarketplacePendingOwner: roles.includes("marketplace-pending-owner"),
    isRegistrarPendingOwner: roles.includes("registrar-pending-owner"),
  };
}

function targetDefinition(releaseId: string, target: AdminContractTarget) {
  const { controller, marketplace, registrar } = getAdminReleaseContext(releaseId);
  if (target === "controller") return { address: controller, abi: adminControllerAbi };
  if (target === "marketplace") return { address: marketplace, abi: adminMarketplaceAbi };
  return { address: registrar, abi: adminRegistrarAbi };
}

export function buildAdminPlan(
  releaseId: string,
  target: AdminContractTarget,
  functionName: string,
  args: readonly unknown[] = [],
  description = functionName,
): AdminTransactionPlan {
  const context = getAdminReleaseContext(releaseId);
  const definition = targetDefinition(context.releaseId, target);
  return {
    releaseId: context.releaseId,
    target,
    to: definition.address,
    data: encodeFunctionData({
      abi: definition.abi,
      functionName,
      args,
    } as never),
    value: 0n,
    description,
  };
}

export async function assertAdminDeployment(
  provider: EthereumProvider,
  account: Address,
  releaseId: string,
  plans: readonly AdminTransactionPlan[],
): Promise<void> {
  await assertArcWalletAccount(provider, account);
  const context = getAdminReleaseContext(releaseId);
  const { manifest } = context;
  const keyByTarget = {
    controller: "controller",
    marketplace: "marketplace",
    registrar: "baseRegistrar",
  } as const;
  const checked = new Set<AdminContractTarget>();
  for (const plan of plans) {
    if (plan.releaseId.toLowerCase() !== context.releaseId.toLowerCase()) {
      throw new Error("The admin transaction plan belongs to a different release.");
    }
    const expectedAddress = requireActivatedContract(
      manifest,
      keyByTarget[plan.target],
    );
    if (!sameAddress(plan.to, expectedAddress)) {
      throw new Error(`${plan.target} target does not match the selected release.`);
    }
    if (checked.has(plan.target)) continue;
    checked.add(plan.target);
    const expected = manifest.contracts[keyByTarget[plan.target]].runtimeCodeHash;
    if (!expected) throw new Error(`${plan.target} runtime identity is unavailable.`);
    const code = await walletReadRequest(provider, {
      method: "eth_getCode",
      params: [plan.to, "latest"],
    });
    if (typeof code !== "string" || !isHex(code) || code === "0x") {
      throw new Error(`${plan.target} runtime code is unavailable.`);
    }
    if (keccak256(code).toLowerCase() !== expected.toLowerCase()) {
      throw new Error(`${plan.target} runtime code does not match the selected release.`);
    }
  }
}

export async function verifyAdminTransaction(
  provider: EthereumProvider,
  hash: Hex,
  account: Address,
  plan: AdminTransactionPlan,
) {
  await waitForWalletReceipt(provider, hash, account);
  const transaction = await walletReadRequest(provider, {
    method: "eth_getTransactionByHash",
    params: [hash],
  });
  if (!transaction || typeof transaction !== "object") {
    throw new Error("The confirmed Arc transaction could not be read back.");
  }
  const value = transaction as {
    from?: unknown;
    to?: unknown;
    input?: unknown;
    value?: unknown;
  };
  if (
    typeof value.from !== "string" ||
    !isAddress(value.from) ||
    getAddress(value.from) !== getAddress(account) ||
    typeof value.to !== "string" ||
    !isAddress(value.to) ||
    getAddress(value.to) !== getAddress(plan.to) ||
    typeof value.input !== "string" ||
    value.input.toLowerCase() !== plan.data.toLowerCase() ||
    parseQuantity(value.value, "transaction value") !== 0n
  ) {
    throw new Error("The confirmed Arc transaction does not match the reviewed admin action.");
  }
}

export function parseAdminAddress(
  value: string,
  options: { allowZero?: boolean; forbidden?: readonly string[] } = {},
): Address {
  const normalized = value.trim();
  if (!isAddress(normalized)) throw new Error("Enter a valid EVM address.");
  const address = getAddress(normalized);
  if (!options.allowZero && address === zeroAddress) {
    throw new Error("The zero address is not allowed.");
  }
  if (options.forbidden?.some((item) => sameAddress(item, address))) {
    throw new Error("That address cannot be used for this action.");
  }
  return address;
}

export function parsePercentToBps(value: string, maximumBps: number): number {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,2})?$/.test(normalized)) {
    throw new Error("Enter a percentage with at most two decimal places.");
  }
  const [whole = "0", fraction = ""] = normalized.split(".");
  const bps = Number(BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0") || "0"));
  if (!Number.isSafeInteger(bps) || bps > maximumBps) {
    throw new Error(`The maximum permitted value is ${formatBps(maximumBps)}.`);
  }
  return bps;
}

export function parseUsdcAmount(value: string, maximum?: bigint): bigint {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(normalized)) {
    throw new Error("Enter a USDC amount with at most six decimals.");
  }
  const amount = parseUnits(normalized, 6);
  if (amount <= 0n) throw new Error("The amount must be greater than zero.");
  if (maximum !== undefined && amount > maximum) {
    throw new Error("The amount exceeds the live withdrawable surplus.");
  }
  return amount;
}

export function formatUsdc(value: bigint | null): string {
  return value === null ? "INSOLVENT" : `${formatUnits(value, 6)} USDC`;
}

export function formatBps(value: number): string {
  const percent = value / 100;
  return `${Number.isInteger(percent) ? percent.toFixed(0) : percent.toFixed(2)}%`;
}

export function shortAddress(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export function explorerAddress(releaseId: string, value: string): string {
  return `${getAdminReleaseContext(releaseId).manifest.chain.explorerUrl}/address/${value}`;
}

export function explorerTransaction(releaseId: string, value: string): string {
  return `${getAdminReleaseContext(releaseId).manifest.chain.explorerUrl}/tx/${value}`;
}

const activityAbi = [
  ...adminControllerAbi.filter((item) => item.type === "event"),
  ...adminMarketplaceAbi.filter((item) => item.type === "event"),
  ...adminRegistrarAbi.filter((item) => item.type === "event"),
] as const;

const activitySignatures = Array.from(new Set([
  "NameRegistered(string,bytes32,address,uint256,uint256,uint256)",
  "NameRenewed(string,bytes32,uint256,uint256)",
  "PermitConsumed(bytes32,address,uint256)",
  "ReferralAccrued(address,uint256)",
  "ReferralClaimed(address,uint256)",
  "TreasuryWithdrawal(address,uint256)",
  "PermitSignerProposed(address,address,uint64,uint64)",
  "PermitSignerChanged(address,address,uint64)",
  "PermitSignerRevoked(address,uint64)",
  "TreasuryChanged(address,address)",
  "ReferralBpsChanged(uint16,uint16)",
  "RegistrationPauseChanged(bool)",
  "Listed(uint256,address,uint256,uint64)",
  "ListingCancelled(uint256,address)",
  "ListingInvalidated(uint256,address)",
  "Purchased(uint256,address,address,uint256,uint256)",
  "ProceedsClaimed(address,uint256)",
  "FeeWithdrawal(address,uint256)",
  "FeeChangedEvent(uint16,uint16)",
  "PauseChanged(bool)",
  "ControllerChanged(address,bool)",
  "OwnershipTransferStarted(address,address)",
  "OwnershipTransferred(address,address)",
])).map((signature) => keccak256(toBytes(signature)));

export type AdminActivityCategory =
  | "registration"
  | "marketplace"
  | "treasury"
  | "signer"
  | "configuration"
  | "ownership";

export type AdminActivityItem = {
  id: string;
  releaseId: Hex;
  category: AdminActivityCategory;
  contract: AdminContractTarget;
  eventName: string;
  title: string;
  detail: string;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
};

export type AdminActivityData = {
  releaseId: Hex;
  events: AdminActivityItem[];
  scannedFromBlock: bigint;
  scannedToBlock: bigint;
  totalDecoded: number;
  hasOlder: boolean;
  eventLimitReached: boolean;
};

type RpcLog = {
  address?: unknown;
  topics?: unknown;
  data?: unknown;
  blockNumber?: unknown;
  transactionHash?: unknown;
  logIndex?: unknown;
};

function eventArgs(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function addressArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  return typeof value === "string" && isAddress(value) ? shortAddress(getAddress(value)) : "unknown";
}

function bigintArg(args: Record<string, unknown>, key: string): bigint {
  const value = args[key];
  return typeof value === "bigint" ? value : BigInt(typeof value === "number" ? value : 0);
}

export function describeAdminEvent(
  eventName: string,
  argsValue: unknown,
): { category: AdminActivityCategory; title: string; detail: string } {
  const args = eventArgs(argsValue);
  switch (eventName) {
    case "NameRegistered":
      return { category: "registration", title: "Name registered", detail: `${String(args.name ?? "Name")} registered to ${addressArg(args, "owner")} for ${formatUsdc(bigintArg(args, "baseCost") + bigintArg(args, "premium"))}.` };
    case "NameRenewed":
      return { category: "registration", title: "Name renewed", detail: `${String(args.name ?? "Name")} renewed for ${formatUsdc(bigintArg(args, "cost"))}.` };
    case "PermitConsumed":
      return { category: "registration", title: "Permit consumed", detail: `Requester ${addressArg(args, "requester")}; nonce ${bigintArg(args, "nonce")}.` };
    case "ReferralAccrued":
      return { category: "registration", title: "Referral accrued", detail: `${addressArg(args, "referrer")} accrued ${formatUsdc(bigintArg(args, "amount"))}.` };
    case "ReferralClaimed":
      return { category: "treasury", title: "Referral claimed", detail: `${addressArg(args, "referrer")} claimed ${formatUsdc(bigintArg(args, "amount"))}.` };
    case "Listed":
      return { category: "marketplace", title: "Name listed", detail: `Token ${bigintArg(args, "tokenId")} listed by ${addressArg(args, "seller")} for ${formatUsdc(bigintArg(args, "price"))}.` };
    case "Purchased":
      return { category: "marketplace", title: "Name purchased", detail: `${addressArg(args, "buyer")} paid ${formatUsdc(bigintArg(args, "price"))}; fee ${formatUsdc(bigintArg(args, "fee"))}.` };
    case "ListingCancelled":
      return { category: "marketplace", title: "Listing cancelled", detail: `Token ${bigintArg(args, "tokenId")} by ${addressArg(args, "seller")}.` };
    case "ListingInvalidated":
      return { category: "marketplace", title: "Listing invalidated", detail: `Stale token ${bigintArg(args, "tokenId")} listing removed.` };
    case "ProceedsClaimed":
      return { category: "treasury", title: "Seller proceeds claimed", detail: `${addressArg(args, "seller")} claimed ${formatUsdc(bigintArg(args, "amount"))}.` };
    case "TreasuryWithdrawal":
    case "FeeWithdrawal":
      return { category: "treasury", title: "Treasury withdrawal", detail: `${formatUsdc(bigintArg(args, "amount"))} sent to ${addressArg(args, "treasury")}.` };
    case "PermitSignerProposed":
      return { category: "signer", title: "Permit signer proposed", detail: `${addressArg(args, "pendingSigner")} becomes activatable at ${bigintArg(args, "validAfter")}.` };
    case "PermitSignerChanged":
      return { category: "signer", title: "Permit signer activated", detail: `${addressArg(args, "oldSigner")} → ${addressArg(args, "newSigner")}.` };
    case "PermitSignerRevoked":
      return { category: "signer", title: "Permit signer revoked", detail: `${addressArg(args, "oldSigner")} revoked at policy ${bigintArg(args, "policyVersion")}.` };
    case "TreasuryChanged":
      return { category: "treasury", title: "Treasury changed", detail: `${addressArg(args, "oldTreasury")} → ${addressArg(args, "newTreasury")}.` };
    case "ReferralBpsChanged":
      return { category: "configuration", title: "Referral rate changed", detail: `${formatBps(Number(args.oldReferralBps ?? 0))} → ${formatBps(Number(args.newReferralBps ?? 0))}.` };
    case "FeeChangedEvent":
      return { category: "configuration", title: "Marketplace fee changed", detail: `${formatBps(Number(args.oldFeeBps ?? 0))} → ${formatBps(Number(args.newFeeBps ?? 0))}.` };
    case "RegistrationPauseChanged":
      return { category: "configuration", title: "Registration status changed", detail: args.paused === true ? "New registrations paused." : "New registrations opened." };
    case "PauseChanged":
      return { category: "configuration", title: "Marketplace status changed", detail: args.paused === true ? "Listing and purchase paused." : "Marketplace opened." };
    case "ControllerChanged":
      return { category: "configuration", title: "Registrar controller changed", detail: `${addressArg(args, "controller")} ${args.enabled === true ? "enabled" : "disabled"}.` };
    case "OwnershipTransferStarted":
      return { category: "ownership", title: "Ownership transfer started", detail: `${addressArg(args, "previousOwner")} nominated ${addressArg(args, "newOwner")}.` };
    case "OwnershipTransferred":
      return { category: "ownership", title: "Ownership transferred", detail: `${addressArg(args, "previousOwner")} → ${addressArg(args, "newOwner")}.` };
    default:
      return { category: "configuration", title: eventName, detail: "Contract event confirmed on Arc Testnet." };
  }
}

function contractTarget(
  releaseId: string,
  address: Address,
): AdminContractTarget | null {
  const { controller, marketplace, registrar } =
    getAdminReleaseContext(releaseId);
  if (sameAddress(address, controller)) return "controller";
  if (sameAddress(address, marketplace)) return "marketplace";
  if (sameAddress(address, registrar)) return "registrar";
  return null;
}

function normalizeRpcLog(value: unknown): Required<RpcLog> | null {
  if (!value || typeof value !== "object") return null;
  const log = value as RpcLog;
  if (
    typeof log.address !== "string" || !isAddress(log.address) ||
    !Array.isArray(log.topics) || log.topics.length === 0 ||
    !log.topics.every((topic) => typeof topic === "string" && isHex(topic)) ||
    typeof log.data !== "string" || !isHex(log.data) ||
    typeof log.transactionHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash)
  ) return null;
  return log as Required<RpcLog>;
}

async function readLogsRange(
  provider: EthereumProvider,
  addresses: readonly Address[],
  fromBlock: bigint,
  toBlock: bigint,
  depth = 0,
): Promise<unknown[]> {
  try {
    const value = await walletReadRequest(provider, {
      method: "eth_getLogs",
      params: [{
        address: addresses,
        fromBlock: `0x${fromBlock.toString(16)}`,
        toBlock: `0x${toBlock.toString(16)}`,
        topics: [activitySignatures],
      }],
    });
    if (!Array.isArray(value)) throw new Error("The wallet returned invalid Arc logs.");
    return value;
  } catch (error) {
    if (!isAdminLogRangeLimitError(error) || fromBlock >= toBlock || depth >= 20) throw error;
    const midpoint = fromBlock + (toBlock - fromBlock) / 2n;
    const left = await readLogsRange(provider, addresses, fromBlock, midpoint, depth + 1);
    const right = await readLogsRange(provider, addresses, midpoint + 1n, toBlock, depth + 1);
    return [...left, ...right];
  }
}

export function isAdminLogRangeLimitError(error: unknown): boolean {
  const messages: string[] = [];
  const statuses = new Set<number>();
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];
  while (pending.length > 0 && seen.size < 12) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const value = current as {
      message?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      status?: unknown;
      statusCode?: unknown;
      cause?: unknown;
      data?: unknown;
    };
    for (const message of [value.message, value.shortMessage, value.details]) {
      if (typeof message === "string") messages.push(message);
    }
    for (const status of [value.status, value.statusCode]) {
      if (typeof status === "number") statuses.add(status);
    }
    pending.push(value.cause, value.data);
  }
  const details = messages.join(" ");
  if (statuses.has(429) || /(?:\b429\b|rate[ -]?limit|too many requests|request limit)/i.test(details)) {
    return false;
  }
  return /(?:block range|range too large|limit(?:ed)? to (?:a )?[\d,]+ (?:block )?range|too many (?:logs|results)|more than \d+ results|response size|query returned more than|result limit)/i.test(details);
}

export async function loadAdminActivity(
  provider: EthereumProvider,
  account: Address,
  releaseId: string,
  onProgress?: (completedTo: bigint, latest: bigint) => void,
  requestedToBlock?: bigint,
): Promise<AdminActivityData> {
  await assertArcWalletAccount(provider, account);
  const context = getAdminReleaseContext(releaseId);
  const { manifest, controller, marketplace, registrar } = context;
  const deploymentBlocks = [
    manifest.contracts.controller.deploymentBlock,
    manifest.contracts.marketplace.deploymentBlock,
    manifest.contracts.baseRegistrar.deploymentBlock,
  ].filter((value): value is number => value !== null);
  if (deploymentBlocks.length !== 3) throw new Error("Admin deployment blocks are incomplete.");
  const fromDeployment = BigInt(Math.min(...deploymentBlocks));
  const latestValue = await walletReadRequest(provider, { method: "eth_blockNumber" });
  const latest = parseQuantity(latestValue, "latest block number");
  const toBlock = requestedToBlock && requestedToBlock < latest ? requestedToBlock : latest;
  if (toBlock < fromDeployment) {
    return {
      releaseId: context.releaseId,
      events: [],
      scannedFromBlock: fromDeployment,
      scannedToBlock: fromDeployment,
      totalDecoded: 0,
      hasOlder: false,
      eventLimitReached: false,
    };
  }
  const rawLogs: unknown[] = [];
  const outerRange = 9_500n;
  const activityBlockWindow = 200_000n;
  const windowStart = toBlock - fromDeployment + 1n > activityBlockWindow
    ? toBlock - activityBlockWindow + 1n
    : fromDeployment;
  for (let from = windowStart; from <= toBlock; from += outerRange) {
    const to = from + outerRange - 1n > toBlock ? toBlock : from + outerRange - 1n;
    rawLogs.push(...await readLogsRange(provider, [controller, marketplace, registrar], from, to));
    onProgress?.(to, toBlock);
    if (to < toBlock) await new Promise((resolve) => setTimeout(resolve, 500));
  }

  const decoded = rawLogs.flatMap((raw): AdminActivityItem[] => {
    const log = normalizeRpcLog(raw);
    if (!log) return [];
    const address = getAddress(log.address as string);
    const target = contractTarget(releaseId, address);
    if (!target) return [];
    try {
      const event = decodeEventLog({
        abi: activityAbi,
        data: log.data as Hex,
        topics: log.topics as [Hex, ...Hex[]],
        strict: true,
      });
      if (!event.eventName) return [];
      const blockNumber = parseQuantity(log.blockNumber, "event block number");
      const logIndex = Number(parseQuantity(log.logIndex, "event log index"));
      const description = describeAdminEvent(event.eventName, event.args);
      return [{
        id: `${log.transactionHash}:${logIndex}`,
        releaseId: context.releaseId,
        category: description.category,
        contract: target,
        eventName: event.eventName,
        title: description.title,
        detail: description.detail,
        blockNumber,
        transactionHash: log.transactionHash as Hex,
        logIndex,
      }];
    } catch {
      return [];
    }
  });

  decoded.sort((left, right) => {
    if (left.blockNumber !== right.blockNumber) return left.blockNumber > right.blockNumber ? -1 : 1;
    return right.logIndex - left.logIndex;
  });
  const maximumEvents = 1_000;
  return {
    releaseId: context.releaseId,
    events: decoded.slice(0, maximumEvents),
    scannedFromBlock: windowStart,
    scannedToBlock: toBlock,
    totalDecoded: decoded.length,
    hasOlder: windowStart > fromDeployment,
    eventLimitReached: decoded.length > maximumEvents,
  };
}
