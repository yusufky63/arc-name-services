#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  concatHex,
  createPublicClient,
  encodeFunctionData,
  getAddress,
  keccak256,
  parseAbi,
  stringToHex,
  zeroAddress,
  zeroHash,
} from "viem";
import { arcTestnet } from "viem/chains";
import {
  CONTRACT_KEYS,
  deploymentManifestDigest,
  parseDeploymentManifest,
  registrarVersionOf,
} from "../packages/config/dist/index.js";
import { rateLimitedArcHttp } from "./lib/arc-rpc-transport.mjs";

const ARC_TESTNET_CHAIN_ID = 5_042_002;
const ARC_RPC_URL = "https://rpc.testnet.arc.network";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const REVERSE_NODE =
  "0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2";
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

const ownedAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
]);
const registryAbi = parseAbi([
  "function owner(bytes32 node) view returns (address)",
]);
const registrarAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function registry() view returns (address)",
  "function baseNode() view returns (bytes32)",
  "function controllers(address) view returns (bool)",
]);
const controllerAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function registrar() view returns (address)",
  "function settlementAsset() view returns (address)",
  "function publicResolver() view returns (address)",
  "function baseNode() view returns (bytes32)",
  "function releaseId() view returns (bytes32)",
  "function normalizationProfileHash() view returns (bytes32)",
  "function permitSigner() view returns (address)",
  "function pendingPermitSigner() view returns (address)",
  "function pendingPermitSignerValidAfter() view returns (uint64)",
  "function signerPolicyVersion() view returns (uint64)",
  "function treasury() view returns (address)",
  "function referralBps() view returns (uint16)",
  "function registrationsPaused() view returns (bool)",
  "function setRegistrationsPaused(bool paused)",
]);
const resolverAbi = parseAbi([
  "function registry() view returns (address)",
]);
const reverseAbi = parseAbi([
  "function registry() view returns (address)",
  "function defaultResolver() view returns (address)",
  "function registrar() view returns (address)",
  "function reverseNode() view returns (bytes32)",
  "function baseNode() view returns (bytes32)",
  "function suffix() view returns (string)",
]);
const universalAbi = parseAbi([
  "function registry() view returns (address)",
  "function reverseRegistrar() view returns (address)",
]);
const marketplaceAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function registrar() view returns (address)",
  "function settlementAsset() view returns (address)",
  "function treasury() view returns (address)",
  "function feeBps() view returns (uint16)",
  "function paused() view returns (bool)",
]);
const erc20Abi = parseAbi([
  "function decimals() view returns (uint8)",
]);

function fail(message) {
  throw new Error(`V1 cutover manifest refused: ${message}`);
}

function parsePositiveBlock(value) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    fail("--cutover-block must be a positive decimal integer");
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("--cutover-block exceeds the safe integer range");
  }
  return parsed;
}

export function parseV1CutoverManifestArguments(argv) {
  const allowed = new Set([
    "--manifest",
    "--pause-transaction",
    "--cutover-block",
    "--cutover-block-hash",
    "--output",
  ]);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag) || values.has(flag)) {
      fail(`unknown or duplicate argument ${String(flag)}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires one value`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of allowed) {
    if (!values.has(flag)) fail(`${flag} is required`);
  }
  const pauseTransactionHash = values.get("--pause-transaction");
  const cutoverBlockHash = values.get("--cutover-block-hash");
  if (!HASH_PATTERN.test(pauseTransactionHash)) {
    fail("--pause-transaction must be a transaction hash");
  }
  if (!HASH_PATTERN.test(cutoverBlockHash)) {
    fail("--cutover-block-hash must be a block hash");
  }
  const manifestPath = resolve(values.get("--manifest"));
  const outputPath = resolve(values.get("--output"));
  if (manifestPath === outputPath) {
    fail("output must differ from the source manifest");
  }
  return {
    manifestPath,
    outputPath,
    pauseTransactionHash,
    cutoverBlock: parsePositiveBlock(values.get("--cutover-block")),
    cutoverBlockHash,
  };
}

