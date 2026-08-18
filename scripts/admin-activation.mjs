#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  keccak256,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rateLimitedArcHttp } from "./lib/arc-rpc-transport.mjs";
import { normalizeOperatorPrivateKey } from "./lib/operator-key.mjs";
import {
  loadRegistrationSmokeEvidence,
  registrationSmokeBindingRecord,
  revalidateRegistrationSmokeEvidence,
  validateRegistrationSmokeLifecycle,
} from "./lib/registration-smoke-evidence.mjs";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ARC_TESTNET_RPC_URL = "https://rpc.testnet.arc.network";
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const RPC_READ_RETRY_DEFAULTS = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 1_000,
});
const TRANSIENT_RPC_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "EAI_AGAIN",
  "ERR_NETWORK",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const TRANSIENT_RPC_MESSAGE_PATTERN = /(?:\b429\b|too many requests|rate[ -]?limit|request limit|temporar(?:y|ily) unavailable|service unavailable|bad gateway|gateway timeout|network error|fetch failed|socket hang up|timed?\s*out|econnreset|econnrefused|etimedout|eai_again|enotfound)/i;

export const adminActivationConstants = Object.freeze({
  chainId: 5_042_002,
  actions: Object.freeze([
    "controller-open",
    "market-open",
    "pause-all",
    "controller-pause",
    "market-pause",
  ]),
});

const ARC_TESTNET = Object.freeze({
  id: adminActivationConstants.chainId,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_TESTNET_RPC_URL] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});

const ownedAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
]);
const controllerAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function releaseId() view returns (bytes32)",
  "function registrationsPaused() view returns (bool)",
  "function setRegistrationsPaused(bool paused)",
]);
const marketplaceAbi = parseAbi([
  "function owner() view returns (address)",
  "function pendingOwner() view returns (address)",
  "function paused() view returns (bool)",
  "function setPaused(bool paused)",
]);

const USAGE = [
  "usage: admin-activation --manifest <manifest.json>",
  "  --action <controller-open|market-open|pause-all|controller-pause|market-pause>",
  "  [--registration-smoke <pass-report.json> --candidate-origin <https://candidate.example>]",
  "  [--broadcast --confirm-release <exact-release-id>]",
].join(" ");

function fail(message) {
  throw new Error(`admin activation refused: ${message}`);
}

function address(value, field) {
  if (typeof value !== "string") fail(`${field} must be an address`);
  try {
    return getAddress(value);
  } catch {
    fail(`${field} must be an address`);
  }
}

function exactAddress(actual, expected, field) {
  if (address(actual, field) !== getAddress(expected)) {
    fail(`${field} does not match the selected deployment manifest`);
  }
}

function exactHash(actual, expected, field) {
  if (typeof actual !== "string" || !HASH_PATTERN.test(actual) || actual.toLowerCase() !== expected.toLowerCase()) {
    fail(`${field} does not match the selected deployment manifest`);
  }
}

function requiredManifestAddress(value, field) {
  const normalized = address(value, field);
  if (normalized === ZERO_ADDRESS) fail(`${field} must not be the zero address`);
  return normalized;
}

function requiredManifestHash(value, field) {
  if (typeof value !== "string" || !HASH_PATTERN.test(value) || /^0x0{64}$/i.test(value)) {
    fail(`${field} must be a non-zero bytes32 value`);
  }
  return value.toLowerCase();
}

function adminManifestIdentity(value) {
  const releaseId = requiredManifestHash(value.releaseId, "manifest releaseId");
  const governanceAccount = requiredManifestAddress(
    value.activationEvidence?.governance?.account,
    "manifest governance account",
  );
  const controller = requiredManifestAddress(value.contracts?.controller?.address, "manifest controller");
  const controllerRuntimeCodeHash = requiredManifestHash(
    value.contracts?.controller?.runtimeCodeHash,
    "manifest controller runtime code hash",
  );
  const marketplace = requiredManifestAddress(value.contracts?.marketplace?.address, "manifest marketplace");
  const marketplaceRuntimeCodeHash = requiredManifestHash(
    value.contracts?.marketplace?.runtimeCodeHash,
    "manifest marketplace runtime code hash",
  );
  if (controller === marketplace) fail("manifest controller and marketplace must be different contracts");
  return Object.freeze({
    chainId: value.chain.id,
    releaseId,
    governanceAccount,
    controller,
    controllerRuntimeCodeHash,
    marketplace,
    marketplaceRuntimeCodeHash,
  });
}

