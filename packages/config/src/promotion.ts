import {
  createPublicClient,
  decodeEventLog,
  encodeAbiParameters,
  getAddress,
  http,
  isAddress,
  keccak256,
  namehash,
  parseAbi,
  parseAbiItem,
  parseAbiParameters,
  recoverMessageAddress,
  sha256,
  toEventSelector,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { ARC_TESTNET, ARC_TESTNET_CHAIN_ID, ARC_TESTNET_EXPLORER_URL } from "./chain.js";
import {
  ACTIVATION_ARTIFACT_KEYS,
  CANONICAL_NFT_METADATA_BASE_URI,
  CONTRACT_KEYS,
  ERC721_METADATA_INTERFACE_ID,
  assertDeploymentManifest,
  deploymentManifestDigest,
  promotionSubjectDigest,
  registrarVersionOf,
  type ActivationArtifactKey,
  type ContractKey,
  type DeploymentManifest,
  type HashedEvidenceArtifact,
  type LegacyReleaseReference,
} from "./manifest.js";

const ZERO_NODE = `0x${"00".repeat(32)}` as Hex;
const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
const MAX_ISSUER_HEALTH_BYTES = 64 * 1024;
const IMPLICIT_EVIDENCE_HOSTS = ["testnet.arcscan.app"] as const;

const registryAbi = parseAbi(["function owner(bytes32 node) view returns (address)"]);
const registrarAbi = parseAbi([
  "function registry() view returns (address)",
  "function baseNode() view returns (bytes32)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function controllers(address controller) view returns (bool)",
  "function metadataBaseURI() view returns (string)",
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
]);
const controllerAbi = parseAbi([
  "function registrar() view returns (address)",
  "function settlementAsset() view returns (address)",
  "function publicResolver() view returns (address)",
  "function baseNode() view returns (bytes32)",
  "function releaseId() view returns (bytes32)",
  "function normalizationProfileHash() view returns (bytes32)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function permitSigner() view returns (address)",
  "function pendingPermitSigner() view returns (address)",
  "function pendingPermitSignerValidAfter() view returns (uint64)",
  "function signerPolicyVersion() view returns (uint64)",
  "function treasury() view returns (address)",
  "function referralBps() view returns (uint16)",
  "function registrationsPaused() view returns (bool)",
]);
const publicResolverAbi = parseAbi(["function registry() view returns (address)"]);
const reverseRegistrarAbi = parseAbi([
  "function registry() view returns (address)",
  "function defaultResolver() view returns (address)",
  "function registrar() view returns (address)",
  "function reverseNode() view returns (bytes32)",
  "function baseNode() view returns (bytes32)",
  "function suffix() view returns (string)",
]);
const universalResolverAbi = parseAbi([
  "function registry() view returns (address)",
  "function reverseRegistrar() view returns (address)",
]);
const marketplaceAbi = parseAbi([
  "function registrar() view returns (address)",
  "function settlementAsset() view returns (address)",
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function treasury() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function paused() view returns (bool)",
]);
const controllerChangedEvent = parseAbiItem(
  "event ControllerChanged(address indexed controller, bool enabled)",
);
const controllerChangedTopic = toEventSelector(controllerChangedEvent);

const REQUIRED_ABI_FUNCTIONS: Readonly<Record<ContractKey, readonly string[]>> = Object.freeze({
  registry: ["owner(bytes32)", "resolver(bytes32)", "setSubnodeOwner(bytes32,bytes32,address)"],
  baseRegistrar: ["registry()", "baseNode()", "owner()", "pendingOwner()", "controllers(address)", "register(uint256,address,uint256,address,bytes[])"],
  controller: [
    "registrar()", "settlementAsset()", "publicResolver()", "baseNode()", "releaseId()",
    "normalizationProfileHash()", "owner()", "pendingOwner()", "permitSigner()", "pendingPermitSigner()",
    "pendingPermitSignerValidAfter()", "signerPolicyVersion()", "treasury()",
    "referralBps()", "registrationsPaused()",
  ],
  publicResolver: ["registry()", "supportsInterface(bytes4)", "clearRecords(bytes32)"],
  reverseRegistrar: ["registry()", "defaultResolver()", "registrar()", "reverseNode()", "baseNode()", "suffix()"],
  universalResolver: ["registry()", "reverseRegistrar()"],
  marketplace: ["registrar()", "settlementAsset()", "owner()", "pendingOwner()", "treasury()", "feeBps()", "paused()"],
});

const VERIFIED_SOURCE_SETTINGS = Object.freeze({
  compilerVersion: "v0.8.24+commit.e11b9ed9",
  optimizerRuns: 10_000,
  evmVersion: "cancun",
});

const VERIFIED_CONTRACT_IDENTITIES: Readonly<Record<ContractKey, { name: string; filePath: string }>> = Object.freeze({
  registry: { name: "ArcNameRegistry", filePath: "src/ArcNameRegistry.sol" },
  baseRegistrar: { name: "ArcBaseRegistrar", filePath: "src/ArcBaseRegistrar.sol" },
  controller: { name: "ArcRegistrarController", filePath: "src/ArcRegistrarController.sol" },
  publicResolver: { name: "ArcPublicResolver", filePath: "src/ArcPublicResolver.sol" },
  reverseRegistrar: { name: "ArcReverseRegistrar", filePath: "src/ArcReverseRegistrar.sol" },
  universalResolver: { name: "ArcUniversalResolver", filePath: "src/ArcUniversalResolver.sol" },
  marketplace: { name: "ArcNameMarketplace", filePath: "src/ArcNameMarketplace.sol" },
});

const V2_REGISTRAR_IDENTITY = Object.freeze({
  name: "ArcBaseRegistrarV2",
  filePath: "src/ArcBaseRegistrarV2.sol",
});

export function requiredContractAbiFunctions(
  manifest: DeploymentManifest,
  key: ContractKey,
): readonly string[] {
  const required = REQUIRED_ABI_FUNCTIONS[key];
  if (key !== "baseRegistrar" || registrarVersionOf(manifest) !== "v2") return required;
  return [
    ...required,
    "metadataBaseURI()",
    "supportsInterface(bytes4)",
    "tokenURI(uint256)",
  ];
}

function verifiedContractIdentity(
  manifest: DeploymentManifest,
  key: ContractKey,
): { name: string; filePath: string } {
  if (key === "baseRegistrar" && registrarVersionOf(manifest) === "v2") {
    return V2_REGISTRAR_IDENTITY;
  }
  return VERIFIED_CONTRACT_IDENTITIES[key];
}

export interface PromotionVerifierOptions {
  publicClient?: PublicClient;
  rpcUrl?: string;
  fetcher?: typeof fetch;
  /** Exact operator-approved evidence/ABI/issuer hostnames. ArcScan is implicit. */
  allowedFetchHosts?: readonly string[];
  /** Optional DNS preflight used by the Node CLI to reject rebinding to non-public space. */
  resolveHostname?: (hostname: string) => Promise<readonly string[]>;
  /** Reviewed reproducible-build output, keyed by each canonical contract role. */
  approvedContractRuntimeCodeHashes?: Readonly<Partial<Record<ContractKey, Hex>>>;
  /** Independent human/release-bot reviewers allowed to sign live PASS envelopes. */
  approvedReviewerAddresses?: readonly Address[];
  /** Optional Basic authorization for a private-candidate issuer health
   * endpoint. It is never attached to evidence, explorer, ABI or RPC requests
   * and requires privateCandidateOrigin. Public Arc releases do not use it. */
  issuerHealthAuthorization?: string;
  /**
   * Exact, operator-approved HTTPS origin of an unaliased private candidate.
   * Required whenever issuerHealthAuthorization is present. The verifier keeps
   * the canonical issuer path from the manifest and replaces only its origin.
   */
  privateCandidateOrigin?: string;
  /**
   * Explicitly verifies a product-live target against the preceding protected
   * private candidate. Only the two rollout-phase flags may differ; every
   * release, chain, signer and policy field remains exact.
   */
  allowAuthenticatedPrivateCandidateSource?: boolean;
}

export type IssuerHealthPayloadMode = "exact-release" | "authenticated-private-candidate-source";

export interface PromotionVerificationReport {
  ok: true;
  productLive: boolean;
  chainId: typeof ARC_TESTNET_CHAIN_ID;
  latestBlock: string;
  verifiedAtBlock: string;
  contracts: Record<ContractKey, { address: Address; deploymentBlock: number; runtimeCodeHash: Hex }>;
  artifacts: ActivationArtifactKey[];
  governanceAccount: Address;
  governanceBalance: string;
  permitSigner: Address;
  issuerReady: boolean;
  controllerHistory: ControllerHistoryVerificationReport;
  legacyReleases: LegacyReleaseVerificationReport[];
}

export interface LegacyReleaseVerificationReport {
  releaseId: Hex;
  referenceVerifiedAtBlock: string;
  verificationBlock: string;
  contracts: Record<ContractKey, {
    address: Address;
    deploymentBlock: number;
    runtimeCodeHash: Hex;
  }>;
  registrationsPaused: true;
  marketplacePaused: false;
}

function fail(message: string): never {
  throw new Error(`promotion verification failed: ${message}`);
}

function address(manifest: DeploymentManifest, key: ContractKey): Address {
  const value = manifest.contracts[key].address;
  if (!value) fail(`${key} address is missing`);
  return getAddress(value);
}

function equalAddress(actual: Address, expected: Address, field: string): void {
  if (getAddress(actual) !== getAddress(expected)) fail(`${field} address mismatch`);
}

export function assertRegistrarMetadataState(
  manifest: DeploymentManifest,
  metadataBaseURI: unknown,
  supportsMetadataInterface: unknown,
): void {
  if (registrarVersionOf(manifest) !== "v2") return;
  if (
    typeof metadataBaseURI !== "string" ||
    metadataBaseURI !== CANONICAL_NFT_METADATA_BASE_URI ||
    metadataBaseURI !== manifest.nftMetadata?.metadataBaseURI
  ) {
    fail("registrar metadata base URI mismatch");
  }
  if (supportsMetadataInterface !== true) {
    fail("registrar does not support the ERC-721 Metadata interface");
  }
}

/**
 * Re-verifies the retained V1 release at one current, explicitly pinned block.
 * Every runtime and every identity/policy read uses the same block so a live
 * PASS cannot combine observations from different chain states.
 */
export async function verifyLegacyReleaseAtBlock(
  client: Pick<PublicClient, "getCode" | "readContract">,
  manifest: DeploymentManifest,
  reference: LegacyReleaseReference,
  blockNumber: bigint,
): Promise<LegacyReleaseVerificationReport> {
  if (registrarVersionOf(manifest) !== "v2") {
    fail("legacy release verification requires a canonical V2 manifest");
  }
  if (blockNumber < BigInt(reference.verifiedAtBlock)) {
    fail("legacy release reference verification block is ahead of the pinned current block");
  }

  const contracts = {} as LegacyReleaseVerificationReport["contracts"];
  await Promise.all(CONTRACT_KEYS.map(async (key) => {
    const expected = reference.contracts[key];
    const contractAddress = getAddress(expected.address);
    const code = await client.getCode({ address: contractAddress, blockNumber });
    if (!code || code === "0x") fail(`legacy ${key} runtime code is missing`);
    if (keccak256(code).toLowerCase() !== expected.runtimeCodeHash.toLowerCase()) {
      fail(`legacy ${key} runtime code hash mismatch`);
    }
    contracts[key] = {
      address: contractAddress,
      deploymentBlock: expected.deploymentBlock,
      runtimeCodeHash: expected.runtimeCodeHash,
    };
  }));

  const registry = getAddress(reference.contracts.registry.address);
  const registrar = getAddress(reference.contracts.baseRegistrar.address);
  const controller = getAddress(reference.contracts.controller.address);
  const publicResolver = getAddress(reference.contracts.publicResolver.address);
  const reverseRegistrar = getAddress(reference.contracts.reverseRegistrar.address);
  const universalResolver = getAddress(reference.contracts.universalResolver.address);
  const marketplace = getAddress(reference.contracts.marketplace.address);
  const reverseNode = namehash("addr.reverse");
  const [
    registrarRegistry,
    registrarBaseNode,
    controllerRegistrar,
    controllerAsset,
    controllerResolver,
    controllerBaseNode,
    controllerRelease,
    controllerNormalization,
    registrationsPaused,
    resolverRegistry,
    reverseRegistry,
    reverseDefaultResolver,
    reverseBaseRegistrar,
    configuredReverseNode,
    reverseBaseNode,
    reverseSuffix,
    universalRegistry,
    universalReverseRegistrar,
    marketRegistrar,
    marketAsset,
    marketPaused,
  ] = await Promise.all([
    client.readContract({
      address: registrar,
      abi: registrarAbi,
      functionName: "registry",
      blockNumber,
    }),
    client.readContract({
      address: registrar,
      abi: registrarAbi,
      functionName: "baseNode",
      blockNumber,
    }),
    client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "registrar",
      blockNumber,
    }),
    client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "settlementAsset",
      blockNumber,
    }),
    client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "publicResolver",
      blockNumber,
    }),
    client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "baseNode",
      blockNumber,
    }),
    client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "releaseId",
      blockNumber,
    }),
    client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "normalizationProfileHash",
      blockNumber,
    }),
    client.readContract({
      address: controller,
      abi: controllerAbi,
      functionName: "registrationsPaused",
      blockNumber,
    }),
    client.readContract({
      address: publicResolver,
      abi: publicResolverAbi,
      functionName: "registry",
      blockNumber,
    }),
    client.readContract({
      address: reverseRegistrar,
      abi: reverseRegistrarAbi,
      functionName: "registry",
      blockNumber,
    }),
    client.readContract({
      address: reverseRegistrar,
      abi: reverseRegistrarAbi,
      functionName: "defaultResolver",
      blockNumber,
    }),
    client.readContract({
      address: reverseRegistrar,
      abi: reverseRegistrarAbi,
      functionName: "registrar",
      blockNumber,
    }),
    client.readContract({
      address: reverseRegistrar,
      abi: reverseRegistrarAbi,
      functionName: "reverseNode",
      blockNumber,
    }),
    client.readContract({
      address: reverseRegistrar,
      abi: reverseRegistrarAbi,
      functionName: "baseNode",
      blockNumber,
    }),
    client.readContract({
      address: reverseRegistrar,
      abi: reverseRegistrarAbi,
      functionName: "suffix",
      blockNumber,
    }),
    client.readContract({
      address: universalResolver,
      abi: universalResolverAbi,
      functionName: "registry",
      blockNumber,
    }),
    client.readContract({
      address: universalResolver,
      abi: universalResolverAbi,
      functionName: "reverseRegistrar",
      blockNumber,
    }),
    client.readContract({
      address: marketplace,
      abi: marketplaceAbi,
      functionName: "registrar",
      blockNumber,
    }),
    client.readContract({
      address: marketplace,
      abi: marketplaceAbi,
      functionName: "settlementAsset",
      blockNumber,
    }),
    client.readContract({
      address: marketplace,
      abi: marketplaceAbi,
      functionName: "paused",
      blockNumber,
    }),
  ]);

  equalAddress(registrarRegistry, registry, "legacy registrar registry");
  if (registrarBaseNode !== manifest.namespace.baseNode) fail("legacy registrar base node mismatch");
  equalAddress(controllerRegistrar, registrar, "legacy controller registrar");
  equalAddress(controllerAsset, manifest.settlement.erc20Address, "legacy controller settlement asset");
  equalAddress(controllerResolver, publicResolver, "legacy controller public resolver");
  if (controllerBaseNode !== manifest.namespace.baseNode) fail("legacy controller base node mismatch");
  if (
    typeof controllerRelease !== "string" ||
    controllerRelease.toLowerCase() !== reference.releaseId.toLowerCase()
  ) {
    fail("legacy controller release ID mismatch");
  }
  if (controllerNormalization !== manifest.normalization.profileHash) {
    fail("legacy controller normalization profile mismatch");
  }
  if (
    registrationsPaused !== true ||
    registrationsPaused !== reference.controllerPolicy.registrationsPaused
  ) {
    fail("legacy controller registrations must be paused");
  }
  equalAddress(resolverRegistry, registry, "legacy public resolver registry");
  equalAddress(reverseRegistry, registry, "legacy reverse registrar registry");
  equalAddress(
    reverseDefaultResolver,
    publicResolver,
    "legacy reverse registrar default resolver",
  );
  equalAddress(reverseBaseRegistrar, registrar, "legacy reverse registrar base registrar");
  if (
    configuredReverseNode !== reverseNode ||
    reverseBaseNode !== manifest.namespace.baseNode ||
    reverseSuffix !== manifest.namespace.suffix
  ) {
    fail("legacy reverse registrar namespace wiring mismatch");
  }
  equalAddress(universalRegistry, registry, "legacy universal resolver registry");
  equalAddress(
    universalReverseRegistrar,
    reverseRegistrar,
    "legacy universal resolver reverse registrar",
  );
  equalAddress(marketRegistrar, registrar, "legacy marketplace registrar");
  equalAddress(marketAsset, manifest.settlement.erc20Address, "legacy marketplace settlement asset");
  if (marketPaused !== false || marketPaused !== reference.marketplacePolicy.paused) {
    fail("legacy marketplace must remain unpaused");
  }

  return {
    releaseId: reference.releaseId,
    referenceVerifiedAtBlock: reference.verifiedAtBlock.toString(),
    verificationBlock: blockNumber.toString(),
    contracts,
    registrationsPaused: true,
    marketplacePaused: false,
  };
}

