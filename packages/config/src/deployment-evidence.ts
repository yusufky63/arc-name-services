import {
  concatHex,
  decodeAbiParameters,
  decodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  sha256,
  stringToHex,
  type Abi,
  type AbiParameter,
  type Address,
  type Hex,
} from "viem";
import {
  ACTIVATION_ARTIFACT_KEYS,
  CANONICAL_NFT_METADATA_BASE_URI,
  CONTRACT_KEYS,
  RESOLVER_CAPABILITY_KEYS,
  parseDeploymentManifest,
  registrarVersionOf,
  type ContractKey,
  type DeploymentManifest,
  type RegistrarVersion,
} from "./manifest.js";

export const ARC_DEPLOYMENT_CHAIN_ID = 5_042_002;
export const ARC_DEPLOYMENT_CAIP2 = "eip155:5042002";
export const ARC_DEPLOYMENT_USDC = "0x3600000000000000000000000000000000000000" as Address;
export const ARC_DEPLOYMENT_BASE_NODE =
  "0xb0622ac8c513b1e04f26418271b595fae314dbed2e3dea63916fc45cde7c5bbe" as Hex;
export const ARC_DEPLOYMENT_REVERSE_NODE =
  "0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2" as Hex;
export const ARC_DEPLOYMENT_NORMALIZATION_PROFILE_HASH =
  "0x0889fdb1d0500090d2c605094dd2bd30510a137778f641aca67d8d2fb491f89c" as Hex;
export const ARC_DEPLOYMENT_SUFFIX = "contour";

export interface ContractDefinition {
  key: ContractKey;
  contractName: string;
  sourceName: string;
  constructorTypes: readonly string[];
  immutableNames: readonly string[];
  envPrefix: string;
}

export const DEPLOYMENT_CONTRACT_DEFINITIONS: readonly ContractDefinition[] = [
  {
    key: "registry",
    contractName: "ArcNameRegistry",
    sourceName: "ArcNameRegistry.sol",
    constructorTypes: ["address"],
    immutableNames: [],
    envPrefix: "ARC_NAME_REGISTRY",
  },
  {
    key: "baseRegistrar",
    contractName: "ArcBaseRegistrar",
    sourceName: "ArcBaseRegistrar.sol",
    constructorTypes: ["address", "bytes32", "address"],
    immutableNames: ["registry", "baseNode"],
    envPrefix: "ARC_BASE_REGISTRAR",
  },
  {
    key: "controller",
    contractName: "ArcRegistrarController",
    sourceName: "ArcRegistrarController.sol",
    constructorTypes: [
      "address", "address", "address", "address", "address", "address", "bytes32", "bytes32", "uint16",
    ],
    immutableNames: [
      "registrar", "settlementAsset", "publicResolver", "baseNode", "releaseId", "normalizationProfileHash",
    ],
    envPrefix: "ARC_REGISTRAR_CONTROLLER",
  },
  {
    key: "publicResolver",
    contractName: "ArcPublicResolver",
    sourceName: "ArcPublicResolver.sol",
    constructorTypes: ["address"],
    immutableNames: ["registry"],
    envPrefix: "ARC_PUBLIC_RESOLVER",
  },
  {
    key: "reverseRegistrar",
    contractName: "ArcReverseRegistrar",
    sourceName: "ArcReverseRegistrar.sol",
    constructorTypes: ["address", "address", "address", "bytes32", "bytes32", "string"],
    immutableNames: ["registry", "defaultResolver", "registrar", "reverseNode", "baseNode"],
    envPrefix: "ARC_REVERSE_REGISTRAR",
  },
  {
    key: "universalResolver",
    contractName: "ArcUniversalResolver",
    sourceName: "ArcUniversalResolver.sol",
    constructorTypes: ["address", "address"],
    immutableNames: ["registry", "reverseRegistrar"],
    envPrefix: "ARC_UNIVERSAL_RESOLVER",
  },
  {
    key: "marketplace",
    contractName: "ArcNameMarketplace",
    sourceName: "ArcNameMarketplace.sol",
    constructorTypes: ["address", "address", "address", "address", "uint16"],
    immutableNames: ["registrar", "settlementAsset"],
    envPrefix: "ARC_NAME_MARKETPLACE",
  },
] as const;

export const V2_DEPLOYMENT_CONTRACT_DEFINITIONS: readonly ContractDefinition[] =
  DEPLOYMENT_CONTRACT_DEFINITIONS.map((definition) => (
    definition.key === "baseRegistrar"
      ? {
          ...definition,
          contractName: "ArcBaseRegistrarV2",
          sourceName: "ArcBaseRegistrarV2.sol",
          constructorTypes: ["address", "bytes32", "address", "string"],
        }
      : definition
  ));

export function deploymentContractDefinitions(
  registrarVersion: RegistrarVersion = "v1",
): readonly ContractDefinition[] {
  if (registrarVersion === "v1") return DEPLOYMENT_CONTRACT_DEFINITIONS;
  if (registrarVersion === "v2") return V2_DEPLOYMENT_CONTRACT_DEFINITIONS;
  fail("registrarVersion must be v1 or v2");
}

export function deploymentArtifactPaths(
  registrarVersion: RegistrarVersion = "v1",
): Readonly<Record<ContractKey, string>> {
  return Object.freeze(Object.fromEntries(
    deploymentContractDefinitions(registrarVersion).map((definition) => [
      definition.key,
      `${definition.sourceName}/${definition.contractName}.json`,
    ]),
  ) as Record<ContractKey, string>);
}

export const DEPLOYMENT_ARTIFACT_PATHS = deploymentArtifactPaths("v1");
export const V2_DEPLOYMENT_ARTIFACT_PATHS = deploymentArtifactPaths("v2");

const V1_DEFINITIONS = Object.freeze(Object.fromEntries(
  DEPLOYMENT_CONTRACT_DEFINITIONS.map((definition) => [
    definition.key,
    definition,
  ]),
) as Record<ContractKey, ContractDefinition>);

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ZERO_BYTES32 = `0x${"00".repeat(32)}` as Hex;
const CONTOUR_LABEL = keccak256(stringToHex(ARC_DEPLOYMENT_SUFFIX));
const REVERSE_LABEL = keccak256(stringToHex("reverse"));
const ADDR_LABEL = keccak256(stringToHex("addr"));
const REVERSE_ROOT = keccak256(concatHex([ZERO_BYTES32, REVERSE_LABEL]));

