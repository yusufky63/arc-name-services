import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getAddress, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentManifestDigest } from "../packages/config/dist/index.js";
import { deriveNameIdentity } from "../packages/normalization/dist/index.js";
import { prepareApprovalPlan } from "../packages/sdk/dist/index.js";
import {
  canonicalRegistrationSmokeJson,
  parseCanonicalRegistrationSmokeBytes,
  revalidateRegistrationSmokeEvidence,
  validateRegistrationSmokeLifecycle,
} from "./lib/registration-smoke-evidence.mjs";
import {
  buildRegistrationSmokeReport,
  parseRegistrationSmokeArgs,
  registrationAccountFromEnvironment,
  REGISTRATION_SMOKE_ASSERTION_IDS,
  REGISTRATION_SMOKE_RPC_URL,
  REGISTRATION_SMOKE_TRANSACTION_IDS,
  runRegistrationSmoke,
} from "./lib/registration-smoke.mjs";
import {
  BROADCAST_EXPIRY,
  BROADCAST_NONCE,
  BROADCAST_NOW_SECONDS,
  BROADCAST_QUOTE,
  createRegistrationBroadcastHarness,
} from "./registration-smoke-broadcast.test-helper.mjs";

const ORIGIN = "https://candidate.example";
const REGISTRANT = getAddress("0x2222222222222222222222222222222222222222");
const HASH = (value) => `0x${value.toString(16).padStart(64, "0")}`;

async function registrationCandidate() {
  const manifest = JSON.parse(await readFile("deployments/5042002.json", "utf8"));
  manifest.state = "active";
  manifest.activationEvidence.productLive = false;
  manifest.activationEvidence.verifiedAtBlock = 52_200_000;
  for (const [index, key] of [
    "deploymentReceipts",
    "constructorWiring",
    "governanceRoles",
    "treasuryControls",
    "signerPolicy",
    "releaseAttestation",
  ].entries()) {
    manifest.activationEvidence.artifacts[key] = {
      url: `https://evidence.example/releases/${key}.json`,
      sha256: HASH(index + 1),
    };
  }
  manifest.activationEvidence.controllerPolicy.registrationsPaused = false;
  manifest.activationEvidence.marketplacePolicy.paused = true;
  manifest.permitIssuer.url = `${ORIGIN}/api/registration/issuer/`;
  manifest.permitIssuer.active = true;
  for (const key of Object.keys(manifest.resolverCapabilities)) {
    manifest.resolverCapabilities[key] = key !== "ccipRead";
  }
  Object.values(manifest.contracts).forEach((deployment, index) => {
    deployment.runtimeCodeHash = keccak256(`0x60${index.toString(16).padStart(2, "0")}00`);
  });
  return manifest;
}

function fixtureBytecode(manifest, address) {
  const index = Object.values(manifest.contracts).findIndex(
    (deployment) => getAddress(deployment.address) === getAddress(address),
  );
  if (index < 0) throw new Error("unknown contract");
  return `0x60${index.toString(16).padStart(2, "0")}00`;
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(value); },
  };
}

