#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress, sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  parseDeploymentManifest,
  promotionPassMessage,
  promotionSubjectDigest,
} from "../packages/config/dist/index.js";
import { validatePromotionTargetPair } from "./lib/promotion-target.mjs";
import { normalizeOperatorPrivateKey } from "./lib/operator-key.mjs";

const ARTIFACTS = new Set(["fundedEndToEnd", "operationsDrill"]);

function fail(message) {
  throw new Error(`promotion PASS signing failed: ${message}`);
}

function commaList(value) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function assertImmutableRunReportUrl(value) {
  let url;
  try { url = new URL(value); }
  catch { fail("run-report URL is invalid"); }
  if (
    url.protocol !== "https:" || url.username || url.password || url.hash ||
    (url.port && url.port !== "443")
  ) fail("run-report URL must be credential-free immutable HTTPS");
  return url.href;
}

function assertExactReportBinding(report, artifact, manifest, subject) {
  if (!report || typeof report !== "object" || Array.isArray(report)) fail("run report must be a JSON object");
  if (
    report.schemaVersion !== "1.0.0" || report.artifact !== artifact || report.verdict !== "PASS" ||
    report.chainId !== manifest.chain.id || report.releaseId !== manifest.releaseId ||
    report.promotionSubjectSha256?.toLowerCase() !== subject.toLowerCase() ||
    report.verifiedAtBlock !== manifest.activationEvidence.verifiedAtBlock ||
    !Number.isSafeInteger(report.evidenceBlock) ||
    report.evidenceBlock < manifest.activationEvidence.verifiedAtBlock
  ) fail("run report is not bound to the exact promotion subject");
  if (!Array.isArray(report.transactions) || report.transactions.length === 0) {
    fail("run report has no transaction evidence");
  }
  return report;
}

export async function createSignedPassEnvelope({
  manifestValue,
  candidateManifestValue,
  targetIntentValue,
  artifact,
  runReportBytes,
  runReportUrl,
  reviewerPrivateKey,
  approvedReviewerAddresses,
}) {
  if (!ARTIFACTS.has(artifact)) fail("artifact must be fundedEndToEnd or operationsDrill");
  try { reviewerPrivateKey = normalizeOperatorPrivateKey(reviewerPrivateKey, "PROMOTION_REVIEWER_PRIVATE_KEY"); }
  catch { fail("PROMOTION_REVIEWER_PRIVATE_KEY must be a bytes32 private key"); }
  let manifest;
  if (candidateManifestValue !== undefined || targetIntentValue !== undefined) {
    if (candidateManifestValue === undefined || targetIntentValue === undefined || manifestValue !== undefined) {
      fail("candidate manifest and target intent must be supplied together without a completed target manifest");
    }
    try { manifest = validatePromotionTargetPair(candidateManifestValue, targetIntentValue).target; }
    catch (error) { fail(error instanceof Error ? error.message : "promotion target intent is invalid"); }
  } else {
    manifest = parseDeploymentManifest(manifestValue);
    if (!manifest.activationEvidence.productLive || !manifest.activationEvidence.verifiedAtBlock) {
      fail("manifest must express a structurally complete product-live target");
    }
  }
  const subject = promotionSubjectDigest(manifest);
  let report;
  try { report = JSON.parse(new TextDecoder().decode(runReportBytes)); }
  catch { fail("run report is not valid JSON"); }
  assertExactReportBinding(report, artifact, manifest, subject);

  const account = privateKeyToAccount(reviewerPrivateKey);
  const reviewer = getAddress(account.address);
  const allowed = new Set(approvedReviewerAddresses.map((value) => getAddress(value).toLowerCase()));
  if (allowed.size === 0 || !allowed.has(reviewer.toLowerCase())) fail("reviewer is not operator-approved");
  const governance = getAddress(manifest.activationEvidence.governance.account);
  if (reviewer === governance || reviewer === getAddress(manifest.activationEvidence.controllerPolicy.permitSigner)) {
    fail("reviewer must be independent from governance and the permit signer");
  }
  for (const transaction of report.transactions) {
    if (!transaction || typeof transaction !== "object" || !transaction.from) {
      fail("run report contains a malformed transaction sender");
    }
    if (
      !Number.isSafeInteger(transaction.blockNumber) ||
      transaction.blockNumber <= manifest.activationEvidence.verifiedAtBlock ||
      transaction.blockNumber > report.evidenceBlock
    ) {
      fail("run report contains a transaction outside the promotion target evidence interval");
    }
    if (getAddress(transaction.from) === reviewer) fail("reviewer must be independent from run transaction senders");
  }

  const unsigned = {
    schemaVersion: "1.1.0",
    artifact,
    verdict: "PASS",
    chainId: manifest.chain.id,
    releaseId: manifest.releaseId,
    promotionSubjectSha256: subject,
    verifiedAtBlock: manifest.activationEvidence.verifiedAtBlock,
    evidenceBlock: report.evidenceBlock,
    runReportUrl: assertImmutableRunReportUrl(runReportUrl),
    runReportSha256: sha256(runReportBytes),
    reviewer,
  };
  const signature = await account.signMessage({ message: promotionPassMessage(unsigned) });
  return { ...unsigned, signature };
}

async function main() {
  const [candidateArgument, targetIntentArgument, artifact, reportArgument, runReportUrl, outputArgument] = process.argv.slice(2);
  if (!candidateArgument || !targetIntentArgument || !artifact || !reportArgument || !runReportUrl || !outputArgument) {
    fail("usage: sign-promotion-pass.mjs <active-candidate.json> <target-intent.json> <artifact> <run-report.json> <immutable-report-url> <output.json>");
  }
  const reviewerPrivateKey = process.env.PROMOTION_REVIEWER_PRIVATE_KEY?.trim();
  const approvedReviewerAddresses = commaList(process.env.PROMOTION_REVIEWER_ADDRESSES);
  if (approvedReviewerAddresses.some((value) => !/^0x[0-9a-fA-F]{40}$/.test(value))) {
    fail("PROMOTION_REVIEWER_ADDRESSES must be a comma-separated address allowlist");
  }
  const [candidateManifestValue, targetIntentValue, runReportBytes] = await Promise.all([
    readFile(resolve(candidateArgument), "utf8").then(JSON.parse),
    readFile(resolve(targetIntentArgument), "utf8").then(JSON.parse),
    readFile(resolve(reportArgument)),
  ]);
  const envelope = await createSignedPassEnvelope({
    candidateManifestValue,
    targetIntentValue,
    artifact,
    runReportBytes,
    runReportUrl,
    reviewerPrivateKey,
    approvedReviewerAddresses,
  });
  const output = resolve(outputArgument);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(envelope, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({ output, artifact, reviewer: envelope.reviewer, runReportSha256: envelope.runReportSha256 })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "unknown signing failure"}\n`);
    process.exitCode = 1;
  });
}