function requiredAddress(value, field) {
  if (typeof value !== "string" || !ADDRESS_PATTERN.test(value) || /^0x0{40}$/i.test(value)) {
    fail(`${field} is not a non-zero address`);
  }
  return getAddress(value);
}

function requiredHash(value, field) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value) || /^0x0{64}$/i.test(value)) {
    fail(`${field} is not a non-zero bytes32 value`);
  }
  return value.toLowerCase();
}

function exactAddress(actual, expected, field) {
  if (typeof actual !== "string" || !ADDRESS_PATTERN.test(actual)) {
    fail(`${field} is not an address`);
  }
  if (getAddress(actual) !== getAddress(expected)) fail(`${field} mismatch`);
}

function exactHash(actual, expected, field) {
  if (
    typeof actual !== "string" ||
    !HASH_PATTERN.test(actual) ||
    actual.toLowerCase() !== expected.toLowerCase()
  ) {
    fail(`${field} mismatch`);
  }
}

function exactInteger(actual, expected, field) {
  let normalized;
  try {
    normalized = BigInt(actual);
  } catch {
    fail(`${field} is not an integer`);
  }
  if (normalized !== BigInt(expected)) fail(`${field} mismatch`);
}

function call(key, address, abi, functionName, args = []) {
  return { key, address, abi, functionName, args };
}

function sourceIdentity(sourceValue, cutoverBlock) {
  const manifest = parseDeploymentManifest(sourceValue);
  if (registrarVersionOf(manifest) !== "v1") {
    fail("source manifest must be the retained V1 release");
  }
  if (
    manifest.state !== "active" ||
    manifest.activationEvidence.productLive !== false ||
    manifest.releaseId === null
  ) {
    fail("source manifest must be the active non-product-live V1 release");
  }
  if (manifest.activationEvidence.controllerPolicy.registrationsPaused !== false) {
    fail("source manifest must record V1 registrations open before the cutover transaction");
  }
  if (manifest.activationEvidence.marketplacePolicy.paused !== false) {
    fail("source manifest must record the retained V1 marketplace open");
  }
  if (
    !Number.isSafeInteger(manifest.activationEvidence.verifiedAtBlock) ||
    BigInt(manifest.activationEvidence.verifiedAtBlock) >= cutoverBlock
  ) {
    fail("cutover block must be later than the source V1 verification block");
  }
  const contracts = Object.fromEntries(CONTRACT_KEYS.map((key) => {
    const contract = manifest.contracts[key];
    return [key, {
      address: requiredAddress(contract.address, `manifest contracts.${key}.address`),
      runtimeCodeHash: requiredHash(
        contract.runtimeCodeHash,
        `manifest contracts.${key}.runtimeCodeHash`,
      ),
    }];
  }));
  return {
    manifest,
    releaseId: requiredHash(manifest.releaseId, "manifest releaseId"),
    governance: requiredAddress(
      manifest.activationEvidence.governance.account,
      "manifest governance account",
    ),
    settlementAsset: requiredAddress(
      manifest.settlement.erc20Address,
      "manifest settlement asset",
    ),
    baseNode: requiredHash(manifest.namespace.baseNode, "manifest base node"),
    profileHash: requiredHash(
      manifest.normalization.profileHash,
      "manifest normalization profile hash",
    ),
    contracts,
  };
}