function bool(value, field) {
  if (typeof value !== "boolean") fail(`${field} must be boolean`);
  return value;
}

function toBlockNumber(value, field) {
  const block = typeof value === "bigint" ? value : BigInt(value);
  if (block < 0n || block > BigInt(Number.MAX_SAFE_INTEGER)) fail(`${field} is outside the safe-integer range`);
  return Number(block);
}

function safeErrorMessage(error, sensitiveValues = []) {
  let message = error instanceof Error ? error.message : "unknown administration failure";
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length > 0) message = message.split(value).join("[REDACTED]");
  }
  message = message
    .replace(/((?:ADMIN_)?PRIVATE_KEY\s*[=:]\s*)\S+/gi, "$1[REDACTED]")
    .replace(/[\r\n\t]+/g, " ")
    .trim();
  return message.slice(0, 600) || "unknown administration failure";
}

function privateKeyValues(env) {
  return [env?.ADMIN_PRIVATE_KEY, env?.PRIVATE_KEY]
    .filter((value) => typeof value === "string" && value.trim().length > 0)
    .map((value) => value.trim());
}

function collectRpcErrorSignals(error) {
  const signals = [];
  const statuses = [];
  const codes = [];
  const queue = [error];
  const seen = new Set();

  while (queue.length > 0 && seen.size < 16) {
    const value = queue.shift();
    if (typeof value === "string" || typeof value === "number") {
      signals.push(String(value));
      continue;
    }
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);

    for (const field of ["message", "shortMessage", "details", "name"]) {
      if (typeof value[field] === "string") signals.push(value[field]);
    }
    for (const field of ["status", "statusCode"]) {
      if (typeof value[field] === "number" || typeof value[field] === "string") statuses.push(Number(value[field]));
    }
    if (typeof value.code === "number" || typeof value.code === "string") codes.push(value.code);
    for (const field of ["cause", "error", "response", "data", "metaMessages"]) {
      if (value[field] !== undefined) queue.push(value[field]);
    }
  }

  return { signals, statuses, codes };
}

export function isTransientRpcReadError(error) {
  const { signals, statuses, codes } = collectRpcErrorSignals(error);
  if (statuses.some((status) => status === 408 || status === 425 || status === 429 || (status >= 500 && status <= 599))) {
    return true;
  }
  if (codes.some((code) => [429, -32_005, -32_011].includes(Number(code)))) return true;
  if (codes.some((code) => TRANSIENT_RPC_CODES.has(String(code).toUpperCase()))) return true;
  return TRANSIENT_RPC_MESSAGE_PATTERN.test(signals.join(" "));
}

function normalizeRpcReadRetryOptions(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) fail("RPC read retry options must be an object");
  const maxAttempts = options.maxAttempts ?? RPC_READ_RETRY_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? RPC_READ_RETRY_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? RPC_READ_RETRY_DEFAULTS.maxDelayMs;
  const sleep = options.sleep ?? ((delayMs) => new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs)));

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 8) {
    fail("RPC read maxAttempts must be an integer from 1 through 8");
  }
  if (!Number.isSafeInteger(baseDelayMs) || baseDelayMs < 0 || baseDelayMs > 10_000) {
    fail("RPC read baseDelayMs must be an integer from 0 through 10000");
  }
  if (!Number.isSafeInteger(maxDelayMs) || maxDelayMs < baseDelayMs || maxDelayMs > 30_000) {
    fail("RPC read maxDelayMs must be an integer no smaller than baseDelayMs and no greater than 30000");
  }
  if (typeof sleep !== "function") fail("RPC read sleep must be a function");
  return { maxAttempts, baseDelayMs, maxDelayMs, sleep };
}

async function retryRpcRead(operation, options) {
  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === options.maxAttempts || !isTransientRpcReadError(error)) throw error;
      const delayMs = Math.min(options.maxDelayMs, options.baseDelayMs * (2 ** (attempt - 1)));
      await options.sleep(delayMs);
    }
  }
  throw new Error("unreachable RPC read retry state");
}