const CREATE_SEQUENCE: Readonly<Record<number, ContractKey>> = Object.freeze({
  0: "registry",
  1: "baseRegistrar",
  2: "publicResolver",
  3: "controller",
  7: "reverseRegistrar",
  9: "universalResolver",
  10: "marketplace",
});

const V1_WIRING_SEQUENCE = Object.freeze([
  "CREATE ArcNameRegistry",
  "CREATE ArcBaseRegistrar",
  "CREATE ArcPublicResolver",
  "CREATE ArcRegistrarController",
  "registry.setSubnodeOwner(root, contour, baseRegistrar)",
  "baseRegistrar.setController(controller, true)",
  "registry.setSubnodeOwner(root, reverse, deployer)",
  "CREATE ArcReverseRegistrar",
  "registry.setSubnodeOwner(reverseRoot, addr, reverseRegistrar)",
  "CREATE ArcUniversalResolver",
  "CREATE ArcNameMarketplace",
  "controller.setRegistrationsPaused(true)",
  "marketplace.setPaused(true)",
  "registry.setOwner(reverseRoot, governanceAccount)",
  "registry.setOwner(root, governanceAccount)",
]);

function definitionsByKey(
  registrarVersion: RegistrarVersion,
): Readonly<Record<ContractKey, ContractDefinition>> {
  if (registrarVersion === "v1") return V1_DEFINITIONS;
  return Object.freeze(Object.fromEntries(
    V2_DEPLOYMENT_CONTRACT_DEFINITIONS.map((definition) => [definition.key, definition]),
  ) as Record<ContractKey, ContractDefinition>);
}

function wiringSequence(registrarVersion: RegistrarVersion): readonly string[] {
  if (registrarVersion === "v1") return V1_WIRING_SEQUENCE;
  return V1_WIRING_SEQUENCE.map((entry) => (
    entry === "CREATE ArcBaseRegistrar" ? "CREATE ArcBaseRegistrarV2" : entry
  ));
}

export class DeploymentEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentEvidenceError";
  }
}

function fail(message: string): never {
  throw new DeploymentEvidenceError(message);
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value;
}

function hex(value: unknown, field: string): Hex {
  if (typeof value !== "string" || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    fail(`${field} must be even-length hex`);
  }
  return value as Hex;
}

function hex32(value: unknown, field: string, nonZero = true): Hex {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    fail(`${field} must be bytes32`);
  }
  if (nonZero && value.toLowerCase() === ZERO_BYTES32) fail(`${field} cannot be zero`);
  return value.toLowerCase() as Hex;
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) fail(`${field} must be an address`);
  const canonical = getAddress(value);
  if (canonical.toLowerCase() === ZERO_ADDRESS) fail(`${field} cannot be zero`);
  return canonical;
}

function quantity(value: unknown, field: string, allowZero = false): number {
  let parsed: bigint;
  try {
    if (typeof value === "bigint") parsed = value;
    else if (typeof value === "number" && Number.isSafeInteger(value)) parsed = BigInt(value);
    else if (typeof value === "string" && /^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) parsed = BigInt(value);
    else fail(`${field} must be an integer quantity`);
  } catch {
    fail(`${field} must be an integer quantity`);
  }
  if (parsed! < 0n || (!allowZero && parsed! === 0n) || parsed! > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(`${field} is outside the safe integer range`);
  }
  return Number(parsed!);
}

function decodedInteger(value: unknown, field: string, maximum: number): number {
  const parsed = quantity(value, field, true);
  if (parsed > maximum) fail(`${field} exceeds ${maximum}`);
  return parsed;
}

function sameAddress(left: unknown, right: unknown): boolean {
  return typeof left === "string" && typeof right === "string" && isAddress(left) && isAddress(right) &&
    getAddress(left).toLowerCase() === getAddress(right).toLowerCase();
}

function comparable(value: unknown): string {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "number") return BigInt(value).toString(10);
  if (typeof value === "string" && isAddress(value)) return getAddress(value).toLowerCase();
  if (typeof value === "string" && value.startsWith("0x")) return value.toLowerCase();
  return JSON.stringify(value);
}

function expectValues(actual: readonly unknown[], expected: readonly unknown[], field: string): void {
  if (actual.length !== expected.length) fail(`${field} argument count mismatch`);
  for (let index = 0; index < expected.length; index += 1) {
    if (comparable(actual[index]) !== comparable(expected[index])) {
      fail(`${field} argument ${index + 1} does not match the deployment script`);
    }
  }
}

function isEmptyObject(value: unknown): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== "object" || Array.isArray(value)) return false;
  return Object.keys(value as Record<string, unknown>).length === 0;
}

interface ParsedArtifact {
  abi: Abi;
  constructorInputs: readonly AbiParameter[];
  creationBytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences: unknown;
  compilerVersion: string;
  sourceKeccak256: Hex;
}