function dryRunHarness(manifest, {
  marketplacePaused = true,
  registrationsPaused = false,
  allowance = 0n,
} = {}) {
  const quote = 500_000n;
  let writes = 0;
  let signatures = 0;
  const controller = getAddress(manifest.contracts.controller.address);
  const publicClient = {
    async getChainId() { return 5_042_002; },
    async getBlockNumber() { return 52_200_100n; },
    async getBytecode({ address }) { return fixtureBytecode(manifest, address); },
    async getBalance() { return 1_000_000_000_000_000_000n; },
    async readContract({ functionName, args }) {
      if (functionName === "registrationsPaused") return registrationsPaused;
      if (functionName === "paused") return marketplacePaused;
      if (functionName === "releaseId") return manifest.releaseId;
      if (functionName === "permitSigner") return manifest.permitIssuer.signerAddress;
      if (functionName === "signerPolicyVersion") return 1n;
      if (functionName === "quote") return quote;
      if (functionName === "available") return true;
      if (functionName === "nonces") return 7n;
      if (functionName === "allowance") return allowance;
      if (functionName === "totalReferralLiability") return 0n;
      if (functionName === "balanceOf") {
        return getAddress(args[0]) === controller ? 1_000_000n : 10_000_000n;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/api/manifest" && !init.method) return jsonResponse(manifest);
    if (url.pathname === "/api/registration/readiness" && !init.method) {
      return jsonResponse({ ready: true });
    }
    if (url.pathname === "/api/registration/preflight" && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.payer, REGISTRANT);
      return jsonResponse({
        normalizedLabel: "registration-smoke",
        expectedAmount: quote.toString(),
        approvalTransaction: allowance < quote
          ? {
              to: prepareApprovalPlan(manifest, quote).to,
              data: prepareApprovalPlan(manifest, quote).data,
              value: "0x0",
            }
          : null,
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const registrant = {
    address: REGISTRANT,
    async signMessage() { signatures += 1; throw new Error("dry run signed"); },
  };
  const walletClient = {
    async writeContract() { writes += 1; throw new Error("dry run wrote"); },
    async sendTransaction() { writes += 1; throw new Error("dry run wrote"); },
  };
  return {
    quote,
    publicClient,
    fetcher,
    account: {
      registrant,
      sensitiveValues: ["registration-smoke-secret-value"],
    },
    walletClient,
    counters: () => ({ writes, signatures }),
  };
}

test("read-only registration smoke requires controller open and marketplace paused", async () => {
  const manifest = await registrationCandidate();
  const harness = dryRunHarness(manifest);
  const result = await runRegistrationSmoke({
    manifest,
    candidateOrigin: ORIGIN,
    label: "registration-smoke",
    env: { ARC_RPC_URL: REGISTRATION_SMOKE_RPC_URL },
    account: harness.account,
    publicClient: harness.publicClient,
    walletClient: harness.walletClient,
    fetcher: harness.fetcher,
  });
  assert.equal(result.artifact, "registrationActivationSmoke");
  assert.equal(result.mode, "DRY_RUN");
  assert.equal(result.verdict, "NOT_EXECUTED");
  assert.equal(result.rpcUrl, REGISTRATION_SMOKE_RPC_URL);
  assert.deepEqual(result.requiredState, {
    registrationsPaused: false,
    marketplacePaused: true,
  });
  assert.deepEqual(result.transactions.map(({ id }) => id), REGISTRATION_SMOKE_TRANSACTION_IDS);
  assert.deepEqual(result.assertions.map(({ id }) => id), REGISTRATION_SMOKE_ASSERTION_IDS);
  assert.deepEqual(harness.counters(), { writes: 0, signatures: 0 });
  assert.doesNotMatch(JSON.stringify(result), /registration-smoke-secret-value/);

  const openMarket = dryRunHarness(manifest, { marketplacePaused: false });
  await assert.rejects(runRegistrationSmoke({
    manifest,
    candidateOrigin: ORIGIN,
    label: "registration-smoke",
    account: openMarket.account,
    publicClient: openMarket.publicClient,
    walletClient: openMarket.walletClient,
    fetcher: openMarket.fetcher,
  }), /marketplace must remain paused/);
  assert.deepEqual(openMarket.counters(), { writes: 0, signatures: 0 });
});

test("broadcast confirmations and the canonical RPC fail closed before effects", async () => {
  const manifest = await registrationCandidate();
  const harness = dryRunHarness(manifest);
  await assert.rejects(runRegistrationSmoke({
    manifest,
    candidateOrigin: ORIGIN,
    label: "registration-smoke",
    broadcastReleaseId: HASH(999),
    confirmRegistrant: REGISTRANT,
    account: harness.account,
    publicClient: harness.publicClient,
    walletClient: harness.walletClient,
    fetcher: harness.fetcher,
  }), /--broadcast must exactly equal releaseId/);
  await assert.rejects(runRegistrationSmoke({
    manifest,
    candidateOrigin: ORIGIN,
    label: "registration-smoke",
    env: { ARC_RPC_URL: "https://example.invalid" },
    account: harness.account,
    publicClient: harness.publicClient,
    walletClient: harness.walletClient,
    fetcher: harness.fetcher,
  }), /ARC_RPC_URL must exactly equal/);
  assert.deepEqual(harness.counters(), { writes: 0, signatures: 0 });
});

for (const { name, initialAllowance, expectedTransactionIds } of [
  {
    name: "insufficient allowance sends approval and registration",
    initialAllowance: 0n,
    expectedTransactionIds: ["registrationUsdcApproval", "registration"],
  },
  {
    name: "exact allowance sends only registration",
    initialAllowance: BROADCAST_QUOTE,
    expectedTransactionIds: ["registration"],
  },
]) {
  test(`successful broadcast ${name} and emits fully revalidatable PASS evidence`, async () => {
    const harness = await createRegistrationBroadcastHarness(
      await registrationCandidate(),
      { initialAllowance },
    );
    const report = await runRegistrationSmoke({
      manifest: harness.manifest,
      candidateOrigin: harness.origin,
      label: "registration-smoke",
      broadcastReleaseId: harness.manifest.releaseId,
      confirmRegistrant: harness.registrant,
      env: { ARC_RPC_URL: REGISTRATION_SMOKE_RPC_URL },
      account: harness.account,
      publicClient: harness.publicClient,
      walletClient: harness.walletClient,
      fetcher: harness.fetcher,
      now: () => BROADCAST_NOW_SECONDS * 1_000,
    });

    assert.equal(report.mode, "BROADCAST");
    assert.equal(report.verdict, "PASS");
    assert.equal(report.evidenceBlock, Number(harness.evidenceBlock));
    assert.equal(report.evidenceBlockHash, harness.evidenceBlockHash);
    assert.equal(
      report.generatedAt,
      new Date(Number(harness.evidenceTimestamp) * 1_000).toISOString(),
    );
    assert.deepEqual(report.transactions.map(({ id }) => id), expectedTransactionIds);
    assert.equal(report.transactions.at(-1).hash, harness.registrationHash);
    assert.equal(report.transactions.at(-1).blockNumber, Number(harness.registrationBlock));
    assert.equal(report.transactions.at(-1).from, harness.registrant);
    assert.equal(report.transactions.at(-1).to, harness.controller);
    assert.equal(harness.calls.sends.length, expectedTransactionIds.length);
    assert.equal(harness.calls.writeContracts, 0);
    assert.equal(harness.calls.signatures, 0);
    assert.ok(harness.calls.receiptWaits.every(({ confirmations, timeout }) =>
      confirmations === harness.manifest.chain.confirmations && timeout === 180_000));
    assert.ok(harness.calls.blockReads.includes(harness.registrationBlock));
    assert.ok(harness.calls.blockReads.includes(harness.evidenceBlock));

    const assertions = Object.fromEntries(report.assertions.map((assertion) => [assertion.id, assertion]));
    assert.equal(assertions.registrationPermitConsumed.actual, "true");
    assert.equal(assertions.registrationNonceIncremented.actual, String(BROADCAST_NONCE + 1n));
    assert.equal(assertions.registrationSettlementExact.actual, BROADCAST_QUOTE.toString());
    assert.equal(assertions.registrationAllowanceConsumed.actual, "0");
    assert.match(assertions.controllerSolvent.actual, /^balance=[0-9]+,liability=[0-9]+$/);
    assert.equal(assertions.registrarOwner.actual, harness.registrant);
    assert.equal(assertions.registryOwner.actual, harness.registrant);
    assert.equal(
      assertions.resolverConfigured.actual,
      `resolver=${harness.resolver},addr=0x0000000000000000000000000000000000000000`,
    );
    assert.equal(assertions.registrationExpiry.actual, BROADCAST_EXPIRY.toString());
    assert.deepEqual(assertions.issuerReconciled, {
      id: "issuerReconciled",
      verdict: "PASS",
      source: "candidate-api",
      expected: "true",
      actual: "true",
    });
    assert.equal(assertions.marketplaceRemainedPaused.actual, "true");
    assert.ok(report.assertions.every(({ verdict }) => verdict === "PASS"));
    const serialized = JSON.stringify(report);
    for (const secret of harness.secrets) assert.doesNotMatch(serialized, new RegExp(secret.slice(2), "i"));

    const canonical = parseCanonicalRegistrationSmokeBytes(canonicalRegistrationSmokeJson(report));
    const binding = validateRegistrationSmokeLifecycle({
      ...canonical,
      controllerOpenManifest: harness.manifest,
      candidateOrigin: harness.origin,
    });
    const revalidated = await revalidateRegistrationSmokeEvidence({
      publicClient: harness.publicClient,
      controllerOpenManifest: harness.manifest,
      binding,
    });
    assert.equal(revalidated.registrationTransactionHash, harness.registrationHash);
  });
}

test("broadcast rejects excessive allowance before the first write", async () => {
  const harness = await createRegistrationBroadcastHarness(
    await registrationCandidate(),
    { initialAllowance: BROADCAST_QUOTE + 1n },
  );
  await assert.rejects(runRegistrationSmoke({
    manifest: harness.manifest,
    candidateOrigin: harness.origin,
    label: "registration-smoke",
    broadcastReleaseId: harness.manifest.releaseId,
    confirmRegistrant: harness.registrant,
    account: harness.account,
    publicClient: harness.publicClient,
    walletClient: harness.walletClient,
    fetcher: harness.fetcher,
    now: () => BROADCAST_NOW_SECONDS * 1_000,
  }), /allowance exceeds the exact Arc quote/);
  assert.equal(harness.calls.sends.length, 0);
  assert.equal(harness.calls.signatures, 0);
});

test("broadcast verifies the permit against the canonical manifest governance signer before writing", async () => {
  const harness = await createRegistrationBroadcastHarness(
    await registrationCandidate(),
    { initialAllowance: BROADCAST_QUOTE },
  );
  const wrongSigner = privateKeyToAccount(`0x${"44".repeat(32)}`).address;
  harness.manifest.activationEvidence.governance.account = wrongSigner;
  harness.manifest.activationEvidence.controllerPolicy.permitSigner = wrongSigner;
  harness.manifest.permitIssuer.signerAddress = wrongSigner;

  await assert.rejects(runRegistrationSmoke({
    manifest: harness.manifest,
    candidateOrigin: harness.origin,
    label: "registration-smoke",
    broadcastReleaseId: harness.manifest.releaseId,
    confirmRegistrant: harness.registrant,
    env: { ARC_RPC_URL: REGISTRATION_SMOKE_RPC_URL },
    account: harness.account,
    publicClient: harness.publicClient,
    walletClient: harness.walletClient,
    fetcher: harness.fetcher,
    now: () => BROADCAST_NOW_SECONDS * 1_000,
  }), /permit signature does not match the manifest signer/);
  assert.equal(harness.calls.sends.length, 0);
});

test("broadcast refuses reorged receipts and insufficient confirmation depth", async (context) => {
  await context.test("receipt block hash changed", async () => {
    const harness = await createRegistrationBroadcastHarness(
      await registrationCandidate(),
      { initialAllowance: BROADCAST_QUOTE, reorgRegistrationReceipt: true },
    );
    await assert.rejects(runRegistrationSmoke({
      manifest: harness.manifest,
      candidateOrigin: harness.origin,
      label: "registration-smoke",
      broadcastReleaseId: harness.manifest.releaseId,
      confirmRegistrant: harness.registrant,
      account: harness.account,
      publicClient: harness.publicClient,
      walletClient: harness.walletClient,
      fetcher: harness.fetcher,
      now: () => BROADCAST_NOW_SECONDS * 1_000,
    }), /receipt was reorged before evidence capture/);
  });

  await context.test("evidence head is below manifest finality", async () => {
    const harness = await createRegistrationBroadcastHarness(
      await registrationCandidate(),
      { initialAllowance: BROADCAST_QUOTE, finalityShortfall: true },
    );
    await assert.rejects(runRegistrationSmoke({
      manifest: harness.manifest,
      candidateOrigin: harness.origin,
      label: "registration-smoke",
      broadcastReleaseId: harness.manifest.releaseId,
      confirmRegistrant: harness.registrant,
      account: harness.account,
      publicClient: harness.publicClient,
      walletClient: harness.walletClient,
      fetcher: harness.fetcher,
      now: () => BROADCAST_NOW_SECONDS * 1_000,
    }), /evidence head predates registration|have not reached the manifest finality policy/);
  });
});

test("registration account accepts the ignored buyer key format and redacts it", () => {
  const secret = "22".repeat(32);
  const account = registrationAccountFromEnvironment({ E2E_BUYER_PRIVATE_KEY: secret });
  assert.ok(account.registrant.address);
  assert.deepEqual(account.sensitiveValues, [`0x${secret}`]);
  assert.doesNotMatch(JSON.stringify({ registrant: account.registrant.address }), new RegExp(secret, "i"));
  assert.throws(
    () => registrationAccountFromEnvironment({ E2E_BUYER_PRIVATE_KEY: "00".repeat(32) }),
    /non-zero/,
  );
});

test("broadcast CLI requires recipient confirmation and an exclusive evidence output", async () => {
  const manifest = await registrationCandidate();
  const base = [
    "--manifest", "candidate.json",
    "--candidate-origin", ORIGIN,
    "--label", "registration-smoke",
    "--broadcast", manifest.releaseId,
  ];
  assert.throws(() => parseRegistrationSmokeArgs(base), /--confirm-registrant is required/);
  assert.throws(() => parseRegistrationSmokeArgs([
    ...base,
    "--confirm-registrant", REGISTRANT,
  ]), /--output is required/);
  const parsed = parseRegistrationSmokeArgs([
    ...base,
    "--confirm-registrant", REGISTRANT,
    "--output", "registration-smoke.json",
  ]);
  assert.equal(parsed.broadcastReleaseId, manifest.releaseId);
  assert.equal(parsed.confirmRegistrant, REGISTRANT);
});

test("registration smoke evidence binds both receipts, all assertions, and no secrets", async () => {
  const manifest = await registrationCandidate();
  const identity = deriveNameIdentity("registration-smoke", manifest.namespace.suffix);
  const verifiedAtBlock = manifest.activationEvidence.verifiedAtBlock;
  const transactions = [
    {
      id: "registrationUsdcApproval",
      hash: HASH(101),
      blockNumber: verifiedAtBlock + 1,
      from: REGISTRANT,
      to: manifest.settlement.erc20Address,
    },
    {
      id: "registration",
      hash: HASH(102),
      blockNumber: verifiedAtBlock + 2,
      from: REGISTRANT,
      to: manifest.contracts.controller.address,
    },
  ];
  const assertions = REGISTRATION_SMOKE_ASSERTION_IDS.map((id) => ({
    id,
    verdict: "PASS",
    source: "test",
    expected: "expected",
    actual: "actual",
  }));
  const secret = `0x${"77".repeat(32)}`;
  const report = buildRegistrationSmokeReport({
    manifest,
    candidateOrigin: ORIGIN,
    identity,
    registrant: { address: REGISTRANT },
    expectedAmount: 500_000n,
    durationYears: 1,
    evidenceBlock: verifiedAtBlock + 3,
    evidenceBlockHash: HASH(103),
    generatedAt: "2026-07-17T12:00:00.000Z",
    transactions,
    assertions,
    sensitiveValues: [secret],
  });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.candidateManifestSha256, deploymentManifestDigest(manifest));
  assert.equal(Object.hasOwn(report, "manifestSha256"), false);
  assert.equal(report.candidateOrigin, ORIGIN);
  assert.equal(report.requiredState.marketplacePaused, true);
  assert.deepEqual(report.transactions, transactions);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(secret.slice(2), "i"));

  assert.throws(() => buildRegistrationSmokeReport({
    manifest,
    candidateOrigin: ORIGIN,
    identity,
    registrant: { address: REGISTRANT },
    expectedAmount: 500_000n,
    durationYears: 1,
    evidenceBlock: verifiedAtBlock + 3,
    evidenceBlockHash: HASH(103),
    generatedAt: "2026-07-17T12:00:00.000Z",
    transactions: [],
    assertions,
  }), /transaction coverage or order/);
});
