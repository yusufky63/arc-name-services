import {
  createPublicClient,
  createWalletClient,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import {
  ARC_TESTNET_CHAIN_ID,
  deploymentManifestDigest,
  EXPECTED_RESOLVER_CAPABILITIES,
  parseDeploymentManifest,
} from "../../packages/config/dist/index.js";
import { deriveNameIdentity } from "../../packages/normalization/dist/index.js";
import {
  baseRegistrarAbi,
  controllerAbi,
  erc20Abi,
  prepareApprovalPlan,
} from "../../packages/sdk/dist/index.js";
import {
  assertSecretFreeReport,
  deterministicJson,
  registrationAcceptancePrimitives,
} from "./funded-acceptance.mjs";
import { rateLimitedArcHttp } from "./arc-rpc-transport.mjs";
import { normalizeOperatorPrivateKey } from "./operator-key.mjs";
import {
  isRegistrationSmokeTransactionSequence,
  REGISTRATION_SMOKE_ASSERTION_IDS,
  REGISTRATION_SMOKE_RPC_URL,
  REGISTRATION_SMOKE_TRANSACTION_IDS,
} from "./registration-smoke-evidence.mjs";

export {
  REGISTRATION_SMOKE_ASSERTION_IDS,
  REGISTRATION_SMOKE_RPC_URL,
  REGISTRATION_SMOKE_TRANSACTION_IDS,
} from "./registration-smoke-evidence.mjs";

const {
  asBigInt,
  assertCandidateManifest,
  canonicalUrl,
  controllerInspectionAbi,
  erc20InspectionAbi,
  exactAddress,
  expectEqual,
  getJson,
  postJson,
  readAt,
  requiredContract,
  requireEvent,
  safePositiveBlockNumber,
  sendAndConfirm,
  snapshotRegistration,
  validatePreparedRegistration,
} = registrationAcceptancePrimitives;

const marketplacePauseAbi = parseAbi(["function paused() view returns (bool)"]);
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function fail(message) {
  throw new Error(message);
}

function normalizeIssuerUrl(value) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function assertRegistrationSmokeManifest(manifest, candidateOrigin) {
  if (
    manifest.chain.id !== ARC_TESTNET_CHAIN_ID ||
    manifest.chain.rpcUrl !== REGISTRATION_SMOKE_RPC_URL ||
    manifest.testnet !== true
  ) {
    fail("registration smoke is restricted to Arc Testnet and the canonical Arc RPC");
  }
  if (manifest.state !== "active" || manifest.activationEvidence.productLive !== false) {
    fail("manifest must be an active private candidate with productLive=false");
  }
  if (!Number.isSafeInteger(manifest.activationEvidence.verifiedAtBlock)) {
    fail("manifest verifiedAtBlock is required before registration smoke");
  }
  if (
    manifest.activationEvidence.controllerPolicy.registrationsPaused !== false ||
    manifest.activationEvidence.marketplacePolicy.paused !== true
  ) {
    fail("registration smoke requires controller open and marketplace still paused");
  }
  if (!BYTES32_PATTERN.test(manifest.releaseId ?? "")) fail("manifest releaseId is missing");
  if (!manifest.permitIssuer.active || !manifest.permitIssuer.url || !manifest.permitIssuer.signerAddress) {
    fail("manifest permit issuer is not active");
  }
  const expectedIssuer = new URL("/api/registration/issuer/", candidateOrigin).toString();
  if (normalizeIssuerUrl(manifest.permitIssuer.url) !== normalizeIssuerUrl(expectedIssuer)) {
    fail("manifest permit issuer is not bound to the explicit candidate origin");
  }
  for (const [key, deployment] of Object.entries(manifest.contracts)) {
    if (!deployment?.address || deployment.sourceVerified !== true) {
      fail(`manifest contract ${key} is not source-verified and active`);
    }
  }
  for (const [key, expected] of Object.entries(EXPECTED_RESOLVER_CAPABILITIES)) {
    if (manifest.resolverCapabilities[key] !== expected) fail(`resolver capability ${key} mismatch`);
  }
}

export function registrationAccountFromEnvironment(env = process.env) {
  let privateKey;
  try {
    privateKey = normalizeOperatorPrivateKey(
      env.E2E_BUYER_PRIVATE_KEY,
      "E2E_BUYER_PRIVATE_KEY",
    );
  } catch {
    fail("E2E_BUYER_PRIVATE_KEY must be a non-zero 32-byte private key");
  }
  if (/^0x0{64}$/i.test(privateKey)) {
    fail("E2E_BUYER_PRIVATE_KEY must be a non-zero 32-byte private key");
  }
  let registrant;
  try { registrant = privateKeyToAccount(privateKey); }
  catch { fail("E2E_BUYER_PRIVATE_KEY is invalid"); }
  return { registrant, sensitiveValues: [privateKey] };
}

function passAssertion(id, source, expected, actual) {
  const assertion = { id, verdict: "PASS", source, expected, actual };
  if (expected.length > 512 || actual.length > 512) fail(`${id} assertion is too large`);
  return assertion;
}

function validateApprovalTransaction(transaction, manifest, expectedAmount) {
  let localPlan;
  try { localPlan = prepareApprovalPlan(manifest, expectedAmount); }
  catch { fail("registration approval plan could not be prepared locally"); }
  if (
    !transaction || typeof transaction !== "object" || Array.isArray(transaction) ||
    typeof transaction.to !== "string" || typeof transaction.data !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(transaction.data)
  ) fail("candidate registration approval plan is malformed");
  let value;
  try { value = BigInt(transaction.value ?? "0x0"); }
  catch { fail("candidate registration approval value is malformed"); }
  if (
    getAddress(transaction.to) !== getAddress(localPlan.to) ||
    transaction.data.toLowerCase() !== localPlan.data.toLowerCase() ||
    value !== localPlan.value
  ) fail("candidate registration approval does not match the local SDK plan");
  return Object.freeze({ to: getAddress(localPlan.to), data: localPlan.data, value: localPlan.value });
}

function canonicalBlockHash(value, field) {
  if (typeof value !== "string" || !BYTES32_PATTERN.test(value) || /^0x0{64}$/i.test(value)) {
    fail(`${field} is invalid`);
  }
  return value.toLowerCase();
}

function assertCanonicalReceipt(receipt, transaction, originalReceipt, blockHeader) {
  let receiptFrom;
  let receiptTo;
  try {
    receiptFrom = getAddress(receipt?.from);
    receiptTo = getAddress(receipt?.to);
  } catch {
    fail(`${transaction.id} canonical receipt identity is invalid`);
  }
  if (
    receipt?.status !== "success" ||
    receipt.transactionHash?.toLowerCase() !== transaction.hash.toLowerCase() ||
    receipt.blockNumber !== BigInt(transaction.blockNumber) ||
    receiptFrom !== getAddress(transaction.from) ||
    receiptTo !== getAddress(transaction.to)
  ) fail(`${transaction.id} canonical receipt changed before evidence capture`);
  const originalBlockHash = canonicalBlockHash(
    originalReceipt?.blockHash,
    `${transaction.id} finalized receipt block hash`,
  );
  const canonicalReceiptBlockHash = canonicalBlockHash(
    receipt.blockHash,
    `${transaction.id} canonical receipt block hash`,
  );
  const canonicalHeaderHash = canonicalBlockHash(
    blockHeader?.hash,
    `${transaction.id} canonical block hash`,
  );
  if (
    originalBlockHash !== canonicalReceiptBlockHash ||
    canonicalReceiptBlockHash !== canonicalHeaderHash ||
    blockHeader.number !== BigInt(transaction.blockNumber)
  ) fail(`${transaction.id} receipt was reorged before evidence capture`);
}

async function revalidateFinalizedTransactions({
  publicClient,
  transactions,
  receipts,
  evidenceBlock,
  confirmations,
}) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 1) {
    fail("manifest confirmation policy is invalid");
  }
  const latestTransactionBlock = transactions.reduce(
    (latest, transaction) => Math.max(latest, transaction.blockNumber),
    0,
  );
  const minimumFinalizedHead = BigInt(latestTransactionBlock + confirmations - 1);
  if (evidenceBlock < minimumFinalizedHead) {
    fail("registration transactions have not reached the manifest finality policy");
  }
  await Promise.all(transactions.map(async (transaction) => {
    let canonicalReceipt;
    let blockHeader;
    try {
      [canonicalReceipt, blockHeader] = await Promise.all([
        publicClient.getTransactionReceipt({ hash: transaction.hash }),
        publicClient.getBlock({ blockNumber: BigInt(transaction.blockNumber) }),
      ]);
    } catch {
      fail(`${transaction.id} canonical receipt or block could not be revalidated`);
    }
    assertCanonicalReceipt(
      canonicalReceipt,
      transaction,
      receipts.get(transaction.id),
      blockHeader,
    );
  }));
}