function ipv4Octets(hostname: string): number[] | null {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^[0-9]{1,3}$/.test(part))) return null;
  const octets = parts.map(Number);
  return octets.some((part) => part > 255) ? null : octets;
}

function mappedIpv4Octets(value: string): number[] | null {
  if (!value.startsWith("::ffff:")) return null;
  const suffix = value.slice(7);
  const dotted = ipv4Octets(suffix);
  if (dotted) return dotted;
  const words = suffix.split(":");
  if (words.length !== 2 || words.some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null;
  const high = Number.parseInt(words[0]!, 16);
  const low = Number.parseInt(words[1]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

export function isNonPublicPromotionAddress(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    normalized === "localhost" || normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") || normalized.endsWith(".internal")
  ) return true;
  if (normalized.includes(":")) {
    const mapped = mappedIpv4Octets(normalized);
    if (mapped) return isNonPublicPromotionAddress(mapped.join("."));
    return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
      normalized.startsWith("fd") || /^fe[89ab]/.test(normalized) ||
      normalized.startsWith("ff") || normalized.startsWith("2001:db8:") ||
      normalized === "2001:db8::";
  }
  const octets = ipv4Octets(normalized);
  if (!octets) return false;
  const [a = 0, b = 0] = octets;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0)
  );
}

/** Rejects literal and special-use destinations before any promotion fetch. */
export function isForbiddenPromotionHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return normalized.includes(":") || ipv4Octets(normalized) !== null || isNonPublicPromotionAddress(normalized);
}

function normalizeAllowedHost(hostname: string): string {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (!normalized || normalized.includes(":") || normalized.includes("/") || isForbiddenPromotionHost(normalized)) {
    fail(`invalid evidence hostname allowlist entry: ${hostname}`);
  }
  return normalized;
}

export function assertAllowedPromotionUrl(url: string | URL, allowedFetchHosts: readonly string[] = []): URL {
  let parsed: URL;
  try { parsed = typeof url === "string" ? new URL(url) : new URL(url.href); }
  catch { fail(`invalid promotion fetch URL: ${String(url)}`); }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash ||
    (parsed.port && parsed.port !== "443") || isForbiddenPromotionHost(hostname)
  ) fail(`promotion fetch URL is not safe: ${parsed.href}`);
  const allowed = new Set([...IMPLICIT_EVIDENCE_HOSTS, ...allowedFetchHosts.map(normalizeAllowedHost)]);
  if (!allowed.has(hostname)) fail(`promotion fetch hostname is not operator-allowlisted: ${hostname}`);
  return parsed;
}

export async function assertPublicPromotionResolution(
  url: URL,
  resolveHostname: PromotionVerifierOptions["resolveHostname"],
): Promise<void> {
  if (!resolveHostname) return;
  const addresses = await resolveHostname(url.hostname);
  if (addresses.length === 0 || addresses.some((value) => {
    const normalized = value.replace(/^\[|\]$/g, "");
    const isAddress = normalized.includes(":") || ipv4Octets(normalized) !== null;
    return !isAddress || isNonPublicPromotionAddress(normalized);
  })) {
    fail(`promotion fetch hostname did not resolve exclusively to public addresses: ${url.hostname}`);
  }
}

export interface ControllerChangeEvidence {
  controller: Address;
  enabled: boolean;
}

export interface ControllerHistoryBlockRange {
  fromBlock: bigint;
  toBlock: bigint;
}

const MAX_CONTROLLER_HISTORY_BLOCKS_PER_QUERY = 1_000n;

/**
 * Reads registrar controller history in deterministic, sequential ranges.
 * Each inclusive range contains at most 1,000 blocks to keep public Arc RPC
 * eth_getLogs queries conservatively below endpoint quota pressure. The
 * caller-provided toBlock remains the final bound for every calculation; this
 * helper never observes a moving chain head.
 *
 * @internal
 */
export async function readControllerHistoryInChunks<T>(
  fromBlock: bigint,
  toBlock: bigint,
  readChunk: (range: ControllerHistoryBlockRange) => Promise<readonly T[]>,
): Promise<T[]> {
  if (fromBlock < 0n || toBlock < 0n || fromBlock > toBlock) {
    fail("registrar controller history block range is invalid");
  }

  const results: T[] = [];
  let start = fromBlock;
  while (start <= toBlock) {
    const maximumEnd = start + MAX_CONTROLLER_HISTORY_BLOCKS_PER_QUERY - 1n;
    const end = maximumEnd < toBlock ? maximumEnd : toBlock;
    const chunk = await readChunk({ fromBlock: start, toBlock: end });
    results.push(...chunk);
    start = end + 1n;
  }
  return results;
}

const ARCSCAN_CONTROLLER_LOG_PAGE_SIZE = 100;
const ARCSCAN_CONTROLLER_LOG_MAX_PAGES = 50;
const ARCSCAN_CONTROLLER_LOG_MAX_PAGE_BYTES = 512 * 1024;