function assertReceiptAndTransaction({
  receipt,
  transaction,
  block,
  identity,
  pauseTransactionHash,
  cutoverBlock,
  cutoverBlockHash,
}) {
  exactHash(block.hash, cutoverBlockHash, "canonical cutover block hash");
  if (BigInt(block.number) !== cutoverBlock) fail("canonical cutover block number mismatch");
  exactHash(receipt.transactionHash, pauseTransactionHash, "pause receipt transaction hash");
  exactHash(receipt.blockHash, cutoverBlockHash, "pause receipt block hash");
  exactInteger(receipt.blockNumber, cutoverBlock, "pause receipt block number");
  if (receipt.status !== "success") fail("pause receipt is not successful");
  exactAddress(receipt.to, identity.contracts.controller.address, "pause receipt target");
  exactAddress(receipt.from, identity.governance, "pause receipt sender");

  exactHash(transaction.hash, pauseTransactionHash, "pause transaction hash");
  exactHash(transaction.blockHash, cutoverBlockHash, "pause transaction block hash");
  exactInteger(transaction.blockNumber, cutoverBlock, "pause transaction block number");
  exactAddress(transaction.to, identity.contracts.controller.address, "pause transaction target");
  exactAddress(transaction.from, identity.governance, "pause transaction sender");
  const expectedInput = encodeFunctionData({
    abi: controllerAbi,
    functionName: "setRegistrationsPaused",
    args: [true],
  });
  if (
    typeof transaction.input !== "string" ||
    transaction.input.toLowerCase() !== expectedInput.toLowerCase()
  ) {
    fail("pause transaction calldata is not setRegistrationsPaused(true)");
  }
  exactInteger(transaction.value, 0n, "pause transaction value");
}

async function verifyRuntimeCode(client, identity, cutoverBlock, runtimeCodeHasher) {
  for (const key of CONTRACT_KEYS) {
    const expected = identity.contracts[key];
    const code = await client.getCode({
      address: expected.address,
      blockNumber: cutoverBlock,
    });
    if (!code || code === "0x") fail(`${key} runtime code is missing at cutover`);
    exactHash(
      runtimeCodeHasher(code),
      expected.runtimeCodeHash,
      `${key} runtime code hash`,
    );
  }
  const governanceCode = await client.getCode({
    address: identity.governance,
    blockNumber: cutoverBlock,
  });
  if (governanceCode && governanceCode !== "0x") {
    fail("governance account is not an EOA at cutover");
  }
  const settlementCode = await client.getCode({
    address: identity.settlementAsset,
    blockNumber: cutoverBlock,
  });
  if (!settlementCode || settlementCode === "0x") {
    fail("settlement asset runtime code is missing at cutover");
  }
}