function buildDryRunPlan({
  manifest,
  candidateOrigin,
  registrant,
  identity,
  durationYears,
  expectedAmount,
  approvalRequired,
}) {
  return {
    schemaVersion: "1.0.0",
    artifact: "registrationActivationSmoke",
    mode: "DRY_RUN",
    verdict: "NOT_EXECUTED",
    chainId: ARC_TESTNET_CHAIN_ID,
    rpcUrl: REGISTRATION_SMOKE_RPC_URL,
    releaseId: manifest.releaseId,
    candidateManifestSha256: deploymentManifestDigest(manifest),
    verifiedAtBlock: manifest.activationEvidence.verifiedAtBlock,
    candidateOrigin,
    registrant: registrant.address,
    normalizedLabel: identity.normalized,
    fullName: identity.name,
    tokenId: identity.tokenId.toString(),
    durationYears,
    expectedAmount: expectedAmount.toString(),
    requiredState: {
      registrationsPaused: false,
      marketplacePaused: true,
    },
    transactions: [
      ...(approvalRequired ? [{
        id: "registrationUsdcApproval",
        from: registrant.address,
        to: manifest.settlement.erc20Address,
      }] : []),
      {
        id: "registration",
        from: registrant.address,
        to: requiredContract(manifest, "controller"),
      },
    ],
    assertions: REGISTRATION_SMOKE_ASSERTION_IDS.map((id) => ({
      id,
      verdict: "PENDING_BROADCAST",
    })),
    redactions: {
      privateKeys: false,
      challengeSecrets: false,
      walletSignatures: false,
      permitSignatures: false,
    },
  };
}