interface IndexedControllerChange {
  address: Address;
  blockNumber: bigint;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  data: Hex;
  topics: [Hex, Hex];
  change: ControllerChangeEvidence;
}

interface VerifiedIndexedControllerChange extends IndexedControllerChange {
  blockHash: Hex;
}

export interface ControllerHistoryVerificationReport {
  source: "arcscan-index-canonical-rpc";
  eventCount: number;
  eventDigest: Hex;
  firstBlock: string;
  lastBlock: string;
}

export interface IndexedControllerHistoryVerificationOptions {
  client: Pick<PublicClient, "getBlock" | "getTransactionReceipt" | "readContract">;
  fetcher: typeof fetch;
  explorerUrl: string;
  registrar: Address;
  canonicalController: Address;
  governanceAccount: Address;
  fromBlock: bigint;
  toBlock: bigint;
  resolveHostname?: PromotionVerifierOptions["resolveHostname"];
}

function arcScanQuantity(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    fail(`ArcScan controller history ${field} is not an exact quantity`);
  }
  const parsed = BigInt(value);
  if (parsed < 0n) fail(`ArcScan controller history ${field} is negative`);
  return parsed;
}

function arcScanIndex(value: unknown, field: string): number {
  const parsed = arcScanQuantity(value, field);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`ArcScan controller history ${field} exceeds the safe integer range`);
  }
  return Number(parsed);
}

function arcScanHash(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail(`ArcScan controller history ${field} is not bytes32`);
  }
  return value as Hex;
}

function parseArcScanControllerLog(
  value: unknown,
  registrar: Address,
  fromBlock: bigint,
  toBlock: bigint,
): IndexedControllerChange {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ArcScan controller history row is not an object");
  }
  const row = value as Record<string, unknown>;
  if (typeof row.address !== "string" || !isAddress(row.address)) {
    fail("ArcScan controller history row address is invalid");
  }
  const logAddress = getAddress(row.address);
  if (logAddress !== getAddress(registrar)) {
    fail("ArcScan controller history row address does not match the registrar");
  }
  if (
    !Array.isArray(row.topics) || row.topics.length !== 4 ||
    typeof row.topics[0] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.topics[0]) ||
    typeof row.topics[1] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.topics[1]) ||
    row.topics[2] !== null || row.topics[3] !== null
  ) {
    fail("ArcScan controller history row topics are malformed");
  }
  const topics = [row.topics[0], row.topics[1]] as [Hex, Hex];
  if (topics[0].toLowerCase() !== controllerChangedTopic.toLowerCase()) {
    fail("ArcScan controller history row event selector mismatch");
  }
  if (typeof row.data !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(row.data)) {
    fail("ArcScan controller history row data is malformed");
  }
  const data = row.data as Hex;
  const blockNumber = arcScanQuantity(row.blockNumber, "blockNumber");
  if (blockNumber < fromBlock || blockNumber > toBlock) {
    fail("ArcScan controller history row is outside the pinned block range");
  }
  const transactionHash = arcScanHash(row.transactionHash, "transactionHash");
  const transactionIndex = arcScanIndex(row.transactionIndex, "transactionIndex");
  const logIndex = arcScanIndex(row.logIndex, "logIndex");
  let decoded: ReturnType<typeof decodeEventLog<typeof controllerChangedEvent[]>>;
  try {
    decoded = decodeEventLog({
      abi: [controllerChangedEvent],
      data,
      topics,
      strict: true,
    });
  } catch {
    fail("ArcScan controller history row does not strictly decode as ControllerChanged");
  }
  if (!decoded.args.controller || typeof decoded.args.enabled !== "boolean") {
    fail("ArcScan controller history row decoded arguments are incomplete");
  }
  return {
    address: logAddress,
    blockNumber,
    transactionHash,
    transactionIndex,
    logIndex,
    data,
    topics,
    change: {
      controller: getAddress(decoded.args.controller),
      enabled: decoded.args.enabled,
    },
  };
}

function parseArcScanControllerPage(
  bytes: Uint8Array,
  registrar: Address,
  fromBlock: bigint,
  toBlock: bigint,
): IndexedControllerChange[] {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail("ArcScan controller history response is not JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("ArcScan controller history response is not an object");
  }
  const response = value as Record<string, unknown>;
  if (!Array.isArray(response.result)) {
    fail("ArcScan controller history response result is not an array");
  }
  if (response.result.length > ARCSCAN_CONTROLLER_LOG_PAGE_SIZE) {
    fail("ArcScan controller history page exceeds the requested result bound");
  }
  const status = response.status;
  const message = typeof response.message === "string" ? response.message.trim() : "";
  const successful = status === "1" && message === "OK";
  const empty = response.result.length === 0 && status === "0" &&
    (message === "No logs found" || message === "No records found");
  if ((!successful && !empty) || (response.result.length > 0 && !successful)) {
    fail("ArcScan controller history response has ambiguous status semantics");
  }
  return response.result.map((row) => parseArcScanControllerLog(row, registrar, fromBlock, toBlock));
}

function controllerHistoryOrder(left: IndexedControllerChange, right: IndexedControllerChange): number {
  if (left.blockNumber !== right.blockNumber) return left.blockNumber < right.blockNumber ? -1 : 1;
  if (left.transactionIndex !== right.transactionIndex) return left.transactionIndex - right.transactionIndex;
  return left.logIndex - right.logIndex;
}

function assertSameHex(actual: string | null, expected: Hex, field: string): void {
  if (!actual || actual.toLowerCase() !== expected.toLowerCase()) {
    fail(`canonical RPC controller history ${field} mismatch`);
  }
}

async function verifyIndexedControllerChange(
  client: IndexedControllerHistoryVerificationOptions["client"],
  indexed: IndexedControllerChange,
  registrar: Address,
  governanceAccount: Address,
): Promise<Hex> {
  const receipt = await client.getTransactionReceipt({ hash: indexed.transactionHash });
  if (
    receipt.status !== "success" || receipt.blockNumber !== indexed.blockNumber ||
    receipt.transactionIndex !== indexed.transactionIndex
  ) {
    fail("canonical RPC controller history transaction receipt mismatch");
  }
  assertSameHex(receipt.transactionHash, indexed.transactionHash, "receipt transaction hash");
  if (!receipt.to || getAddress(receipt.to) !== getAddress(registrar)) {
    fail("canonical RPC controller history receipt target mismatch");
  }
  if (getAddress(receipt.from) !== getAddress(governanceAccount)) {
    fail("canonical RPC controller history receipt sender mismatch");
  }
  const matchingLogs = receipt.logs.filter((log) => log.logIndex === indexed.logIndex);
  if (matchingLogs.length !== 1) {
    fail("canonical RPC controller history receipt does not contain one exact log index");
  }
  const log = matchingLogs[0]!;
  if (
    log.removed || log.blockNumber !== indexed.blockNumber ||
    log.transactionIndex !== indexed.transactionIndex || log.logIndex !== indexed.logIndex ||
    getAddress(log.address) !== indexed.address || log.data.toLowerCase() !== indexed.data.toLowerCase() ||
    log.topics.length !== indexed.topics.length ||
    log.topics.some((topic, index) => topic.toLowerCase() !== indexed.topics[index]!.toLowerCase())
  ) {
    fail("canonical RPC controller history receipt log mismatch");
  }
  assertSameHex(log.transactionHash, indexed.transactionHash, "log transaction hash");
  assertSameHex(log.blockHash, receipt.blockHash, "log block hash");
  const block = await client.getBlock({ blockNumber: indexed.blockNumber });
  if (block.number !== indexed.blockNumber) {
    fail("canonical RPC controller history block number mismatch");
  }
  assertSameHex(block.hash, receipt.blockHash, "block hash");
  return receipt.blockHash;
}

function controllerHistoryDigest(events: readonly VerifiedIndexedControllerChange[]): Hex {
  const canonical = events.map((event) => [
    event.blockNumber.toString(),
    event.transactionIndex.toString(),
    event.logIndex.toString(),
    event.blockHash.toLowerCase(),
    event.transactionHash.toLowerCase(),
    event.change.controller.toLowerCase(),
    event.change.enabled ? "1" : "0",
  ].join(":"));
  return sha256(new TextEncoder().encode(canonical.join("\n")));
}

/**
 * Uses ArcScan only to discover the bounded event set. Every discovered row is
 * then cross-checked against its canonical Arc RPC receipt, exact receipt log,
 * containing block and pinned controller state before history policy is
 * evaluated. A short final ArcScan page is the explicit pagination terminator.
 *
 * ArcScan remains a completeness oracle: canonical RPC prevents forged rows,
 * but a selectively omitted otherwise-valid event cannot be detected without
 * a full RPC range scan. Ambiguous pagination or an empty history fails closed.
 */
export async function verifyIndexedControllerHistory(
  options: IndexedControllerHistoryVerificationOptions,
): Promise<ControllerHistoryVerificationReport> {
  const {
    client, fetcher, registrar, canonicalController, governanceAccount,
    fromBlock, toBlock, resolveHostname,
  } = options;
  if (fromBlock < 0n || toBlock < 0n || fromBlock > toBlock) {
    fail("indexed registrar controller history block range is invalid");
  }
  let explorer: URL;
  try { explorer = new URL(options.explorerUrl); }
  catch { fail("indexed registrar controller history explorer URL is invalid"); }
  const canonicalExplorer = new URL(ARC_TESTNET_EXPLORER_URL);
  if (
    explorer.origin !== canonicalExplorer.origin || explorer.pathname !== canonicalExplorer.pathname ||
    explorer.search || explorer.hash || explorer.username || explorer.password
  ) {
    fail("indexed registrar controller history must use the canonical ArcScan API");
  }

  const discovered: IndexedControllerChange[] = [];
  const transactionLogKeys = new Set<string>();
  const blockLogKeys = new Set<string>();
  let complete = false;
  for (let page = 1; page <= ARCSCAN_CONTROLLER_LOG_MAX_PAGES; page += 1) {
    const endpoint = new URL("/api", explorer);
    endpoint.searchParams.set("module", "logs");
    endpoint.searchParams.set("action", "getLogs");
    endpoint.searchParams.set("fromBlock", fromBlock.toString());
    endpoint.searchParams.set("toBlock", toBlock.toString());
    endpoint.searchParams.set("address", getAddress(registrar));
    endpoint.searchParams.set("topic0", controllerChangedTopic);
    endpoint.searchParams.set("page", page.toString());
    endpoint.searchParams.set("offset", ARCSCAN_CONTROLLER_LOG_PAGE_SIZE.toString());
    endpoint.searchParams.set("sort", "asc");
    const policy: EvidenceFetchPolicy = {
      allowedFetchHosts: [],
      ...(resolveHostname ? { resolveHostname } : {}),
    };
    const bytes = await fetchBounded(
      fetcher,
      endpoint,
      policy,
      ARCSCAN_CONTROLLER_LOG_MAX_PAGE_BYTES,
    );
    const rows = parseArcScanControllerPage(bytes, registrar, fromBlock, toBlock);
    for (const row of rows) {
      const transactionLogKey = `${row.transactionHash.toLowerCase()}:${row.logIndex}`;
      const blockLogKey = `${row.blockNumber}:${row.logIndex}`;
      if (transactionLogKeys.has(transactionLogKey) || blockLogKeys.has(blockLogKey)) {
        fail("ArcScan controller history contains a duplicate event");
      }
      const previous = discovered.at(-1);
      if (previous && controllerHistoryOrder(previous, row) >= 0) {
        fail("ArcScan controller history is not strictly ordered");
      }
      transactionLogKeys.add(transactionLogKey);
      blockLogKeys.add(blockLogKey);
      discovered.push(row);
    }
    if (rows.length < ARCSCAN_CONTROLLER_LOG_PAGE_SIZE) {
      complete = true;
      break;
    }
  }
  if (!complete) fail("ArcScan controller history pagination exceeded its safety bound");
  if (discovered.length === 0) fail("ArcScan controller history is empty");

  const canonical = getAddress(canonicalController);
  const initial = discovered[0]!;
  if (!initial.change.enabled || initial.change.controller !== canonical) {
    fail("initial registrar controller event does not enable the canonical controller");
  }
  const verified: VerifiedIndexedControllerChange[] = [];
  for (const event of discovered) {
    const blockHash = await verifyIndexedControllerChange(client, event, registrar, governanceAccount);
    verified.push({ ...event, blockHash });
  }
  assertExclusiveControllerHistory(discovered.map((event) => event.change), canonical);
  const currentlyEnabled = await client.readContract({
    address: registrar,
    abi: registrarAbi,
    functionName: "controllers",
    args: [canonical],
    blockNumber: toBlock,
  });
  if (currentlyEnabled !== true) {
    fail("canonical registrar controller is not enabled at the pinned latest block");
  }
  return {
    source: "arcscan-index-canonical-rpc",
    eventCount: discovered.length,
    eventDigest: controllerHistoryDigest(verified),
    firstBlock: discovered[0]!.blockNumber.toString(),
    lastBlock: discovered.at(-1)!.blockNumber.toString(),
  };
}