export function parseAdminActivationArguments(argv) {
  const values = new Map();
  let broadcast = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--broadcast") {
      if (broadcast) fail("--broadcast may only be specified once");
      broadcast = true;
      continue;
    }
    if (
      !["--manifest", "--action", "--confirm-release", "--registration-smoke", "--candidate-origin"].includes(flag) ||
      values.has(flag)
    ) {
      fail(`unknown or duplicate argument ${String(flag)}; ${USAGE}`);
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(`${flag} requires one explicit value; ${USAGE}`);
    }
    values.set(flag, value);
    index += 1;
  }

  if (!values.has("--manifest")) fail(`--manifest is required; ${USAGE}`);
  if (!values.has("--action")) fail(`--action is required; ${USAGE}`);
  const action = values.get("--action");
  if (!adminActivationConstants.actions.includes(action)) fail(`unsupported action; ${USAGE}`);
  if (action === "market-open") {
    if (!values.has("--registration-smoke")) fail("market-open requires --registration-smoke");
    if (!values.has("--candidate-origin")) fail("market-open requires --candidate-origin");
  } else if (values.has("--registration-smoke") || values.has("--candidate-origin")) {
    fail("--registration-smoke and --candidate-origin are only valid with market-open");
  }

  const confirmation = values.get("--confirm-release");
  if (broadcast) {
    if (typeof confirmation !== "string" || !HASH_PATTERN.test(confirmation)) {
      fail("--broadcast requires --confirm-release <exact-release-id>");
    }
  } else if (confirmation !== undefined) {
    fail("--confirm-release is only valid with --broadcast");
  }

  return {
    manifestPath: resolve(values.get("--manifest")),
    action,
    broadcast,
    ...(confirmation === undefined ? {} : { confirmRelease: confirmation }),
    ...(values.has("--registration-smoke")
      ? { registrationSmokePath: resolve(values.get("--registration-smoke")) }
      : {}),
    ...(values.has("--candidate-origin") ? { candidateOrigin: values.get("--candidate-origin") } : {}),
  };
}

export function validateCanonicalAdminManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("manifest must be a JSON object");
  if (value.schemaVersion !== "1.1.0") fail("manifest schemaVersion must equal 1.1.0");
  if (value.testnet !== true) fail("manifest must identify a testnet release");
  if (value.chain?.id !== adminActivationConstants.chainId) fail("manifest chain ID is not Arc Testnet");
  if (value.chain?.caip2 !== `eip155:${adminActivationConstants.chainId}`) fail("manifest CAIP-2 ID is not Arc Testnet");
  if (value.chain?.rpcUrl !== ARC_TESTNET_RPC_URL) fail("manifest Arc Testnet RPC URL is not canonical");
  if (!Number.isSafeInteger(value.chain?.confirmations) || value.chain.confirmations < 1) {
    fail("manifest confirmations must be a positive safe integer");
  }
  adminManifestIdentity(value);
  bool(value.activationEvidence?.controllerPolicy?.registrationsPaused, "manifest controller pause policy");
  bool(value.activationEvidence?.marketplacePolicy?.paused, "manifest marketplace pause policy");
  if (typeof value.state !== "string") fail("manifest state is missing");
  if (typeof value.permitIssuer?.active !== "boolean") fail("manifest permit issuer policy is missing");
  return value;
}

export function deriveCanonicalAdminAccount(
  env = process.env,
  derive = privateKeyToAccount,
  expectedGovernanceAccount,
) {
  const governanceAccount = requiredManifestAddress(
    expectedGovernanceAccount,
    "selected manifest governance account",
  );
  const adminKey = typeof env?.ADMIN_PRIVATE_KEY === "string" ? env.ADMIN_PRIVATE_KEY.trim() : "";
  const fallbackKey = typeof env?.PRIVATE_KEY === "string" ? env.PRIVATE_KEY.trim() : "";
  if (!adminKey && !fallbackKey) {
    fail("ADMIN_PRIVATE_KEY or PRIVATE_KEY must be supplied through the process environment");
  }

  const deriveOne = (value) => {
    let privateKey;
    try {
      privateKey = normalizeOperatorPrivateKey(value);
    } catch {
      fail("the environment private key is invalid");
    }
    try {
      return derive(privateKey);
    } catch {
      fail("the environment private key is invalid");
    }
  };

  const account = deriveOne(adminKey || fallbackKey);
  if (adminKey && fallbackKey) {
    const fallbackAccount = deriveOne(fallbackKey);
    if (address(account.address, "ADMIN_PRIVATE_KEY account") !== address(fallbackAccount.address, "PRIVATE_KEY account")) {
      fail("ADMIN_PRIVATE_KEY and PRIVATE_KEY resolve to different accounts");
    }
  }
  exactAddress(account.address, governanceAccount, "environment private-key account");
  return account;
}