function parseArtifact(value: unknown, definition: ContractDefinition): ParsedArtifact {
  const artifact = record(value, `${definition.contractName} artifact`);
  const abi = array(artifact.abi, `${definition.contractName}.abi`) as Abi;
  const constructor = abi.find((item) => item.type === "constructor");
  const constructorInputs = constructor?.type === "constructor" ? constructor.inputs : [];
  const actualTypes = constructorInputs.map((input) => input.type);
  if (actualTypes.join(",") !== definition.constructorTypes.join(",")) {
    fail(`${definition.contractName} constructor ABI does not match the deployment script`);
  }

  const bytecode = record(artifact.bytecode, `${definition.contractName}.bytecode`);
  const deployed = record(artifact.deployedBytecode, `${definition.contractName}.deployedBytecode`);
  const creationBytecode = hex(bytecode.object, `${definition.contractName}.bytecode.object`);
  const deployedBytecode = hex(deployed.object, `${definition.contractName}.deployedBytecode.object`);
  if (creationBytecode.length <= 2 || deployedBytecode.length <= 2) {
    fail(`${definition.contractName} bytecode cannot be empty`);
  }
  if (!isEmptyObject(bytecode.linkReferences) || !isEmptyObject(deployed.linkReferences)) {
    fail(`${definition.contractName} must not depend on unlinked libraries`);
  }

  const metadata = record(artifact.metadata, `${definition.contractName}.metadata`);
  const compiler = record(metadata.compiler, `${definition.contractName}.metadata.compiler`);
  const compilerVersion = typeof compiler.version === "string" ? compiler.version : "";
  if (!compilerVersion.startsWith("0.8.24+")) fail(`${definition.contractName} must use solc 0.8.24`);
  const settings = record(metadata.settings, `${definition.contractName}.metadata.settings`);
  const optimizer = record(settings.optimizer, `${definition.contractName}.metadata.settings.optimizer`);
  if (optimizer.enabled !== true || optimizer.runs !== 10_000) {
    fail(`${definition.contractName} optimizer settings must be enabled with 10000 runs`);
  }
  const metadataSettings = record(settings.metadata, `${definition.contractName}.metadata.settings.metadata`);
  if (metadataSettings.bytecodeHash !== "none" || metadataSettings.appendCBOR !== false) {
    fail(`${definition.contractName} metadata must use bytecodeHash=none and appendCBOR=false`);
  }
  const target = record(settings.compilationTarget, `${definition.contractName}.metadata.settings.compilationTarget`);
  if (target[`src/${definition.sourceName}`] !== definition.contractName) {
    fail(`${definition.contractName} compilation target mismatch`);
  }
  const sources = record(metadata.sources, `${definition.contractName}.metadata.sources`);
  const source = record(sources[`src/${definition.sourceName}`], `${definition.contractName} source metadata`);
  const sourceKeccak256 = hex32(source.keccak256, `${definition.contractName} source keccak256`);

  return {
    abi,
    constructorInputs,
    creationBytecode,
    deployedBytecode,
    immutableReferences: deployed.immutableReferences,
    compilerVersion,
    sourceKeccak256,
  };
}

function immutableWord(value: unknown, field: string): string {
  if (typeof value !== "string") fail(`${field} must be an address or bytes32`);
  if (isAddress(value)) return getAddress(value).slice(2).toLowerCase().padStart(64, "0");
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value.slice(2).toLowerCase();
  fail(`${field} must be an address or bytes32`);
}

/** Reconstructs exact runtime code by filling Solidity's 32-byte immutable slots. */
export function reconstructRuntimeBytecode(
  deployedBytecode: Hex,
  immutableReferencesValue: unknown,
  immutableValues: readonly unknown[],
  field = "contract",
): Hex {
  const raw = hex(deployedBytecode, `${field}.deployedBytecode`).slice(2).toLowerCase();
  const referencesRecord = immutableReferencesValue === undefined || immutableReferencesValue === null
    ? {}
    : record(immutableReferencesValue, `${field}.immutableReferences`);
  const groups = Object.keys(referencesRecord).sort((left, right) => Number(left) - Number(right));
  if (groups.length !== immutableValues.length) {
    fail(`${field} immutable reference count does not match the reviewed contract layout`);
  }
  const bytes = raw.match(/.{2}/g) ?? [];
  const occupied = new Set<number>();
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex]!;
    if (!/^[0-9]+$/.test(group)) fail(`${field} immutable reference id is invalid`);
    const word = immutableWord(immutableValues[groupIndex], `${field}.${group}`);
    const references = array(referencesRecord[group], `${field}.immutableReferences.${group}`);
    if (references.length === 0) fail(`${field} immutable reference group cannot be empty`);
    for (const [referenceIndex, referenceValue] of references.entries()) {
      const reference = record(referenceValue, `${field}.immutableReferences.${group}[${referenceIndex}]`);
      const start = quantity(reference.start, `${field} immutable start`, true);
      const length = quantity(reference.length, `${field} immutable length`);
      if (length !== 32 || start + length > bytes.length) {
        fail(`${field} immutable reference must be an in-range 32-byte slot`);
      }
      for (let offset = start; offset < start + length; offset += 1) {
        if (occupied.has(offset)) fail(`${field} immutable references overlap`);
        occupied.add(offset);
      }
      if (bytes.slice(start, start + length).some((byte) => byte !== "00")) {
        fail(`${field} immutable artifact slot is not zero-filled`);
      }
      const replacement = word.match(/.{2}/g)!;
      bytes.splice(start, length, ...replacement);
    }
  }
  return `0x${bytes.join("")}` as Hex;
}

function decodeConstructorInput(
  entry: Record<string, unknown>,
  transaction: Record<string, unknown>,
  artifact: ParsedArtifact,
  definition: ContractDefinition,
): Record<string, unknown> {
  if (entry.transactionType !== "CREATE" || entry.contractName !== definition.contractName) {
    fail(`expected CREATE ${definition.contractName}`);
  }
  const input = hex(transaction.input, `${definition.contractName} transaction input`);
  if (!input.toLowerCase().startsWith(artifact.creationBytecode.toLowerCase())) {
    fail(`${definition.contractName} creation input does not match the reviewed artifact`);
  }
  const encodedArguments = `0x${input.slice(artifact.creationBytecode.length)}` as Hex;
  let decoded: readonly unknown[];
  try {
    decoded = artifact.constructorInputs.length === 0
      ? []
      : decodeAbiParameters(artifact.constructorInputs, encodedArguments);
  } catch {
    fail(`${definition.contractName} constructor arguments cannot be decoded`);
  }
  if (decoded!.length !== artifact.constructorInputs.length) {
    fail(`${definition.contractName} constructor argument count mismatch`);
  }
  return Object.fromEntries(artifact.constructorInputs.map((parameter, index) => [parameter.name, decoded![index]]));
}

function constructorValue(
  values: Record<string, unknown>,
  name: string,
  field: string,
): unknown {
  if (!Object.hasOwn(values, name)) fail(`${field} constructor is missing ${name}`);
  return values[name];
}