export function assertExclusiveControllerHistory(
  changes: readonly ControllerChangeEvidence[],
  canonicalController: Address,
): void {
  const canonical = getAddress(canonicalController).toLowerCase();
  const enabled = new Set<string>();
  for (const change of changes) {
    const changedController = getAddress(change.controller).toLowerCase();
    if (change.enabled && changedController !== canonical) {
      fail(`non-canonical registrar controller ${change.controller} was enabled`);
    }
    if (change.enabled) enabled.add(changedController);
    else enabled.delete(changedController);
  }
  if (enabled.size !== 1 || !enabled.has(canonical)) {
    fail("registrar controller history does not end with exactly the canonical controller enabled");
  }
}

async function verifyExclusiveRegistrarController(
  client: PublicClient,
  fetcher: typeof fetch,
  explorerUrl: string,
  registrar: Address,
  canonicalController: Address,
  governanceAccount: Address,
  fromBlock: bigint,
  toBlock: bigint,
  resolveHostname: PromotionVerifierOptions["resolveHostname"],
): Promise<ControllerHistoryVerificationReport> {
  return verifyIndexedControllerHistory({
    client,
    fetcher,
    explorerUrl,
    registrar,
    canonicalController,
    governanceAccount,
    fromBlock,
    toBlock,
    ...(resolveHostname ? { resolveHostname } : {}),
  });
}

async function readBoundedBody(response: Response, maximum: number, field: string): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > maximum)) {
    fail(`${field} declared body is too large or invalid`);
  }
  if (!response.body) fail(`${field} response has no body`);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximum) {
      await reader.cancel("bounded promotion response exceeded limit");
      fail(`${field} body is too large`);
    }
    chunks.push(value);
  }
  if (length === 0) fail(`${field} body is empty`);
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

interface EvidenceFetchPolicy {
  allowedFetchHosts: readonly string[];
  resolveHostname?: PromotionVerifierOptions["resolveHostname"];
}

interface ScopedFetchAuthorization {
  value: string;
  origin: string;
}

async function fetchBounded(
  fetcher: typeof fetch,
  url: string | URL,
  policy: EvidenceFetchPolicy,
  maximum = MAX_ARTIFACT_BYTES,
  authorization?: ScopedFetchAuthorization,
): Promise<Uint8Array> {
  const safeUrl = assertAllowedPromotionUrl(url, policy.allowedFetchHosts);
  if (authorization && safeUrl.origin !== authorization.origin) {
    fail("issuer health authorization target escaped the private candidate origin");
  }
  await assertPublicPromotionResolution(safeUrl, policy.resolveHostname);
  const headers: Record<string, string> = {
    accept: "application/json,text/plain;q=0.9,*/*;q=0.1",
  };
  if (authorization) {
    headers.authorization = authorization.value;
  }
  const response = await fetcher(safeUrl, {
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail(`evidence fetch returned ${response.status} for ${safeUrl.href}`);
  return readBoundedBody(response, maximum, `promotion response ${safeUrl.href}`);
}

async function verifyArtifact(
  fetcher: typeof fetch,
  artifact: HashedEvidenceArtifact,
  field: string,
  policy: EvidenceFetchPolicy,
): Promise<Uint8Array> {
  if (!artifact.url || !artifact.sha256) fail(`${field} is incomplete`);
  const bytes = await fetchBounded(fetcher, artifact.url, policy);
  if (sha256(bytes).toLowerCase() !== artifact.sha256.toLowerCase()) {
    fail(`${field} SHA-256 mismatch`);
  }
  return bytes;
}

export type SignedPassArtifact = "fundedEndToEnd" | "operationsDrill";

export interface SignedPassEnvelope {
  schemaVersion: "1.1.0";
  artifact: SignedPassArtifact;
  verdict: "PASS";
  chainId: typeof ARC_TESTNET_CHAIN_ID;
  releaseId: Hex;
  promotionSubjectSha256: Hex;
  verifiedAtBlock: number;
  evidenceBlock: number;
  runReportUrl: string;
  runReportSha256: Hex;
  reviewer: Address;
  signature: Hex;
}

export interface PromotionRunTransaction {
  id: string;
  hash: Hex;
  blockNumber: number;
  from: Address;
  to: Address;
}

interface PromotionRunAssertion {
  id: string;
  verdict: "PASS";
  source: "receipt" | "rpc" | "http" | "operator";
  expected: string;
  actual: string;
}

interface RegistrationActivationSmokeBinding {
  schemaVersion: "1.0.0";
  artifact: "registrationActivationSmoke";
  candidateManifestSha256: Hex;
  candidateVerifiedAtBlock: number;
  evidenceBlock: number;
  evidenceBlockHash: Hex;
  registrant: Address;
  registrationTransactionHash: Hex;
  reportSha256: Hex;
}

interface PromotionRunReport {
  schemaVersion: "1.0.0";
  artifact: SignedPassArtifact;
  verdict: "PASS";
  chainId: typeof ARC_TESTNET_CHAIN_ID;
  releaseId: Hex;
  promotionSubjectSha256: Hex;
  verifiedAtBlock: number;
  evidenceBlock: number;
  generatedAt: string;
  transactions: PromotionRunTransaction[];
  assertions: PromotionRunAssertion[];
  registrationActivationSmoke?: RegistrationActivationSmokeBinding;
  redactions: {
    privateKeys: false;
    challengeSecrets: false;
    walletSignatures: false;
    permitSignatures: false;
  };
}

export interface SignedPassVerificationOptions {
  publicClient: Pick<PublicClient, "getBlock" | "getTransactionReceipt">;
  fetcher?: typeof fetch;
  allowedFetchHosts?: readonly string[];
  resolveHostname?: PromotionVerifierOptions["resolveHostname"];
}

const RUN_TRANSACTION_TARGETS: Readonly<Record<SignedPassArtifact, Readonly<Record<string, ContractKey | "settlement">>>> = Object.freeze({
  fundedEndToEnd: Object.freeze({
    registrationUsdcApproval: "settlement",
    registration: "controller",
    sellerNftApproval: "baseRegistrar",
    firstListing: "marketplace",
    firstCancellation: "marketplace",
    secondListing: "marketplace",
    buyerUsdcApproval: "settlement",
    purchase: "marketplace",
    sellerClaimProceeds: "marketplace",
    buyerNftApproval: "baseRegistrar",
    buyerRelisting: "marketplace",
    buyerDirectTransfer: "baseRegistrar",
    listingInvalidation: "marketplace",
  }),
  operationsDrill: Object.freeze({
    controllerPause: "controller",
    controllerUnpause: "controller",
    marketplacePause: "marketplace",
    marketplaceUnpause: "marketplace",
  }),
});

const RUN_ASSERTIONS: Readonly<Record<SignedPassArtifact, readonly string[]>> = Object.freeze({
  fundedEndToEnd: Object.freeze([
    "registrationPermitConsumed",
    "registrationNonceIncremented",
    "registrationSettlementExact",
    "registrarOwner",
    "registryOwner",
    "resolverAddress",
    "marketplacePurchase",
    "sellerProceedsClaimed",
    "marketplaceLiability",
    "marketplaceSolvent",
    "staleListingInvalidated",
  ]),
  operationsDrill: Object.freeze([
    "registrationReadinessClosed",
    "registrationReadinessRecovered",
    "marketplaceReadinessClosed",
    "marketplaceReadinessRecovered",
    "rollbackRepaused",
  ]),
});

export const V2_FUNDED_METADATA_ASSERTION_IDS = Object.freeze([
  "erc721MetadataInterface",
  "nftTokenUri",
  "nftMetadataDocument",
  "nftImageDocument",
] as const);

const V2_FUNDED_METADATA_ASSERTION_SOURCES: Readonly<Record<
  (typeof V2_FUNDED_METADATA_ASSERTION_IDS)[number],
  PromotionRunAssertion["source"]
>> = Object.freeze({
  erc721MetadataInterface: "rpc",
  nftTokenUri: "rpc",
  nftMetadataDocument: "http",
  nftImageDocument: "http",
});

export function requiredPromotionRunAssertionIds(
  manifest: Pick<DeploymentManifest, "registrarVersion">,
  artifact: SignedPassArtifact,
): readonly string[] {
  if (artifact === "fundedEndToEnd" && registrarVersionOf(manifest) === "v2") {
    return Object.freeze([
      ...RUN_ASSERTIONS.fundedEndToEnd,
      ...V2_FUNDED_METADATA_ASSERTION_IDS,
    ]);
  }
  return RUN_ASSERTIONS[artifact];
}

function exactKeys(value: object, expected: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.join(",") !== required.join(",")) fail(`${field} has unexpected fields`);
}

function isNonZeroBytes32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value) && !/^0x0{64}$/i.test(value);
}