export function buildRegistrationSmokeReport({
  manifest,
  candidateOrigin,
  identity,
  registrant,
  expectedAmount,
  durationYears,
  evidenceBlock,
  evidenceBlockHash,
  generatedAt,
  transactions,
  assertions,
  sensitiveValues = [],
}) {
  if (!isRegistrationSmokeTransactionSequence(transactions)) {
    fail("registration smoke transaction coverage or order is incomplete");
  }
  if (assertions.map(({ id }) => id).join(",") !== REGISTRATION_SMOKE_ASSERTION_IDS.join(",")) {
    fail("registration smoke assertion coverage or order is incomplete");
  }
  if (assertions.some(({ verdict }) => verdict !== "PASS")) {
    fail("registration smoke report contains a non-passing assertion");
  }
  const verifiedAtBlock = safePositiveBlockNumber(
    manifest.activationEvidence.verifiedAtBlock,
    "manifest verified block",
  );
  const reportEvidenceBlock = safePositiveBlockNumber(evidenceBlock, "registration evidence block");
  if (reportEvidenceBlock < verifiedAtBlock) fail("registration evidence predates manifest verification");
  const expectedTargets = {
    registrationUsdcApproval: manifest.settlement.erc20Address,
    registration: requiredContract(manifest, "controller"),
  };
  for (const transaction of transactions) {
    if (!TX_HASH_PATTERN.test(transaction.hash ?? "")) fail(`${transaction.id} hash is malformed`);
    const blockNumber = safePositiveBlockNumber(
      transaction.blockNumber,
      `${transaction.id} transaction block`,
    );
    if (blockNumber <= verifiedAtBlock || blockNumber > reportEvidenceBlock) {
      fail(`${transaction.id} transaction is outside the verified evidence interval`);
    }
    if (exactAddress(transaction.from, `${transaction.id} sender`) !== getAddress(registrant.address)) {
      fail(`${transaction.id} sender mismatch`);
    }
    if (
      exactAddress(transaction.to, `${transaction.id} target`) !==
      getAddress(expectedTargets[transaction.id])
    ) {
      fail(`${transaction.id} target mismatch`);
    }
  }
  if (typeof generatedAt !== "string" || Number.isNaN(Date.parse(generatedAt))) {
    fail("registration smoke generatedAt is invalid");
  }
  if (!Number.isInteger(durationYears) || durationYears < 1 || durationYears > 10) {
    fail("registration smoke durationYears must be 1..10");
  }
  if (!BYTES32_PATTERN.test(evidenceBlockHash ?? "") || /^0x0{64}$/i.test(evidenceBlockHash)) {
    fail("registration smoke evidenceBlockHash is invalid");
  }
  const report = {
    schemaVersion: "1.0.0",
    artifact: "registrationActivationSmoke",
    mode: "BROADCAST",
    verdict: "PASS",
    chainId: ARC_TESTNET_CHAIN_ID,
    rpcUrl: REGISTRATION_SMOKE_RPC_URL,
    releaseId: manifest.releaseId,
    candidateManifestSha256: deploymentManifestDigest(manifest),
    verifiedAtBlock,
    evidenceBlock: reportEvidenceBlock,
    evidenceBlockHash: evidenceBlockHash.toLowerCase(),
    generatedAt,
    candidateOrigin: canonicalUrl(candidateOrigin, "candidate origin"),
    registrant: getAddress(registrant.address),
    normalizedLabel: identity.normalized,
    fullName: identity.name,
    tokenId: identity.tokenId.toString(),
    durationYears,
    expectedAmount: expectedAmount.toString(),
    requiredState: {
      registrationsPaused: false,
      marketplacePaused: true,
    },
    transactions,
    assertions,
    redactions: {
      privateKeys: false,
      challengeSecrets: false,
      walletSignatures: false,
      permitSignatures: false,
    },
  };
  return assertSecretFreeReport(report, sensitiveValues);
}