function decodeCall(
  entries: readonly Record<string, unknown>[],
  artifacts: Record<ContractKey, ParsedArtifact>,
  index: number,
  targetKey: ContractKey,
  targetAddress: Address,
  functionName: string,
): readonly unknown[] {
  const entry = entries[index];
  if (!entry) fail(`missing transaction ${index + 1}`);
  if (entry.transactionType !== "CALL") fail(`transaction ${index + 1} must be CALL ${functionName}`);
  const transaction = record(entry.transaction, `transactions[${index}].transaction`);
  if (!sameAddress(transaction.to, targetAddress)) {
    fail(`transaction ${index + 1} targets the wrong contract for ${functionName}`);
  }
  let decoded: { functionName: string; args: readonly unknown[] | undefined };
  try {
    decoded = decodeFunctionData({
      abi: artifacts[targetKey].abi,
      data: hex(transaction.input, `transactions[${index}].transaction.input`),
    });
  } catch {
    fail(`transaction ${index + 1} cannot decode ${functionName}`);
  }
  if (decoded!.functionName !== functionName) {
    fail(`transaction ${index + 1} must call ${functionName}`);
  }
  return decoded!.args ?? [];
}

function jsonValue(value: unknown): string | number | boolean | null | Array<unknown> | Record<string, unknown> {
  if (typeof value === "bigint") return value.toString(10);
  if (typeof value === "string" && isAddress(value)) return getAddress(value);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (typeof value === "object" && value) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  fail("decoded constructor value is not JSON-safe");
}

export interface PreparedContractEvidence {
  contractName: string;
  address: Address;
  transactionHash: Hex;
  deploymentBlock: number;
  runtimeCodeHash: Hex;
  creationCodeHash: Hex;
  canonicalAbiSha256: Hex;
  sourceKeccak256: Hex;
  constructorArguments: Record<string, unknown>;
  immutableNames: readonly string[];
}

export interface PreparedDeploymentEvidence {
  schemaVersion: "1.1.0";
  artifact: "contour-offline-deployment-evidence";
  chain: { id: typeof ARC_DEPLOYMENT_CHAIN_ID; caip2: typeof ARC_DEPLOYMENT_CAIP2 };
  config: {
    deployer: Address;
    governanceAccount: Address;
    permitSigner: Address;
    releaseId: Hex;
    referralBps: number;
    marketplaceFeeBps: number;
    registrarVersion: RegistrarVersion;
    metadataBaseURI: typeof CANONICAL_NFT_METADATA_BASE_URI | null;
  };
  contracts: Record<ContractKey, PreparedContractEvidence>;
  wiring: {
    validated: true;
    transactionCount: 15;
    sequence: readonly string[];
    suffix: typeof ARC_DEPLOYMENT_SUFFIX;
    baseNode: typeof ARC_DEPLOYMENT_BASE_NODE;
    reverseNode: typeof ARC_DEPLOYMENT_REVERSE_NODE;
    settlementAsset: typeof ARC_DEPLOYMENT_USDC;
    normalizationProfileHash: typeof ARC_DEPLOYMENT_NORMALIZATION_PROFILE_HASH;
  };
  offlineLimitations: readonly string[];
}

interface TransactionEvidence {
  entry: Record<string, unknown>;
  transaction: Record<string, unknown>;
  receipt: Record<string, unknown>;
  transactionHash: Hex;
  blockNumber: number;
}

export interface PrepareDeploymentEvidenceOptions {
  /** V1 remains the compatibility default; V2 must always be selected explicitly. */
  registrarVersion?: RegistrarVersion;
}

function immutableValues(
  key: ContractKey,
  constructors: Record<ContractKey, Record<string, unknown>>,
): readonly unknown[] {
  const values = constructors[key];
  switch (key) {
    case "registry": return [];
    case "baseRegistrar": return [values.registry_, values.baseNode_];
    case "publicResolver": return [values.registry_];
    case "controller": return [
      values.registrar_, values.settlementAsset_, values.publicResolver_, ARC_DEPLOYMENT_BASE_NODE,
      values.releaseId_, values.normalizationProfileHash_,
    ];
    case "reverseRegistrar": return [
      values.registry_, values.defaultResolver_, values.registrar_, values.reverseNode_, values.baseNode_,
    ];
    case "universalResolver": return [values.registry_, values.reverseRegistrar_];
    case "marketplace": return [values.registrar_, values.settlementAsset_];
  }
}

/**
 * Validates a completed Foundry broadcast and reconstructs deployment evidence without RPC access.
 * This function deliberately requires the exact 15-transaction sequence emitted by the reviewed
 * DeployArcNameService script; partial or augmented broadcasts fail closed.
 */
