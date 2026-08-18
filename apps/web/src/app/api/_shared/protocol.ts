import { type Address } from "viem";
import {
  CONTRACT_KEYS,
  deploymentManifestDigest,
  type ContractKey,
  type DeploymentManifest,
} from "@contour/config";
import {
  baseRegistrarAbi,
  controllerAbi,
  erc20Abi,
  marketplaceAbi,
  publicResolverAbi,
  registryAbi,
  reverseRegistrarAbi,
  universalResolverAbi,
  type NameRecord,
} from "@contour/sdk";
import { getDeploymentManifest } from "../../../lib/manifest";
import { getSharedProtocolClient } from "../../../lib/protocol-client";

export const ABI_KEYS = [
  ...CONTRACT_KEYS,
  "erc20",
] as const;

export type AbiKey = (typeof ABI_KEYS)[number];

export const PROTOCOL_ABIS = {
  registry: registryAbi,
  baseRegistrar: baseRegistrarAbi,
  controller: controllerAbi,
  publicResolver: publicResolverAbi,
  reverseRegistrar: reverseRegistrarAbi,
  universalResolver: universalResolverAbi,
  marketplace: marketplaceAbi,
  erc20: erc20Abi,
} as const;

export function protocolContext(manifest: DeploymentManifest = getDeploymentManifest()) {
  return {
    schemaVersion: manifest.schemaVersion,
    manifestSha256: deploymentManifestDigest(manifest),
    state: manifest.state,
    releaseId: manifest.releaseId,
    chain: {
      id: manifest.chain.id,
      caip2: manifest.chain.caip2,
      explorerUrl: manifest.chain.explorerUrl,
      confirmations: manifest.chain.confirmations,
    },
    namespace: manifest.namespace,
    settlement: manifest.settlement,
    contracts: Object.fromEntries(
      CONTRACT_KEYS.map((key) => [key, manifest.contracts[key].address]),
    ) as Record<ContractKey, Address | null>,
  };
}

/** Reuses the lazy RPC-backed SDK client so successful chain identity checks are
 * shared by warm API reads. Builds still never initialize a transport. */
export function createReadClient(manifest: DeploymentManifest = getDeploymentManifest()) {
  return getSharedProtocolClient(manifest).names;
}

export function serializeNameRecord(record: NameRecord) {
  return {
    releaseId: record.releaseId,
    name: record.name,
    node: record.node,
    tokenId: record.tokenId.toString(),
    registryOwner: record.registryOwner,
    registrant: record.registrant,
    resolver: record.resolver,
    resolvedAddress: record.resolvedAddress,
    contentHash: record.contentHash,
    expiry: record.expiry?.toString() ?? null,
    available: record.available,
  };
}

export function parseAbiKey(segment: string): AbiKey | null {
  const candidate = segment.endsWith(".json") ? segment.slice(0, -5) : segment;
  return ABI_KEYS.find((key) => key === candidate) ?? null;
}

export function abiArtifact(key: AbiKey, manifest: DeploymentManifest = getDeploymentManifest()) {
  if (key === "erc20") {
    return {
      schemaVersion: "1.0.0",
      abiScope: "sdk-surface",
      contractName: "USDC",
      key,
      chainId: manifest.chain.id,
      address: manifest.settlement.erc20Address,
      abi: PROTOCOL_ABIS[key],
    };
  }
  const deployment = manifest.contracts[key];
  return {
    schemaVersion: "1.0.0",
    abiScope: "sdk-surface",
    contractName: key,
    key,
    chainId: manifest.chain.id,
    address: deployment.address,
    deploymentBlock: deployment.deploymentBlock,
    sourceVerified: deployment.sourceVerified,
    evidence: {
      abiUrl: deployment.abiUrl,
      abiSha256: deployment.abiSha256,
      sourceVerificationUrl: deployment.sourceVerificationUrl,
    },
    abi: PROTOCOL_ABIS[key],
  };
}
