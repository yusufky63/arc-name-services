#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  deploymentManifestDigest,
  EXPECTED_RESOLVER_CAPABILITIES,
  parseDeploymentManifest,
  promotionExecutionTargetDigest,
  promotionSubjectDigest,
} from "../packages/config/dist/index.js";
import { validatePromotionTargetPair } from "./lib/promotion-target.mjs";
import {
  loadRegistrationSmokeEvidence,
  registrationSmokeBindingRecord,
  validateRegistrationSmokeLifecycle,
} from "./lib/registration-smoke-evidence.mjs";

const PHASES = Object.freeze([
  "verified",
  "private-candidate",
  "controller-open",
  "market-open",
  "product-live",
]);

const ARTIFACT_FLAGS = Object.freeze({
  deploymentReceipts: ["--deployment-receipts-url", "--deployment-receipts-sha256"],
  constructorWiring: ["--constructor-wiring-url", "--constructor-wiring-sha256"],
  governanceRoles: ["--governance-roles-url", "--governance-roles-sha256"],
  treasuryControls: ["--treasury-controls-url", "--treasury-controls-sha256"],
  signerPolicy: ["--signer-policy-url", "--signer-policy-sha256"],
  releaseAttestation: ["--release-attestation-url", "--release-attestation-sha256"],
  fundedEndToEnd: ["--funded-end-to-end-url", "--funded-end-to-end-sha256"],
  operationsDrill: ["--operations-drill-url", "--operations-drill-sha256"],
});

const COMMON_VALUE_FLAGS = new Set(["--input", "--output", "--phase"]);
const VALUE_FLAGS = new Set([
  ...COMMON_VALUE_FLAGS,
  "--verified-at-block",
  "--issuer-url",
  "--registration-smoke",
  "--target-intent",
  ...Object.values(ARTIFACT_FLAGS).flat(),
]);

const BASELINE_ARTIFACTS = Object.freeze([
  "deploymentReceipts",
  "constructorWiring",
  "governanceRoles",
  "treasuryControls",
  "signerPolicy",
  "releaseAttestation",
]);

const USAGE = [
  "usage: prepare-release-stage --input <manifest.json> --output <staged.json>",
  "  --phase <verified|private-candidate|controller-open|market-open|product-live>",
  "  [phase-specific arguments] [--overwrite]",
].join(" ");

function fail(message) {
  throw new Error(`release stage refused: ${message}`);
}

function requiredFlagsForPhase(phase) {
  if (phase === "verified") {
    return [
      "--verified-at-block",
      ...BASELINE_ARTIFACTS.flatMap((key) => ARTIFACT_FLAGS[key]),
    ];
  }
  if (phase === "private-candidate") return ["--issuer-url"];
  if (phase === "controller-open") return ["--verified-at-block"];
  if (phase === "market-open") return ["--verified-at-block", "--registration-smoke"];
  if (phase === "product-live") {
    return [
      "--verified-at-block",
      "--target-intent",
      ...ARTIFACT_FLAGS.fundedEndToEnd,
      ...ARTIFACT_FLAGS.operationsDrill,
    ];
  }
  fail(`unsupported phase; ${USAGE}`);
}

export function parseReleaseStageArguments(argv) {
  const values = new Map();
  let overwrite = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--overwrite") {
      if (overwrite) fail("--overwrite may only be specified once");
      overwrite = true;
      continue;
    }
    if (!VALUE_FLAGS.has(flag) || values.has(flag)) {
      fail(`unknown or duplicate argument ${String(flag)}; ${USAGE}`);
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(`${flag} requires one explicit value; ${USAGE}`);
    }
    values.set(flag, value);
    index += 1;
  }

  for (const flag of COMMON_VALUE_FLAGS) {
    if (!values.has(flag)) fail(`${flag} is required; ${USAGE}`);
  }
  const phase = values.get("--phase");
  if (!PHASES.includes(phase)) fail(`unsupported phase; ${USAGE}`);

  const required = new Set(requiredFlagsForPhase(phase));
  const allowed = new Set([...COMMON_VALUE_FLAGS, ...required]);
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) fail(`${flag} is not valid for phase ${phase}`);
  }
  for (const flag of required) {
    if (!values.has(flag)) fail(`${flag} is required for phase ${phase}`);
  }

  const artifacts = {};
  for (const [key, [urlFlag, hashFlag]] of Object.entries(ARTIFACT_FLAGS)) {
    if (values.has(urlFlag)) {
      artifacts[key] = { url: values.get(urlFlag), sha256: values.get(hashFlag) };
    }
  }

  return {
    inputPath: resolve(values.get("--input")),
    outputPath: resolve(values.get("--output")),
    phase,
    overwrite,
    ...(values.has("--verified-at-block")
      ? { verifiedAtBlock: parsePositiveSafeInteger(values.get("--verified-at-block"), "--verified-at-block") }
      : {}),
    ...(values.has("--issuer-url") ? { issuerUrl: values.get("--issuer-url") } : {}),
    ...(values.has("--registration-smoke")
      ? { registrationSmokePath: resolve(values.get("--registration-smoke")) }
      : {}),
    ...(values.has("--target-intent") ? { targetIntentPath: resolve(values.get("--target-intent")) } : {}),
    artifacts,
  };
}