async function verifyWiringAndPolicy(client, identity, cutoverBlock) {
  const reverseRoot = keccak256(
    concatHex([zeroHash, keccak256(stringToHex("reverse"))]),
  );
  const { contracts, manifest } = identity;
  const calls = [
    call("registryRootOwner", contracts.registry.address, registryAbi, "owner", [zeroHash]),
    call("registryBaseOwner", contracts.registry.address, registryAbi, "owner", [identity.baseNode]),
    call("registryReverseRootOwner", contracts.registry.address, registryAbi, "owner", [reverseRoot]),
    call("registryReverseOwner", contracts.registry.address, registryAbi, "owner", [REVERSE_NODE]),
    call("registrarOwner", contracts.baseRegistrar.address, registrarAbi, "owner"),
    call("registrarPendingOwner", contracts.baseRegistrar.address, registrarAbi, "pendingOwner"),
    call("registrarRegistry", contracts.baseRegistrar.address, registrarAbi, "registry"),
    call("registrarBaseNode", contracts.baseRegistrar.address, registrarAbi, "baseNode"),
    call(
      "registrarControllerEnabled",
      contracts.baseRegistrar.address,
      registrarAbi,
      "controllers",
      [contracts.controller.address],
    ),
    call("controllerOwner", contracts.controller.address, controllerAbi, "owner"),
    call("controllerPendingOwner", contracts.controller.address, controllerAbi, "pendingOwner"),
    call("controllerRegistrar", contracts.controller.address, controllerAbi, "registrar"),
    call("controllerSettlementAsset", contracts.controller.address, controllerAbi, "settlementAsset"),
    call("controllerPublicResolver", contracts.controller.address, controllerAbi, "publicResolver"),
    call("controllerBaseNode", contracts.controller.address, controllerAbi, "baseNode"),
    call("controllerReleaseId", contracts.controller.address, controllerAbi, "releaseId"),
    call(
      "controllerNormalizationProfileHash",
      contracts.controller.address,
      controllerAbi,
      "normalizationProfileHash",
    ),
    call("controllerPermitSigner", contracts.controller.address, controllerAbi, "permitSigner"),
    call(
      "controllerPendingPermitSigner",
      contracts.controller.address,
      controllerAbi,
      "pendingPermitSigner",
    ),
    call(
      "controllerPendingPermitSignerValidAfter",
      contracts.controller.address,
      controllerAbi,
      "pendingPermitSignerValidAfter",
    ),
    call(
      "controllerSignerPolicyVersion",
      contracts.controller.address,
      controllerAbi,
      "signerPolicyVersion",
    ),
    call("controllerTreasury", contracts.controller.address, controllerAbi, "treasury"),
    call("controllerReferralBps", contracts.controller.address, controllerAbi, "referralBps"),
    call(
      "controllerRegistrationsPaused",
      contracts.controller.address,
      controllerAbi,
      "registrationsPaused",
    ),
    call("resolverRegistry", contracts.publicResolver.address, resolverAbi, "registry"),
    call("reverseRegistry", contracts.reverseRegistrar.address, reverseAbi, "registry"),
    call(
      "reverseDefaultResolver",
      contracts.reverseRegistrar.address,
      reverseAbi,
      "defaultResolver",
    ),
    call("reverseRegistrar", contracts.reverseRegistrar.address, reverseAbi, "registrar"),
    call("reverseNode", contracts.reverseRegistrar.address, reverseAbi, "reverseNode"),
    call("reverseBaseNode", contracts.reverseRegistrar.address, reverseAbi, "baseNode"),
    call("reverseSuffix", contracts.reverseRegistrar.address, reverseAbi, "suffix"),
    call("universalRegistry", contracts.universalResolver.address, universalAbi, "registry"),
    call(
      "universalReverseRegistrar",
      contracts.universalResolver.address,
      universalAbi,
      "reverseRegistrar",
    ),
    call("marketplaceOwner", contracts.marketplace.address, marketplaceAbi, "owner"),
    call(
      "marketplacePendingOwner",
      contracts.marketplace.address,
      marketplaceAbi,
      "pendingOwner",
    ),
    call("marketplaceRegistrar", contracts.marketplace.address, marketplaceAbi, "registrar"),
    call(
      "marketplaceSettlementAsset",
      contracts.marketplace.address,
      marketplaceAbi,
      "settlementAsset",
    ),
    call("marketplaceTreasury", contracts.marketplace.address, marketplaceAbi, "treasury"),
    call("marketplaceFeeBps", contracts.marketplace.address, marketplaceAbi, "feeBps"),
    call("marketplacePaused", contracts.marketplace.address, marketplaceAbi, "paused"),
    call("settlementDecimals", identity.settlementAsset, erc20Abi, "decimals"),
  ];
  const values = await client.multicall({
    multicallAddress: MULTICALL3,
    allowFailure: false,
    blockNumber: cutoverBlock,
    contracts: calls.map(({ key: _key, ...spec }) => spec),
  });
  const state = Object.fromEntries(calls.map(({ key }, index) => [key, values[index]]));

  exactAddress(state.registryRootOwner, identity.governance, "registry root owner");
  exactAddress(state.registryBaseOwner, contracts.baseRegistrar.address, "registry base owner");
  exactAddress(state.registryReverseRootOwner, identity.governance, "registry reverse-root owner");
  exactAddress(
    state.registryReverseOwner,
    contracts.reverseRegistrar.address,
    "registry reverse owner",
  );
  exactAddress(state.registrarOwner, identity.governance, "registrar owner");
  exactAddress(state.registrarPendingOwner, zeroAddress, "registrar pending owner");
  exactAddress(state.registrarRegistry, contracts.registry.address, "registrar registry");
  exactHash(state.registrarBaseNode, identity.baseNode, "registrar base node");
  if (state.registrarControllerEnabled !== true) {
    fail("V1 controller is not enabled on the registrar");
  }
  exactAddress(state.controllerOwner, identity.governance, "controller owner");
  exactAddress(state.controllerPendingOwner, zeroAddress, "controller pending owner");
  exactAddress(state.controllerRegistrar, contracts.baseRegistrar.address, "controller registrar");
  exactAddress(
    state.controllerSettlementAsset,
    identity.settlementAsset,
    "controller settlement asset",
  );
  exactAddress(
    state.controllerPublicResolver,
    contracts.publicResolver.address,
    "controller public resolver",
  );
  exactHash(state.controllerBaseNode, identity.baseNode, "controller base node");
  exactHash(state.controllerReleaseId, identity.releaseId, "controller release ID");
  exactHash(
    state.controllerNormalizationProfileHash,
    identity.profileHash,
    "controller normalization profile hash",
  );
  exactAddress(
    state.controllerPermitSigner,
    manifest.activationEvidence.controllerPolicy.permitSigner,
    "controller permit signer",
  );
  exactAddress(
    state.controllerPendingPermitSigner,
    zeroAddress,
    "controller pending permit signer",
  );
  exactInteger(
    state.controllerPendingPermitSignerValidAfter,
    0n,
    "controller pending permit signer activation",
  );
  exactInteger(
    state.controllerSignerPolicyVersion,
    manifest.activationEvidence.controllerPolicy.signerPolicyVersion,
    "controller signer policy version",
  );
  exactAddress(state.controllerTreasury, identity.governance, "controller treasury");
  exactInteger(
    state.controllerReferralBps,
    manifest.activationEvidence.controllerPolicy.referralBps,
    "controller referral BPS",
  );
  if (state.controllerRegistrationsPaused !== true) {
    fail("V1 registrations are not paused at the cutover block");
  }
  exactAddress(state.resolverRegistry, contracts.registry.address, "resolver registry");
  exactAddress(state.reverseRegistry, contracts.registry.address, "reverse registrar registry");
  exactAddress(
    state.reverseDefaultResolver,
    contracts.publicResolver.address,
    "reverse default resolver",
  );
  exactAddress(
    state.reverseRegistrar,
    contracts.baseRegistrar.address,
    "reverse base registrar",
  );
  exactHash(state.reverseNode, REVERSE_NODE, "reverse node");
  exactHash(state.reverseBaseNode, identity.baseNode, "reverse base node");
  if (state.reverseSuffix !== manifest.namespace.suffix) fail("reverse suffix mismatch");
  exactAddress(
    state.universalRegistry,
    contracts.registry.address,
    "universal resolver registry",
  );
  exactAddress(
    state.universalReverseRegistrar,
    contracts.reverseRegistrar.address,
    "universal reverse registrar",
  );
  exactAddress(state.marketplaceOwner, identity.governance, "marketplace owner");
  exactAddress(state.marketplacePendingOwner, zeroAddress, "marketplace pending owner");
  exactAddress(
    state.marketplaceRegistrar,
    contracts.baseRegistrar.address,
    "marketplace registrar",
  );
  exactAddress(
    state.marketplaceSettlementAsset,
    identity.settlementAsset,
    "marketplace settlement asset",
  );
  exactAddress(state.marketplaceTreasury, identity.governance, "marketplace treasury");
  exactInteger(
    state.marketplaceFeeBps,
    manifest.activationEvidence.marketplacePolicy.feeBps,
    "marketplace fee BPS",
  );
  if (state.marketplacePaused !== false) {
    fail("retained V1 marketplace is paused at the cutover block");
  }
  exactInteger(state.settlementDecimals, manifest.settlement.applicationDecimals, "USDC decimals");
}

