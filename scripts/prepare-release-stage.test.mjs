import assert from "node:assert/strict";
import { readFile, readdir, rm, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  deploymentManifestDigest,
  parseDeploymentManifest,
  promotionExecutionTargetDigest,
  promotionSubjectDigest,
} from "../packages/config/dist/index.js";
import {
  parseReleaseStageArguments,
  prepareReleaseStage,
  runReleaseStage,
} from "./prepare-release-stage.mjs";
import { createPromotionTargetIntent } from "./lib/promotion-target.mjs";
import {
  registrationControllerOpenManifest,
  registrationSmokeEvidence,
  TEST_EVIDENCE_BLOCK,
} from "./registration-smoke-evidence.test-helper.mjs";

const HASH = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const URL = (name) => `https://evidence.example.com/releases/contour/${name}.json`;

async function configuredFixture() {
  const value = JSON.parse(await readFile(resolve("deployments/5042002.json"), "utf8"));
  value.state = "configured";
  value.activationEvidence.productLive = false;
  value.activationEvidence.verifiedAtBlock = null;
  for (const key of Object.keys(value.activationEvidence.artifacts)) {
    value.activationEvidence.artifacts[key] = { url: null, sha256: null };
  }
  value.activationEvidence.controllerPolicy.registrationsPaused = true;
  value.activationEvidence.marketplacePolicy.paused = true;
  value.permitIssuer.url = null;
  value.permitIssuer.active = false;
  for (const key of Object.keys(value.resolverCapabilities)) value.resolverCapabilities[key] = false;
  value.bens = {
    protocolConfigured: false,
    subgraphSynced: false,
    apiUrl: null,
    subgraphUrl: null,
    hostedArcscanActive: false,
  };
  value.x402.active = false;
  value.x402.facilitatorUrl = null;
  return parseDeploymentManifest(value);
}

function baselineArtifacts() {
  return Object.fromEntries([
    "deploymentReceipts",
    "constructorWiring",
    "governanceRoles",
    "treasuryControls",
    "signerPolicy",
    "releaseAttestation",
  ].map((key, index) => [key, { url: URL(key), sha256: HASH(index + 1) }]));
}

function liveArtifacts() {
  return {
    fundedEndToEnd: { url: URL("fundedEndToEnd"), sha256: HASH(100) },
    operationsDrill: { url: URL("operationsDrill"), sha256: HASH(101) },
  };
}

test("stages the strict five-phase lifecycle while preserving manifest invariants", async () => {
  const configured = await configuredFixture();
  const firstBlock = Math.max(...Object.values(configured.contracts).map((entry) => entry.deploymentBlock)) + 1;
  const verified = prepareReleaseStage(configured, {
    phase: "verified",
    verifiedAtBlock: firstBlock,
    artifacts: baselineArtifacts(),
  });
  assert.equal(verified.state, "verified");
  assert.equal(verified.permitIssuer.active, false);
  assert.equal(verified.resolverCapabilities.addr, true);
  assert.equal(verified.activationEvidence.controllerPolicy.registrationsPaused, true);

  const candidate = prepareReleaseStage(verified, {
    phase: "private-candidate",
    issuerUrl: "https://candidate.example.com/api/registration/issuer/",
    artifacts: {},
  });
  assert.equal(candidate.state, "active");
  assert.equal(candidate.activationEvidence.productLive, false);
  assert.equal(candidate.permitIssuer.active, true);

  const controllerOpen = prepareReleaseStage(candidate, {
    phase: "controller-open",
    verifiedAtBlock: firstBlock + 1,
    artifacts: {},
  });
  assert.equal(controllerOpen.activationEvidence.controllerPolicy.registrationsPaused, false);
  assert.equal(controllerOpen.activationEvidence.marketplacePolicy.paused, true);

  const registrationSmoke = registrationSmokeEvidence(controllerOpen);
  const marketOpen = prepareReleaseStage(controllerOpen, {
    phase: "market-open",
    verifiedAtBlock: TEST_EVIDENCE_BLOCK + 1,
    registrationSmoke,
    artifacts: {},
  });
  assert.equal(marketOpen.activationEvidence.marketplacePolicy.paused, false);

  const live = prepareReleaseStage(marketOpen, {
    phase: "product-live",
    verifiedAtBlock: TEST_EVIDENCE_BLOCK + 2,
    targetIntent: createPromotionTargetIntent(marketOpen, TEST_EVIDENCE_BLOCK + 2),
    artifacts: liveArtifacts(),
  });
  assert.equal(live.state, "active");
  assert.equal(live.activationEvidence.productLive, true);
  assert.doesNotThrow(() => parseDeploymentManifest(live));
  assert.equal(promotionExecutionTargetDigest(marketOpen), promotionExecutionTargetDigest(live));
  assert.notEqual(promotionSubjectDigest(marketOpen), promotionSubjectDigest(live));
  assert.match(deploymentManifestDigest(live), /^0x[0-9a-f]{64}$/);
  assert.match(promotionSubjectDigest(live), /^0x[0-9a-f]{64}$/);
  assert.notEqual(deploymentManifestDigest(live), promotionSubjectDigest(live));
});