export function createAdminClients({
  rpcUrl,
  account,
  transport,
  transportFactory = rateLimitedArcHttp,
  publicClientFactory = createPublicClient,
  walletClientFactory = createWalletClient,
} = {}) {
  if (rpcUrl !== ARC_TESTNET_RPC_URL) fail(`Arc Testnet RPC URL must exactly equal ${ARC_TESTNET_RPC_URL}`);
  const selectedTransport = transport ?? transportFactory(rpcUrl);
  const chain = {
    ...ARC_TESTNET,
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  return {
    publicClient: publicClientFactory({ chain, transport: selectedTransport }),
    walletClient: walletClientFactory({ chain, transport: selectedTransport, account }),
  };
}

async function readAt(client, blockNumber, addressValue, abi, functionName) {
  return client.readContract({ address: addressValue, abi, functionName, blockNumber });
}

export async function readCanonicalAdminState(publicClient, manifest, retryOptions = {}) {
  validateCanonicalAdminManifest(manifest);
  const identity = adminManifestIdentity(manifest);
  const { runtimeCodeHasher = keccak256, ...rpcRetryOptions } = retryOptions;
  if (typeof runtimeCodeHasher !== "function") fail("runtime code hasher must be a function");
  const retry = normalizeRpcReadRetryOptions(rpcRetryOptions);
  const rpcRead = (operation) => retryRpcRead(operation, retry);
  const chainId = await rpcRead(() => publicClient.getChainId());
  if (chainId !== identity.chainId) fail(`connected chain ID ${chainId} is not Arc Testnet`);
  const captureBlock = await rpcRead(() => publicClient.getBlockNumber());
  const controller = identity.controller;
  const marketplace = identity.marketplace;
  const governance = identity.governanceAccount;

  // Keep every assertion pinned to one block, but issue reads sequentially. Arc's
  // public testnet endpoint rate-limits short concurrent bursts even for eth_call.
  // Only these idempotent reads receive bounded transient-error retries.
  const governanceCode = await rpcRead(() => publicClient.getCode({ address: governance, blockNumber: captureBlock }));
  const controllerCode = await rpcRead(() => publicClient.getCode({ address: controller, blockNumber: captureBlock }));
  const marketplaceCode = await rpcRead(() => publicClient.getCode({ address: marketplace, blockNumber: captureBlock }));
  const controllerOwner = await rpcRead(() => readAt(publicClient, captureBlock, controller, ownedAbi, "owner"));
  const controllerPendingOwner = await rpcRead(() => readAt(publicClient, captureBlock, controller, ownedAbi, "pendingOwner"));
  const controllerReleaseId = await rpcRead(() => readAt(publicClient, captureBlock, controller, controllerAbi, "releaseId"));
  const controllerPaused = await rpcRead(() => readAt(publicClient, captureBlock, controller, controllerAbi, "registrationsPaused"));
  const marketplaceOwner = await rpcRead(() => readAt(publicClient, captureBlock, marketplace, ownedAbi, "owner"));
  const marketplacePendingOwner = await rpcRead(() => readAt(publicClient, captureBlock, marketplace, ownedAbi, "pendingOwner"));
  const marketplacePaused = await rpcRead(() => readAt(publicClient, captureBlock, marketplace, marketplaceAbi, "paused"));

  if (governanceCode && governanceCode !== "0x") fail("canonical governance account is not an EOA at the capture block");
  if (!controllerCode || controllerCode === "0x") fail("canonical controller has no runtime code at the capture block");
  if (!marketplaceCode || marketplaceCode === "0x") fail("canonical marketplace has no runtime code at the capture block");
  exactHash(
    runtimeCodeHasher(controllerCode),
    identity.controllerRuntimeCodeHash,
    "on-chain controller runtime code hash",
  );
  exactHash(
    runtimeCodeHasher(marketplaceCode),
    identity.marketplaceRuntimeCodeHash,
    "on-chain marketplace runtime code hash",
  );
  exactAddress(controllerOwner, identity.governanceAccount, "on-chain controller owner");
  exactAddress(marketplaceOwner, identity.governanceAccount, "on-chain marketplace owner");
  exactAddress(controllerPendingOwner, ZERO_ADDRESS, "on-chain controller pending owner");
  exactAddress(marketplacePendingOwner, ZERO_ADDRESS, "on-chain marketplace pending owner");
  exactHash(controllerReleaseId, identity.releaseId, "on-chain controller releaseId");

  return {
    blockNumber: toBlockNumber(captureBlock, "capture block"),
    controllerPaused: bool(controllerPaused, "on-chain controller pause state"),
    marketplacePaused: bool(marketplacePaused, "on-chain marketplace pause state"),
  };
}

function operationPlan(action) {
  if (action === "controller-open") return [{ target: "controller", paused: false }];
  if (action === "market-open") return [{ target: "marketplace", paused: false }];
  if (action === "pause-all") {
    return [
      { target: "marketplace", paused: true },
      { target: "controller", paused: true },
    ];
  }
  if (action === "controller-pause") return [{ target: "controller", paused: true }];
  if (action === "market-pause") return [{ target: "marketplace", paused: true }];
  fail("unsupported action");
}

function targetSpec(target, identity) {
  if (target === "controller") {
    return {
      address: identity.controller,
      abi: controllerAbi,
      functionName: "setRegistrationsPaused",
      stateKey: "controllerPaused",
    };
  }
  return {
    address: identity.marketplace,
    abi: marketplaceAbi,
    functionName: "setPaused",
    stateKey: "marketplacePaused",
  };
}

function assertOpenPreconditions(manifest, action, state) {
  if (action !== "controller-open" && action !== "market-open") return;
  if (manifest.state !== "active" || manifest.permitIssuer.active !== true) {
    fail(`${action} requires an active manifest with the permit issuer enabled`);
  }
  if (action === "controller-open" && state.marketplacePaused !== true) {
    fail("controller-open requires the marketplace to be paused first");
  }
  if (action === "market-open" && (
    state.controllerPaused !== false || state.marketplacePaused !== true
  )) {
    fail("market-open requires registration open and marketplace paused");
  }
}

function expectedPauseState(preState, plan, identity) {
  const expected = {
    controllerPaused: preState.controllerPaused,
    marketplacePaused: preState.marketplacePaused,
  };
  for (const item of plan) expected[targetSpec(item.target, identity).stateKey] = item.paused;
  return expected;
}

function assertExpectedPauseState(actual, expected, label) {
  if (
    actual.controllerPaused !== expected.controllerPaused ||
    actual.marketplacePaused !== expected.marketplacePaused
  ) {
    fail(
      `${label} pause-state mismatch; expected controller=${expected.controllerPaused}, marketplace=${expected.marketplacePaused}`,
    );
  }
}

function receiptSummary(receipt) {
  return {
    transactionHash: receipt.transactionHash,
    blockHash: receipt.blockHash,
    blockNumber: toBlockNumber(receipt.blockNumber, "receipt block"),
    status: receipt.status,
  };
}

function assertConfirmedReceipt(waited, confirmed, hash, targetAddress, governanceAccount) {
  if (waited?.transactionHash?.toLowerCase() !== hash.toLowerCase()) fail("waited receipt transaction hash mismatch");
  if (confirmed?.transactionHash?.toLowerCase() !== hash.toLowerCase()) fail("confirmed receipt transaction hash mismatch");
  if (waited.status !== "success" || confirmed.status !== "success") fail("administration transaction reverted");
  if (waited.blockHash !== confirmed.blockHash || BigInt(waited.blockNumber) !== BigInt(confirmed.blockNumber)) {
    fail("waited and confirmed receipts disagree");
  }
  if (!confirmed.to || getAddress(confirmed.to) !== getAddress(targetAddress)) {
    fail("receipt target does not match the canonical contract");
  }
  if (!confirmed.from || getAddress(confirmed.from) !== getAddress(governanceAccount)) {
    fail("receipt sender does not match the canonical governance EOA");
  }
}

async function performOperation({
  publicClient,
  walletClient,
  account,
  identity,
  item,
  broadcast,
  confirmations,
  currentState,
  force = false,
}) {
  const spec = targetSpec(item.target, identity);
  const report = {
    target: item.target,
    contract: spec.address,
    function: spec.functionName,
    desiredPaused: item.paused,
    priorPaused: currentState[spec.stateKey],
    skipped: !force && currentState[spec.stateKey] === item.paused,
    simulated: false,
    broadcast: false,
    transactionHash: null,
    blockHash: null,
    blockNumber: null,
    receiptStatus: null,
    receiptConfirmed: false,
  };
  if (report.skipped) return report;

  try {
    const simulation = await publicClient.simulateContract({
      address: spec.address,
      abi: spec.abi,
      functionName: spec.functionName,
      args: [item.paused],
      account,
    });
    report.simulated = true;
    if (!broadcast) return report;

    const hash = await walletClient.writeContract(simulation.request);
    if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) fail("wallet returned an invalid transaction hash");
    report.broadcast = true;
    report.transactionHash = hash;
    const waited = await publicClient.waitForTransactionReceipt({ hash, confirmations });
    const confirmed = await publicClient.getTransactionReceipt({ hash });
    assertConfirmedReceipt(waited, confirmed, hash, spec.address, account.address);
    const summary = receiptSummary(confirmed);
    report.blockHash = summary.blockHash;
    report.blockNumber = summary.blockNumber;
    report.receiptStatus = summary.status;
    report.receiptConfirmed = true;
    return report;
  } catch (error) {
    error.operationReport = report;
    throw error;
  }
}