async function verifyRegistrationActivationSmokeBinding(
  report: PromotionRunReport,
  manifest: DeploymentManifest,
  client: SignedPassVerificationOptions["publicClient"],
): Promise<void> {
  const binding = report.registrationActivationSmoke;
  if (!binding || typeof binding !== "object" || Array.isArray(binding)) {
    fail("fundedEndToEnd registration activation smoke binding is missing");
  }
  exactKeys(binding, [
    "artifact", "candidateManifestSha256", "candidateVerifiedAtBlock", "evidenceBlock",
    "evidenceBlockHash", "registrant", "registrationTransactionHash", "reportSha256",
    "schemaVersion",
  ], "fundedEndToEnd registration activation smoke binding");
  if (
    binding.schemaVersion !== "1.0.0" || binding.artifact !== "registrationActivationSmoke" ||
    !isNonZeroBytes32(binding.candidateManifestSha256) ||
    !isNonZeroBytes32(binding.evidenceBlockHash) ||
    !isNonZeroBytes32(binding.registrationTransactionHash) ||
    !isNonZeroBytes32(binding.reportSha256) ||
    !isAddress(binding.registrant) ||
    !Number.isSafeInteger(binding.candidateVerifiedAtBlock) || binding.candidateVerifiedAtBlock <= 0 ||
    !Number.isSafeInteger(binding.evidenceBlock) ||
    binding.evidenceBlock < binding.candidateVerifiedAtBlock ||
    binding.evidenceBlock >= report.verifiedAtBlock
  ) fail("fundedEndToEnd registration activation smoke binding is invalid");

  const predecessor = structuredClone(manifest);
  predecessor.activationEvidence.productLive = false;
  predecessor.activationEvidence.verifiedAtBlock = binding.candidateVerifiedAtBlock;
  predecessor.activationEvidence.marketplacePolicy.paused = true;
  predecessor.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
  predecessor.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
  if (
    deploymentManifestDigest(predecessor).toLowerCase() !==
    binding.candidateManifestSha256.toLowerCase()
  ) fail("fundedEndToEnd registration activation smoke predecessor digest mismatch");

  let receipt: Awaited<ReturnType<SignedPassVerificationOptions["publicClient"]["getTransactionReceipt"]>>;
  try {
    receipt = await client.getTransactionReceipt({ hash: binding.registrationTransactionHash });
  } catch {
    fail("fundedEndToEnd registration activation smoke receipt is unavailable");
  }
  if (
    receipt.status !== "success" ||
    receipt.blockNumber <= BigInt(binding.candidateVerifiedAtBlock) ||
    receipt.blockNumber > BigInt(binding.evidenceBlock) ||
    getAddress(receipt.from) !== getAddress(binding.registrant) ||
    !receipt.to || getAddress(receipt.to) !== expectedRunTarget(manifest, "controller")
  ) fail("fundedEndToEnd registration activation smoke receipt mismatch");

  let evidenceBlock: Awaited<ReturnType<SignedPassVerificationOptions["publicClient"]["getBlock"]>>;
  try {
    evidenceBlock = await client.getBlock({ blockNumber: BigInt(binding.evidenceBlock) });
  } catch {
    fail("fundedEndToEnd registration activation smoke evidence block is unavailable");
  }
  if (
    evidenceBlock.number !== BigInt(binding.evidenceBlock) ||
    evidenceBlock.hash?.toLowerCase() !== binding.evidenceBlockHash.toLowerCase()
  ) fail("fundedEndToEnd registration activation smoke evidence block mismatch");
}

function expectedRunTarget(
  manifest: DeploymentManifest,
  target: ContractKey | "settlement",
): Address {
  return target === "settlement"
    ? getAddress(manifest.settlement.erc20Address)
    : address(manifest, target);
}

async function verifyPromotionRunReport(
  bytes: Uint8Array,
  artifact: SignedPassArtifact,
  envelope: SignedPassEnvelope,
  manifest: DeploymentManifest,
  latestBlock: bigint,
  client: SignedPassVerificationOptions["publicClient"],
): Promise<void> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail(`${artifact} run report is not valid JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${artifact} run report is not a JSON object`);
  }
  const report = value as PromotionRunReport;
  const expectedReportKeys = [
    "artifact", "assertions", "chainId", "evidenceBlock", "generatedAt",
    "promotionSubjectSha256", "redactions", "releaseId", "schemaVersion",
    "transactions", "verdict", "verifiedAtBlock",
  ];
  if (artifact === "fundedEndToEnd") expectedReportKeys.push("registrationActivationSmoke");
  exactKeys(report, expectedReportKeys, `${artifact} run report`);
  const generatedAt = typeof report.generatedAt === "string" ? Date.parse(report.generatedAt) : Number.NaN;
  if (
    report.schemaVersion !== "1.0.0" || report.artifact !== artifact || report.verdict !== "PASS" ||
    report.chainId !== envelope.chainId || report.releaseId !== envelope.releaseId ||
    report.promotionSubjectSha256?.toLowerCase() !== envelope.promotionSubjectSha256.toLowerCase() ||
    report.verifiedAtBlock !== envelope.verifiedAtBlock || report.evidenceBlock !== envelope.evidenceBlock ||
    !Number.isFinite(generatedAt) || new Date(generatedAt).toISOString() !== report.generatedAt ||
    !Array.isArray(report.transactions) || !Array.isArray(report.assertions)
  ) fail(`${artifact} run report is not bound to its signed envelope`);

  if (!report.redactions || typeof report.redactions !== "object" || Array.isArray(report.redactions)) {
    fail(`${artifact} run report redaction declaration is missing`);
  }
  exactKeys(report.redactions, [
    "challengeSecrets", "permitSignatures", "privateKeys", "walletSignatures",
  ], `${artifact} run report redactions`);
  if (
    report.redactions.privateKeys !== false || report.redactions.challengeSecrets !== false ||
    report.redactions.walletSignatures !== false || report.redactions.permitSignatures !== false
  ) fail(`${artifact} run report must exclude all secret and signature material`);

  if (artifact === "fundedEndToEnd") {
    await verifyRegistrationActivationSmokeBinding(report, manifest, client);
  }

  const targetMap = RUN_TRANSACTION_TARGETS[artifact];
  const requiredTransactionIds = Object.keys(targetMap).sort();
  const transactionIds = report.transactions.map((transaction) => transaction?.id).sort();
  if (transactionIds.join(",") !== requiredTransactionIds.join(",")) {
    fail(`${artifact} run report transaction coverage is incomplete`);
  }
  const reviewer = getAddress(envelope.reviewer);
  const governance = manifest.activationEvidence.governance.account
    ? getAddress(manifest.activationEvidence.governance.account)
    : null;
  await Promise.all(report.transactions.map(async (transaction) => {
    if (!transaction || typeof transaction !== "object" || Array.isArray(transaction)) {
      fail(`${artifact} run report contains a malformed transaction`);
    }
    exactKeys(transaction, ["blockNumber", "from", "hash", "id", "to"], `${artifact} run transaction`);
    const target = targetMap[transaction.id];
    if (
      !target || !/^0x[0-9a-fA-F]{64}$/.test(transaction.hash) ||
      !Number.isSafeInteger(transaction.blockNumber) || transaction.blockNumber <= envelope.verifiedAtBlock ||
      transaction.blockNumber > envelope.evidenceBlock || BigInt(transaction.blockNumber) > latestBlock ||
      !isAddress(transaction.from) || !isAddress(transaction.to)
    ) fail(`${artifact} run report contains an invalid transaction binding`);
    const from = getAddress(transaction.from);
    const to = getAddress(transaction.to);
    if (to !== expectedRunTarget(manifest, target)) {
      fail(`${artifact} ${transaction.id} transaction target mismatch`);
    }
    if (from === reviewer) fail(`${artifact} reviewer is not independent from run transaction senders`);
    if (governance && reviewer === governance) fail(`${artifact} reviewer is not independent from governance`);
    let receipt: Awaited<ReturnType<SignedPassVerificationOptions["publicClient"]["getTransactionReceipt"]>>;
    try { receipt = await client.getTransactionReceipt({ hash: transaction.hash }); }
    catch { fail(`${artifact} ${transaction.id} transaction receipt is unavailable`); }
    if (
      receipt.status !== "success" || receipt.blockNumber !== BigInt(transaction.blockNumber) ||
      !receipt.to || getAddress(receipt.to) !== to || getAddress(receipt.from) !== from
    ) fail(`${artifact} ${transaction.id} transaction receipt mismatch`);
  }));

  const requiredAssertions = [...requiredPromotionRunAssertionIds(manifest, artifact)].sort();
  const assertionIds = report.assertions.map((assertion) => assertion?.id).sort();
  if (assertionIds.join(",") !== requiredAssertions.join(",")) {
    fail(`${artifact} run report assertion coverage is incomplete`);
  }
  for (const assertion of report.assertions) {
    if (!assertion || typeof assertion !== "object" || Array.isArray(assertion)) {
      fail(`${artifact} run report contains a malformed assertion`);
    }
    exactKeys(assertion, ["actual", "expected", "id", "source", "verdict"], `${artifact} run assertion`);
    if (
      assertion.verdict !== "PASS" ||
      !["receipt", "rpc", "http", "operator"].includes(assertion.source) ||
      typeof assertion.expected !== "string" || assertion.expected.length === 0 || assertion.expected.length > 512 ||
      typeof assertion.actual !== "string" || assertion.actual.length === 0 || assertion.actual.length > 512
    ) fail(`${artifact} run report contains an invalid PASS assertion`);
    if (
      artifact === "fundedEndToEnd" &&
      registrarVersionOf(manifest) === "v2" &&
      Object.hasOwn(V2_FUNDED_METADATA_ASSERTION_SOURCES, assertion.id) &&
      assertion.source !== V2_FUNDED_METADATA_ASSERTION_SOURCES[
        assertion.id as keyof typeof V2_FUNDED_METADATA_ASSERTION_SOURCES
      ]
    ) {
      fail(`fundedEndToEnd ${assertion.id} assertion source mismatch`);
    }
  }
}

export function promotionPassMessage(envelope: Omit<SignedPassEnvelope, "signature">): string {
  return [
    "Contour Promotion Evidence v1",
    `artifact:${envelope.artifact}`,
    `verdict:${envelope.verdict}`,
    `chainId:${envelope.chainId}`,
    `releaseId:${envelope.releaseId}`,
    `promotionSubjectSha256:${envelope.promotionSubjectSha256}`,
    `verifiedAtBlock:${envelope.verifiedAtBlock}`,
    `evidenceBlock:${envelope.evidenceBlock}`,
    `runReportUrl:${envelope.runReportUrl}`,
    `runReportSha256:${envelope.runReportSha256}`,
    `reviewer:${getAddress(envelope.reviewer)}`,
  ].join("\n");
}

