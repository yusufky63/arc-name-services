import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  decodeEventLog,
  getAddress,
  isAddress,
  parseAbi,
  zeroAddress,
} from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  deploymentManifestDigest,
  parseDeploymentManifest,
} from "../../packages/config/dist/index.js";
import { deriveNameIdentity } from "../../packages/normalization/dist/index.js";

export const REGISTRATION_SMOKE_RPC_URL = "https://rpc.testnet.arc.network";
export const REGISTRATION_SMOKE_TRANSACTION_IDS = Object.freeze([
  "registrationUsdcApproval",
  "registration",
]);
const REGISTRATION_SMOKE_WITHOUT_APPROVAL_TRANSACTION_IDS = Object.freeze([
  "registration",
]);
export const REGISTRATION_SMOKE_ASSERTION_IDS = Object.freeze([
  "registrationPermitConsumed",
  "registrationNonceIncremented",
  "registrationSettlementExact",
  "registrationAllowanceConsumed",
  "controllerSolvent",
  "registrarOwner",
  "registryOwner",
  "resolverConfigured",
  "registrationExpiry",
  "issuerReconciled",
  "marketplaceRemainedPaused",
]);

const REPORT_KEYS = Object.freeze([
  "artifact",
  "assertions",
  "candidateManifestSha256",
  "candidateOrigin",
  "chainId",
  "durationYears",
  "evidenceBlock",
  "evidenceBlockHash",
  "expectedAmount",
  "fullName",
  "generatedAt",
  "mode",
  "normalizedLabel",
  "redactions",
  "registrant",
  "releaseId",
  "requiredState",
  "rpcUrl",
  "schemaVersion",
  "tokenId",
  "transactions",
  "verdict",
  "verifiedAtBlock",
]);
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const controllerEvidenceAbi = parseAbi([
  "function usedPermit(bytes32 permitId) view returns (bool)",
  "function nonces(address requester) view returns (uint256)",
  "function totalReferralLiability() view returns (uint256)",
  "event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)",
  "event PermitConsumed(bytes32 indexed permitId, address indexed requester, uint256 indexed nonce)",
]);
const erc20EvidenceAbi = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const registrarEvidenceAbi = parseAbi([
  "function ownerOf(uint256 tokenId) view returns (address)",
  "function nameExpires(uint256 tokenId) view returns (uint256)",
]);
const registryEvidenceAbi = parseAbi([
  "function owner(bytes32 node) view returns (address)",
  "function resolver(bytes32 node) view returns (address)",
]);
const resolverEvidenceAbi = parseAbi([
  "function addr(bytes32 node) view returns (address)",
]);
const marketplaceEvidenceAbi = parseAbi(["function paused() view returns (bool)"]);

export function isRegistrationSmokeTransactionSequence(transactions) {
  if (!Array.isArray(transactions)) return false;
  const ids = transactions.map(({ id }) => id).join(",");
  return ids === REGISTRATION_SMOKE_TRANSACTION_IDS.join(",") ||
    ids === REGISTRATION_SMOKE_WITHOUT_APPROVAL_TRANSACTION_IDS.join(",");
}

function transactionById(transactions, id) {
  return transactions.find((transaction) => transaction.id === id);
}

function fail(message) {
  throw new Error(message);
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join(",") !== wanted.join(",")) {
    fail(`${field} contains unexpected or missing fields`);
  }
}

function safePositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${field} must be a positive safe integer`);
  return value;
}

function exactHash(value, field) {
  if (typeof value !== "string" || !BYTES32_PATTERN.test(value) || /^0x0{64}$/i.test(value)) {
    fail(`${field} must be a non-zero bytes32 value`);
  }
  return value.toLowerCase();
}

function exactAddress(value, field) {
  if (typeof value !== "string" || !isAddress(value)) fail(`${field} must be an address`);
  return getAddress(value);
}

function canonicalOrigin(value, field) {
  let url;
  try { url = new URL(value); }
  catch { fail(`${field} must be a URL`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) fail(`${field} must be a credential-free HTTPS origin`);
  return url.origin;
}

function sortJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

export function canonicalRegistrationSmokeJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

function sha256Bytes(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

export function parseCanonicalRegistrationSmokeBytes(bytesValue) {
  const bytes = Buffer.isBuffer(bytesValue) ? bytesValue : Buffer.from(bytesValue);
  if (bytes.byteLength === 0 || bytes.byteLength > 1_000_000) {
    fail("registration smoke report must be 1..1000000 bytes");
  }
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { fail("registration smoke report is not valid UTF-8"); }
  let report;
  try { report = JSON.parse(text); }
  catch { fail("registration smoke report is not valid JSON"); }
  if (text !== canonicalRegistrationSmokeJson(report)) {
    fail("registration smoke report bytes are not deterministic canonical JSON");
  }
  return Object.freeze({
    report,
    reportBytes: bytes,
    reportSha256: sha256Bytes(bytes),
  });
}

export async function loadRegistrationSmokeEvidence(reference, fetcher = fetch) {
  if (typeof reference !== "string" || reference.trim() === "") {
    fail("--registration-smoke is required");
  }
  let bytes;
  if (/^https?:\/\//i.test(reference)) {
    let url;
    try { url = new URL(reference); }
    catch { fail("registration smoke report URL is invalid"); }
    if (
      url.protocol !== "https:" || url.username || url.password || url.hash ||
      (url.port && url.port !== "443")
    ) fail("registration smoke report URL must be credential-free HTTPS");
    let response;
    try { response = await fetcher(url, { headers: { accept: "application/json" }, redirect: "error" }); }
    catch { fail("registration smoke report could not be fetched"); }
    if (!response?.ok || typeof response.text !== "function") {
      fail("registration smoke report could not be fetched");
    }
    bytes = Buffer.from(await response.text(), "utf8");
  } else {
    try { bytes = await readFile(reference); }
    catch { fail("registration smoke report file could not be read"); }
  }
  return parseCanonicalRegistrationSmokeBytes(bytes);
}

function assertExactReportShape(report) {
  exactKeys(report, REPORT_KEYS, "registration smoke report");
  if (
    report.schemaVersion !== "1.0.0" ||
    report.artifact !== "registrationActivationSmoke" ||
    report.mode !== "BROADCAST" ||
    report.verdict !== "PASS"
  ) fail("registration smoke report identity is invalid");
  exactKeys(report.requiredState, ["marketplacePaused", "registrationsPaused"], "registration smoke requiredState");
  if (
    report.requiredState.registrationsPaused !== false ||
    report.requiredState.marketplacePaused !== true
  ) fail("registration smoke report does not prove the pre-market activation state");
  exactKeys(
    report.redactions,
    ["challengeSecrets", "permitSignatures", "privateKeys", "walletSignatures"],
    "registration smoke redactions",
  );
  if (Object.values(report.redactions).some((value) => value !== false)) {
    fail("registration smoke report redaction declaration is invalid");
  }
  if (!Array.isArray(report.transactions)) fail("registration smoke transactions must be an array");
  if (!Array.isArray(report.assertions)) fail("registration smoke assertions must be an array");
  if (!isRegistrationSmokeTransactionSequence(report.transactions)) {
    fail("registration smoke transaction coverage or order is incomplete");
  }
  if (
    report.assertions.map(({ id }) => id).join(",") !==
    REGISTRATION_SMOKE_ASSERTION_IDS.join(",")
  ) fail("registration smoke assertion coverage or order is incomplete");
  for (const transaction of report.transactions) {
    exactKeys(transaction, ["blockNumber", "from", "hash", "id", "to"], `${transaction.id} transaction`);
  }
  for (const assertion of report.assertions) {
    exactKeys(assertion, ["actual", "expected", "id", "source", "verdict"], `${assertion.id} assertion`);
    if (
      assertion.verdict !== "PASS" ||
      typeof assertion.source !== "string" || assertion.source.length === 0 ||
      typeof assertion.expected !== "string" || assertion.expected.length > 512 ||
      typeof assertion.actual !== "string" || assertion.actual.length > 512
    ) fail(`${assertion.id} assertion is invalid`);
  }
  const issuerAssertion = report.assertions.find(({ id }) => id === "issuerReconciled");
  if (
    issuerAssertion.source !== "candidate-api" ||
    issuerAssertion.expected !== "true" ||
    issuerAssertion.actual !== "true"
  ) fail("issuerReconciled assertion does not prove successful candidate reconciliation");
  const marketplaceAssertion = report.assertions.find(({ id }) => id === "marketplaceRemainedPaused");
  if (
    marketplaceAssertion.source !== "rpc" ||
    marketplaceAssertion.expected !== "true" ||
    marketplaceAssertion.actual !== "true"
  ) fail("marketplaceRemainedPaused assertion does not prove the pre-market pause state");
}

function assertControllerOpenCandidate(manifest, origin) {
  if (
    manifest.chain.id !== ARC_TESTNET_CHAIN_ID ||
    manifest.chain.rpcUrl !== REGISTRATION_SMOKE_RPC_URL ||
    manifest.testnet !== true ||
    manifest.state !== "active" ||
    manifest.activationEvidence.productLive !== false ||
    manifest.activationEvidence.controllerPolicy.registrationsPaused !== false ||
    manifest.activationEvidence.marketplacePolicy.paused !== true ||
    manifest.permitIssuer.active !== true
  ) fail("registration smoke binding requires the Arc controller-open private candidate");
  if (
    manifest.activationEvidence.artifacts.fundedEndToEnd.url !== null ||
    manifest.activationEvidence.artifacts.fundedEndToEnd.sha256 !== null ||
    manifest.activationEvidence.artifacts.operationsDrill.url !== null ||
    manifest.activationEvidence.artifacts.operationsDrill.sha256 !== null
  ) fail("controller-open candidate must not contain live-only evidence");
  const expectedIssuer = new URL("/api/registration/issuer/", origin).toString().replace(/\/$/, "");
  const actualIssuer = new URL(manifest.permitIssuer.url).toString().replace(/\/$/, "");
  if (actualIssuer !== expectedIssuer) fail("controller-open candidate issuer is not bound to the candidate origin");
}

export function controllerOpenPredecessorFromMarketOpen(marketOpenValue, report) {
  let marketOpenManifest;
  try { marketOpenManifest = parseDeploymentManifest(structuredClone(marketOpenValue)); }
  catch { fail("market-open candidate failed canonical validation"); }
  if (
    marketOpenManifest.state !== "active" ||
    marketOpenManifest.activationEvidence.productLive !== false ||
    marketOpenManifest.activationEvidence.controllerPolicy.registrationsPaused !== false ||
    marketOpenManifest.activationEvidence.marketplacePolicy.paused !== false
  ) fail("registration smoke predecessor projection requires the Arc market-open candidate");
  const candidateVerifiedAtBlock = safePositiveInteger(
    report?.verifiedAtBlock,
    "registration candidate verifiedAtBlock",
  );
  const evidenceBlock = safePositiveInteger(report?.evidenceBlock, "registration evidenceBlock");
  if (evidenceBlock < candidateVerifiedAtBlock) {
    fail("registration evidence predates the controller-open predecessor");
  }
  if (marketOpenManifest.activationEvidence.verifiedAtBlock <= evidenceBlock) {
    fail("market-open candidate must be verified later than registration smoke evidence");
  }
  const predecessor = structuredClone(marketOpenManifest);
  predecessor.activationEvidence.verifiedAtBlock = candidateVerifiedAtBlock;
  predecessor.activationEvidence.marketplacePolicy.paused = true;
  try { return parseDeploymentManifest(predecessor); }
  catch { fail("controller-open predecessor projection failed canonical validation"); }
}

export function validateRegistrationSmokeLifecycle({
  report,
  reportSha256,
  controllerOpenManifest: controllerOpenValue,
  candidateOrigin,
}) {
  assertExactReportShape(report);
  let controllerOpenManifest;
  try { controllerOpenManifest = parseDeploymentManifest(structuredClone(controllerOpenValue)); }
  catch { fail("controller-open candidate failed canonical validation"); }
  let manifestOrigin;
  try { manifestOrigin = new URL(controllerOpenManifest.permitIssuer.url).origin; }
  catch { fail("controller-open candidate issuer URL is invalid"); }
  const origin = canonicalOrigin(candidateOrigin ?? manifestOrigin, "candidate origin");
  assertControllerOpenCandidate(controllerOpenManifest, origin);

  if (
    report.chainId !== ARC_TESTNET_CHAIN_ID ||
    report.rpcUrl !== REGISTRATION_SMOKE_RPC_URL ||
    report.releaseId !== controllerOpenManifest.releaseId ||
    report.candidateOrigin !== origin
  ) fail("registration smoke report does not match the controller-open candidate identity");
  const candidateVerifiedAtBlock = safePositiveInteger(report.verifiedAtBlock, "registration candidate verifiedAtBlock");
  const evidenceBlock = safePositiveInteger(report.evidenceBlock, "registration evidenceBlock");
  const manifestVerifiedAtBlock = safePositiveInteger(
    controllerOpenManifest.activationEvidence.verifiedAtBlock,
    "controller-open candidate verifiedAtBlock",
  );
  if (candidateVerifiedAtBlock !== manifestVerifiedAtBlock) {
    fail("registration smoke verifiedAtBlock does not match the controller-open candidate");
  }
  if (evidenceBlock < candidateVerifiedAtBlock) fail("registration evidence predates its candidate verification");
  const evidenceBlockHash = exactHash(report.evidenceBlockHash, "registration evidenceBlockHash");
  const exactReportSha256 = exactHash(reportSha256, "registration smoke report SHA-256");
  const computedReportSha256 = sha256Bytes(Buffer.from(canonicalRegistrationSmokeJson(report), "utf8"));
  if (exactReportSha256 !== computedReportSha256) {
    fail("registration smoke report SHA-256 does not match the canonical report bytes");
  }
  if (typeof report.generatedAt !== "string" || Number.isNaN(Date.parse(report.generatedAt))) {
    fail("registration smoke generatedAt is invalid");
  }
  const registrant = exactAddress(report.registrant, "registration smoke registrant");
  if (!Number.isInteger(report.durationYears) || report.durationYears < 1 || report.durationYears > 10) {
    fail("registration smoke durationYears must be 1..10");
  }
  if (typeof report.expectedAmount !== "string" || !/^[1-9][0-9]*$/.test(report.expectedAmount)) {
    fail("registration smoke expectedAmount must be a positive integer string");
  }
  let identity;
  try { identity = deriveNameIdentity(report.normalizedLabel, controllerOpenManifest.namespace.suffix); }
  catch { fail("registration smoke normalized label is invalid"); }
  if (
    identity.changed || report.fullName !== identity.name ||
    report.tokenId !== identity.tokenId.toString()
  ) fail("registration smoke name identity does not match the controller-open candidate");

  const candidateManifestSha256 = deploymentManifestDigest(controllerOpenManifest);
  if (
    exactHash(report.candidateManifestSha256, "registration candidateManifestSha256") !==
    candidateManifestSha256.toLowerCase()
  ) fail("registration smoke is not bound to the exact controller-open predecessor");

  const expectedTargets = {
    registrationUsdcApproval: controllerOpenManifest.settlement.erc20Address,
    registration: controllerOpenManifest.contracts.controller.address,
  };
  for (const transaction of report.transactions) {
    if (!TX_HASH_PATTERN.test(transaction.hash ?? "")) fail(`${transaction.id} transaction hash is malformed`);
    const blockNumber = safePositiveInteger(transaction.blockNumber, `${transaction.id} transaction block`);
    if (blockNumber <= candidateVerifiedAtBlock || blockNumber > evidenceBlock) {
      fail(`${transaction.id} transaction is outside the registration evidence interval`);
    }
    if (exactAddress(transaction.from, `${transaction.id} sender`) !== registrant) {
      fail(`${transaction.id} sender does not match the registrant`);
    }
    if (
      exactAddress(transaction.to, `${transaction.id} target`) !==
      exactAddress(expectedTargets[transaction.id], `${transaction.id} expected target`)
    ) fail(`${transaction.id} transaction target mismatch`);
  }
  const approvalTransaction = transactionById(report.transactions, "registrationUsdcApproval");
  const registrationTransaction = transactionById(report.transactions, "registration");
  if (approvalTransaction && approvalTransaction.blockNumber > registrationTransaction.blockNumber) {
    fail("registration approval cannot follow the registration transaction");
  }

  return Object.freeze({
    report,
    reportSha256: exactReportSha256,
    candidateManifestSha256,
    candidateVerifiedAtBlock,
    evidenceBlock,
    evidenceBlockHash,
    registrant,
    identity,
    controllerOpenManifest,
  });
}

export function registrationSmokeBindingRecord(binding) {
  return Object.freeze({
    schemaVersion: "1.0.0",
    artifact: "registrationActivationSmoke",
    reportSha256: binding.reportSha256,
    candidateManifestSha256: binding.candidateManifestSha256,
    candidateVerifiedAtBlock: binding.candidateVerifiedAtBlock,
    evidenceBlock: binding.evidenceBlock,
    evidenceBlockHash: binding.evidenceBlockHash,
    registrant: binding.registrant,
    registrationTransactionHash: transactionById(binding.report.transactions, "registration").hash.toLowerCase(),
  });
}

function requireEvent(receipt, address, abi, eventName, predicate = () => true) {
  for (const log of receipt.logs ?? []) {
    if (!log.address || getAddress(log.address) !== getAddress(address)) continue;
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
      if (decoded.eventName === eventName && predicate(decoded.args)) return decoded.args;
    } catch {
      // Receipts contain logs from several contracts.
    }
  }
  fail(`registration smoke ${eventName} event is missing during revalidation`);
}

async function readAt(publicClient, address, abi, functionName, args, blockNumber) {
  try {
    return await publicClient.readContract({ address, abi, functionName, args, blockNumber });
  } catch {
    fail(`registration smoke historical ${functionName} read failed`);
  }
}

function assertReceipt(receipt, transaction, blockHeader) {
  if (
    receipt?.status !== "success" ||
    receipt.transactionHash?.toLowerCase() !== transaction.hash.toLowerCase() ||
    receipt.blockNumber !== BigInt(transaction.blockNumber) ||
    !receipt.from || getAddress(receipt.from) !== getAddress(transaction.from) ||
    !receipt.to || getAddress(receipt.to) !== getAddress(transaction.to)
  ) fail(`${transaction.id} receipt no longer matches the immutable registration report`);
  const receiptBlockHash = exactHash(receipt.blockHash, `${transaction.id} receipt block hash`);
  const headerBlockHash = exactHash(blockHeader?.hash, `${transaction.id} canonical block hash`);
  if (
    blockHeader?.number !== BigInt(transaction.blockNumber) ||
    receiptBlockHash !== headerBlockHash
  ) fail(`${transaction.id} receipt block hash no longer matches the canonical transaction block`);
}

export async function revalidateRegistrationSmokeEvidence({
  publicClient,
  controllerOpenManifest: manifest,
  binding,
}) {
  const approvalTransaction = transactionById(binding.report.transactions, "registrationUsdcApproval");
  const registrationTransaction = transactionById(binding.report.transactions, "registration");
  let chainId;
  let approvalReceipt;
  let registrationReceipt;
  let approvalHeader;
  let registrationHeader;
  let evidenceHeader;
  try {
    [
      chainId,
      approvalReceipt,
      registrationReceipt,
      approvalHeader,
      registrationHeader,
      evidenceHeader,
    ] = await Promise.all([
      publicClient.getChainId(),
      approvalTransaction
        ? publicClient.getTransactionReceipt({ hash: approvalTransaction.hash })
        : Promise.resolve(null),
      publicClient.getTransactionReceipt({ hash: registrationTransaction.hash }),
      approvalTransaction
        ? publicClient.getBlock({ blockNumber: BigInt(approvalTransaction.blockNumber) })
        : Promise.resolve(null),
      publicClient.getBlock({ blockNumber: BigInt(registrationTransaction.blockNumber) }),
      publicClient.getBlock({ blockNumber: BigInt(binding.evidenceBlock) }),
    ]);
  } catch {
    fail("registration smoke receipt or block revalidation failed");
  }
  if (chainId !== ARC_TESTNET_CHAIN_ID) fail("registration smoke receipt chain ID mismatch");
  if (approvalTransaction) assertReceipt(approvalReceipt, approvalTransaction, approvalHeader);
  assertReceipt(registrationReceipt, registrationTransaction, registrationHeader);
  if (
    evidenceHeader?.number !== BigInt(binding.evidenceBlock) ||
    evidenceHeader?.hash?.toLowerCase() !== binding.evidenceBlockHash ||
    new Date(Number(evidenceHeader.timestamp) * 1_000).toISOString() !== binding.report.generatedAt
  ) fail("registration smoke evidence block hash or timestamp mismatch");

  const controller = getAddress(manifest.contracts.controller.address);
  const registrar = getAddress(manifest.contracts.baseRegistrar.address);
  const registry = getAddress(manifest.contracts.registry.address);
  const resolver = getAddress(manifest.contracts.publicResolver.address);
  const marketplace = getAddress(manifest.contracts.marketplace.address);
  const settlement = getAddress(manifest.settlement.erc20Address);
  const expectedAmount = BigInt(binding.report.expectedAmount);
  if (approvalReceipt) {
    const approvalEvent = requireEvent(
      approvalReceipt,
      settlement,
      erc20EvidenceAbi,
      "Approval",
      (args) => getAddress(args.owner) === binding.registrant &&
        getAddress(args.spender) === controller && args.value === expectedAmount,
    );
    if (approvalEvent.value !== expectedAmount) fail("registration smoke approval amount mismatch");
  }
  const permitEvent = requireEvent(
    registrationReceipt,
    controller,
    controllerEvidenceAbi,
    "PermitConsumed",
    (args) => getAddress(args.requester) === binding.registrant,
  );
  const nameEvent = requireEvent(
    registrationReceipt,
    controller,
    controllerEvidenceAbi,
    "NameRegistered",
    (args) => args.name === binding.identity.normalized &&
      args.label.toLowerCase() === binding.identity.labelhash.toLowerCase() &&
      getAddress(args.owner) === binding.registrant && args.baseCost === expectedAmount,
  );
  requireEvent(
    registrationReceipt,
    settlement,
    erc20EvidenceAbi,
    "Transfer",
    (args) => getAddress(args.from) === binding.registrant &&
      getAddress(args.to) === controller && args.value === expectedAmount,
  );
  const evidenceBlock = BigInt(binding.evidenceBlock);
  const [
    marketplacePaused,
    registrarOwner,
    registryOwner,
    registryResolver,
    resolvedAddress,
    expiry,
    usedPermit,
    nonce,
    allowance,
    controllerBalance,
    controllerLiability,
  ] = await Promise.all([
    readAt(publicClient, marketplace, marketplaceEvidenceAbi, "paused", [], evidenceBlock),
    readAt(publicClient, registrar, registrarEvidenceAbi, "ownerOf", [binding.identity.tokenId], evidenceBlock),
    readAt(publicClient, registry, registryEvidenceAbi, "owner", [binding.identity.namehash], evidenceBlock),
    readAt(publicClient, registry, registryEvidenceAbi, "resolver", [binding.identity.namehash], evidenceBlock),
    readAt(publicClient, resolver, resolverEvidenceAbi, "addr", [binding.identity.namehash], evidenceBlock),
    readAt(publicClient, registrar, registrarEvidenceAbi, "nameExpires", [binding.identity.tokenId], evidenceBlock),
    readAt(publicClient, controller, controllerEvidenceAbi, "usedPermit", [permitEvent.permitId], evidenceBlock),
    readAt(publicClient, controller, controllerEvidenceAbi, "nonces", [binding.registrant], evidenceBlock),
    readAt(publicClient, settlement, erc20EvidenceAbi, "allowance", [binding.registrant, controller], evidenceBlock),
    readAt(publicClient, settlement, erc20EvidenceAbi, "balanceOf", [controller], evidenceBlock),
    readAt(publicClient, controller, controllerEvidenceAbi, "totalReferralLiability", [], evidenceBlock),
  ]);
  if (
    marketplacePaused !== true ||
    getAddress(registrarOwner) !== binding.registrant ||
    getAddress(registryOwner) !== binding.registrant ||
    getAddress(registryResolver) !== resolver ||
    getAddress(resolvedAddress) !== zeroAddress ||
    BigInt(expiry) < nameEvent.expires ||
    usedPermit !== true ||
    BigInt(nonce) !== permitEvent.nonce + 1n ||
    BigInt(allowance) !== 0n ||
    BigInt(controllerBalance) < BigInt(controllerLiability)
  ) fail("registration smoke historical state no longer proves the pre-market registration gate");

  return registrationSmokeBindingRecord(binding);
}
