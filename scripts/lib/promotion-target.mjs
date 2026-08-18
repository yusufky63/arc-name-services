import { readFile } from "node:fs/promises";
import {
  deploymentManifestDigest,
  parseDeploymentManifest,
  promotionExecutionTargetDigest,
  promotionSubjectDigest,
} from "../../packages/config/dist/index.js";

const TARGET_INTENT_KEYS = Object.freeze([
  "artifact",
  "candidateManifestSha256",
  "chainId",
  "executionTargetSha256",
  "productLive",
  "promotionSubjectSha256",
  "releaseId",
  "schemaVersion",
  "verifiedAtBlock",
]);
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function fail(message) {
  throw new Error(message);
}

function parseManifest(value, field) {
  try {
    return parseDeploymentManifest(structuredClone(value));
  } catch {
    fail(`${field} is not a structurally valid deployment manifest`);
  }
}

function positiveSafeBlock(value, field) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (
    !Number.isSafeInteger(number) || number <= 0 ||
    (typeof value === "bigint" && BigInt(number) !== value)
  ) fail(`${field} must be a positive safe integer`);
  return number;
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be a JSON object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.join(",") !== wanted.join(",")) fail(`${field} contains unexpected or missing fields`);
}

function exactHash(value, expected, field) {
  if (
    typeof value !== "string" || !BYTES32_PATTERN.test(value) ||
    value.toLowerCase() !== expected.toLowerCase()
  ) fail(`${field} does not match the exact promotion target`);
}

function assertExecutionCandidate(candidate) {
  const liveArtifacts = ["fundedEndToEnd", "operationsDrill"];
  if (
    candidate.state !== "active" ||
    candidate.activationEvidence.productLive !== false ||
    candidate.activationEvidence.controllerPolicy.registrationsPaused !== false ||
    candidate.activationEvidence.marketplacePolicy.paused !== false ||
    candidate.permitIssuer.active !== true ||
    liveArtifacts.some((key) => {
      const artifact = candidate.activationEvidence.artifacts[key];
      return artifact.url !== null || artifact.sha256 !== null;
    })
  ) {
    fail("execution candidate must remain active, productLive=false, unpaused, issuer-active, and free of live-only evidence");
  }
}

function projectedTarget(candidate, verifiedAtBlock) {
  const target = structuredClone(candidate);
  target.activationEvidence.productLive = true;
  target.activationEvidence.verifiedAtBlock = verifiedAtBlock;
  target.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
  target.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
  return target;
}

/**
 * Creates a deliberately non-publishable target intent. It binds the exact
 * future product-live subject and verification block without inventing the
 * funded/operations artifact URLs and hashes that can exist only after the
 * runs finish.
 */
export function createPromotionTargetIntent(candidateValue, verifiedAtBlockValue) {
  const candidate = parseManifest(candidateValue, "execution candidate manifest");
  assertExecutionCandidate(candidate);
  const candidateBlock = positiveSafeBlock(
    candidate.activationEvidence.verifiedAtBlock,
    "execution candidate verifiedAtBlock",
  );
  const verifiedAtBlock = positiveSafeBlock(verifiedAtBlockValue, "target intent verifiedAtBlock");
  if (verifiedAtBlock <= candidateBlock) {
    fail("target intent verifiedAtBlock must be later than the execution candidate verifiedAtBlock");
  }
  const target = projectedTarget(candidate, verifiedAtBlock);
  return Object.freeze({
    schemaVersion: "1.0.0",
    artifact: "promotionTargetIntent",
    chainId: candidate.chain.id,
    releaseId: candidate.releaseId,
    candidateManifestSha256: deploymentManifestDigest(candidate),
    executionTargetSha256: promotionExecutionTargetDigest(target),
    productLive: true,
    verifiedAtBlock,
    promotionSubjectSha256: promotionSubjectDigest(target),
  });
}