export class AdminActivationFailure extends Error {
  constructor(message, report) {
    super(message);
    this.name = "AdminActivationFailure";
    this.report = report;
  }
}

async function attemptOpenRollback({
  target,
  publicClient,
  walletClient,
  account,
  identity,
  confirmations,
  sensitiveValues,
  readState,
}) {
  const rollback = {
    attempted: true,
    target,
    succeeded: false,
    operation: null,
    postState: null,
    error: null,
  };
  try {
    const before = await readState();
    const operation = await performOperation({
      publicClient,
      walletClient,
      account,
      identity,
      item: { target, paused: true },
      broadcast: true,
      confirmations,
      currentState: before,
      force: true,
    });
    rollback.operation = operation;
    rollback.postState = await readState();
    const stateKey = targetSpec(target, identity).stateKey;
    if (rollback.postState[stateKey] !== true) fail(`${target} rollback did not restore the paused state`);
    rollback.succeeded = true;
  } catch (error) {
    if (error?.operationReport) rollback.operation = error.operationReport;
    rollback.error = safeErrorMessage(error, sensitiveValues);
    try {
      rollback.postState = await readState();
    } catch {
      // The original redacted rollback error is more useful than a second RPC error.
    }
  }
  return rollback;
}

export async function executeAdminActivation({
  manifest,
  action,
  broadcast = false,
  account,
  publicClient,
  walletClient,
  sensitiveValues = [],
  runtimeCodeHasher = keccak256,
  registrationSmoke,
  candidateOrigin,
}) {
  validateCanonicalAdminManifest(manifest);
  const identity = adminManifestIdentity(manifest);
  if (!adminActivationConstants.actions.includes(action)) fail("unsupported action");
  exactAddress(account?.address, identity.governanceAccount, "administration account");
  if (!publicClient) fail("a public client is required");
  if (typeof runtimeCodeHasher !== "function") fail("runtime code hasher must be a function");
  if (broadcast && !walletClient) fail("a wallet client is required for broadcast mode");
  if (broadcast && walletClient.account?.address) {
    exactAddress(walletClient.account.address, identity.governanceAccount, "wallet client account");
  }
  if (action === "market-open" && !registrationSmoke) {
    fail("market-open requires registration smoke PASS evidence");
  }
  if (action !== "market-open" && (registrationSmoke || candidateOrigin)) {
    fail("registration smoke evidence is only valid with market-open");
  }

  const report = {
    schemaVersion: "1.0.0",
    ok: false,
    mode: broadcast ? "broadcast" : "dry-run",
    action,
    chainId: identity.chainId,
    releaseId: identity.releaseId,
    governanceAccount: identity.governanceAccount,
    targets: {
      controller: identity.controller,
      marketplace: identity.marketplace,
    },
    preState: null,
    expectedState: null,
    operations: [],
    postState: null,
    rollback: null,
    registrationSmoke: null,
    error: null,
  };
  const plan = operationPlan(action);
  const readState = () => readCanonicalAdminState(publicClient, manifest, { runtimeCodeHasher });
  let primaryTransactionStarted = false;

  try {
    report.preState = await readState();
    assertOpenPreconditions(manifest, action, report.preState);
    if (action === "market-open") {
      const binding = validateRegistrationSmokeLifecycle({
        ...registrationSmoke,
        controllerOpenManifest: manifest,
        candidateOrigin,
      });
      const minimumFinalizedHead = binding.evidenceBlock + manifest.chain.confirmations - 1;
      if (report.preState.blockNumber < minimumFinalizedHead) {
        fail("registration smoke evidence has not reached the manifest finality policy");
      }
      await revalidateRegistrationSmokeEvidence({
        publicClient,
        controllerOpenManifest: manifest,
        binding,
      });
      report.registrationSmoke = registrationSmokeBindingRecord(binding);
    }
    report.expectedState = expectedPauseState(report.preState, plan, identity);
    let currentState = { ...report.preState };

    for (const item of plan) {
      let operation;
      try {
        operation = await performOperation({
          publicClient,
          walletClient,
          account,
          identity,
          item,
          broadcast,
          confirmations: manifest.chain.confirmations,
          currentState,
        });
      } catch (error) {
        if (error?.operationReport) {
          report.operations.push(error.operationReport);
          primaryTransactionStarted ||= error.operationReport.transactionHash !== null;
        }
        throw error;
      }
      report.operations.push(operation);
      primaryTransactionStarted ||= operation.transactionHash !== null;
      if (broadcast && !operation.skipped) {
        currentState = await readState();
        const stateKey = targetSpec(item.target, identity).stateKey;
        if (currentState[stateKey] !== item.paused) fail(`${item.target} state did not match the confirmed transaction`);
      } else if (!broadcast) {
        currentState[targetSpec(item.target, identity).stateKey] = item.paused;
      }
    }

    report.postState = await readState();
    if (broadcast) assertExpectedPauseState(report.postState, report.expectedState, "post-transaction");
    report.ok = true;
    return report;
  } catch (error) {
    report.error = {
      code: "ADMIN_ACTIVATION_FAILED",
      message: safeErrorMessage(error, sensitiveValues),
    };

    if (broadcast && primaryTransactionStarted && (action === "controller-open" || action === "market-open")) {
      report.rollback = await attemptOpenRollback({
        target: action === "controller-open" ? "controller" : "marketplace",
        publicClient,
        walletClient,
        account,
        identity,
        confirmations: manifest.chain.confirmations,
        sensitiveValues,
        readState,
      });
    }
    try {
      report.postState = await readState();
    } catch {
      // Preserve the original failure and any rollback diagnostics.
    }
    throw new AdminActivationFailure(report.error.message, report);
  }
}