export async function verifySignedPassEnvelope(
  bytes: Uint8Array,
  artifact: SignedPassArtifact,
  manifest: DeploymentManifest,
  latestBlock: bigint,
  approvedReviewers: readonly Address[] | undefined,
  options: SignedPassVerificationOptions,
): Promise<Address> {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail(`${artifact} is not a signed JSON PASS envelope`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${artifact} is not a signed JSON PASS envelope`);
  }
  const envelope = value as SignedPassEnvelope;
  const keys = Object.keys(envelope).sort();
  const expectedKeys = [
    "artifact", "chainId", "evidenceBlock", "promotionSubjectSha256", "releaseId",
    "reviewer", "runReportSha256", "runReportUrl", "schemaVersion", "signature", "verdict",
    "verifiedAtBlock",
  ].sort();
  if (keys.join(",") !== expectedKeys.join(",")) fail(`${artifact} PASS envelope has unexpected fields`);
  if (
    envelope.schemaVersion !== "1.1.0" || envelope.artifact !== artifact || envelope.verdict !== "PASS" ||
    envelope.chainId !== ARC_TESTNET_CHAIN_ID || envelope.releaseId !== manifest.releaseId ||
    envelope.promotionSubjectSha256?.toLowerCase() !== promotionSubjectDigest(manifest).toLowerCase() ||
    envelope.verifiedAtBlock !== manifest.activationEvidence.verifiedAtBlock ||
    !Number.isSafeInteger(envelope.evidenceBlock) ||
    envelope.evidenceBlock < manifest.activationEvidence.verifiedAtBlock! ||
    BigInt(envelope.evidenceBlock) > latestBlock || !isAddress(envelope.reviewer) ||
    typeof envelope.runReportUrl !== "string" ||
    !/^0x[0-9a-fA-F]{64}$/.test(envelope.runReportSha256) ||
    !/^0x[0-9a-fA-F]{130}$/.test(envelope.signature)
  ) fail(`${artifact} PASS envelope is not bound to this live release`);
  const allowed = new Set((approvedReviewers ?? []).map((address) => getAddress(address).toLowerCase()));
  const reviewer = getAddress(envelope.reviewer);
  if (allowed.size === 0 || !allowed.has(reviewer.toLowerCase())) {
    fail(`${artifact} reviewer is not independently approved`);
  }
  const { signature: _signature, ...unsigned } = envelope;
  const recovered = await recoverMessageAddress({
    message: promotionPassMessage(unsigned),
    signature: envelope.signature,
  });
  if (getAddress(recovered) !== reviewer) fail(`${artifact} reviewer signature mismatch`);
  const fetchPolicy: EvidenceFetchPolicy = {
    allowedFetchHosts: options.allowedFetchHosts ?? [],
    ...(options.resolveHostname ? { resolveHostname: options.resolveHostname } : {}),
  };
  const reportBytes = await fetchBounded(options.fetcher ?? fetch, envelope.runReportUrl, fetchPolicy);
  if (sha256(reportBytes).toLowerCase() !== envelope.runReportSha256.toLowerCase()) {
    fail(`${artifact} run report SHA-256 mismatch`);
  }
  await verifyPromotionRunReport(
    reportBytes,
    artifact,
    envelope,
    manifest,
    latestBlock,
    options.publicClient,
  );
  return reviewer;
}

function abiSignatures(value: unknown): Set<string> {
  const object = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const abi = Array.isArray(value) ? value : object && Array.isArray(object.abi) ? object.abi : null;
  if (!abi) fail("published ABI is not a JSON ABI array");
  const signatures = new Set<string>();
  for (const item of abi) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (record.type !== "function" || typeof record.name !== "string" || !Array.isArray(record.inputs)) continue;
    const inputs: string[] = [];
    for (const input of record.inputs) {
      if (!input || typeof input !== "object" || typeof (input as Record<string, unknown>).type !== "string") {
        fail(`published ABI has an invalid input for ${record.name}`);
      }
      inputs.push((input as { type: string }).type);
    }
    signatures.add(`${record.name}(${inputs.join(",")})`);
  }
  return signatures;
}

async function verifyPublishedAbi(
  fetcher: typeof fetch,
  manifest: DeploymentManifest,
  key: ContractKey,
  policy: EvidenceFetchPolicy,
): Promise<void> {
  const deployment = manifest.contracts[key];
  if (!deployment.abiUrl || !deployment.abiSha256) fail(`${key} ABI evidence is incomplete`);
  const bytes = await fetchBounded(fetcher, deployment.abiUrl, policy);
  if (sha256(bytes).toLowerCase() !== deployment.abiSha256.toLowerCase()) fail(`${key} ABI SHA-256 mismatch`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(`${key} published ABI is not valid JSON`);
  }
  const signatures = abiSignatures(parsed);
  for (const required of requiredContractAbiFunctions(manifest, key)) {
    if (!signatures.has(required)) fail(`${key} published ABI is missing ${required}`);
  }
}

function expectedConstructorArguments(manifest: DeploymentManifest, key: ContractKey): Hex {
  const governance = manifest.activationEvidence.governance.account;
  const permitSigner = manifest.activationEvidence.controllerPolicy.permitSigner;
  const referralBps = manifest.activationEvidence.controllerPolicy.referralBps;
  const feeBps = manifest.activationEvidence.marketplacePolicy.feeBps;
  if (!governance || !permitSigner || referralBps === null || feeBps === null) {
    fail(`${key} constructor evidence cannot be derived from an incomplete manifest`);
  }
  const registry = address(manifest, "registry");
  const registrar = address(manifest, "baseRegistrar");
  const controllerResolver = address(manifest, "publicResolver");
  const reverseRegistrar = address(manifest, "reverseRegistrar");
  switch (key) {
    case "registry":
      return encodeAbiParameters(parseAbiParameters("address"), [governance]);
    case "baseRegistrar":
      return registrarVersionOf(manifest) === "v2"
        ? encodeAbiParameters(parseAbiParameters("address, bytes32, address, string"), [
            registry,
            manifest.namespace.baseNode!,
            governance,
            manifest.nftMetadata!.metadataBaseURI,
          ])
        : encodeAbiParameters(parseAbiParameters("address, bytes32, address"), [
            registry, manifest.namespace.baseNode!, governance,
          ]);
    case "controller":
      return encodeAbiParameters(
        parseAbiParameters("address, address, address, address, address, address, bytes32, bytes32, uint16"),
        [
          registrar,
          manifest.settlement.erc20Address,
          controllerResolver,
          governance,
          permitSigner,
          governance,
          manifest.releaseId!,
          manifest.normalization.profileHash,
          referralBps,
        ],
      );
    case "publicResolver":
      return encodeAbiParameters(parseAbiParameters("address"), [registry]);
    case "reverseRegistrar":
      return encodeAbiParameters(
        parseAbiParameters("address, address, address, bytes32, bytes32, string"),
        [
          registry,
          controllerResolver,
          registrar,
          namehash("addr.reverse"),
          manifest.namespace.baseNode!,
          manifest.namespace.suffix!,
        ],
      );
    case "universalResolver":
      return encodeAbiParameters(parseAbiParameters("address, address"), [registry, reverseRegistrar]);
    case "marketplace":
      return encodeAbiParameters(parseAbiParameters("address, address, address, address, uint16"), [
        registrar, manifest.settlement.erc20Address, governance, governance, feeBps,
      ]);
  }
}

export function assertArcScanSourceResponse(
  bytes: Uint8Array,
  manifest: DeploymentManifest,
  key: ContractKey,
): void {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(bytes)); }
  catch { fail(`${key} source-verification response is not JSON`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${key} source-verification response is not an object`);
  }
  const response = value as Record<string, unknown>;
  const identity = verifiedContractIdentity(manifest, key);
  const settings = response.compiler_settings;
  const optimizer = settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).optimizer
    : null;
  const metadata = settings && typeof settings === "object" && !Array.isArray(settings)
    ? (settings as Record<string, unknown>).metadata
    : null;
  const settingsRecord = settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : null;
  const optimizerRecord = optimizer && typeof optimizer === "object" && !Array.isArray(optimizer)
    ? optimizer as Record<string, unknown>
    : null;
  const metadataRecord = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata as Record<string, unknown>
    : null;
  if (
    response.is_verified !== true || response.creation_status !== "success" ||
    response.language !== "solidity" || response.name !== identity.name || response.file_path !== identity.filePath ||
    response.compiler_version !== VERIFIED_SOURCE_SETTINGS.compilerVersion ||
    response.optimization_enabled !== true || response.optimization_runs !== VERIFIED_SOURCE_SETTINGS.optimizerRuns ||
    response.evm_version !== VERIFIED_SOURCE_SETTINGS.evmVersion ||
    settingsRecord?.evmVersion !== VERIFIED_SOURCE_SETTINGS.evmVersion || settingsRecord?.viaIR !== false ||
    optimizerRecord?.enabled !== true || optimizerRecord?.runs !== VERIFIED_SOURCE_SETTINGS.optimizerRuns ||
    metadataRecord?.appendCBOR !== false || metadataRecord?.bytecodeHash !== "none" ||
    typeof response.source_code !== "string" || response.source_code.length === 0 ||
    typeof response.deployed_bytecode !== "string" || !/^0x[0-9a-fA-F]+$/.test(response.deployed_bytecode) ||
    typeof response.constructor_args !== "string" || !/^(?:0x)?[0-9a-fA-F]*$/.test(response.constructor_args)
  ) fail(`${key} ArcScan source-verification semantics mismatch`);
  const constructorArguments = response.constructor_args.startsWith("0x")
    ? response.constructor_args
    : `0x${response.constructor_args}`;
  if (constructorArguments.toLowerCase() !== expectedConstructorArguments(manifest, key).toLowerCase()) {
    fail(`${key} ArcScan constructor arguments mismatch`);
  }
  const expectedRuntimeHash = manifest.contracts[key].runtimeCodeHash;
  if (!expectedRuntimeHash || keccak256(response.deployed_bytecode as Hex).toLowerCase() !== expectedRuntimeHash.toLowerCase()) {
    fail(`${key} ArcScan deployed bytecode mismatch`);
  }
}

async function verifyArcScanSource(
  fetcher: typeof fetch,
  manifest: DeploymentManifest,
  key: ContractKey,
  policy: EvidenceFetchPolicy,
): Promise<void> {
  const deployment = manifest.contracts[key];
  if (!deployment.sourceVerificationUrl || !deployment.sourceVerificationSha256) {
    fail(`${key} source-verification evidence is incomplete`);
  }
  const url = assertAllowedPromotionUrl(deployment.sourceVerificationUrl, policy.allowedFetchHosts);
  if (
    url.hostname.toLowerCase() !== "testnet.arcscan.app" || url.search ||
    url.pathname.toLowerCase() !== `/api/v2/smart-contracts/${address(manifest, key).toLowerCase()}`
  ) fail(`${key} source-verification URL is not the canonical ArcScan contract API`);
  const bytes = await fetchBounded(fetcher, url, policy);
  if (sha256(bytes).toLowerCase() !== deployment.sourceVerificationSha256.toLowerCase()) {
    fail(`${key} source-verification SHA-256 mismatch`);
  }
  assertArcScanSourceResponse(bytes, manifest, key);
}

export function assertApprovedContractRuntimeHash(
  key: ContractKey,
  manifestHash: Hex,
  approved: Readonly<Partial<Record<ContractKey, Hex>>> | undefined,
): void {
  const trustedHash = approved?.[key];
  if (!trustedHash || trustedHash.toLowerCase() !== manifestHash.toLowerCase()) {
    fail(`${key} runtime code hash is not bound to the reviewed reproducible build`);
  }
}

/**
 * Release 1 is Arc Testnet-only and intentionally uses one externally owned
 * account for every privileged role. Promotion still rejects contract wallets
 * and empty accounts so a stale or mistyped authority cannot go live.
 */
export async function verifyFundedGovernanceAccount(
  client: Pick<PublicClient, "getCode" | "getBalance">,
  account: Address,
  blockNumber: bigint,
): Promise<bigint> {
  const governanceAccount = getAddress(account);
  const [code, balance] = await Promise.all([
    client.getCode({ address: governanceAccount, blockNumber }),
    client.getBalance({ address: governanceAccount, blockNumber }),
  ]);
  if (code && code !== "0x") fail("governance account must be an EOA with no runtime code");
  if (balance <= 0n) fail("governance account must have a positive Arc native-USDC balance");
  return balance;
}

