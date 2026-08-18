import { getAddress, isAddress, namehash, sha256, stringToBytes, type Address, type Hex } from "viem";
import {
  ARC_TESTNET_CAIP2,
  ARC_TESTNET_CHAIN_ID,
  ARC_TESTNET_EXPLORER_URL,
  ARC_TESTNET_MULTICALL3,
  ARC_TESTNET_RPC_URL,
  ARC_USDC,
} from "./chain.js";

export const CONTRACT_KEYS = [
  "registry",
  "baseRegistrar",
  "controller",
  "publicResolver",
  "reverseRegistrar",
  "universalResolver",
  "marketplace",
] as const;

export type ContractKey = (typeof CONTRACT_KEYS)[number];
export type ActivationState = "draft" | "configured" | "verified" | "active";
export type RegistrarVersion = "v1" | "v2";

export const CANONICAL_NFT_METADATA_BASE_URI =
  "https://contour-arc.vercel.app/api/metadata/" as const;
export const ERC721_METADATA_INTERFACE_ID = "0x5b5e139f" as const;

export const CANONICAL_NORMALIZATION = Object.freeze({
  profileId: "arc-ensip15-single-label-v1",
  implementation: "@adraffy/ens-normalize@1.11.1",
  unicodeVersion: "17.0.0",
  upstreamSpecSha256: "0x4febc8f5d285cbf80d2320fb0c1777ac25e378eb72910c34ec963d0a4e319c84" as Hex,
  profileHash: "0x0889fdb1d0500090d2c605094dd2bd30510a137778f641aca67d8d2fb491f89c" as Hex,
  corpusHash: "0xd25e274d718f468f1edbded13a5319a404d9e2dff39ded6ecf78ef88ea37cf60" as Hex,
} as const);

export const RESOLVER_CAPABILITY_KEYS = [
  "addr", "multicoinAddr", "text", "name", "contenthash", "interface", "ccipRead",
] as const;
export type ResolverCapability = (typeof RESOLVER_CAPABILITY_KEYS)[number];
export const EXPECTED_RESOLVER_CAPABILITIES: Readonly<Record<ResolverCapability, boolean>> = Object.freeze({
  addr: true,
  multicoinAddr: true,
  text: true,
  name: true,
  contenthash: true,
  interface: true,
  ccipRead: false,
});

export const ACTIVATION_ARTIFACT_KEYS = [
  "deploymentReceipts",
  "constructorWiring",
  "governanceRoles",
  "treasuryControls",
  "signerPolicy",
  "releaseAttestation",
  "fundedEndToEnd",
  "operationsDrill",
] as const;

export type ActivationArtifactKey = (typeof ACTIVATION_ARTIFACT_KEYS)[number];

export interface HashedEvidenceArtifact {
  url: string | null;
  sha256: Hex | null;
}

export interface ActivationEvidence {
  /** Candidate execution may run privately while false; public product surfaces require true. */
  productLive: boolean;
  verifiedAtBlock: number | null;
  artifacts: Record<ActivationArtifactKey, HashedEvidenceArtifact>;
  governance: {
    /**
     * Arc Testnet Release 1 deliberately uses one funded EOA for deployment,
     * protocol ownership, treasury settlement and EIP-712 permit signing.
     * Promotion proves that this address has no runtime code and has a
     * positive native-USDC balance; no multisig/KMS assumption is encoded.
     */
    account: Address | null;
  };
  controllerPolicy: {
    permitSigner: Address | null;
    signerPolicyVersion: string | null;
    referralBps: number | null;
    registrationsPaused: boolean | null;
  };
  marketplacePolicy: {
    feeBps: number | null;
    paused: boolean | null;
  };
}

export interface ContractDeployment {
  address: Address | null;
  deploymentBlock: number | null;
  transactionHash: Hex | null;
  runtimeCodeHash: Hex | null;
  abiUrl: string | null;
  abiSha256: Hex | null;
  sourceVerified: boolean;
  sourceVerificationUrl: string | null;
  sourceVerificationSha256: Hex | null;
}

export interface NftMetadataConfiguration {
  metadataBaseURI: typeof CANONICAL_NFT_METADATA_BASE_URI;
}

export interface LegacyContractReference {
  address: Address;
  deploymentBlock: number;
  runtimeCodeHash: Hex;
}

export interface LegacyReleaseReference {
  registrarVersion: "v1";
  releaseId: Hex;
  verifiedAtBlock: number;
  contracts: Record<ContractKey, LegacyContractReference>;
  controllerPolicy: {
    registrationsPaused: true;
  };
  marketplacePolicy: {
    paused: false;
  };
}