export async function runAdminActivation(argv, dependencies = {}) {
  const options = parseAdminActivationArguments(argv);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(options.manifestPath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) fail("manifest is not valid JSON");
    fail("manifest could not be read");
  }
  validateCanonicalAdminManifest(manifest);
  const identity = adminManifestIdentity(manifest);
  if (options.broadcast) {
    try {
      exactHash(options.confirmRelease, identity.releaseId, "--confirm-release");
    } catch {
      fail(`--broadcast requires --confirm-release ${identity.releaseId}`);
    }
  }
  const env = dependencies.env ?? process.env;
  const account = deriveCanonicalAdminAccount(
    env,
    dependencies.privateKeyToAccount ?? privateKeyToAccount,
    identity.governanceAccount,
  );
  const rpcUrl = typeof env.ARC_RPC_URL === "string" && env.ARC_RPC_URL.trim()
    ? env.ARC_RPC_URL.trim()
    : manifest.chain.rpcUrl;
  const clients = dependencies.clients ?? createAdminClients({
    rpcUrl,
    account,
    transport: dependencies.transport,
    transportFactory: dependencies.transportFactory,
    publicClientFactory: dependencies.publicClientFactory,
    walletClientFactory: dependencies.walletClientFactory,
  });
  const registrationSmoke = options.registrationSmokePath
    ? await loadRegistrationSmokeEvidence(options.registrationSmokePath)
    : undefined;
  return executeAdminActivation({
    manifest,
    action: options.action,
    broadcast: options.broadcast,
    account,
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    sensitiveValues: privateKeyValues(env),
    runtimeCodeHasher: dependencies.runtimeCodeHasher ?? keccak256,
    registrationSmoke,
    candidateOrigin: options.candidateOrigin,
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const report = await runAdminActivation(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    if (error instanceof AdminActivationFailure) {
      process.stdout.write(`${JSON.stringify(error.report, null, 2)}\n`);
    }
    process.stderr.write(`${safeErrorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