function validatePromotionTargetIntent(candidate, value) {
  exactKeys(value, TARGET_INTENT_KEYS, "promotion target intent");
  const verifiedAtBlock = positiveSafeBlock(value.verifiedAtBlock, "target intent verifiedAtBlock");
  const expected = createPromotionTargetIntent(candidate, verifiedAtBlock);
  if (
    value.schemaVersion !== expected.schemaVersion ||
    value.artifact !== expected.artifact ||
    value.chainId !== expected.chainId ||
    value.releaseId !== expected.releaseId ||
    value.productLive !== true
  ) fail("promotion target intent identity does not match the execution candidate");
  exactHash(value.candidateManifestSha256, expected.candidateManifestSha256, "target intent candidateManifestSha256");
  exactHash(value.executionTargetSha256, expected.executionTargetSha256, "target intent executionTargetSha256");
  exactHash(value.promotionSubjectSha256, expected.promotionSubjectSha256, "target intent promotionSubjectSha256");
  return { target: projectedTarget(candidate, verifiedAtBlock), intent: expected };
}

export async function loadPromotionTargetInput(reference, fetcher = fetch) {
  if (typeof reference !== "string" || reference.trim() === "") fail("--target-intent is required");
  let text;
  if (/^https?:\/\//i.test(reference)) {
    const response = await fetcher(reference, { headers: { accept: "application/json" } });
    if (!response?.ok) fail("promotion target intent could not be fetched");
    text = await response.text();
  } else {
    try { text = await readFile(reference, "utf8"); }
    catch { fail("promotion target intent file could not be read"); }
  }
  if (Buffer.byteLength(text) > 1_000_000) fail("promotion target intent is too large");
  try { return JSON.parse(text); }
  catch { fail("promotion target intent is not valid JSON"); }
}

/**
 * Validates the only supported promotion transition: an executable private
 * candidate to a structurally complete product-live target. Execution remains
 * candidate-bound; only reports and reviewer signatures bind the returned
 * target manifest.
 */
export function validatePromotionTargetPair(candidateValue, targetValue) {
  if (targetValue === undefined || targetValue === null) {
    fail("--target-intent is required for broadcast");
  }
  const candidate = parseManifest(candidateValue, "execution candidate manifest");
  assertExecutionCandidate(candidate);
  const intentInput = targetValue?.artifact === "promotionTargetIntent";
  const intentResult = intentInput ? validatePromotionTargetIntent(candidate, targetValue) : null;
  const target = intentResult?.target ?? parseManifest(targetValue, "promotion target manifest");
  const candidateBlock = positiveSafeBlock(
    candidate.activationEvidence.verifiedAtBlock,
    "execution candidate verifiedAtBlock",
  );
  const targetBlock = positiveSafeBlock(
    target.activationEvidence.verifiedAtBlock,
    "promotion target verifiedAtBlock",
  );

  if (
    target.state !== "active" ||
    target.activationEvidence.productLive !== true ||
    target.activationEvidence.controllerPolicy.registrationsPaused !== false ||
    target.activationEvidence.marketplacePolicy.paused !== false ||
    target.permitIssuer.active !== true
  ) {
    fail("promotion target must be structurally complete, active, productLive=true, unpaused, and issuer-active");
  }
  if (targetBlock <= candidateBlock) {
    fail("promotion target verifiedAtBlock must be later than the execution candidate verifiedAtBlock");
  }
  const candidateExecutionTarget = promotionExecutionTargetDigest(candidate);
  const targetExecutionTarget = promotionExecutionTargetDigest(target);
  if (candidateExecutionTarget !== targetExecutionTarget) {
    fail("promotion target differs from the execution candidate outside permitted promotion fields");
  }

  return Object.freeze({
    candidate,
    target,
    candidateVerifiedAtBlock: candidateBlock,
    targetVerifiedAtBlock: targetBlock,
    executionTargetSha256: targetExecutionTarget,
    promotionSubjectSha256: promotionSubjectDigest(target),
    targetInputKind: intentInput ? "intent" : "manifest",
  });
}

export function assertPromotionTargetAtHead(target, headValue) {
  const targetBlock = positiveSafeBlock(
    target?.activationEvidence?.verifiedAtBlock,
    "promotion target verifiedAtBlock",
  );
  const head = positiveSafeBlock(headValue, "pre-run Arc head");
  if (targetBlock > head) {
    fail("promotion target verifiedAtBlock is later than the pre-run Arc head");
  }
  return head;
}
