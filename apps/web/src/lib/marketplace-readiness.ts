import "server-only";

import {
  createPublicClient,
  getAddress,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import type { DeploymentManifest } from "@contour/config";
import { arcTestnet } from "@/lib/network";
import { coalesceArcRpcRead, rateLimitedArcHttp } from "./arc-rpc";

const readinessMarketplaceAbi = parseAbi([
  "function registrar() view returns (address)",
  "function settlementAsset() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function treasury() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function paused() view returns (bool)",
]);

export const MARKETPLACE_READINESS_REASONS = [
  "EXECUTION_SURFACE_DISABLED",
  "MANIFEST_NOT_ACTIVE",
  "MANIFEST_POLICY_INCOMPLETE",
  "MANIFEST_POLICY_NOT_OPEN",
  "ARC_CHAIN_MISMATCH",
  "MARKETPLACE_RUNTIME_MISMATCH",
  "MARKETPLACE_REGISTRAR_MISMATCH",
  "MARKETPLACE_SETTLEMENT_MISMATCH",
  "MARKETPLACE_OWNER_MISMATCH",
  "MARKETPLACE_PENDING_OWNER",
  "MARKETPLACE_TREASURY_MISMATCH",
  "MARKETPLACE_FEE_POLICY_MISMATCH",
  "MARKETPLACE_PAUSED",
  "ARC_RPC_UNAVAILABLE",
  "READINESS_DEPENDENCY_UNAVAILABLE",
] as const;

export type MarketplaceReadinessReason =
  (typeof MARKETPLACE_READINESS_REASONS)[number];

export type MarketplaceReadiness = {
  ready: boolean;
  reasons: MarketplaceReadinessReason[];
  releaseId: Hex | null;
  chainId: number | null;
  marketplace: Address | null;
  asOfBlock: string | null;
  paused: boolean | null;
  feeBps: number | null;
};

type MarketplaceReadinessClient = ReturnType<typeof createPublicClient>;

function sameAddress(left: unknown, right: Address): boolean {
  if (typeof left !== "string") return false;
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function manifestAddress(value: string | null): Address | null {
  if (!value) return null;
  try {
    return getAddress(value);
  } catch {
    return null;
  }
}

function baseReadiness(
  manifest: DeploymentManifest | null,
  reason: MarketplaceReadinessReason,
): MarketplaceReadiness {
  return {
    ready: false,
    reasons: [reason],
    releaseId: manifest?.releaseId ?? null,
    chainId: null,
    marketplace: manifestAddress(manifest?.contracts.marketplace.address ?? null),
    asOfBlock: null,
    paused: null,
    feeBps: null,
  };
}

export function unavailableMarketplaceReadiness(
  manifest: DeploymentManifest | null,
  reason: MarketplaceReadinessReason,
): MarketplaceReadiness {
  return baseReadiness(manifest, reason);
}

/** Creates the Arc RPC client lazily so `next build` never opens a transport. */
function createMarketplaceReadinessClient(
  manifest: DeploymentManifest,
): MarketplaceReadinessClient {
  return createPublicClient({
    chain: arcTestnet,
    batch: { multicall: { wait: 25 } },
    transport: rateLimitedArcHttp(manifest.chain.rpcUrl),
  });
}

async function readMarketplaceReadinessUncoalesced(
  manifest: DeploymentManifest,
): Promise<MarketplaceReadiness> {
  if (manifest.state !== "active") {
    return baseReadiness(manifest, "MANIFEST_NOT_ACTIVE");
  }

  const marketplace = manifestAddress(manifest.contracts.marketplace.address);
  const registrar = manifestAddress(manifest.contracts.baseRegistrar.address);
  const governance = manifestAddress(manifest.activationEvidence.governance.account);
  const settlementAsset = manifestAddress(manifest.settlement.erc20Address);
  const expectedRuntimeCodeHash = manifest.contracts.marketplace.runtimeCodeHash;
  const expectedFeeBps = manifest.activationEvidence.marketplacePolicy.feeBps;
  if (
    !marketplace ||
    !registrar ||
    !governance ||
    !settlementAsset ||
    !expectedRuntimeCodeHash ||
    expectedFeeBps === null
  ) {
    return baseReadiness(manifest, "MANIFEST_POLICY_INCOMPLETE");
  }
  if (manifest.activationEvidence.marketplacePolicy.paused !== false) {
    return baseReadiness(manifest, "MANIFEST_POLICY_NOT_OPEN");
  }

  try {
    const client = createMarketplaceReadinessClient(manifest);
    const chainId = await client.getChainId();
    if (chainId !== manifest.chain.id) {
      return {
        ...baseReadiness(manifest, "ARC_CHAIN_MISMATCH"),
        chainId,
      };
    }

    const latestBlock = await client.getBlockNumber();
    const confirmationDepth = BigInt(Math.max(1, manifest.chain.confirmations));
    if (latestBlock + 1n < confirmationDepth) {
      return baseReadiness(manifest, "ARC_RPC_UNAVAILABLE");
    }
    const asOfBlock = latestBlock - confirmationDepth + 1n;
    const [
      runtimeCode,
      observedRegistrar,
      observedSettlementAsset,
      observedOwner,
      observedPendingOwner,
      observedTreasury,
      observedFeeBps,
      observedPaused,
    ] = await Promise.all([
      client.getCode({ address: marketplace, blockNumber: asOfBlock }),
      client.readContract({
        address: marketplace,
        abi: readinessMarketplaceAbi,
        functionName: "registrar",
        blockNumber: asOfBlock,
      }),
      client.readContract({
        address: marketplace,
        abi: readinessMarketplaceAbi,
        functionName: "settlementAsset",
        blockNumber: asOfBlock,
      }),
      client.readContract({
        address: marketplace,
        abi: readinessMarketplaceAbi,
        functionName: "owner",
        blockNumber: asOfBlock,
      }),
      client.readContract({
        address: marketplace,
        abi: readinessMarketplaceAbi,
        functionName: "pendingOwner",
        blockNumber: asOfBlock,
      }),
      client.readContract({
        address: marketplace,
        abi: readinessMarketplaceAbi,
        functionName: "treasury",
        blockNumber: asOfBlock,
      }),
      client.readContract({
        address: marketplace,
        abi: readinessMarketplaceAbi,
        functionName: "feeBps",
        blockNumber: asOfBlock,
      }),
      client.readContract({
        address: marketplace,
        abi: readinessMarketplaceAbi,
        functionName: "paused",
        blockNumber: asOfBlock,
      }),
    ]);

    const feeBps = Number(observedFeeBps);
    const paused = observedPaused === true;
    const reasons: MarketplaceReadinessReason[] = [];
    if (
      !runtimeCode ||
      runtimeCode === "0x" ||
      keccak256(runtimeCode).toLowerCase() !== expectedRuntimeCodeHash.toLowerCase()
    ) {
      reasons.push("MARKETPLACE_RUNTIME_MISMATCH");
    }
    if (!sameAddress(observedRegistrar, registrar)) {
      reasons.push("MARKETPLACE_REGISTRAR_MISMATCH");
    }
    if (!sameAddress(observedSettlementAsset, settlementAsset)) {
      reasons.push("MARKETPLACE_SETTLEMENT_MISMATCH");
    }
    if (!sameAddress(observedOwner, governance)) {
      reasons.push("MARKETPLACE_OWNER_MISMATCH");
    }
    if (!sameAddress(observedPendingOwner, zeroAddress)) {
      reasons.push("MARKETPLACE_PENDING_OWNER");
    }
    if (!sameAddress(observedTreasury, governance)) {
      reasons.push("MARKETPLACE_TREASURY_MISMATCH");
    }
    if (!Number.isSafeInteger(feeBps) || feeBps !== expectedFeeBps) {
      reasons.push("MARKETPLACE_FEE_POLICY_MISMATCH");
    }
    if (observedPaused !== false) {
      reasons.push("MARKETPLACE_PAUSED");
    }

    return {
      ready: reasons.length === 0,
      reasons,
      releaseId: manifest.releaseId,
      chainId,
      marketplace,
      asOfBlock: asOfBlock.toString(),
      paused,
      feeBps: Number.isSafeInteger(feeBps) ? feeBps : null,
    };
  } catch {
    return baseReadiness(manifest, "ARC_RPC_UNAVAILABLE");
  }
}

export function readMarketplaceReadiness(
  manifest: DeploymentManifest,
): Promise<MarketplaceReadiness> {
  const key = [
    "marketplace-readiness",
    manifest.chain.rpcUrl,
    manifest.releaseId,
    manifest.activationEvidence.verifiedAtBlock,
    manifest.activationEvidence.marketplacePolicy.paused,
    manifest.activationEvidence.marketplacePolicy.feeBps,
    manifest.contracts.marketplace.runtimeCodeHash,
  ].join(":");
  return coalesceArcRpcRead(key, () => readMarketplaceReadinessUncoalesced(manifest));
}