async function inspectRegistrationReadiness({
  manifest,
  candidateOrigin,
  fetcher,
  publicClient,
  registrant,
  identity,
  durationYears,
}) {
  const controller = requiredContract(manifest, "controller");
  const registrar = requiredContract(manifest, "baseRegistrar");
  const marketplace = requiredContract(manifest, "marketplace");
  const settlement = manifest.settlement.erc20Address;
  let chainId;
  let head;
  try {
    [chainId, head] = await Promise.all([publicClient.getChainId(), publicClient.getBlockNumber()]);
  } catch {
    fail("Arc RPC readiness request failed");
  }
  expectEqual(chainId, ARC_TESTNET_CHAIN_ID, "Arc RPC chain ID");
  if (head < BigInt(manifest.activationEvidence.verifiedAtBlock)) {
    fail("Arc RPC head predates manifest verification");
  }
  await Promise.all(Object.entries(manifest.contracts).map(async ([key, deployment]) => {
    let bytecode;
    try { bytecode = await publicClient.getBytecode({ address: deployment.address, blockNumber: head }); }
    catch { fail(`Arc RPC bytecode read failed for ${key}`); }
    if (
      !bytecode ||
      bytecode === "0x" ||
      keccak256(bytecode).toLowerCase() !== deployment.runtimeCodeHash.toLowerCase()
    ) {
      fail(`${key} runtime code does not match the explicit manifest`);
    }
  }));

  const [
    remoteManifest,
    issuerReadiness,
    registrationsPaused,
    marketplacePaused,
    onchainRelease,
    activeSigner,
    policyVersion,
    expectedAmount,
    available,
    nonce,
    allowance,
    registrantBalance,
    registrantNative,
    controllerBalance,
    controllerLiability,
  ] = await Promise.all([
    getJson(fetcher, new URL("/api/manifest", candidateOrigin), "candidate manifest"),
    getJson(fetcher, new URL("/api/registration/readiness", candidateOrigin), "issuer readiness"),
    readAt(publicClient, controller, controllerInspectionAbi, "registrationsPaused"),
    readAt(publicClient, marketplace, marketplacePauseAbi, "paused"),
    readAt(publicClient, controller, controllerInspectionAbi, "releaseId"),
    readAt(publicClient, controller, controllerInspectionAbi, "permitSigner"),
    readAt(publicClient, controller, controllerInspectionAbi, "signerPolicyVersion"),
    readAt(publicClient, controller, controllerAbi, "quote", [identity.normalized, BigInt(durationYears)]),
    readAt(publicClient, registrar, baseRegistrarAbi, "available", [identity.tokenId]),
    readAt(publicClient, controller, controllerAbi, "nonces", [registrant.address]),
    readAt(publicClient, settlement, erc20Abi, "allowance", [registrant.address, controller], head),
    readAt(publicClient, settlement, erc20Abi, "balanceOf", [registrant.address]),
    publicClient.getBalance({ address: registrant.address }).catch(() => fail("registrant native balance read failed")),
    readAt(publicClient, settlement, erc20Abi, "balanceOf", [controller]),
    readAt(publicClient, controller, controllerInspectionAbi, "totalReferralLiability"),
  ]);
  assertCandidateManifest(manifest, remoteManifest);
  if (issuerReadiness?.ready !== true) fail("candidate permit issuer is not ready");
  if (registrationsPaused !== false) fail("controller registrations are paused");
  if (marketplacePaused !== true) fail("marketplace must remain paused during registration smoke");
  if (String(onchainRelease).toLowerCase() !== manifest.releaseId.toLowerCase()) {
    fail("controller releaseId mismatch");
  }
  if (getAddress(activeSigner) !== getAddress(manifest.permitIssuer.signerAddress)) {
    fail("permit signer mismatch");
  }
  if (String(policyVersion) !== manifest.permitIssuer.policyVersion) {
    fail("permit signer policy version mismatch");
  }
  const quote = asBigInt(expectedAmount, "registration quote");
  const balance = asBigInt(registrantBalance, "registrant USDC balance");
  const preControllerBalance = asBigInt(controllerBalance, "controller balance");
  const preControllerLiability = asBigInt(controllerLiability, "controller liability");
  if (quote <= 0n) fail("registration quote must be positive");
  if (available !== true) fail("registration smoke label is not available");
  if (balance < quote) fail("registrant has insufficient USDC");
  if (registrantNative <= 0n) fail("registrant has no Arc gas balance");
  if (preControllerBalance < preControllerLiability) fail("controller is insolvent before registration");
  return {
    head,
    expectedAmount: quote,
    nonce: asBigInt(nonce, "registrant nonce"),
    allowance: asBigInt(allowance, "registration allowance"),
    controllerBalance: preControllerBalance,
    controllerLiability: preControllerLiability,
  };
}