export function prepareDeploymentEvidence(
  broadcastValue: unknown,
  artifactValues: Readonly<Record<ContractKey, unknown>>,
  options: PrepareDeploymentEvidenceOptions = {},
): PreparedDeploymentEvidence {
  const registrarVersion = options.registrarVersion ?? "v1";
  if (registrarVersion !== "v1" && registrarVersion !== "v2") {
    fail("registrarVersion must be v1 or v2");
  }
  const definitions = definitionsByKey(registrarVersion);
  const expectedWiringSequence = wiringSequence(registrarVersion);
  const broadcast = record(broadcastValue, "broadcast");
  const rawEntries = array(broadcast.transactions, "broadcast.transactions");
  const rawReceipts = array(broadcast.receipts, "broadcast.receipts");
  if (rawEntries.length !== expectedWiringSequence.length) {
    fail(`broadcast must contain exactly ${expectedWiringSequence.length} transactions`);
  }
  if (rawReceipts.length !== rawEntries.length) fail("every broadcast transaction must have one receipt");
  if (broadcast.pending !== undefined && array(broadcast.pending, "broadcast.pending").length !== 0) {
    fail("broadcast contains pending transactions");
  }

  const artifacts = {} as Record<ContractKey, ParsedArtifact>;
  for (const key of CONTRACT_KEYS) {
    artifacts[key] = parseArtifact(artifactValues[key], definitions[key]);
  }

  const receiptsByHash = new Map<string, Record<string, unknown>>();
  for (const [index, rawReceipt] of rawReceipts.entries()) {
    const receipt = record(rawReceipt, `receipts[${index}]`);
    const transactionHash = hex32(receipt.transactionHash, `receipts[${index}].transactionHash`);
    if (receiptsByHash.has(transactionHash)) fail("receipt transaction hashes must be unique");
    receiptsByHash.set(transactionHash, receipt);
  }

  const entries: Record<string, unknown>[] = [];
  const transactions: TransactionEvidence[] = [];
  let deployer: Address | undefined;
  for (const [index, rawEntry] of rawEntries.entries()) {
    const entry = record(rawEntry, `transactions[${index}]`);
    const transaction = record(entry.transaction, `transactions[${index}].transaction`);
    const transactionHash = hex32(entry.hash, `transactions[${index}].hash`);
    const receipt = receiptsByHash.get(transactionHash);
    if (!receipt) fail(`transaction ${index + 1} has no matching receipt`);
    if (quantity(receipt.status, `receipts for transaction ${index + 1}.status`, true) !== 1) {
      fail(`transaction ${index + 1} did not succeed`);
    }
    const from = address(transaction.from, `transactions[${index}].transaction.from`);
    if (deployer === undefined) deployer = from;
    else if (!sameAddress(deployer, from)) fail("all broadcast transactions must use one deployer");
    if (quantity(transaction.chainId, `transactions[${index}].transaction.chainId`) !== ARC_DEPLOYMENT_CHAIN_ID) {
      fail(`transaction ${index + 1} is not for Arc Testnet`);
    }
    if (quantity(transaction.value ?? 0, `transactions[${index}].transaction.value`, true) !== 0) {
      fail(`transaction ${index + 1} unexpectedly transfers native value`);
    }
    entries.push(entry);
    transactions.push({
      entry,
      transaction,
      receipt,
      transactionHash,
      blockNumber: quantity(receipt.blockNumber, `receipts for transaction ${index + 1}.blockNumber`),
    });
  }
  if (receiptsByHash.size !== transactions.length) fail("broadcast contains unmatched receipts");

  const deployments = {} as Record<ContractKey, { address: Address; transactionHash: Hex; deploymentBlock: number }>;
  const constructors = {} as Record<ContractKey, Record<string, unknown>>;
  for (const [indexText, key] of Object.entries(CREATE_SEQUENCE)) {
    const index = Number(indexText);
    const evidence = transactions[index]!;
    const definition = definitions[key];
    constructors[key] = decodeConstructorInput(evidence.entry, evidence.transaction, artifacts[key], definition);
    const entryAddress = address(evidence.entry.contractAddress, `${definition.contractName}.contractAddress`);
    const receiptAddress = address(evidence.receipt.contractAddress, `${definition.contractName} receipt.contractAddress`);
    if (!sameAddress(entryAddress, receiptAddress)) fail(`${definition.contractName} receipt address mismatch`);
    deployments[key] = {
      address: entryAddress,
      transactionHash: evidence.transactionHash,
      deploymentBlock: evidence.blockNumber,
    };
  }
  const distinctAddresses = new Set(CONTRACT_KEYS.map((key) => deployments[key].address.toLowerCase()));
  if (distinctAddresses.size !== CONTRACT_KEYS.length) fail("all seven deployed contract addresses must be distinct");

  const registry = deployments.registry.address;
  const baseRegistrar = deployments.baseRegistrar.address;
  const controller = deployments.controller.address;
  const publicResolver = deployments.publicResolver.address;
  const reverseRegistrar = deployments.reverseRegistrar.address;
  const universalResolver = deployments.universalResolver.address;
  const marketplace = deployments.marketplace.address;
  const deployerAddress = deployer!;

  const registryConstructor = constructors.registry;
  expectValues(
    [constructorValue(registryConstructor, "rootOwner", "registry")],
    [deployerAddress],
    "ArcNameRegistry constructor",
  );
  expectValues(
    registrarVersion === "v2"
      ? [
          constructors.baseRegistrar.registry_,
          constructors.baseRegistrar.baseNode_,
          constructors.baseRegistrar.initialOwner,
          constructors.baseRegistrar.initialMetadataBaseURI,
        ]
      : [
          constructors.baseRegistrar.registry_,
          constructors.baseRegistrar.baseNode_,
          constructors.baseRegistrar.initialOwner,
        ],
    registrarVersion === "v2"
      ? [
          registry,
          ARC_DEPLOYMENT_BASE_NODE,
          deployerAddress,
          CANONICAL_NFT_METADATA_BASE_URI,
        ]
      : [registry, ARC_DEPLOYMENT_BASE_NODE, deployerAddress],
    registrarVersion === "v2"
      ? "ArcBaseRegistrarV2 constructor"
      : "ArcBaseRegistrar constructor",
  );
  expectValues(
    [constructors.publicResolver.registry_],
    [registry],
    "ArcPublicResolver constructor",
  );

  const permitSigner = address(constructors.controller.permitSigner_, "controller permit signer");
  const treasury = address(constructors.controller.treasury_, "controller treasury");
  const releaseId = hex32(constructors.controller.releaseId_, "controller release ID");
  const referralBps = decodedInteger(constructors.controller.referralBps_, "controller referral bps", 3_000);
  expectValues(
    [
      constructors.controller.registrar_, constructors.controller.settlementAsset_,
      constructors.controller.publicResolver_, constructors.controller.initialOwner,
      constructors.controller.permitSigner_, constructors.controller.treasury_,
      constructors.controller.releaseId_, constructors.controller.normalizationProfileHash_,
      constructors.controller.referralBps_,
    ],
    [
      baseRegistrar, ARC_DEPLOYMENT_USDC, publicResolver, deployerAddress, permitSigner, treasury,
      releaseId, ARC_DEPLOYMENT_NORMALIZATION_PROFILE_HASH, BigInt(referralBps),
    ],
    "ArcRegistrarController constructor",
  );
  expectValues(
    [
      constructors.reverseRegistrar.registry_, constructors.reverseRegistrar.defaultResolver_,
      constructors.reverseRegistrar.registrar_, constructors.reverseRegistrar.reverseNode_,
      constructors.reverseRegistrar.baseNode_, constructors.reverseRegistrar.suffix_,
    ],
    [
      registry, publicResolver, baseRegistrar, ARC_DEPLOYMENT_REVERSE_NODE,
      ARC_DEPLOYMENT_BASE_NODE, ARC_DEPLOYMENT_SUFFIX,
    ],
    "ArcReverseRegistrar constructor",
  );
  expectValues(
    [constructors.universalResolver.registry_, constructors.universalResolver.reverseRegistrar_],
    [registry, reverseRegistrar],
    "ArcUniversalResolver constructor",
  );
  const marketplaceFeeBps = decodedInteger(
    constructors.marketplace.feeBps_,
    "marketplace fee bps",
    1_000,
  );
  expectValues(
    [
      constructors.marketplace.registrar_, constructors.marketplace.settlementAsset_,
      constructors.marketplace.initialOwner, constructors.marketplace.treasury_, constructors.marketplace.feeBps_,
    ],
    [baseRegistrar, ARC_DEPLOYMENT_USDC, deployerAddress, treasury, BigInt(marketplaceFeeBps)],
    "ArcNameMarketplace constructor",
  );

  expectValues(
    decodeCall(entries, artifacts, 4, "registry", registry, "setSubnodeOwner"),
    [ZERO_BYTES32, CONTOUR_LABEL, baseRegistrar],
    "transaction 5 setSubnodeOwner",
  );
  expectValues(
    decodeCall(entries, artifacts, 5, "baseRegistrar", baseRegistrar, "setController"),
    [controller, true],
    "transaction 6 setController",
  );
  expectValues(
    decodeCall(entries, artifacts, 6, "registry", registry, "setSubnodeOwner"),
    [ZERO_BYTES32, REVERSE_LABEL, deployerAddress],
    "transaction 7 reverse root",
  );
  expectValues(
    decodeCall(entries, artifacts, 8, "registry", registry, "setSubnodeOwner"),
    [REVERSE_ROOT, ADDR_LABEL, reverseRegistrar],
    "transaction 9 addr.reverse",
  );
  expectValues(
    decodeCall(entries, artifacts, 11, "controller", controller, "setRegistrationsPaused"),
    [true],
    "transaction 12 registration pause",
  );
  expectValues(
    decodeCall(entries, artifacts, 12, "marketplace", marketplace, "setPaused"),
    [true],
    "transaction 13 marketplace pause",
  );
  const governanceAccount = deployerAddress;
  expectValues(
    decodeCall(entries, artifacts, 13, "registry", registry, "setOwner"),
    [REVERSE_ROOT, governanceAccount],
    "transaction 14 reverse ownership",
  );
  expectValues(
    decodeCall(entries, artifacts, 14, "registry", registry, "setOwner"),
    [ZERO_BYTES32, governanceAccount],
    "transaction 15 root ownership",
  );
  if (
    !sameAddress(governanceAccount, deployerAddress) ||
    !sameAddress(treasury, governanceAccount) ||
    !sameAddress(permitSigner, governanceAccount)
  ) {
    fail("deployer, protocol owner, treasury and permit signer must be the same Arc Testnet account");
  }

  const contractEvidence = {} as Record<ContractKey, PreparedContractEvidence>;
  for (const key of CONTRACT_KEYS) {
    const definition = definitions[key];
    const artifact = artifacts[key];
    const runtime = reconstructRuntimeBytecode(
      artifact.deployedBytecode,
      artifact.immutableReferences,
      immutableValues(key, constructors),
      definition.contractName,
    );
    contractEvidence[key] = {
      contractName: definition.contractName,
      ...deployments[key],
      runtimeCodeHash: keccak256(runtime),
      creationCodeHash: keccak256(artifact.creationBytecode),
      canonicalAbiSha256: sha256(stringToHex(JSON.stringify(artifact.abi))),
      sourceKeccak256: artifact.sourceKeccak256,
      constructorArguments: Object.fromEntries(
        Object.entries(constructors[key]).map(([name, value]) => [name, jsonValue(value)]),
      ),
      immutableNames: definition.immutableNames,
    };
  }

  // Silence accidental omission in future refactors: both deployed read contracts are expected.
  if (!universalResolver || !marketplace) fail("read and marketplace deployments are required");

  return {
    schemaVersion: "1.1.0",
    artifact: "contour-offline-deployment-evidence",
    chain: { id: ARC_DEPLOYMENT_CHAIN_ID, caip2: ARC_DEPLOYMENT_CAIP2 },
    config: {
      deployer: deployerAddress,
      governanceAccount,
      permitSigner,
      releaseId,
      referralBps,
      marketplaceFeeBps,
      registrarVersion,
      metadataBaseURI:
        registrarVersion === "v2" ? CANONICAL_NFT_METADATA_BASE_URI : null,
    },
    contracts: contractEvidence,
    wiring: {
      validated: true,
      transactionCount: 15,
      sequence: expectedWiringSequence,
      suffix: ARC_DEPLOYMENT_SUFFIX,
      baseNode: ARC_DEPLOYMENT_BASE_NODE,
      reverseNode: ARC_DEPLOYMENT_REVERSE_NODE,
      settlementAsset: ARC_DEPLOYMENT_USDC,
      normalizationProfileHash: ARC_DEPLOYMENT_NORMALIZATION_PROFILE_HASH,
    },
    offlineLimitations: [
      "Runtime hashes are reconstructed from reviewed local artifacts and constructor immutables; promotion must compare them with live Arc code.",
      "The governance account must be independently verified as a funded EOA with no runtime code during promotion.",
      "Source verification, ABI publication, funded end-to-end evidence and unpausing are not performed here.",
    ],
  };
}