export async function prepareV1CutoverManifest({
  sourceValue,
  pauseTransactionHash,
  cutoverBlock,
  cutoverBlockHash,
  client,
  runtimeCodeHasher = keccak256,
}) {
  if (typeof runtimeCodeHasher !== "function") fail("runtime code hasher is invalid");
  const identity = sourceIdentity(sourceValue, cutoverBlock);
  const chainId = await client.getChainId();
  if (chainId !== ARC_TESTNET_CHAIN_ID) fail("connected chain is not Arc Testnet");
  const head = await client.getBlockNumber();
  const confirmations = BigInt(identity.manifest.chain.confirmations);
  if (head < cutoverBlock + confirmations - 1n) {
    fail("cutover receipt does not have the manifest-required confirmations");
  }
  const [block, receipt, transaction] = await Promise.all([
    client.getBlock({ blockNumber: cutoverBlock, includeTransactions: false }),
    client.getTransactionReceipt({ hash: pauseTransactionHash }),
    client.getTransaction({ hash: pauseTransactionHash }),
  ]);
  assertReceiptAndTransaction({
    receipt,
    transaction,
    block,
    identity,
    pauseTransactionHash,
    cutoverBlock,
    cutoverBlockHash,
  });
  await verifyRuntimeCode(client, identity, cutoverBlock, runtimeCodeHasher);
  await verifyWiringAndPolicy(client, identity, cutoverBlock);

  const output = structuredClone(identity.manifest);
  output.activationEvidence.productLive = false;
  output.activationEvidence.verifiedAtBlock = Number(cutoverBlock);
  output.activationEvidence.controllerPolicy.registrationsPaused = true;
  output.activationEvidence.marketplacePolicy.paused = false;
  return {
    manifest: parseDeploymentManifest(output),
    verification: {
      schemaVersion: "1.0.0",
      artifact: "v1CutoverManifest",
      verdict: "PASS",
      chainId: ARC_TESTNET_CHAIN_ID,
      releaseId: identity.releaseId,
      pauseTransactionHash: pauseTransactionHash.toLowerCase(),
      cutoverBlock: Number(cutoverBlock),
      cutoverBlockHash: cutoverBlockHash.toLowerCase(),
    },
  };
}