export async function runRegistrationSmoke({
  manifest,
  candidateOrigin,
  label,
  durationYears = 1,
  broadcastReleaseId,
  confirmRegistrant,
  env = process.env,
  account,
  publicClient,
  walletClient,
  fetcher = fetch,
  now = () => Date.now(),
}) {
  const origin = canonicalUrl(candidateOrigin, "--candidate-origin");
  let parsed;
  try { parsed = parseDeploymentManifest(structuredClone(manifest)); }
  catch { fail("explicit manifest failed canonical validation"); }
  assertRegistrationSmokeManifest(parsed, origin);
  if ((env.ARC_RPC_URL?.trim() || REGISTRATION_SMOKE_RPC_URL) !== REGISTRATION_SMOKE_RPC_URL) {
    fail(`ARC_RPC_URL must exactly equal ${REGISTRATION_SMOKE_RPC_URL}`);
  }
  if (broadcastReleaseId !== undefined && broadcastReleaseId !== parsed.releaseId) {
    fail(`--broadcast must exactly equal releaseId ${parsed.releaseId}`);
  }
  const broadcast = broadcastReleaseId !== undefined;
  if (!Number.isInteger(durationYears) || durationYears < 1 || durationYears > 10) {
    fail("durationYears must be 1..10");
  }
  if (typeof label !== "string" || label.length === 0) fail("--label is required");
  let identity;
  try { identity = deriveNameIdentity(label, parsed.namespace.suffix); }
  catch { fail("label is invalid under the pinned normalization profile"); }
  if (identity.changed) fail("registration smoke label must already be canonically normalized");

  const accountBundle = account ?? registrationAccountFromEnvironment(env);
  const registrant = accountBundle.registrant;
  const sensitiveValues = [...(accountBundle.sensitiveValues ?? [])];
  if (!registrant?.address || !isAddress(registrant.address)) fail("registrant account is invalid");
  if (broadcast) {
    if (!confirmRegistrant || !isAddress(confirmRegistrant)) {
      fail("--confirm-registrant is required for broadcast");
    }
    if (getAddress(confirmRegistrant) !== getAddress(registrant.address)) {
      fail("--confirm-registrant does not match E2E_BUYER_PRIVATE_KEY");
    }
  }

  const transport = rateLimitedArcHttp(REGISTRATION_SMOKE_RPC_URL);
  const chainClient = publicClient ?? createPublicClient({
    chain: arcTestnet,
    transport,
    batch: { multicall: { wait: 25 } },
  });
  const registrantWallet = walletClient ?? createWalletClient({
    account: registrant,
    chain: arcTestnet,
    transport,
  });
  const readiness = await inspectRegistrationReadiness({
    manifest: parsed,
    candidateOrigin: origin,
    fetcher,
    publicClient: chainClient,
    registrant,
    identity,
    durationYears,
  });
  const preflight = await postJson(fetcher, new URL("/api/registration/preflight", origin), {
    rawLabel: identity.normalized,
    normalizationAccepted: true,
    durationYears,
    payer: registrant.address,
  }, "registration preflight");
  if (
    preflight.normalizedLabel !== identity.normalized ||
    asBigInt(preflight.expectedAmount, "preflight amount") !== readiness.expectedAmount
  ) {
    fail("candidate registration preflight does not match Arc quote");
  }
  if (readiness.allowance > readiness.expectedAmount) {
    fail("registration allowance exceeds the exact Arc quote");
  }
  const approvalRequired = readiness.allowance < readiness.expectedAmount;
  if (approvalRequired !== Boolean(preflight.approvalTransaction)) {
    fail("candidate registration approval plan does not match the Arc allowance");
  }
  const approvalTransaction = approvalRequired
    ? validateApprovalTransaction(preflight.approvalTransaction, parsed, readiness.expectedAmount)
    : null;

  if (!broadcast) {
    return assertSecretFreeReport(buildDryRunPlan({
      manifest: parsed,
      candidateOrigin: origin,
      registrant,
      identity,
      durationYears,
      expectedAmount: readiness.expectedAmount,
      approvalRequired,
    }), sensitiveValues);
  }

  const settlement = parsed.settlement.erc20Address;
  const controller = requiredContract(parsed, "controller");
  const resolver = requiredContract(parsed, "publicResolver");
  const marketplace = requiredContract(parsed, "marketplace");
  const transactions = [];
  const receipts = new Map();

  if (approvalTransaction) {
    const approval = await sendAndConfirm({
      id: "registrationUsdcApproval",
      publicClient: chainClient,
      walletClient: registrantWallet,
      account: registrant,
      to: settlement,
      confirmations: parsed.chain.confirmations,
      send: () => registrantWallet.sendTransaction({
        account: registrant,
        to: approvalTransaction.to,
        data: approvalTransaction.data,
        value: approvalTransaction.value,
      }),
    });
    transactions.push(approval.transaction);
    receipts.set(approval.transaction.id, approval.receipt);
    requireEvent(approval.receipt, settlement, erc20InspectionAbi, "Approval", (args) =>
      getAddress(args.owner) === getAddress(registrant.address) &&
      getAddress(args.spender) === getAddress(controller) &&
      args.value === readiness.expectedAmount);
    const approved = await readAt(
      chainClient,
      settlement,
      erc20Abi,
      "allowance",
      [registrant.address, controller],
      approval.receipt.blockNumber,
    );
    expectEqual(approved, readiness.expectedAmount, "exact registration allowance");
  }

  const requestId = `registration-smoke-${parsed.releaseId.slice(2, 10)}-${identity.labelhash.slice(2, 18)}`;
  // Keep the activation gate on the same public prepare contract used by the
  // web UI, OpenAPI clients and hosted MCP helpers.
  const prepared = await postJson(fetcher, new URL("/api/registration/prepare", origin), {
    rawLabel: identity.normalized,
    normalizationAccepted: true,
    durationYears,
    requester: registrant.address,
    payer: registrant.address,
    recipient: registrant.address,
    requestId,
  }, "registration permit preparation");
  if (typeof prepared.signature === "string") sensitiveValues.push(prepared.signature);
  const registrationPlan = await validatePreparedRegistration({
    prepared,
    manifest: parsed,
    identity,
    seller: registrant,
    durationYears,
    expectedAmount: readiness.expectedAmount,
    nonce: readiness.nonce,
    nowSeconds: Math.floor(now() / 1_000),
  });
  const permitUsedBefore = await readAt(
    chainClient,
    controller,
    controllerAbi,
    "usedPermit",
    [registrationPlan.permitId],
    readiness.head,
  );
  if (permitUsedBefore !== false) fail("registration permit was already consumed before broadcast");

  const registration = await sendAndConfirm({
    id: "registration",
    publicClient: chainClient,
    walletClient: registrantWallet,
    account: registrant,
    to: controller,
    confirmations: parsed.chain.confirmations,
    send: () => registrantWallet.sendTransaction({
      account: registrant,
      to: controller,
      data: registrationPlan.transaction.data,
      value: 0n,
    }),
  });
  transactions.push(registration.transaction);
  receipts.set(registration.transaction.id, registration.receipt);
  requireEvent(registration.receipt, controller, controllerInspectionAbi, "PermitConsumed", (args) =>
    args.permitId.toLowerCase() === registrationPlan.permitId.toLowerCase() &&
    getAddress(args.requester) === getAddress(registrant.address) &&
    args.nonce === readiness.nonce);
  const nameEvent = requireEvent(
    registration.receipt,
    controller,
    controllerInspectionAbi,
    "NameRegistered",
    (args) => args.label.toLowerCase() === identity.labelhash.toLowerCase() &&
      getAddress(args.owner) === getAddress(registrant.address),
  );
  expectEqual(nameEvent.baseCost, readiness.expectedAmount, "registration event exact amount");

  const registrationState = await snapshotRegistration(
    chainClient,
    parsed,
    identity,
    registrationPlan.permitId,
    registrant.address,
    registration.receipt.blockNumber,
  );
  const [allowanceAfter, marketPausedAtRegistration] = await Promise.all([
    readAt(
      chainClient,
      settlement,
      erc20Abi,
      "allowance",
      [registrant.address, controller],
      registration.receipt.blockNumber,
    ),
    readAt(
      chainClient,
      marketplace,
      marketplacePauseAbi,
      "paused",
      [],
      registration.receipt.blockNumber,
    ),
  ]);
  expectEqual(registrationState.usedPermit, true, "permit consumption");
  expectEqual(registrationState.nonce, readiness.nonce + 1n, "registration nonce increment");
  expectEqual(registrationState.registrarOwner, getAddress(registrant.address), "registrar owner");
  expectEqual(registrationState.registryOwner, getAddress(registrant.address), "registry owner");
  expectEqual(registrationState.registryResolver, getAddress(resolver), "registry resolver");
  expectEqual(registrationState.resolvedAddress, zeroAddress, "empty resolver address");
  if (registrationState.expiry < nameEvent.expires) {
    fail("registrar expiry predates the NameRegistered event");
  }
  expectEqual(
    registrationState.balance - readiness.controllerBalance,
    readiness.expectedAmount,
    "controller exact USDC delta",
  );
  expectEqual(registrationState.liability, readiness.controllerLiability, "controller referral liability");
  expectEqual(allowanceAfter, 0n, "registration allowance consumption");
  expectEqual(marketPausedAtRegistration, true, "marketplace pause at registration");
  if (registrationState.balance < registrationState.liability) fail("controller is insolvent after registration");

  const issuerVerification = await postJson(fetcher, new URL("/api/registration/verify", origin), {
    transactionHash: registration.receipt.transactionHash,
    rawLabel: identity.normalized,
    recipient: registrant.address,
    requester: registrant.address,
    permitId: registrationPlan.permitId,
  }, "issuer registration verification");
  if (
    issuerVerification?.verified !== true ||
    issuerVerification.issuerReconciled !== true ||
    issuerVerification.transactionHash?.toLowerCase() !== registration.receipt.transactionHash.toLowerCase() ||
    issuerVerification.tokenId !== identity.tokenId.toString() ||
    getAddress(issuerVerification.owner) !== getAddress(registrant.address)
  ) {
    fail("issuer registration verification mismatch");
  }

  let evidenceBlock;
  try { evidenceBlock = await chainClient.getBlockNumber(); }
  catch { fail("Arc RPC evidence head read failed"); }
  if (evidenceBlock < registration.receipt.blockNumber) fail("evidence head predates registration");
  await revalidateFinalizedTransactions({
    publicClient: chainClient,
    transactions,
    receipts,
    evidenceBlock,
    confirmations: parsed.chain.confirmations,
  });
  const [finalState, finalMarketplacePaused, evidenceHeader] = await Promise.all([
    snapshotRegistration(
      chainClient,
      parsed,
      identity,
      registrationPlan.permitId,
      registrant.address,
      evidenceBlock,
    ),
    readAt(chainClient, marketplace, marketplacePauseAbi, "paused", [], evidenceBlock),
    chainClient.getBlock({ blockNumber: evidenceBlock }).catch(() => fail("Arc RPC evidence block read failed")),
  ]);
  canonicalBlockHash(evidenceHeader?.hash, "registration evidence block hash");
  if (evidenceHeader.number !== evidenceBlock) {
    fail("registration evidence block number mismatch");
  }
  expectEqual(finalState.registrarOwner, getAddress(registrant.address), "final registrar owner");
  expectEqual(finalState.registryOwner, getAddress(registrant.address), "final registry owner");
  expectEqual(finalState.usedPermit, true, "final permit consumption");
  expectEqual(finalState.nonce, readiness.nonce + 1n, "final registration nonce");
  expectEqual(finalState.registryResolver, getAddress(resolver), "final registry resolver");
  expectEqual(finalState.resolvedAddress, zeroAddress, "final resolver address");
  expectEqual(finalMarketplacePaused, true, "final marketplace pause");
  if (finalState.expiry < nameEvent.expires) fail("final registrar expiry predates registration");
  if (finalState.balance < finalState.liability) fail("controller is insolvent at evidence head");

  const assertions = [
    passAssertion("registrationPermitConsumed", "receipt+rpc", "true", String(finalState.usedPermit)),
    passAssertion("registrationNonceIncremented", "rpc", String(readiness.nonce + 1n), String(finalState.nonce)),
    passAssertion("registrationSettlementExact", "receipt+rpc", readiness.expectedAmount.toString(), String(registrationState.balance - readiness.controllerBalance)),
    passAssertion("registrationAllowanceConsumed", "rpc", "0", String(allowanceAfter)),
    passAssertion("controllerSolvent", "rpc", "balance>=liability", `balance=${finalState.balance},liability=${finalState.liability}`),
    passAssertion("registrarOwner", "rpc", registrant.address, finalState.registrarOwner),
    passAssertion("registryOwner", "rpc", registrant.address, finalState.registryOwner),
    passAssertion("resolverConfigured", "rpc", `resolver=${resolver},addr=${zeroAddress}`, `resolver=${finalState.registryResolver},addr=${finalState.resolvedAddress}`),
    passAssertion("registrationExpiry", "receipt+rpc", `expiry>=${nameEvent.expires}`, String(finalState.expiry)),
    passAssertion("issuerReconciled", "candidate-api", "true", String(issuerVerification.issuerReconciled)),
    passAssertion("marketplaceRemainedPaused", "rpc", "true", String(finalMarketplacePaused)),
  ];
  return buildRegistrationSmokeReport({
    manifest: parsed,
    candidateOrigin: origin,
    identity,
    registrant,
    expectedAmount: readiness.expectedAmount,
    durationYears,
    evidenceBlock,
    evidenceBlockHash: evidenceHeader.hash,
    generatedAt: new Date(Number(evidenceHeader.timestamp) * 1_000).toISOString(),
    transactions,
    assertions,
    sensitiveValues,
  });
}