function parsePositiveSafeInteger(value, field) {
  if (!/^[1-9][0-9]*$/.test(value)) fail(`${field} must be a positive base-10 integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail(`${field} exceeds the safe-integer range`);
  return parsed;
}

function assertNoSecretFields(value, path = "manifest") {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoSecretFields(entry, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (/private[_-]?key|mnemonic|seed[_-]?phrase|password|secret|api[_-]?key|authorization|keystore/i.test(key)) {
      fail(`${path} contains forbidden secret-bearing field ${key}`);
    }
    assertNoSecretFields(child, `${path}.${key}`);
  }
}

function assertArtifactAbsent(manifest, key, phase) {
  const artifact = manifest.activationEvidence.artifacts[key];
  if (artifact.url !== null || artifact.sha256 !== null) {
    fail(`${phase} input must not pre-publish ${key} evidence`);
  }
}

function assertPrivateCandidateBase(manifest, phase) {
  if (
    manifest.state !== "active" ||
    manifest.activationEvidence.productLive ||
    !manifest.permitIssuer.active ||
    manifest.permitIssuer.url === null
  ) {
    fail(`${phase} requires an active, non-product-live private candidate with an active issuer`);
  }
  assertArtifactAbsent(manifest, "fundedEndToEnd", phase);
  assertArtifactAbsent(manifest, "operationsDrill", phase);
}

function requireLaterVerificationBlock(manifest, value, phase) {
  const previous = manifest.activationEvidence.verifiedAtBlock;
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail(`${phase} requires a positive verified-at block`);
  }
  if (!Number.isSafeInteger(previous) || value <= previous) {
    fail(`${phase} verified-at block must be later than the preceding stage`);
  }
  return value;
}

function requireArtifacts(options, keys, phase) {
  for (const key of keys) {
    const artifact = options.artifacts?.[key];
    if (!artifact || typeof artifact.url !== "string" || typeof artifact.sha256 !== "string") {
      fail(`${phase} requires an explicit URL and SHA-256 for ${key}`);
    }
  }
}

export function prepareReleaseStage(inputValue, options) {
  assertNoSecretFields(inputValue);
  const input = parseDeploymentManifest(inputValue);
  const manifest = structuredClone(input);
  const phase = options?.phase;

  if (!PHASES.includes(phase)) fail("a supported phase is required");

  if (phase === "verified") {
    if (
      input.state !== "configured" ||
      input.activationEvidence.productLive ||
      input.permitIssuer.active ||
      input.activationEvidence.controllerPolicy.registrationsPaused !== true ||
      input.activationEvidence.marketplacePolicy.paused !== true
    ) {
      fail("verified requires a configured, fully paused release with an inactive issuer");
    }
    assertArtifactAbsent(input, "fundedEndToEnd", phase);
    assertArtifactAbsent(input, "operationsDrill", phase);
    requireArtifacts(options, BASELINE_ARTIFACTS, phase);
    if (!Number.isSafeInteger(options.verifiedAtBlock) || options.verifiedAtBlock <= 0) {
      fail("verified requires a positive verified-at block");
    }
    manifest.state = "verified";
    manifest.activationEvidence.verifiedAtBlock = options.verifiedAtBlock;
    for (const key of BASELINE_ARTIFACTS) {
      manifest.activationEvidence.artifacts[key] = { ...options.artifacts[key] };
    }
    manifest.resolverCapabilities = { ...EXPECTED_RESOLVER_CAPABILITIES };
  } else if (phase === "private-candidate") {
    if (
      input.state !== "verified" ||
      input.activationEvidence.productLive ||
      input.permitIssuer.active ||
      input.activationEvidence.controllerPolicy.registrationsPaused !== true ||
      input.activationEvidence.marketplacePolicy.paused !== true
    ) {
      fail("private-candidate requires a verified, fully paused release with an inactive issuer");
    }
    assertArtifactAbsent(input, "fundedEndToEnd", phase);
    assertArtifactAbsent(input, "operationsDrill", phase);
    if (typeof options.issuerUrl !== "string" || options.issuerUrl.length === 0) {
      fail("private-candidate requires an explicit issuer URL");
    }
    manifest.state = "active";
    manifest.permitIssuer.url = options.issuerUrl;
    manifest.permitIssuer.active = true;
  } else if (phase === "controller-open") {
    assertPrivateCandidateBase(input, phase);
    if (
      input.activationEvidence.controllerPolicy.registrationsPaused !== true ||
      input.activationEvidence.marketplacePolicy.paused !== true
    ) {
      fail("controller-open requires both controls to be paused in the preceding stage");
    }
    manifest.activationEvidence.verifiedAtBlock = requireLaterVerificationBlock(
      input,
      options.verifiedAtBlock,
      phase,
    );
    manifest.activationEvidence.controllerPolicy.registrationsPaused = false;
  } else if (phase === "market-open") {
    assertPrivateCandidateBase(input, phase);
    if (
      input.activationEvidence.controllerPolicy.registrationsPaused !== false ||
      input.activationEvidence.marketplacePolicy.paused !== true
    ) {
      fail("market-open requires registration open and marketplace paused in the preceding stage");
    }
    if (!options.registrationSmoke) fail("market-open requires registration smoke PASS evidence");
    let registrationBinding;
    try {
      registrationBinding = validateRegistrationSmokeLifecycle({
        ...options.registrationSmoke,
        controllerOpenManifest: input,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : "registration smoke evidence is invalid");
    }
    if (options.verifiedAtBlock <= registrationBinding.evidenceBlock) {
      fail("market-open verified-at block must be later than registration smoke evidence");
    }
    manifest.activationEvidence.verifiedAtBlock = requireLaterVerificationBlock(
      input,
      options.verifiedAtBlock,
      phase,
    );
    manifest.activationEvidence.marketplacePolicy.paused = false;
  } else {
    assertPrivateCandidateBase(input, phase);
    if (
      input.activationEvidence.controllerPolicy.registrationsPaused !== false ||
      input.activationEvidence.marketplacePolicy.paused !== false
    ) {
      fail("product-live requires both protocol controls to be open in the preceding stage");
    }
    requireArtifacts(options, ["fundedEndToEnd", "operationsDrill"], phase);
    if (!options.targetIntent) fail("product-live requires the exact promotion target intent");
    let targetBinding;
    try { targetBinding = validatePromotionTargetPair(input, options.targetIntent); }
    catch (error) { fail(error instanceof Error ? error.message : "promotion target intent is invalid"); }
    if (options.verifiedAtBlock !== targetBinding.targetVerifiedAtBlock) {
      fail("product-live verified-at block does not match the promotion target intent");
    }
    manifest.activationEvidence.verifiedAtBlock = requireLaterVerificationBlock(
      input,
      options.verifiedAtBlock,
      phase,
    );
    manifest.activationEvidence.artifacts.fundedEndToEnd = { ...options.artifacts.fundedEndToEnd };
    manifest.activationEvidence.artifacts.operationsDrill = { ...options.artifacts.operationsDrill };
    manifest.activationEvidence.productLive = true;
  }

  assertNoSecretFields(manifest);
  const parsed = parseDeploymentManifest(manifest);
  if (phase === "product-live") {
    const targetBinding = validatePromotionTargetPair(input, options.targetIntent);
    if (
      promotionExecutionTargetDigest(parsed) !== targetBinding.executionTargetSha256 ||
      promotionSubjectDigest(parsed) !== targetBinding.promotionSubjectSha256
    ) fail("completed product-live manifest does not reproduce the promotion target intent");
  }
  return parsed;
}

function exactFileSha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

export async function writeReleaseStage(outputPath, bytes, overwrite) {
  if (!overwrite) {
    await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
    return;
  }

  const temporaryPath = resolve(
    dirname(outputPath),
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
    temporaryExists = true;
    await rename(temporaryPath, outputPath);
    temporaryExists = false;
  } finally {
    if (temporaryExists) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function runReleaseStage(argv) {
  const options = parseReleaseStageArguments(argv);
  const inputBytes = await readFile(options.inputPath);
  let inputValue;
  try {
    inputValue = JSON.parse(inputBytes.toString("utf8"));
  } catch {
    fail("input is not valid JSON");
  }
  if (options.targetIntentPath) {
    try { options.targetIntent = JSON.parse(await readFile(options.targetIntentPath, "utf8")); }
    catch { fail("promotion target intent is not valid readable JSON"); }
  }
  if (options.registrationSmokePath) {
    options.registrationSmoke = await loadRegistrationSmokeEvidence(options.registrationSmokePath);
  }
  const manifest = prepareReleaseStage(inputValue, options);
  const outputBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const report = {
    ok: true,
    phase: options.phase,
    state: manifest.state,
    productLive: manifest.activationEvidence.productLive,
    verifiedAtBlock: manifest.activationEvidence.verifiedAtBlock,
    promotionExecutionTargetSha256: promotionExecutionTargetDigest(manifest),
    promotionSubjectSha256: promotionSubjectDigest(manifest),
    manifestSha256: deploymentManifestDigest(manifest),
    outputFileSha256: exactFileSha256(outputBytes),
    overwrite: options.overwrite,
    ...(options.phase === "market-open"
      ? {
          registrationSmoke: registrationSmokeBindingRecord(validateRegistrationSmokeLifecycle({
            ...options.registrationSmoke,
            controllerOpenManifest: inputValue,
          })),
        }
      : {}),
  };
  await writeReleaseStage(options.outputPath, outputBytes, options.overwrite);
  return report;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const report = await runReleaseStage(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown release-stage failure";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