export function assertIssuerHealthPayload(
  body: Record<string, unknown>,
  manifest: DeploymentManifest,
  controller: Address,
  mode: IssuerHealthPayloadMode = "exact-release",
): void {
  if (mode === "authenticated-private-candidate-source" && !manifest.activationEvidence.productLive) {
    fail("private candidate source can only promote a product-live target");
  }
  const signer = manifest.permitIssuer.signerAddress;
  const policyVersion = manifest.permitIssuer.policyVersion;
  if (!signer || !policyVersion || !manifest.releaseId) fail("active issuer metadata is incomplete");
  const addressMatches = (value: unknown, expected: Address) =>
    typeof value === "string" && /^0x[0-9a-fA-F]{40}$/.test(value) && getAddress(value) === getAddress(expected);
  const expectedProductLive = mode === "authenticated-private-candidate-source"
    ? false
    : manifest.activationEvidence.productLive;
  if (
    body.ok !== true || body.chainId !== ARC_TESTNET_CHAIN_ID || !addressMatches(body.controller, controller) ||
    body.releaseId !== manifest.releaseId || body.normalizationProfileHash !== manifest.normalization.profileHash ||
    body.productLive !== expectedProductLive ||
    !addressMatches(body.signerAddress, signer) || !addressMatches(body.configuredSignerAddress, signer) ||
    !addressMatches(body.localSignerAddress, signer) || body.signerReady !== true ||
    body.signerKind !== "local-private-key" || body.storage !== "stateless" ||
    body.coordinationScope !== "onchain-finality" || body.durable !== false ||
    body.policyVersion !== policyVersion || body.onchainPolicyVersion !== policyVersion ||
    body.registrationsPaused !== false
  ) {
    fail("permit issuer health does not match the active release");
  }
}

export function assertIssuerHealthAuthorization(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const token = value.startsWith("Basic ") ? value.slice(6) : "";
  if (
    value.length > 5_500 ||
    token.length === 0 ||
    token.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(token)
  ) {
    fail("issuer health authorization must be a bounded Basic credential");
  }
  let credential = "";
  try {
    credential = atob(token);
  } catch {
    fail("issuer health authorization must be a bounded Basic credential");
  }
  const separator = credential.indexOf(":");
  const username = separator > 0 ? credential.slice(0, separator) : "";
  const password = separator > 0 ? credential.slice(separator + 1) : "";
  if (
    btoa(credential) !== token ||
    username.length > 256 || username.includes(":") || !/^[\u0021-\u007e]+$/.test(username) ||
    password.length < 32 || password.length > 3_800 || !/^[\u0020-\u007e]+$/.test(password)
  ) {
    fail("issuer health authorization must be a bounded Basic credential");
  }
  return value;
}

export function assertPrivateCandidateOrigin(
  value: string | undefined,
  allowedFetchHosts: readonly string[] = [],
): URL | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    fail("private candidate origin must be an exact HTTPS origin");
  }
  const origin = assertAllowedPromotionUrl(value, allowedFetchHosts);
  if (
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.href !== `${origin.origin}/`
  ) {
    fail("private candidate origin must not contain a path, query or fragment");
  }
  return origin;
}

export function issuerHealthUrl(
  manifest: DeploymentManifest,
  privateCandidateOrigin?: URL,
): URL {
  const issuerUrl = manifest.permitIssuer.url;
  if (!issuerUrl) fail("active issuer metadata is incomplete");
  const base = issuerUrl.endsWith("/") ? issuerUrl : `${issuerUrl}/`;
  const canonicalHealthUrl = new URL("healthz", base);
  if (!privateCandidateOrigin) return canonicalHealthUrl;
  const healthUrl = new URL(canonicalHealthUrl.pathname, privateCandidateOrigin);
  if (healthUrl.origin !== privateCandidateOrigin.origin || healthUrl.search || healthUrl.hash) {
    fail("private candidate issuer health URL escaped the approved origin");
  }
  return healthUrl;
}

export function assertPrivateCandidateIngressChallenge(
  response: Pick<Response, "status" | "headers">,
): void {
  const challenge = response.headers.get("www-authenticate") ?? "";
  const cacheControl = response.headers.get("cache-control") ?? "";
  if (
    response.status !== 401 ||
    !/^Basic(?:\s|$)/i.test(challenge) ||
    !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)
  ) {
    fail("private candidate issuer health must reject unauthenticated requests with a Basic challenge");
  }
}