function createClient(rpcUrl) {
  return createPublicClient({
    chain: arcTestnet,
    batch: { multicall: { wait: 25 } },
    transport: rateLimitedArcHttp(rpcUrl),
  });
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseV1CutoverManifestArguments(argv);
  let sourceValue;
  try {
    sourceValue = JSON.parse(await readFile(options.manifestPath, "utf8"));
  } catch {
    fail("source manifest is unreadable or invalid JSON");
  }
  const rpcUrl = sourceValue?.chain?.rpcUrl;
  if (rpcUrl !== ARC_RPC_URL) fail(`source manifest RPC must exactly equal ${ARC_RPC_URL}`);
  const configuredRpc = (dependencies.environment ?? process.env).ARC_RPC_URL?.trim();
  if (configuredRpc && configuredRpc !== ARC_RPC_URL) {
    fail(`ARC_RPC_URL must exactly equal ${ARC_RPC_URL}`);
  }
  const result = await prepareV1CutoverManifest({
    sourceValue,
    pauseTransactionHash: options.pauseTransactionHash,
    cutoverBlock: options.cutoverBlock,
    cutoverBlockHash: options.cutoverBlockHash,
    client: dependencies.client ?? createClient(ARC_RPC_URL),
    ...(dependencies.runtimeCodeHasher
      ? { runtimeCodeHasher: dependencies.runtimeCodeHasher }
      : {}),
  });
  const bytes = `${JSON.stringify(result.manifest, null, 2)}\n`;
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, bytes, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const stdout = dependencies.stdout ?? process.stdout;
  stdout.write(`${JSON.stringify({
    ...result.verification,
    output: options.outputPath,
    manifestSha256: deploymentManifestDigest(result.manifest),
    outputFileSha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
  }, null, 2)}\n`);
  return { ...result, outputPath: options.outputPath };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "V1 cutover manifest failed"}\n`,
    );
    process.exitCode = 1;
  });
}