function sameHex(left: string | null, right: string): boolean {
  return left !== null && left.toLowerCase() === right.toLowerCase();
}

function assertConfiguredTemplateMatchesEvidence(
  template: DeploymentManifest,
  evidence: PreparedDeploymentEvidence,
): void {
  assertReleaseIdentityMatchesEvidence(template, evidence);
  if (!sameHex(template.releaseId, evidence.config.releaseId)) {
    fail("configured manifest releaseId does not match the deployment receipt");
  }
  for (const key of CONTRACT_KEYS) {
    const configured = template.contracts[key];
    const prepared = evidence.contracts[key];
    if (configured.address === null || !sameAddress(configured.address, prepared.address)) {
      fail(`configured manifest ${key} address does not match the deployment receipt`);
    }
    if (configured.deploymentBlock !== prepared.deploymentBlock) {
      fail(`configured manifest ${key} deployment block does not match the deployment receipt`);
    }
    if (!sameHex(configured.transactionHash, prepared.transactionHash)) {
      fail(`configured manifest ${key} transaction hash does not match the deployment receipt`);
    }
    if (!sameHex(configured.runtimeCodeHash, prepared.runtimeCodeHash)) {
      fail(`configured manifest ${key} runtime code hash does not match the reviewed artifact`);
    }
  }

  const activation = template.activationEvidence;
  if (activation.productLive || activation.verifiedAtBlock !== null) {
    fail("configured manifest must remain unverified and product-live false");
  }
  for (const key of ACTIVATION_ARTIFACT_KEYS) {
    if (activation.artifacts[key].url !== null || activation.artifacts[key].sha256 !== null) {
      fail("configured manifest contains activation artifacts; use the live verifier instead of the offline preparer");
    }
  }
  const governanceAccount = activation.governance.account;
  if (governanceAccount === null || !sameAddress(governanceAccount, evidence.config.governanceAccount)) {
    fail("configured manifest governance account does not match the deployment receipt");
  }
  const controller = activation.controllerPolicy;
  if (
    controller.permitSigner === null || !sameAddress(controller.permitSigner, evidence.config.permitSigner) ||
    controller.signerPolicyVersion !== "1" || controller.referralBps !== evidence.config.referralBps ||
    controller.registrationsPaused !== true
  ) {
    fail("configured manifest controller policy does not match the paused deployment receipt");
  }
  if (
    activation.marketplacePolicy.feeBps !== evidence.config.marketplaceFeeBps ||
    activation.marketplacePolicy.paused !== true
  ) {
    fail("configured manifest marketplace policy does not match the paused deployment receipt");
  }
  if (
    template.permitIssuer.signerAddress === null ||
    !sameAddress(template.permitIssuer.signerAddress, evidence.config.permitSigner) ||
    template.permitIssuer.policyVersion !== "1" || template.permitIssuer.active
  ) {
    fail("configured manifest permit issuer metadata does not match the inactive deployment candidate");
  }
}