async function verifyPrivateCandidateIngressBoundary(
  fetcher: typeof fetch,
  url: string | URL,
  policy: EvidenceFetchPolicy,
): Promise<void> {
  const safeUrl = assertAllowedPromotionUrl(url, policy.allowedFetchHosts);
  await assertPublicPromotionResolution(safeUrl, policy.resolveHostname);
  const response = await fetcher(safeUrl, {
    headers: { accept: "application/json,text/plain;q=0.9,*/*;q=0.1" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  try {
    assertPrivateCandidateIngressChallenge(response);
  } finally {
    if (response.body) await response.body.cancel().catch(() => undefined);
  }
}

async function verifyIssuerHealth(
  fetcher: typeof fetch,
  manifest: DeploymentManifest,
  controller: Address,
  policy: EvidenceFetchPolicy,
  healthUrl: URL,
  authorization?: ScopedFetchAuthorization,
  mode: IssuerHealthPayloadMode = "exact-release",
): Promise<void> {
  if (
    !manifest.permitIssuer.url ||
    !manifest.permitIssuer.signerAddress ||
    !manifest.permitIssuer.policyVersion ||
    !manifest.releaseId
  ) {
    fail("active issuer metadata is incomplete");
  }
  const healthBytes = await fetchBounded(
    fetcher,
    healthUrl,
    policy,
    MAX_ISSUER_HEALTH_BYTES,
    authorization,
  );
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(new TextDecoder().decode(healthBytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail("permit issuer health is not a JSON object");
    body = parsed as Record<string, unknown>;
  } catch {
    fail("permit issuer health is not valid bounded JSON");
  }
  assertIssuerHealthPayload(body, manifest, controller, mode);
}

export async function verifyDeploymentPromotion(
  value: unknown,
  options: PromotionVerifierOptions = {},
): Promise<PromotionVerificationReport> {
  assertDeploymentManifest(value);
  const manifest = value;
  if (manifest.state !== "verified" && manifest.state !== "active") {
    fail("manifest must be structurally verified before live promotion checks");
  }
  const issuerHealthAuthorization = assertIssuerHealthAuthorization(options.issuerHealthAuthorization);
  const privateCandidateOrigin = assertPrivateCandidateOrigin(
    options.privateCandidateOrigin,
    options.allowedFetchHosts,
  );
  if (issuerHealthAuthorization && !privateCandidateOrigin) {
    fail("issuer health authorization requires an explicit private candidate origin");
  }
  if (privateCandidateOrigin && !issuerHealthAuthorization) {
    fail("private candidate origin requires bounded Basic credentials");
  }
  if (
    options.allowAuthenticatedPrivateCandidateSource !== undefined &&
    typeof options.allowAuthenticatedPrivateCandidateSource !== "boolean"
  ) {
    fail("authenticated private candidate source option must be boolean");
  }
  const candidateSource = options.allowAuthenticatedPrivateCandidateSource === true;
  if (candidateSource) {
    if (!issuerHealthAuthorization) {
      fail("authenticated private candidate source requires bounded Basic credentials");
    }
    if (manifest.state !== "active" || !manifest.activationEvidence.productLive) {
      fail("candidate source verification requires a product-live target");
    }
  }
  const rpcUrl = options.rpcUrl ?? manifest.chain.rpcUrl;
  const parsedRpc = new URL(rpcUrl);
  if (parsedRpc.protocol !== "https:" || parsedRpc.username || parsedRpc.password) fail("promotion RPC must use credential-free HTTPS");
  const client = options.publicClient ?? createPublicClient({
    chain: ARC_TESTNET,
    transport: http(rpcUrl, { timeout: 7_500, retryCount: 1 }),
  });
  const fetcher = options.fetcher ?? fetch;
  const fetchPolicy: EvidenceFetchPolicy = {
    allowedFetchHosts: options.allowedFetchHosts ?? [],
    ...(options.resolveHostname ? { resolveHostname: options.resolveHostname } : {}),
  };
  const scopedIssuerAuthorization = issuerHealthAuthorization && privateCandidateOrigin
    ? {
        value: issuerHealthAuthorization,
        origin: privateCandidateOrigin.origin,
      }
    : undefined;
  const [chainId, latestBlock] = await Promise.all([client.getChainId(), client.getBlockNumber()]);
  if (chainId !== ARC_TESTNET_CHAIN_ID) fail(`RPC returned chain ${chainId}`);
  const verifiedAtBlock = BigInt(manifest.activationEvidence.verifiedAtBlock!);
  if (verifiedAtBlock > latestBlock) fail("verification block is ahead of Arc RPC");

  const contracts = {} as PromotionVerificationReport["contracts"];
  await Promise.all(CONTRACT_KEYS.map(async (key) => {
    const deployment = manifest.contracts[key];
    const contractAddress = address(manifest, key);
    if (!deployment.transactionHash || !deployment.deploymentBlock || !deployment.runtimeCodeHash) {
      fail(`${key} deployment evidence is incomplete`);
    }
    assertApprovedContractRuntimeHash(key, deployment.runtimeCodeHash, options.approvedContractRuntimeCodeHashes);
    const [receipt, codeAtEvidence, codeNow] = await Promise.all([
      client.getTransactionReceipt({ hash: deployment.transactionHash }),
      client.getCode({ address: contractAddress, blockNumber: verifiedAtBlock }),
      client.getCode({ address: contractAddress }),
      verifyPublishedAbi(fetcher, manifest, key, fetchPolicy),
      verifyArcScanSource(fetcher, manifest, key, fetchPolicy),
    ]);
    if (
      receipt.status !== "success" || receipt.to !== null || !receipt.contractAddress ||
      getAddress(receipt.contractAddress) !== contractAddress || receipt.blockNumber !== BigInt(deployment.deploymentBlock)
    ) {
      fail(`${key} deployment receipt does not prove a direct successful creation`);
    }
    if (!codeAtEvidence || codeAtEvidence === "0x" || !codeNow || codeNow === "0x") fail(`${key} runtime code is missing`);
    const expectedHash = deployment.runtimeCodeHash.toLowerCase();
    if (keccak256(codeAtEvidence).toLowerCase() !== expectedHash || keccak256(codeNow).toLowerCase() !== expectedHash) {
      fail(`${key} runtime code hash mismatch`);
    }
    contracts[key] = {
      address: contractAddress,
      deploymentBlock: deployment.deploymentBlock,
      runtimeCodeHash: deployment.runtimeCodeHash,
    };
  }));

  const legacyReleases =
    manifest.activationEvidence.productLive && registrarVersionOf(manifest) === "v2"
      ? await Promise.all(
          manifest.legacyReleases!.map((reference) =>
            verifyLegacyReleaseAtBlock(client, manifest, reference, latestBlock)
          ),
        )
      : [];

  const artifactChecks = ACTIVATION_ARTIFACT_KEYS.filter((key) => manifest.activationEvidence.artifacts[key].url !== null);
  await Promise.all(artifactChecks.map(async (key) => {
    const bytes = await verifyArtifact(
      fetcher,
      manifest.activationEvidence.artifacts[key],
      `activationEvidence.artifacts.${key}`,
      fetchPolicy,
    );
    if (manifest.activationEvidence.productLive && (key === "fundedEndToEnd" || key === "operationsDrill")) {
      await verifySignedPassEnvelope(
        bytes,
        key,
        manifest,
        latestBlock,
        options.approvedReviewerAddresses,
        {
          publicClient: client,
          fetcher,
          allowedFetchHosts: fetchPolicy.allowedFetchHosts,
          ...(fetchPolicy.resolveHostname ? { resolveHostname: fetchPolicy.resolveHostname } : {}),
        },
      );
    }
  }));

  const registry = address(manifest, "registry");
  const registrar = address(manifest, "baseRegistrar");
  const controller = address(manifest, "controller");
  const publicResolver = address(manifest, "publicResolver");
  const reverseRegistrar = address(manifest, "reverseRegistrar");
  const universalResolver = address(manifest, "universalResolver");
  const marketplace = address(manifest, "marketplace");
  const configuredGovernanceAccount = manifest.activationEvidence.governance.account;
  if (!configuredGovernanceAccount) fail("single governance account evidence is incomplete");
  const governanceAccount = getAddress(configuredGovernanceAccount);
  const controllerHistory = await verifyExclusiveRegistrarController(
    client,
    fetcher,
    manifest.chain.explorerUrl,
    registrar,
    controller,
    governanceAccount,
    BigInt(manifest.contracts.baseRegistrar.deploymentBlock!),
    latestBlock,
    fetchPolicy.resolveHostname,
  );
  const governanceBalance = await verifyFundedGovernanceAccount(client, governanceAccount, latestBlock);
  const reverseNode = namehash("addr.reverse");
  const reverseParentNode = namehash("reverse");
  const [
    registryRootOwner, registryBaseOwner, registryReverseParentOwner, registryReverseOwner,
    registrarRegistry, registrarBaseNode, registrarOwner, registrarPendingOwner, controllerEnabled,
    controllerRegistrar, controllerAsset, controllerResolver, controllerBaseNode, controllerRelease,
    controllerNormalization, controllerOwner, controllerPendingOwner, permitSigner, pendingPermitSigner,
    pendingPermitSignerValidAfter, signerPolicyVersion, controllerTreasury,
    referralBps, registrationsPaused,
    resolverRegistry,
    reverseRegistry, reverseDefaultResolver, reverseBaseRegistrar, configuredReverseNode, reverseBaseNode, reverseSuffix,
    universalRegistry, universalReverseRegistrar,
    marketRegistrar, marketAsset, marketOwner, marketPendingOwner, marketTreasury, marketFeeBps, marketPaused,
  ] = await Promise.all([
    client.readContract({ address: registry, abi: registryAbi, functionName: "owner", args: [ZERO_NODE] }),
    client.readContract({ address: registry, abi: registryAbi, functionName: "owner", args: [manifest.namespace.baseNode!] }),
    client.readContract({ address: registry, abi: registryAbi, functionName: "owner", args: [reverseParentNode] }),
    client.readContract({ address: registry, abi: registryAbi, functionName: "owner", args: [reverseNode] }),
    client.readContract({ address: registrar, abi: registrarAbi, functionName: "registry" }),
    client.readContract({ address: registrar, abi: registrarAbi, functionName: "baseNode" }),
    client.readContract({ address: registrar, abi: registrarAbi, functionName: "owner" }),
    client.readContract({ address: registrar, abi: registrarAbi, functionName: "pendingOwner" }),
    client.readContract({ address: registrar, abi: registrarAbi, functionName: "controllers", args: [controller] }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "registrar" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "settlementAsset" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "publicResolver" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "baseNode" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "releaseId" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "normalizationProfileHash" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "owner" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "pendingOwner" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "permitSigner" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "pendingPermitSigner" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "pendingPermitSignerValidAfter" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "signerPolicyVersion" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "treasury" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "referralBps" }),
    client.readContract({ address: controller, abi: controllerAbi, functionName: "registrationsPaused" }),
    client.readContract({ address: publicResolver, abi: publicResolverAbi, functionName: "registry" }),
    client.readContract({ address: reverseRegistrar, abi: reverseRegistrarAbi, functionName: "registry" }),
    client.readContract({ address: reverseRegistrar, abi: reverseRegistrarAbi, functionName: "defaultResolver" }),
    client.readContract({ address: reverseRegistrar, abi: reverseRegistrarAbi, functionName: "registrar" }),
    client.readContract({ address: reverseRegistrar, abi: reverseRegistrarAbi, functionName: "reverseNode" }),
    client.readContract({ address: reverseRegistrar, abi: reverseRegistrarAbi, functionName: "baseNode" }),
    client.readContract({ address: reverseRegistrar, abi: reverseRegistrarAbi, functionName: "suffix" }),
    client.readContract({ address: universalResolver, abi: universalResolverAbi, functionName: "registry" }),
    client.readContract({ address: universalResolver, abi: universalResolverAbi, functionName: "reverseRegistrar" }),
    client.readContract({ address: marketplace, abi: marketplaceAbi, functionName: "registrar" }),
    client.readContract({ address: marketplace, abi: marketplaceAbi, functionName: "settlementAsset" }),
    client.readContract({ address: marketplace, abi: marketplaceAbi, functionName: "owner" }),
    client.readContract({ address: marketplace, abi: marketplaceAbi, functionName: "pendingOwner" }),
    client.readContract({ address: marketplace, abi: marketplaceAbi, functionName: "treasury" }),
    client.readContract({ address: marketplace, abi: marketplaceAbi, functionName: "feeBps" }),
    client.readContract({ address: marketplace, abi: marketplaceAbi, functionName: "paused" }),
  ]);

  if (registrarVersionOf(manifest) === "v2") {
    const [registrarMetadataBaseURI, supportsMetadataInterface] = await Promise.all([
      client.readContract({
        address: registrar,
        abi: registrarAbi,
        functionName: "metadataBaseURI",
      }),
      client.readContract({
        address: registrar,
        abi: registrarAbi,
        functionName: "supportsInterface",
        args: [ERC721_METADATA_INTERFACE_ID],
      }),
    ]);
    assertRegistrarMetadataState(
      manifest,
      registrarMetadataBaseURI,
      supportsMetadataInterface,
    );
  }

  equalAddress(registryRootOwner, governanceAccount, "registry root owner");
  equalAddress(registryBaseOwner, registrar, "registry base-node owner");
  equalAddress(registryReverseParentOwner, governanceAccount, "registry reverse parent owner");
  equalAddress(registryReverseOwner, reverseRegistrar, "registry reverse-node owner");
  equalAddress(registrarRegistry, registry, "registrar registry");
  if (registrarBaseNode !== manifest.namespace.baseNode) fail("registrar base node mismatch");
  equalAddress(registrarOwner, governanceAccount, "registrar owner");
  if (getAddress(registrarPendingOwner) !== zeroAddress) fail("registrar has a pending ownership transfer");
  if (!controllerEnabled) fail("controller is not enabled on registrar");
  equalAddress(controllerRegistrar, registrar, "controller registrar");
  equalAddress(controllerAsset, manifest.settlement.erc20Address, "controller settlement asset");
  equalAddress(controllerResolver, publicResolver, "controller public resolver");
  if (controllerBaseNode !== manifest.namespace.baseNode) fail("controller base node mismatch");
  if (controllerRelease !== manifest.releaseId) fail("controller release ID mismatch");
  if (controllerNormalization !== manifest.normalization.profileHash) fail("controller normalization profile mismatch");
  equalAddress(controllerOwner, governanceAccount, "controller owner");
  if (getAddress(controllerPendingOwner) !== zeroAddress) fail("controller has a pending ownership transfer");
  equalAddress(permitSigner, manifest.activationEvidence.controllerPolicy.permitSigner!, "controller permit signer");
  equalAddress(permitSigner, governanceAccount, "single-account permit signer");
  if (getAddress(pendingPermitSigner) !== zeroAddress || pendingPermitSignerValidAfter !== 0n) {
    fail("controller has a pending permit-signer rotation");
  }
  if (signerPolicyVersion.toString() !== manifest.activationEvidence.controllerPolicy.signerPolicyVersion) {
    fail("controller signer policy version mismatch");
  }
  equalAddress(controllerTreasury, governanceAccount, "controller treasury");
  if (Number(referralBps) !== manifest.activationEvidence.controllerPolicy.referralBps) fail("controller referral policy mismatch");
  if (registrationsPaused !== manifest.activationEvidence.controllerPolicy.registrationsPaused) fail("controller pause policy mismatch");
  equalAddress(resolverRegistry, registry, "public resolver registry");
  equalAddress(reverseRegistry, registry, "reverse registrar registry");
  equalAddress(reverseDefaultResolver, publicResolver, "reverse registrar default resolver");
  equalAddress(reverseBaseRegistrar, registrar, "reverse registrar base registrar");
  if (configuredReverseNode !== reverseNode || reverseBaseNode !== manifest.namespace.baseNode || reverseSuffix !== manifest.namespace.suffix) {
    fail("reverse registrar namespace wiring mismatch");
  }
  equalAddress(universalRegistry, registry, "universal resolver registry");
  equalAddress(universalReverseRegistrar, reverseRegistrar, "universal resolver reverse registrar");
  equalAddress(marketRegistrar, registrar, "marketplace registrar");
  equalAddress(marketAsset, manifest.settlement.erc20Address, "marketplace settlement asset");
  equalAddress(marketOwner, governanceAccount, "marketplace owner");
  if (getAddress(marketPendingOwner) !== zeroAddress) fail("marketplace has a pending ownership transfer");
  equalAddress(marketTreasury, governanceAccount, "marketplace treasury");
  if (Number(marketFeeBps) !== manifest.activationEvidence.marketplacePolicy.feeBps) fail("marketplace fee policy mismatch");
  if (marketPaused !== manifest.activationEvidence.marketplacePolicy.paused) fail("marketplace pause policy mismatch");

  if (manifest.state === "active") {
    const healthUrl = issuerHealthUrl(manifest, privateCandidateOrigin);
    if (candidateSource) {
      await verifyPrivateCandidateIngressBoundary(
        fetcher,
        healthUrl,
        fetchPolicy,
      );
    }
    await verifyIssuerHealth(
      fetcher,
      manifest,
      controller,
      fetchPolicy,
      healthUrl,
      scopedIssuerAuthorization,
      candidateSource ? "authenticated-private-candidate-source" : "exact-release",
    );
  }
  return {
    ok: true,
    productLive: manifest.activationEvidence.productLive,
    chainId: ARC_TESTNET_CHAIN_ID,
    latestBlock: latestBlock.toString(),
    verifiedAtBlock: verifiedAtBlock.toString(),
    contracts,
    artifacts: artifactChecks,
    governanceAccount,
    governanceBalance: governanceBalance.toString(),
    permitSigner: getAddress(permitSigner),
    issuerReady: manifest.state === "active",
    controllerHistory,
    legacyReleases,
  };
}