export interface DeploymentManifest {
  schemaVersion: "1.1.0";
  state: ActivationState;
  releaseId: Hex | null;
  /**
   * Omitted by legacy schema-1.1.0 manifests and interpreted as V1. New
   * releases must publish this field explicitly.
   */
  registrarVersion?: RegistrarVersion;
  /** Required and exact for V2; absent or null for V1. */
  nftMetadata?: NftMetadataConfiguration | null;
  /** Immutable references retained across a clean V2 cutover. */
  legacyReleases?: readonly LegacyReleaseReference[];
  testnet: true;
  chain: {
    id: typeof ARC_TESTNET_CHAIN_ID;
    caip2: typeof ARC_TESTNET_CAIP2;
    rpcUrl: typeof ARC_TESTNET_RPC_URL;
    websocketUrl: string;
    explorerUrl: typeof ARC_TESTNET_EXPLORER_URL;
    multicall3: typeof ARC_TESTNET_MULTICALL3;
    confirmations: 1;
  };
  settlement: {
    symbol: "USDC";
    erc20Address: typeof ARC_USDC.erc20Address;
    applicationDecimals: 6;
    nativeInterfaceDecimals: 18;
    sharedUnderlyingBalance: true;
  };
  namespace: {
    brand: string | null;
    suffix: string | null;
    baseNode: Hex | null;
  };
  normalization: {
    profileId: string;
    implementation: string;
    unicodeVersion: string;
    upstreamSpecSha256: Hex;
    profileHash: Hex;
    corpusHash: Hex;
  };
  contracts: Record<ContractKey, ContractDeployment>;
  activationEvidence: ActivationEvidence;
  permitIssuer: {
    url: string | null;
    signerAddress: Address | null;
    publicKey: Hex | null;
    policyVersion: string | null;
    active: boolean;
  };
  resolverCapabilities: Record<ResolverCapability, boolean>;
  discovery: {
    manifestUrl: string | null;
    agentManifestUrl: string | null;
    mcpUrl: string | null;
    openApiUrl: string | null;
  };
  bens: {
    protocolConfigured: boolean;
    subgraphSynced: boolean;
    apiUrl: string | null;
    subgraphUrl: string | null;
    hostedArcscanActive: boolean;
  };
  x402: {
    active: boolean;
    network: typeof ARC_TESTNET_CAIP2;
    asset: typeof ARC_USDC.erc20Address;
    scheme: "exact";
    facilitatorUrl: string | null;
  };
}

export class ManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestValidationError";
  }
}

function fail(message: string): never {
  throw new ManifestValidationError(message);
}

function isHex32(value: unknown): value is Hex {
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value);
}

function isNonZeroHex32(value: unknown): value is Hex {
  return isHex32(value) && !/^0x0{64}$/i.test(value);
}

function isNonZeroAddress(value: unknown): value is Address {
  return typeof value === "string" && isAddress(value) &&
    getAddress(value) !== "0x0000000000000000000000000000000000000000";
}

function assertNullableUrl(value: unknown, field: string): void {
  if (value === null) return;
  if (typeof value !== "string") fail(`${field} must be a URL or null`);
  try {
    const url = new URL(value);
    const localhost = url.hostname === "localhost" && (url.protocol === "http:" || url.protocol === "https:");
    if (url.protocol !== "https:" && !localhost) {
      fail(`${field} must use https (localhost is the only exception)`);
    }
    if (url.username || url.password) fail(`${field} must not contain credentials`);
  } catch {
    fail(`${field} must be a valid URL or null`);
  }
}

function assertPublicEvidenceUrl(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string") fail(`${field} must be an immutable HTTPS URL`);
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) {
      fail(`${field} must be an immutable HTTPS URL without credentials or fragments`);
    }
  } catch {
    fail(`${field} must be an immutable HTTPS URL`);
  }
}

