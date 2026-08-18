import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadValues,
  parseArguments,
  redact,
  variablesToRemove,
} from "./sync-vercel-release-env.mjs";

const PRIVATE_KEY = `0x${"11".repeat(32)}`;
const CHALLENGE = "c".repeat(40);
const PASSWORD = "p".repeat(40);
const LIVE_BINDING = `${`0x${"22".repeat(32)}`}:${`0x${"33".repeat(32)}`}:123`;

async function fixtures(context, candidate = [
  "PRIVATE_CANDIDATE_INGRESS_USERNAME=operator",
  `PRIVATE_CANDIDATE_INGRESS_PASSWORD=${PASSWORD}`,
].join("\n")) {
  const directory = await mkdtemp(join(tmpdir(), "contour-vercel-env-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const adminFile = join(directory, "root.env");
  const webFile = join(directory, "web.env.local");
  const candidateSecretFile = join(directory, "release-activation.env");
  await Promise.all([
    writeFile(adminFile, `PRIVATE_KEY=${PRIVATE_KEY}\n`),
    writeFile(webFile, `REGISTRATION_CHALLENGE_SECRET=${CHALLENGE}\n`),
    writeFile(candidateSecretFile, `${candidate}\n`),
  ]);
  return { adminFile, webFile, candidateSecretFile };
}

test("private-candidate mode is explicit, production-scoped and file-backed", async (context) => {
  const paths = await fixtures(context);
  const parsed = parseArguments([
    "--mode",
    "private-candidate",
    "--candidate-secret-file",
    paths.candidateSecretFile,
  ]);
  const values = await loadValues(parsed.mode, parsed.binding, {
    ...paths,
    candidateSecretFile: parsed.candidateSecretFile,
  });

  assert.equal(values.get("PRODUCT_LIVE_RELEASE"), "false");
  assert.equal(values.get("PRIVATE_CANDIDATE_MODE"), "true");
  assert.equal(values.get("PRIVATE_CANDIDATE_INGRESS_USERNAME"), "operator");
  assert.equal(values.get("PRIVATE_CANDIDATE_INGRESS_PASSWORD"), PASSWORD);
  assert.equal(values.get("REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY"), PRIVATE_KEY);
  assert.deepEqual(variablesToRemove(values).sort(), [
    "PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE",
    "PROMOTION_CANDIDATE_INGRESS_PASSWORD",
    "PROMOTION_CANDIDATE_INGRESS_USERNAME",
  ]);
});

test("public and public-live remove every runtime and operator candidate variable", async (context) => {
  const paths = await fixtures(context);
  for (const [mode, binding] of [["public", null], ["public-live", LIVE_BINDING]]) {
    const values = await loadValues(mode, binding, {
      adminFile: paths.adminFile,
      webFile: paths.webFile,
      candidateSecretFile: join(tmpdir(), "must-not-be-read"),
    });
    assert.equal(values.get("PRODUCT_LIVE_RELEASE"), binding ?? "false");
    assert.deepEqual(variablesToRemove(values).sort(), [
      "PRIVATE_CANDIDATE_INGRESS_PASSWORD",
      "PRIVATE_CANDIDATE_INGRESS_USERNAME",
      "PRIVATE_CANDIDATE_MODE",
      "PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE",
      "PROMOTION_CANDIDATE_INGRESS_PASSWORD",
      "PROMOTION_CANDIDATE_INGRESS_USERNAME",
    ]);
  }
});

test("mode arguments and candidate credentials fail closed", async (context) => {
  assert.throws(() => parseArguments(["--mode", "private-candidate", "--binding", LIVE_BINDING]), /only valid/);
  assert.throws(() => parseArguments(["--mode", "public-live"]), /requires --binding/);
  assert.throws(
    () => parseArguments(["--mode", "public", "--candidate-secret-file", "secret.env"]),
    /only valid/,
  );

  const shortPassword = await fixtures(context, [
    "PRIVATE_CANDIDATE_INGRESS_USERNAME=operator",
    "PRIVATE_CANDIDATE_INGRESS_PASSWORD=short",
  ].join("\n"));
  await assert.rejects(
    loadValues("private-candidate", null, shortPassword),
    /bounded printable ASCII secret/,
  );

  const nonAsciiUsername = await fixtures(context, [
    "PRIVATE_CANDIDATE_INGRESS_USERNAME=operatör",
    `PRIVATE_CANDIDATE_INGRESS_PASSWORD=${PASSWORD}`,
  ].join("\n"));
  await assert.rejects(
    loadValues("private-candidate", null, nonAsciiUsername),
    /bounded printable ASCII/,
  );
});

test("operator-facing errors redact every supplied sensitive value", () => {
  const output = redact(
    `failed username=operator password=${PASSWORD} challenge=${CHALLENGE} key=${PRIVATE_KEY}`,
    ["operator", PASSWORD, CHALLENGE, PRIVATE_KEY],
  );
  assert.doesNotMatch(output, /operator|p{32}|c{32}|0x11/);
  assert.match(output, /\[REDACTED\]/);
});
