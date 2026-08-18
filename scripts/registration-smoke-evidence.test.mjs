import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalRegistrationSmokeJson,
  controllerOpenPredecessorFromMarketOpen,
  parseCanonicalRegistrationSmokeBytes,
  registrationSmokeBindingRecord,
  revalidateRegistrationSmokeEvidence,
  validateRegistrationSmokeLifecycle,
} from "./lib/registration-smoke-evidence.mjs";
import {
  registrationControllerOpenManifest,
  registrationSmokeChainFixture,
  registrationSmokeEvidence,
  registrationSmokeReport,
  TEST_CANDIDATE_ORIGIN,
} from "./registration-smoke-evidence.test-helper.mjs";

test("canonical registration evidence binds the exact controller-open predecessor", async () => {
  const manifest = await registrationControllerOpenManifest();
  const evidence = registrationSmokeEvidence(manifest);
  const binding = validateRegistrationSmokeLifecycle({
    ...evidence,
    controllerOpenManifest: manifest,
    candidateOrigin: TEST_CANDIDATE_ORIGIN,
  });
  assert.equal(binding.candidateVerifiedAtBlock, manifest.activationEvidence.verifiedAtBlock);
  assert.equal(binding.candidateManifestSha256, evidence.report.candidateManifestSha256);
  assert.equal(registrationSmokeBindingRecord(binding).registrationTransactionHash, evidence.report.transactions[1].hash);

  const tampered = structuredClone(evidence.report);
  tampered.candidateManifestSha256 = `0x${"99".repeat(32)}`;
  assert.throws(() => validateRegistrationSmokeLifecycle({
    report: tampered,
    reportSha256: evidence.reportSha256,
    controllerOpenManifest: manifest,
    candidateOrigin: TEST_CANDIDATE_ORIGIN,
  }), /SHA-256 does not match|exact controller-open predecessor/);

  const wrongState = structuredClone(manifest);
  wrongState.activationEvidence.marketplacePolicy.paused = false;
  assert.throws(() => validateRegistrationSmokeLifecycle({
    ...evidence,
    controllerOpenManifest: wrongState,
    candidateOrigin: TEST_CANDIDATE_ORIGIN,
  }), /controller-open private candidate/);
});

test("canonical parser rejects mutable bytes and recomputes the report digest", async () => {
  const manifest = await registrationControllerOpenManifest();
  const report = registrationSmokeReport(manifest);
  assert.throws(
    () => parseCanonicalRegistrationSmokeBytes(JSON.stringify(report)),
    /deterministic canonical JSON/,
  );
  const evidence = parseCanonicalRegistrationSmokeBytes(canonicalRegistrationSmokeJson(report));
  assert.throws(() => validateRegistrationSmokeLifecycle({
    ...evidence,
    reportSha256: `0x${"aa".repeat(32)}`,
    controllerOpenManifest: manifest,
    candidateOrigin: TEST_CANDIDATE_ORIGIN,
  }), /SHA-256 does not match/);
});

test("market-open projection preserves the exact controller-open interval", async () => {
  const controllerOpen = await registrationControllerOpenManifest();
  const evidence = registrationSmokeEvidence(controllerOpen);
  const marketOpen = structuredClone(controllerOpen);
  marketOpen.activationEvidence.marketplacePolicy.paused = false;
  marketOpen.activationEvidence.verifiedAtBlock = evidence.report.evidenceBlock + 1;
  const projected = controllerOpenPredecessorFromMarketOpen(marketOpen, evidence.report);
  assert.deepEqual(projected, controllerOpen);

  marketOpen.activationEvidence.verifiedAtBlock = evidence.report.evidenceBlock;
  assert.throws(
    () => controllerOpenPredecessorFromMarketOpen(marketOpen, evidence.report),
    /verified later than registration smoke evidence/,
  );
});

test("historical Arc receipt, block and state revalidation passes exact evidence", async () => {
  const manifest = await registrationControllerOpenManifest();
  const fixture = registrationSmokeChainFixture(manifest);
  const result = await revalidateRegistrationSmokeEvidence({
    publicClient: fixture.publicClient,
    controllerOpenManifest: manifest,
    binding: fixture.binding,
  });
  assert.equal(result.reportSha256, fixture.evidence.reportSha256);
  assert.equal(result.evidenceBlockHash, fixture.evidence.report.evidenceBlockHash);
  assert.equal(result.registrationTransactionHash, fixture.evidence.report.transactions[1].hash);
});

test("historical revalidation rejects evidence-block reorgs", async () => {
  const manifest = await registrationControllerOpenManifest();
  const fixture = registrationSmokeChainFixture(manifest, {
    evidenceBlockHash: `0x${"ab".repeat(32)}`,
  });
  await assert.rejects(revalidateRegistrationSmokeEvidence({
    publicClient: fixture.publicClient,
    controllerOpenManifest: manifest,
    binding: fixture.binding,
  }), /block hash or timestamp mismatch/);
});

test("historical revalidation rejects transaction-receipt block hash reorgs", async () => {
  const manifest = await registrationControllerOpenManifest();
  const fixture = registrationSmokeChainFixture(manifest, {
    registrationReceiptBlockHash: `0x${"ab".repeat(32)}`,
  });
  await assert.rejects(revalidateRegistrationSmokeEvidence({
    publicClient: fixture.publicClient,
    controllerOpenManifest: manifest,
    binding: fixture.binding,
  }), /receipt block hash no longer matches the canonical transaction block/);
});

test("historical revalidation rejects changed receipts and settlement logs", async () => {
  const manifest = await registrationControllerOpenManifest();
  const wrongReceipt = registrationSmokeChainFixture(manifest);
  const registrationHash = wrongReceipt.evidence.report.transactions[1].hash.toLowerCase();
  wrongReceipt.receipts.get(registrationHash).status = "reverted";
  await assert.rejects(revalidateRegistrationSmokeEvidence({
    publicClient: wrongReceipt.publicClient,
    controllerOpenManifest: manifest,
    binding: wrongReceipt.binding,
  }), /receipt no longer matches/);

  const missingTransfer = registrationSmokeChainFixture(manifest);
  missingTransfer.receipts.get(registrationHash).logs = missingTransfer.receipts
    .get(registrationHash).logs.filter((log) => log.address.toLowerCase() !== manifest.settlement.erc20Address.toLowerCase());
  await assert.rejects(revalidateRegistrationSmokeEvidence({
    publicClient: missingTransfer.publicClient,
    controllerOpenManifest: manifest,
    binding: missingTransfer.binding,
  }), /Transfer event is missing/);
});

for (const [name, state, pattern] of [
  ["marketplace pause", { marketplacePaused: false }, /historical state/],
  ["registrar owner", { registrarOwner: "0x1111111111111111111111111111111111111111" }, /historical state/],
  ["permit nonce", { nonce: 9n }, /historical state/],
  ["controller solvency", { controllerBalance: 0n, controllerLiability: 1n }, /historical state/],
]) {
  test(`historical revalidation rejects changed ${name}`, async () => {
    const manifest = await registrationControllerOpenManifest();
    const fixture = registrationSmokeChainFixture(manifest, { state });
    await assert.rejects(revalidateRegistrationSmokeEvidence({
      publicClient: fixture.publicClient,
      controllerOpenManifest: manifest,
      binding: fixture.binding,
    }), pattern);
  });
}