function assertEvidenceArtifact(
  artifact: HashedEvidenceArtifact | undefined,
  field: string,
  required: boolean,
): void {
  if (!artifact || typeof artifact !== "object") fail(`${field} is required`);
  if ((artifact.url === null) !== (artifact.sha256 === null)) {
    fail(`${field} URL and SHA-256 must activate together`);
  }
  if (artifact.url !== null) assertPublicEvidenceUrl(artifact.url, `${field}.url`);
  if (artifact.sha256 !== null && !isNonZeroHex32(artifact.sha256)) {
    fail(`${field}.sha256 must be a non-zero bytes32 value`);
  }
  if (required && (artifact.url === null || artifact.sha256 === null)) {
    fail(`${field} is required for this activation state`);
  }
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${field} must contain exactly: ${keys.join(", ")}`);
  }
}

export function registrarVersionOf(
  manifest: Pick<DeploymentManifest, "registrarVersion">,
): RegistrarVersion {
  return manifest.registrarVersion ?? "v1";
}

function assertRegistrarMetadata(manifest: DeploymentManifest): void {
  if (
    manifest.registrarVersion !== undefined &&
    manifest.registrarVersion !== "v1" &&
    manifest.registrarVersion !== "v2"
  ) {
    fail("registrarVersion must be v1 or v2");
  }
  const version = registrarVersionOf(manifest);
  if (version === "v1") {
    if (manifest.nftMetadata !== undefined && manifest.nftMetadata !== null) {
      fail("V1 registrar cannot publish nftMetadata");
    }
    return;
  }
  if (manifest.registrarVersion !== "v2") {
    fail("V2 registrarVersion must be explicit");
  }
  if (!manifest.nftMetadata || typeof manifest.nftMetadata !== "object") {
    fail("V2 registrar requires nftMetadata");
  }
  assertExactKeys(
    manifest.nftMetadata as unknown as Record<string, unknown>,
    ["metadataBaseURI"],
    "nftMetadata",
  );
  if (manifest.nftMetadata.metadataBaseURI !== CANONICAL_NFT_METADATA_BASE_URI) {
    fail(`nftMetadata.metadataBaseURI must equal ${CANONICAL_NFT_METADATA_BASE_URI}`);
  }
}

function assertLegacyReleases(manifest: DeploymentManifest): void {
  const registrarVersion = registrarVersionOf(manifest);
  if (registrarVersion !== "v2") {
    if (manifest.legacyReleases === undefined) return;
    fail("legacyReleases are only valid on a V2 cutover manifest");
  }
  if (!Array.isArray(manifest.legacyReleases)) {
    fail("V2 cutover manifest requires exactly one legacy V1 release reference");
  }
  if (manifest.legacyReleases.length !== 1) {
    fail("V2 cutover manifest requires exactly one legacy V1 release reference");
  }
  const releaseIds = new Set<string>();
  const currentAddresses = new Set(
    CONTRACT_KEYS
      .map((key) => manifest.contracts?.[key]?.address)
      .filter((value): value is Address => value !== null && value !== undefined)
      .map((value) => getAddress(value).toLowerCase()),
  );
  for (const [index, legacy] of manifest.legacyReleases.entries()) {
    const field = `legacyReleases[${index}]`;
    if (!legacy || typeof legacy !== "object" || Array.isArray(legacy)) {
      fail(`${field} must be an object`);
    }
    assertExactKeys(
      legacy as unknown as Record<string, unknown>,
      [
        "registrarVersion",
        "releaseId",
        "verifiedAtBlock",
        "contracts",
        "controllerPolicy",
        "marketplacePolicy",
      ],
      field,
    );
    if (legacy.registrarVersion !== "v1") fail(`${field}.registrarVersion must be v1`);
    if (!isNonZeroHex32(legacy.releaseId)) fail(`${field}.releaseId must be non-zero bytes32`);
    const releaseId = legacy.releaseId.toLowerCase();
    if (releaseIds.has(releaseId)) fail(`${field}.releaseId is duplicated`);
    if (manifest.releaseId?.toLowerCase() === releaseId) {
      fail(`${field}.releaseId must differ from the current V2 release`);
    }
    releaseIds.add(releaseId);
    if (!Number.isSafeInteger(legacy.verifiedAtBlock) || legacy.verifiedAtBlock <= 0) {
      fail(`${field}.verifiedAtBlock must be a positive safe integer`);
    }
    if (!legacy.contracts || typeof legacy.contracts !== "object") {
      fail(`${field}.contracts must be an object`);
    }
    assertExactKeys(
      legacy.contracts as unknown as Record<string, unknown>,
      CONTRACT_KEYS,
      `${field}.contracts`,
    );
    const addresses = new Set<string>();
    for (const key of CONTRACT_KEYS) {
      const contract = legacy.contracts[key];
      const contractField = `${field}.contracts.${key}`;
      if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
        fail(`${contractField} must be an object`);
      }
      assertExactKeys(
        contract as unknown as Record<string, unknown>,
        ["address", "deploymentBlock", "runtimeCodeHash"],
        contractField,
      );
      if (!isNonZeroAddress(contract.address)) fail(`${contractField}.address is invalid`);
      const normalizedAddress = getAddress(contract.address).toLowerCase();
      if (addresses.has(normalizedAddress)) fail(`${contractField}.address is duplicated`);
      addresses.add(normalizedAddress);
      if (
        !Number.isSafeInteger(contract.deploymentBlock) ||
        contract.deploymentBlock <= 0 ||
        contract.deploymentBlock > legacy.verifiedAtBlock
      ) {
        fail(`${contractField}.deploymentBlock must not exceed the legacy verification block`);
      }
      if (!isNonZeroHex32(contract.runtimeCodeHash)) {
        fail(`${contractField}.runtimeCodeHash must be non-zero bytes32`);
      }
      if (currentAddresses.has(normalizedAddress)) {
        fail(`${contractField}.address must differ from every current V2 contract`);
      }
    }
    if (!legacy.controllerPolicy || typeof legacy.controllerPolicy !== "object") {
      fail(`${field}.controllerPolicy must be an object`);
    }
    assertExactKeys(
      legacy.controllerPolicy as unknown as Record<string, unknown>,
      ["registrationsPaused"],
      `${field}.controllerPolicy`,
    );
    if (legacy.controllerPolicy.registrationsPaused !== true) {
      fail(`${field}.controllerPolicy.registrationsPaused must be true`);
    }
    if (!legacy.marketplacePolicy || typeof legacy.marketplacePolicy !== "object") {
      fail(`${field}.marketplacePolicy must be an object`);
    }
    assertExactKeys(
      legacy.marketplacePolicy as unknown as Record<string, unknown>,
      ["paused"],
      `${field}.marketplacePolicy`,
    );
    if (legacy.marketplacePolicy.paused !== false) {
      fail(`${field}.marketplacePolicy.paused must be false`);
    }
  }
}

/**
 * Binds the canonical V2 cutover document to the complete retained V1
 * manifest. The compact canonical reference is sufficient for on-chain
 * promotion checks, while this comparison prevents a web/preflight consumer
 * from loading a different historical release or stale cutover policy.
 */
export function assertV2LegacyManifestParity(
  canonical: DeploymentManifest,
  legacy: DeploymentManifest,
): LegacyReleaseReference {
  if (registrarVersionOf(canonical) !== "v2") {
    fail("legacy manifest parity is only valid for a canonical V2 cutover");
  }
  if (canonical.legacyReleases?.length !== 1) {
    fail("canonical V2 cutover must reference exactly one legacy V1 release");
  }
  if (registrarVersionOf(legacy) !== "v1") {
    fail("retained legacy manifest must use registrarVersion v1");
  }
  if (legacy.state !== "active" || legacy.releaseId === null) {
    fail("retained legacy V1 manifest must be an active release");
  }

  const reference = canonical.legacyReleases[0]!;
  if (legacy.releaseId.toLowerCase() !== reference.releaseId.toLowerCase()) {
    fail("retained legacy V1 releaseId does not match the canonical reference");
  }
  if (legacy.activationEvidence.verifiedAtBlock !== reference.verifiedAtBlock) {
    fail("retained legacy V1 verification block does not match the canonical reference");
  }
  if (
    legacy.activationEvidence.controllerPolicy.registrationsPaused !== true ||
    legacy.activationEvidence.controllerPolicy.registrationsPaused !==
      reference.controllerPolicy.registrationsPaused
  ) {
    fail("retained legacy V1 registration policy must be paused at cutover");
  }
  if (
    legacy.activationEvidence.marketplacePolicy.paused !== false ||
    legacy.activationEvidence.marketplacePolicy.paused !==
      reference.marketplacePolicy.paused
  ) {
    fail("retained legacy V1 marketplace policy must remain open at cutover");
  }

  for (const key of CONTRACT_KEYS) {
    const actual = legacy.contracts[key];
    const expected = reference.contracts[key];
    if (
      actual.address === null ||
      actual.deploymentBlock === null ||
      actual.runtimeCodeHash === null ||
      getAddress(actual.address) !== getAddress(expected.address) ||
      actual.deploymentBlock !== expected.deploymentBlock ||
      actual.runtimeCodeHash.toLowerCase() !== expected.runtimeCodeHash.toLowerCase()
    ) {
      fail(`retained legacy V1 ${key} identity does not match the canonical reference`);
    }
  }

  return reference;
}

/**
 * Strictly validates the public manifest and rejects partial activation. Draft
 * manifests may contain null deployment values; non-draft manifests may not.
 */
export function assertDeploymentManifest(value: unknown): asserts value is DeploymentManifest {
  if (!value || typeof value !== "object") fail("manifest must be an object");
  const manifest = value as DeploymentManifest;
  if (manifest.schemaVersion !== "1.1.0") fail("unsupported schemaVersion");
  if (!["draft", "configured", "verified", "active"].includes(manifest.state)) {
    fail("state must be draft, configured, verified or active");
  }
  if (manifest.chain?.id !== ARC_TESTNET_CHAIN_ID || manifest.chain.caip2 !== ARC_TESTNET_CAIP2) {
    fail("manifest is not for Arc Testnet");
  }
  if (manifest.testnet !== true) fail("testnet must be true");
  if (manifest.releaseId !== null && !isNonZeroHex32(manifest.releaseId)) {
    fail("releaseId must be a non-zero bytes32 value or null");
  }
  assertRegistrarMetadata(manifest);
  if (manifest.chain.rpcUrl !== ARC_TESTNET_RPC_URL) fail("canonical Arc Testnet RPC mismatch");
  if (manifest.chain.websocketUrl !== "wss://rpc.testnet.arc.network") fail("canonical Arc Testnet WebSocket mismatch");
  if (manifest.chain.explorerUrl !== ARC_TESTNET_EXPLORER_URL) fail("Arc explorer mismatch");
  if (manifest.chain.multicall3 !== ARC_TESTNET_MULTICALL3) fail("Arc Multicall3 mismatch");
  if (manifest.chain.confirmations !== 1) fail("receipt confirmation policy mismatch");
  if (
    typeof manifest.settlement?.erc20Address !== "string" ||
    manifest.settlement.erc20Address.toLowerCase() !== ARC_USDC.erc20Address ||
    manifest.settlement.applicationDecimals !== 6 ||
    manifest.settlement.nativeInterfaceDecimals !== 18 ||
    manifest.settlement.sharedUnderlyingBalance !== true
  ) {
    fail("Arc shared-USDC metadata mismatch");
  }
  if (manifest.settlement?.symbol !== "USDC") fail("settlement symbol must be USDC");
  if (!manifest.namespace || typeof manifest.namespace !== "object") fail("namespace is required");
  if (manifest.namespace.baseNode !== null && !isHex32(manifest.namespace.baseNode)) {
    fail("namespace.baseNode must be bytes32 or null");
  }
  if (
    !isHex32(manifest.normalization?.profileHash) ||
    !isHex32(manifest.normalization?.corpusHash) ||
    !isHex32(manifest.normalization?.upstreamSpecSha256)
  ) {
    fail("normalization hashes must be bytes32 values");
  }
  for (const [key, expected] of Object.entries(CANONICAL_NORMALIZATION)) {
    const actual = manifest.normalization[key as keyof typeof CANONICAL_NORMALIZATION];
    if (typeof actual !== "string" || actual.toLowerCase() !== expected.toLowerCase()) {
      fail(`normalization.${key} does not match the canonical pinned profile`);
    }
  }
  if (!manifest.resolverCapabilities || typeof manifest.resolverCapabilities !== "object") {
    fail("resolverCapabilities are required");
  }
  const capabilityKeys = Object.keys(manifest.resolverCapabilities).sort();
  const expectedCapabilityKeys = [...RESOLVER_CAPABILITY_KEYS].sort();
  if (capabilityKeys.join(",") !== expectedCapabilityKeys.join(",")) {
    fail("resolverCapabilities must contain exactly the supported capability keys");
  }
  for (const key of RESOLVER_CAPABILITY_KEYS) {
    if (typeof manifest.resolverCapabilities[key] !== "boolean") fail(`resolverCapabilities.${key} must be boolean`);
  }
  if (!manifest.contracts) fail("contracts are required");

  let activated = 0;
  const deploymentAddresses = new Set<string>();
  for (const key of CONTRACT_KEYS) {
    const deployment = manifest.contracts[key];
    if (!deployment) fail(`missing contract deployment: ${key}`);
    if (typeof deployment.sourceVerified !== "boolean") fail(`${key} sourceVerified must be boolean`);
    const hasAddress = deployment.address !== null;
    const hasBlock = deployment.deploymentBlock !== null;
    const hasTx = deployment.transactionHash !== null;
    if (hasAddress !== hasBlock || hasAddress !== hasTx) {
      fail(`${key} address, deploymentBlock and transactionHash must activate together`);
    }
    if (hasAddress) {
      if (!isAddress(deployment.address!)) fail(`${key} address is invalid`);
      if (getAddress(deployment.address!) === "0x0000000000000000000000000000000000000000") {
        fail(`${key} cannot use the zero address`);
      }
      const canonicalAddress = getAddress(deployment.address!).toLowerCase();
      if (deploymentAddresses.has(canonicalAddress)) {
        fail(`${key} reuses another protocol contract address`);
      }
      deploymentAddresses.add(canonicalAddress);
      if (!Number.isSafeInteger(deployment.deploymentBlock) || deployment.deploymentBlock! <= 0) {
        fail(`${key} deploymentBlock must be a positive safe integer`);
      }
      if (!isNonZeroHex32(deployment.transactionHash)) fail(`${key} transactionHash must be non-zero bytes32`);
      activated += 1;
    }
    if (deployment.runtimeCodeHash !== null && !isNonZeroHex32(deployment.runtimeCodeHash)) {
      fail(`${key} runtimeCodeHash must be a non-zero bytes32 value or null`);
    }
    assertNullableUrl(deployment.abiUrl, `contracts.${key}.abiUrl`);
    if ((deployment.abiUrl === null) !== (deployment.abiSha256 === null)) {
      fail(`${key} ABI URL and hash must activate together`);
    }
    if (deployment.abiSha256 !== null && !isNonZeroHex32(deployment.abiSha256)) {
      fail(`${key} abiSha256 must be non-zero bytes32`);
    }
    assertNullableUrl(deployment.sourceVerificationUrl, `contracts.${key}.sourceVerificationUrl`);
    if ((deployment.sourceVerificationUrl === null) !== (deployment.sourceVerificationSha256 === null)) {
      fail(`${key} source-verification URL and hash must activate together`);
    }
    if (deployment.sourceVerificationSha256 !== null && !isNonZeroHex32(deployment.sourceVerificationSha256)) {
      fail(`${key} sourceVerificationSha256 must be non-zero bytes32`);
    }
    if ((manifest.state === "verified" || manifest.state === "active") && (
      !deployment.sourceVerified || deployment.runtimeCodeHash === null ||
      deployment.abiUrl === null || deployment.abiSha256 === null ||
      deployment.sourceVerificationUrl === null || deployment.sourceVerificationSha256 === null
    )) {
      fail(`${key} requires runtime-code, source-verification and ABI evidence for ${manifest.state} state`);
    }
    if (manifest.state === "verified" || manifest.state === "active") {
      assertPublicEvidenceUrl(deployment.abiUrl, `contracts.${key}.abiUrl`);
      assertPublicEvidenceUrl(deployment.sourceVerificationUrl, `contracts.${key}.sourceVerificationUrl`);
      const sourceUrl = new URL(deployment.sourceVerificationUrl);
      if (
        sourceUrl.hostname !== "testnet.arcscan.app" ||
        !sourceUrl.pathname.toLowerCase().includes(getAddress(deployment.address!).toLowerCase())
      ) {
        fail(`${key} source verification must use the matching ArcScan contract endpoint`);
      }
    }
  }

  const evidence = manifest.activationEvidence;
  if (!evidence || typeof evidence !== "object" || !evidence.artifacts || typeof evidence.artifacts !== "object") {
    fail("activationEvidence is required");
  }
  const artifactKeys = Object.keys(evidence.artifacts).sort();
  const expectedArtifactKeys = [...ACTIVATION_ARTIFACT_KEYS].sort();
  if (artifactKeys.join(",") !== expectedArtifactKeys.join(",")) {
    fail("activationEvidence.artifacts must contain exactly the required evidence keys");
  }
  const verifiedOrActive = manifest.state === "verified" || manifest.state === "active";
  if (typeof evidence.productLive !== "boolean") fail("activationEvidence.productLive must be boolean");
  if (evidence.productLive && manifest.state !== "active") {
    fail("productLive cannot be enabled before the active candidate state");
  }
  for (const key of ACTIVATION_ARTIFACT_KEYS) {
    const liveOnlyArtifact = key === "fundedEndToEnd" || key === "operationsDrill";
    const required = verifiedOrActive && !liveOnlyArtifact || evidence.productLive;
    assertEvidenceArtifact(evidence.artifacts[key], `activationEvidence.artifacts.${key}`, required);
  }
  if (evidence.verifiedAtBlock !== null && (
    !Number.isSafeInteger(evidence.verifiedAtBlock) || evidence.verifiedAtBlock <= 0
  )) {
    fail("activationEvidence.verifiedAtBlock must be a positive safe integer or null");
  }
  if (verifiedOrActive) {
    if (evidence.verifiedAtBlock === null) fail("verified/active releases require a verification block");
    const maxDeploymentBlock = Math.max(...CONTRACT_KEYS.map((key) => manifest.contracts[key].deploymentBlock ?? 0));
    if (evidence.verifiedAtBlock < maxDeploymentBlock) {
      fail("activation evidence cannot predate a contract deployment");
    }
  }

  if (!evidence.governance || typeof evidence.governance !== "object") {
    fail("activationEvidence.governance is required");
  }
  if (evidence.governance.account !== null && !isNonZeroAddress(evidence.governance.account)) {
    fail("activationEvidence.governance.account must be a non-zero address or null");
  }
  if (verifiedOrActive && evidence.governance.account === null) {
    fail("verified/active releases require the single governance account");
  }

  const controllerPolicy = evidence.controllerPolicy;
  if (!controllerPolicy || typeof controllerPolicy !== "object") fail("activationEvidence.controllerPolicy is required");
  if (controllerPolicy.permitSigner !== null && !isNonZeroAddress(controllerPolicy.permitSigner)) {
    fail("activationEvidence.controllerPolicy.permitSigner must be non-zero or null");
  }
  if (controllerPolicy.signerPolicyVersion !== null && !/^[1-9][0-9]*$/.test(controllerPolicy.signerPolicyVersion)) {
    fail("activationEvidence.controllerPolicy.signerPolicyVersion must be a positive integer string or null");
  }
  if (controllerPolicy.referralBps !== null && (
    !Number.isSafeInteger(controllerPolicy.referralBps) || controllerPolicy.referralBps < 0 || controllerPolicy.referralBps > 3_000
  )) {
    fail("activationEvidence.controllerPolicy.referralBps is outside controller bounds");
  }
  if (controllerPolicy.registrationsPaused !== null && typeof controllerPolicy.registrationsPaused !== "boolean") {
    fail("activationEvidence.controllerPolicy.registrationsPaused must be boolean or null");
  }
  const marketplacePolicy = evidence.marketplacePolicy;
  if (!marketplacePolicy || typeof marketplacePolicy !== "object") fail("activationEvidence.marketplacePolicy is required");
  if (marketplacePolicy.feeBps !== null && (
    !Number.isSafeInteger(marketplacePolicy.feeBps) || marketplacePolicy.feeBps < 0 || marketplacePolicy.feeBps > 1_000
  )) {
    fail("activationEvidence.marketplacePolicy.feeBps is outside marketplace bounds");
  }
  if (marketplacePolicy.paused !== null && typeof marketplacePolicy.paused !== "boolean") {
    fail("activationEvidence.marketplacePolicy.paused must be boolean or null");
  }
  if (verifiedOrActive) {
    if (
      !controllerPolicy.permitSigner || !controllerPolicy.signerPolicyVersion || controllerPolicy.referralBps === null ||
      controllerPolicy.registrationsPaused === null || marketplacePolicy.feeBps === null || marketplacePolicy.paused === null
    ) {
      fail("verified/active releases require complete controller and marketplace policy evidence");
    }
    if (
      !manifest.permitIssuer.signerAddress || !manifest.permitIssuer.policyVersion ||
      getAddress(manifest.permitIssuer.signerAddress) !== getAddress(controllerPolicy.permitSigner) ||
      manifest.permitIssuer.policyVersion !== controllerPolicy.signerPolicyVersion
    ) {
      fail("permit issuer metadata must match controller policy evidence");
    }
    if (
      !evidence.governance.account ||
      getAddress(controllerPolicy.permitSigner) !== getAddress(evidence.governance.account)
    ) {
      fail("permit signer must match the single Arc Testnet governance account");
    }
  }
  if (evidence.productLive && (controllerPolicy.registrationsPaused || marketplacePolicy.paused)) {
    fail("a product-live release cannot publish paused registration or marketplace policy");
  }

  if (manifest.state === "draft") {
    if (evidence.productLive) fail("draft manifest cannot be product-live");
    if (evidence.verifiedAtBlock !== null) fail("draft manifest cannot publish a verification block");
    if (ACTIVATION_ARTIFACT_KEYS.some((key) => evidence.artifacts[key].url !== null)) {
      fail("draft manifest cannot publish activation artifacts");
    }
    if (evidence.governance.account !== null) {
      fail("draft manifest cannot publish a governance account");
    }
    if (
      controllerPolicy.permitSigner !== null || controllerPolicy.signerPolicyVersion !== null ||
      controllerPolicy.referralBps !== null || controllerPolicy.registrationsPaused !== null ||
      marketplacePolicy.feeBps !== null || marketplacePolicy.paused !== null
    ) {
      fail("draft manifest cannot publish live policy evidence");
    }
  }

  if (manifest.state === "draft" && activated !== 0) {
    fail("draft manifest cannot contain a partial deployment");
  }
  if (manifest.state === "draft" && manifest.releaseId !== null) {
    fail("draft manifest cannot publish a releaseId");
  }
  if (manifest.state !== "draft" && activated !== CONTRACT_KEYS.length) {
    fail("configured/verified/active manifests require all seven contracts");
  }
  if (manifest.state !== "draft" && (!manifest.releaseId || !manifest.namespace.suffix || !manifest.namespace.brand || !manifest.namespace.baseNode)) {
    fail("activation requires releaseId, brand, suffix and baseNode");
  }
  assertLegacyReleases(manifest);
  if (manifest.state !== "draft") {
    if (!/^[a-z0-9-]+$/.test(manifest.namespace.suffix!) || manifest.namespace.suffix!.includes(".")) {
      fail("namespace.suffix must be one lowercase ASCII label");
    }
    if (namehash(manifest.namespace.suffix!).toLowerCase() !== manifest.namespace.baseNode!.toLowerCase()) {
      fail("namespace.baseNode does not match the configured suffix namehash");
    }
  }
  if (manifest.state === "verified" || manifest.state === "active") {
    for (const key of RESOLVER_CAPABILITY_KEYS) {
      if (manifest.resolverCapabilities[key] !== EXPECTED_RESOLVER_CAPABILITIES[key]) {
        fail(`resolverCapabilities.${key} does not match the verified resolver surface`);
      }
    }
  }
  if (!manifest.bens || typeof manifest.bens !== "object") fail("bens status is required");
  if (manifest.bens.protocolConfigured && manifest.state !== "active") {
    fail("BENS cannot be configured before the release is active");
  }
  if (manifest.bens.subgraphSynced && (!manifest.bens.protocolConfigured || !manifest.bens.subgraphUrl)) {
    fail("BENS subgraph sync requires protocol configuration and a subgraph URL");
  }
  if (manifest.bens.protocolConfigured && (!manifest.bens.apiUrl || !manifest.bens.subgraphUrl)) {
    fail("configured BENS requires API and subgraph URLs");
  }
  if (manifest.bens.hostedArcscanActive && (!manifest.bens.protocolConfigured || !manifest.bens.subgraphSynced)) {
    fail("hosted ArcScan cannot be active before BENS protocol configuration");
  }
  if (!manifest.x402 || manifest.x402.network !== ARC_TESTNET_CAIP2 ||
      typeof manifest.x402.asset !== "string" ||
      manifest.x402.asset.toLowerCase() !== ARC_USDC.erc20Address || manifest.x402.scheme !== "exact") {
    fail("x402 Arc network, asset or scheme mismatch");
  }
  if (manifest.x402.active && manifest.state !== "active") {
    fail("x402 cannot activate before the release is active");
  }
  if (manifest.x402.active && manifest.x402.facilitatorUrl === null) {
    fail("active x402 requires a facilitator URL");
  }
  if (!manifest.permitIssuer || typeof manifest.permitIssuer !== "object" || typeof manifest.permitIssuer.active !== "boolean") {
    fail("permitIssuer configuration is required");
  }
  if (manifest.state === "active" && !manifest.permitIssuer.active) {
    fail("Release 1 activation requires the dedicated permit issuer to be active");
  }
  if (manifest.permitIssuer.active) {
    if (manifest.state !== "active") fail("permit issuer cannot activate before the release");
    if (!manifest.permitIssuer.url || !manifest.permitIssuer.signerAddress || !manifest.permitIssuer.policyVersion) {
      fail("active permit issuer requires URL, signer address and policy version");
    }
    assertPublicEvidenceUrl(manifest.permitIssuer.url, "permitIssuer.url");
  }
  if (manifest.permitIssuer.signerAddress !== null && !isAddress(manifest.permitIssuer.signerAddress)) {
    fail("permit issuer signerAddress is invalid");
  }
  if (
    manifest.permitIssuer.signerAddress !== null &&
    getAddress(manifest.permitIssuer.signerAddress) === "0x0000000000000000000000000000000000000000"
  ) {
    fail("permit issuer signerAddress cannot be the zero address");
  }
  if (manifest.permitIssuer.publicKey !== null && !/^0x[0-9a-fA-F]+$/.test(manifest.permitIssuer.publicKey)) {
    fail("permit issuer publicKey is invalid");
  }
  if (manifest.permitIssuer.policyVersion !== null && !/^[1-9][0-9]*$/.test(manifest.permitIssuer.policyVersion)) {
    fail("permit issuer policyVersion must be a positive integer string or null");
  }
  assertNullableUrl(manifest.permitIssuer.url, "permitIssuer.url");
  assertNullableUrl(manifest.discovery.manifestUrl, "discovery.manifestUrl");
  assertNullableUrl(manifest.discovery.agentManifestUrl, "discovery.agentManifestUrl");
  assertNullableUrl(manifest.discovery.mcpUrl, "discovery.mcpUrl");
  assertNullableUrl(manifest.discovery.openApiUrl, "discovery.openApiUrl");
  assertNullableUrl(manifest.bens.apiUrl, "bens.apiUrl");
  assertNullableUrl(manifest.bens.subgraphUrl, "bens.subgraphUrl");
  assertNullableUrl(manifest.x402.facilitatorUrl, "x402.facilitatorUrl");
}

export function parseDeploymentManifest(value: unknown): DeploymentManifest {
  assertDeploymentManifest(value);
  return value;
}

/** Stable semantic digest used to bind a build-time live-promotion attestation. */
export function deploymentManifestDigest(value: unknown): Hex {
  return sha256(stringToBytes(JSON.stringify(value)));
}

/**
 * Canonical reviewer-signature subject. Artifact locations and hashes are
 * intentionally blanked to avoid a cryptographic fixed point while the
 * release, contracts, governance, policies and product-live intent remain
 * bound.
 */
export function promotionSubjectDigest(manifest: DeploymentManifest): Hex {
  const subject = structuredClone(manifest);
  for (const key of ACTIVATION_ARTIFACT_KEYS) {
    subject.activationEvidence.artifacts[key] = { url: null, sha256: null };
  }
  return deploymentManifestDigest(subject);
}

function sortSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortSemanticValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => [key, sortSemanticValue((value as Record<string, unknown>)[key])]),
  );
}

/**
 * Cross-stage execution-state identity for a private-candidate -> product-live
 * promotion. The digest deliberately projects both inputs onto the public-live
 * intent, while removing only the stage-specific verification block and the
 * artifact URL/hash pairs that cannot exist until the runs are complete.
 *
 * This is not a reviewer signature subject. Callers must still validate that
 * the candidate has productLive=false, the target has productLive=true, and the
 * target verification block is strictly later. Reviewer signatures continue to
 * use promotionSubjectDigest(), which binds the exact target block and intent.
 */
export function promotionExecutionTargetDigest(manifest: DeploymentManifest): Hex {
  const target = structuredClone(manifest);
  target.activationEvidence.productLive = true;
  target.activationEvidence.verifiedAtBlock = null;
  for (const key of ACTIVATION_ARTIFACT_KEYS) {
    target.activationEvidence.artifacts[key] = { url: null, sha256: null };
  }
  return deploymentManifestDigest(sortSemanticValue(target));
}

/**
 * Returns a source-verified deployed contract for read-only calls. Configured
 * releases are intentionally readable before transaction execution is
 * activated, but drafts and unverified deployments remain fail-closed.
 */
export function requireDeployedContract(
  manifest: DeploymentManifest,
  contract: ContractKey,
): Address {
  const deployment = manifest.contracts[contract];
  if (
    manifest.state === "draft" ||
    deployment.address === null ||
    !deployment.sourceVerified
  ) {
    throw new ManifestValidationError(
      `${contract} is not a source-verified deployment; refusing contract read`,
    );
  }
  return deployment.address;
}

export function requireActivatedContract(
  manifest: DeploymentManifest,
  contract: ContractKey,
): Address {
  // `active + productLive:false` is deliberately executable only for private
  // funded acceptance. Public product surfaces enforce productLive separately.
  const address = manifest.contracts[contract].address;
  if (manifest.state !== "active" || address === null) {
    throw new ManifestValidationError(`${contract} is not active; refusing to prepare execution`);
  }
  return address;
}