export function parseRegistrationSmokeArgs(argv) {
  const options = {};
  const valueFlags = new Set([
    "--manifest",
    "--candidate-origin",
    "--candidate-basic-auth-file",
    "--label",
    "--duration-years",
    "--broadcast",
    "--confirm-registrant",
    "--output",
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    if (!valueFlags.has(flag)) fail(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires an explicit value`);
    index += 1;
    if (flag === "--manifest") options.manifestReference = value;
    if (flag === "--candidate-origin") options.candidateOrigin = value;
    if (flag === "--candidate-basic-auth-file") options.candidateBasicAuthFile = value;
    if (flag === "--label") options.label = value;
    if (flag === "--duration-years") options.durationYears = Number(value);
    if (flag === "--broadcast") options.broadcastReleaseId = value;
    if (flag === "--confirm-registrant") options.confirmRegistrant = value;
    if (flag === "--output") options.output = value;
  }
  if (!options.manifestReference) fail("--manifest is required");
  if (!options.candidateOrigin) fail("--candidate-origin is required");
  if (!options.label) fail("--label is required");
  if (options.broadcastReleaseId !== undefined) {
    if (!options.confirmRegistrant) fail("--confirm-registrant is required with --broadcast");
    if (!options.output) fail("--output is required with --broadcast");
  }
  return options;
}

export const REGISTRATION_SMOKE_HELP = `Usage:
  pnpm smoke:registration --manifest <controller-open-candidate.json> \\
    --candidate-origin <https://candidate.example> --label <available-label> [options]

Options:
  --duration-years <1..10>       Registration duration (default: 1)
  --candidate-basic-auth-file <path>
                                 One-line username:password file for private ingress
  --broadcast <release-id>       Execute only when value exactly matches manifest releaseId
  --confirm-registrant <address> Required for broadcast; must match the ignored buyer key
  --output <path>                Write deterministic JSON; required for broadcast
  --help                         Show this help

Runtime secrets:
  E2E_BUYER_PRIVATE_KEY is loaded by the package command from the ignored
  .local-keystores/release-activation.env file. Secret values and signatures
  are never included in the report.

Without --broadcast the runner is read-only. Both modes require registrations
open and the marketplace still paused on Arc Testnet.
`;