test("argument parsing is phase-specific and refuses missing or secret-like inputs", async () => {
  assert.throws(
    () => parseReleaseStageArguments(["--input", "in.json", "--output", "out.json", "--phase", "private-candidate"]),
    /--issuer-url is required/,
  );
  assert.throws(
    () => parseReleaseStageArguments([
      "--input", "in.json", "--output", "out.json", "--phase", "private-candidate",
      "--issuer-url", "https://candidate.example.com", "--verified-at-block", "1",
    ]),
    /not valid for phase/,
  );
  assert.throws(
    () => parseReleaseStageArguments([
      "--input", "in.json", "--output", "out.json", "--phase", "market-open",
      "--verified-at-block", "100",
    ]),
    /--registration-smoke is required/,
  );
  const configured = await configuredFixture();
  configured.privateKey = `0x${"11".repeat(32)}`;
  assert.throws(
    () => prepareReleaseStage(configured, {
      phase: "verified",
      verifiedAtBlock: 60_000_000,
      artifacts: baselineArtifacts(),
    }),
    /forbidden secret-bearing field privateKey/,
  );
});

test("market-open staging requires exact offline registration smoke binding", async () => {
  const controllerOpen = await registrationControllerOpenManifest();
  const registrationSmoke = registrationSmokeEvidence(controllerOpen);
  const options = {
    phase: "market-open",
    verifiedAtBlock: TEST_EVIDENCE_BLOCK + 1,
    artifacts: {},
  };
  assert.throws(
    () => prepareReleaseStage(controllerOpen, options),
    /requires registration smoke PASS evidence/,
  );
  const staged = prepareReleaseStage(controllerOpen, { ...options, registrationSmoke });
  assert.equal(staged.activationEvidence.marketplacePolicy.paused, false);
  assert.equal(staged.activationEvidence.verifiedAtBlock, TEST_EVIDENCE_BLOCK + 1);

  const tampered = registrationSmokeEvidence(controllerOpen, {
    candidateManifestSha256: HASH(900),
  });
  assert.throws(
    () => prepareReleaseStage(controllerOpen, { ...options, registrationSmoke: tampered }),
    /exact controller-open predecessor/,
  );
  assert.throws(
    () => prepareReleaseStage(controllerOpen, {
      ...options,
      registrationSmoke,
      verifiedAtBlock: TEST_EVIDENCE_BLOCK,
    }),
    /later than registration smoke evidence/,
  );
});

test("market-open CLI loads canonical smoke bytes and never writes on tamper", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "contour-market-stage-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const controllerOpen = await registrationControllerOpenManifest();
  const evidence = registrationSmokeEvidence(controllerOpen);
  const inputPath = join(directory, "controller-open.json");
  const smokePath = join(directory, "registration-smoke.json");
  const outputPath = join(directory, "market-open.json");
  await writeFile(inputPath, `${JSON.stringify(controllerOpen, null, 2)}\n`);
  await writeFile(smokePath, evidence.reportBytes);
  const report = await runReleaseStage([
    "--input", inputPath,
    "--output", outputPath,
    "--phase", "market-open",
    "--verified-at-block", String(TEST_EVIDENCE_BLOCK + 1),
    "--registration-smoke", smokePath,
  ]);
  assert.equal(report.registrationSmoke.reportSha256, evidence.reportSha256);
  assert.equal(
    JSON.parse(await readFile(outputPath, "utf8")).activationEvidence.marketplacePolicy.paused,
    false,
  );

  const tamperedPath = join(directory, "tampered-smoke.json");
  const refusedOutput = join(directory, "refused-market-open.json");
  await writeFile(tamperedPath, registrationSmokeEvidence(controllerOpen, {
    candidateManifestSha256: HASH(901),
  }).reportBytes);
  await assert.rejects(runReleaseStage([
    "--input", inputPath,
    "--output", refusedOutput,
    "--phase", "market-open",
    "--verified-at-block", String(TEST_EVIDENCE_BLOCK + 1),
    "--registration-smoke", tamperedPath,
  ]), /exact controller-open predecessor/);
  await assert.rejects(readFile(refusedOutput), (error) => error?.code === "ENOENT");
});

test("CLI writes with no-overwrite by default and uses a clean atomic replacement when authorized", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "contour-release-stage-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, "configured.json");
  const outputPath = join(directory, "verified.json");
  const configured = await configuredFixture();
  await writeFile(inputPath, `${JSON.stringify(configured, null, 2)}\n`);
  const firstBlock = Math.max(...Object.values(configured.contracts).map((entry) => entry.deploymentBlock)) + 1;
  const artifactArgs = Object.entries({
    deploymentReceipts: "deployment-receipts",
    constructorWiring: "constructor-wiring",
    governanceRoles: "governance-roles",
    treasuryControls: "treasury-controls",
    signerPolicy: "signer-policy",
    releaseAttestation: "release-attestation",
  }).flatMap(([key, flag], index) => [
    `--${flag}-url`, baselineArtifacts()[key].url,
    `--${flag}-sha256`, HASH(index + 1),
  ]);
  const args = [
    "--input", inputPath,
    "--output", outputPath,
    "--phase", "verified",
    "--verified-at-block", String(firstBlock),
    ...artifactArgs,
  ];

  const report = await runReleaseStage(args);
  assert.equal(report.phase, "verified");
  assert.equal(report.manifestSha256, deploymentManifestDigest(JSON.parse(await readFile(outputPath, "utf8"))));
  await assert.rejects(runReleaseStage(args), (error) => error?.code === "EEXIST");

  const overwritten = await runReleaseStage([...args, "--overwrite"]);
  assert.equal(overwritten.overwrite, true);
  assert.deepEqual(
    (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    [],
  );
});