function assertReleaseIdentityMatchesEvidence(
  template: DeploymentManifest,
  evidence: PreparedDeploymentEvidence,
): void {
  const templateVersion = registrarVersionOf(template);
  if (templateVersion !== evidence.config.registrarVersion) {
    fail("manifest registrarVersion does not match the deployment evidence");
  }
  const templateMetadataBaseURI = template.nftMetadata?.metadataBaseURI ?? null;
  if (templateMetadataBaseURI !== evidence.config.metadataBaseURI) {
    fail("manifest nftMetadata does not match the registrar constructor");
  }
  if (templateVersion === "v2" && template.legacyReleases?.length !== 1) {
    fail("V2 deployment evidence requires exactly one retained V1 release reference");
  }
}

function stripUntrustedContractPublicationFields(template: Record<string, unknown>): Record<string, unknown> {
  const rawContracts = template.contracts;
  const rawX402 = template.x402;
  const strippedX402 =
    rawX402 && typeof rawX402 === "object" && !Array.isArray(rawX402) && template.state !== "active"
      ? { ...(rawX402 as Record<string, unknown>), active: false }
      : rawX402;

  if (!rawContracts || typeof rawContracts !== "object" || Array.isArray(rawContracts)) {
    return { ...template, ...(strippedX402 !== rawX402 ? { x402: strippedX402 } : {}) };
  }
  const contracts = { ...rawContracts } as Record<string, unknown>;
  for (const key of CONTRACT_KEYS) {
    const rawDeployment = contracts[key];
    if (!rawDeployment || typeof rawDeployment !== "object" || Array.isArray(rawDeployment)) continue;
    contracts[key] = {
      ...rawDeployment,
      abiUrl: null,
      abiSha256: null,
      sourceVerified: false,
      sourceVerificationUrl: null,
      sourceVerificationSha256: null,
    };
  }
  return { ...template, contracts, ...(strippedX402 !== rawX402 ? { x402: strippedX402 } : {}) };
}

/**
 * Creates a configured candidate while preserving all verification and product-live gates.
 * A previously generated configured candidate is accepted only when every receipt-derived field
 * still matches. Contract-level ABI and source-verification fields are deliberately ignored and
 * reset because the offline preparer cannot authenticate live ArcScan responses. This makes the
 * receipt-only operation idempotent without treating untrusted live metadata as offline proof.
 */
export function prepareConfiguredDeploymentManifest(
  templateValue: unknown,
  evidence: PreparedDeploymentEvidence,
): DeploymentManifest {
  const rawTemplate = record(templateValue, "manifest template");
  if (rawTemplate.state !== "draft" && rawTemplate.state !== "configured") {
    fail("manifest template must be a draft or an unverified configured candidate");
  }
  // Strip before schema validation: these fields came from a live service and are neither trusted
  // nor authenticated by this offline receipt path. The promotion verifier owns their validation.
  const template = parseDeploymentManifest(stripUntrustedContractPublicationFields(rawTemplate));
  assertReleaseIdentityMatchesEvidence(template, evidence);
  const configuredInput = template.state === "configured";
  if (configuredInput) assertConfiguredTemplateMatchesEvidence(template, evidence);
  // Rebuild from an explicit schema allowlist so unknown input fields can never be copied to a
  // generated public artifact. This matters even when a caller supplies a non-canonical template.
  const contracts = {} as DeploymentManifest["contracts"];
  for (const key of CONTRACT_KEYS) {
    const prepared = evidence.contracts[key];
    contracts[key] = {
      address: prepared.address,
      deploymentBlock: prepared.deploymentBlock,
      transactionHash: prepared.transactionHash,
      runtimeCodeHash: prepared.runtimeCodeHash,
      abiUrl: null,
      abiSha256: null,
      sourceVerified: false,
      sourceVerificationUrl: null,
      sourceVerificationSha256: null,
    };
  }
  const artifacts = {} as DeploymentManifest["activationEvidence"]["artifacts"];
  for (const key of ACTIVATION_ARTIFACT_KEYS) artifacts[key] = { url: null, sha256: null };
  const resolverCapabilities = {} as DeploymentManifest["resolverCapabilities"];
  for (const key of RESOLVER_CAPABILITY_KEYS) resolverCapabilities[key] = template.resolverCapabilities[key];
  const registrarVersion = registrarVersionOf(template);
  const releaseIdentity = template.registrarVersion !== undefined || registrarVersion === "v2"
    ? {
        registrarVersion,
        nftMetadata: registrarVersion === "v2"
          ? { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI }
          : null,
      }
    : {};
  const legacyIdentity = template.legacyReleases !== undefined
    ? { legacyReleases: structuredClone(template.legacyReleases) }
    : {};

  const manifest: DeploymentManifest = {
    schemaVersion: "1.1.0",
    state: "configured",
    releaseId: evidence.config.releaseId,
    ...releaseIdentity,
    ...legacyIdentity,
    testnet: true,
    chain: {
      id: template.chain.id,
      caip2: template.chain.caip2,
      rpcUrl: template.chain.rpcUrl,
      websocketUrl: template.chain.websocketUrl,
      explorerUrl: template.chain.explorerUrl,
      multicall3: template.chain.multicall3,
      confirmations: template.chain.confirmations,
    },
    settlement: {
      symbol: template.settlement.symbol,
      erc20Address: template.settlement.erc20Address,
      applicationDecimals: template.settlement.applicationDecimals,
      nativeInterfaceDecimals: template.settlement.nativeInterfaceDecimals,
      sharedUnderlyingBalance: template.settlement.sharedUnderlyingBalance,
    },
    namespace: {
      brand: template.namespace.brand,
      suffix: template.namespace.suffix,
      baseNode: template.namespace.baseNode,
    },
    normalization: {
      profileId: template.normalization.profileId,
      implementation: template.normalization.implementation,
      unicodeVersion: template.normalization.unicodeVersion,
      upstreamSpecSha256: template.normalization.upstreamSpecSha256,
      profileHash: template.normalization.profileHash,
      corpusHash: template.normalization.corpusHash,
    },
    contracts,
    activationEvidence: {
      productLive: false,
      verifiedAtBlock: null,
      artifacts,
      governance: {
        account: configuredInput
          ? getAddress(template.activationEvidence.governance.account!)
          : evidence.config.governanceAccount,
      },
      controllerPolicy: {
        permitSigner: evidence.config.permitSigner,
        signerPolicyVersion: "1",
        referralBps: evidence.config.referralBps,
        registrationsPaused: true,
      },
      marketplacePolicy: {
        feeBps: evidence.config.marketplaceFeeBps,
        paused: true,
      },
    },
    permitIssuer: {
      url: template.permitIssuer.url,
      signerAddress: evidence.config.permitSigner,
      publicKey: template.permitIssuer.publicKey,
      policyVersion: "1",
      active: false,
    },
    resolverCapabilities,
    discovery: {
      manifestUrl: template.discovery.manifestUrl,
      agentManifestUrl: template.discovery.agentManifestUrl,
      mcpUrl: template.discovery.mcpUrl,
      openApiUrl: template.discovery.openApiUrl,
    },
    bens: {
      protocolConfigured: template.bens.protocolConfigured,
      subgraphSynced: template.bens.subgraphSynced,
      apiUrl: template.bens.apiUrl,
      subgraphUrl: template.bens.subgraphUrl,
      hostedArcscanActive: template.bens.hostedArcscanActive,
    },
    x402: {
      active: false,
      network: template.x402.network,
      asset: template.x402.asset,
      scheme: template.x402.scheme,
      facilitatorUrl: null,
    },
  };
  return parseDeploymentManifest(manifest);
}

/** Renders only public on-chain configuration. No secret-shaped key is accepted or emitted. */
export function renderPublicDeploymentEnv(evidence: PreparedDeploymentEvidence): string {
  const lines = [
    "# PUBLIC deployment metadata generated from a validated Foundry receipt.",
    "# Never append private keys, mnemonics, API tokens, or signer credentials to this file.",
    `ARC_CHAIN_ID=${ARC_DEPLOYMENT_CHAIN_ID}`,
    `ARC_CAIP2=${ARC_DEPLOYMENT_CAIP2}`,
    `ARC_RELEASE_ID=${evidence.config.releaseId}`,
    `ARC_DEPLOYER_ADDRESS=${evidence.config.deployer}`,
    `ARC_GOVERNANCE_ACCOUNT=${evidence.config.governanceAccount}`,
    `ARC_PERMIT_SIGNER_ADDRESS=${evidence.config.permitSigner}`,
    `ARC_REFERRAL_BPS=${evidence.config.referralBps}`,
    `ARC_MARKETPLACE_FEE_BPS=${evidence.config.marketplaceFeeBps}`,
  ];
  if (evidence.config.registrarVersion === "v2") {
    lines.push(
      "ARC_REGISTRAR_VERSION=v2",
      `ARC_NFT_METADATA_BASE_URI=${evidence.config.metadataBaseURI}`,
    );
  }
  for (const definition of DEPLOYMENT_CONTRACT_DEFINITIONS) {
    const deployment = evidence.contracts[definition.key];
    lines.push(
      `${definition.envPrefix}_ADDRESS=${deployment.address}`,
      `${definition.envPrefix}_DEPLOYMENT_TX=${deployment.transactionHash}`,
      `${definition.envPrefix}_DEPLOYMENT_BLOCK=${deployment.deploymentBlock}`,
      `${definition.envPrefix}_RUNTIME_CODE_HASH=${deployment.runtimeCodeHash}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
