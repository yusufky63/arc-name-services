#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SITE_URL = "https://contour-arc.vercel.app";
const RPC_URL = "https://rpc.testnet.arc.network";
const DEFAULT_CANDIDATE_SECRET_FILE = resolve(".local-keystores", "release-activation.env");
const PRIVATE_KEY_PATTERN = /(?:0x)?[0-9a-fA-F]{64}/g;
const LIVE_BINDING_PATTERN = /^0x[0-9a-fA-F]{64}:0x[0-9a-fA-F]{64}:[1-9][0-9]*$/;
const COMMON = Object.freeze({
  NEXT_PUBLIC_SITE_URL: SITE_URL,
  REGISTRATION_CHALLENGE_ORIGIN: SITE_URL,
  ARC_RPC_URL: RPC_URL,
  REGISTRATION_PERMIT_TTL_SECONDS: "180",
});
const PRIVATE_CANDIDATE_RUNTIME = Object.freeze([
  "PRIVATE_CANDIDATE_MODE",
  "PRIVATE_CANDIDATE_INGRESS_USERNAME",
  "PRIVATE_CANDIDATE_INGRESS_PASSWORD",
]);
const OPERATOR_ONLY = Object.freeze([
  "PROMOTION_CANDIDATE_INGRESS_USERNAME",
  "PROMOTION_CANDIDATE_INGRESS_PASSWORD",
  "PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE",
]);

function fail(message) {
  throw new Error(`Vercel release environment sync refused: ${message}`);
}

export function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--mode", "--binding", "--candidate-secret-file"].includes(flag) || values.has(flag)) {
      fail(`unknown or duplicate argument ${String(flag)}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires exactly one value`);
    values.set(flag, value);
    index += 1;
  }
  const mode = values.get("--mode");
  if (!new Set(["private-candidate", "public", "public-live"]).has(mode)) {
    fail("--mode must be private-candidate, public or public-live");
  }
  const binding = values.get("--binding") ?? null;
  if (mode !== "public-live" && binding !== null) fail("--binding is only valid in public-live mode");
  if (mode === "public-live" && !LIVE_BINDING_PATTERN.test(binding ?? "")) {
    fail("public-live requires --binding <releaseId:manifestSha256:verifiedAtBlock>");
  }
  const explicitSecretFile = values.get("--candidate-secret-file") ?? null;
  if (mode !== "private-candidate" && explicitSecretFile !== null) {
    fail("--candidate-secret-file is only valid in private-candidate mode");
  }
  const candidateSecretFile = mode === "private-candidate"
    ? resolve(explicitSecretFile ?? DEFAULT_CANDIDATE_SECRET_FILE)
    : null;
  return { mode, binding, candidateSecretFile };
}

export function parseEnvironment(text, field) {
  const result = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || result.has(name)) fail(`${field} is malformed`);
    result.set(name, value);
  }
  return result;
}

function required(map, name, field) {
  const value = map.get(name);
  if (!value) fail(`${name} is missing from ${field}`);
  return value;
}

export async function loadValues(
  mode,
  binding,
  {
    adminFile = resolve(".env"),
    webFile = resolve("apps", "web", ".env.local"),
    candidateSecretFile = DEFAULT_CANDIDATE_SECRET_FILE,
  } = {},
) {
  let rawAdmin;
  let rawWeb;
  try {
    [rawAdmin, rawWeb] = await Promise.all([
      readFile(adminFile, "utf8"),
      readFile(webFile, "utf8"),
    ]);
  } catch {
    fail("root .env or apps/web/.env.local could not be read");
  }
  const adminMatches = rawAdmin.match(PRIVATE_KEY_PATTERN) ?? [];
  if (adminMatches.length !== 1) fail("root .env must contain exactly one 32-byte private key");
  const adminKey = adminMatches[0].startsWith("0x") ? adminMatches[0] : `0x${adminMatches[0]}`;
  const web = parseEnvironment(rawWeb, "apps/web/.env.local");
  const challenge = required(web, "REGISTRATION_CHALLENGE_SECRET", "apps/web/.env.local");
  if (challenge.length < 32) fail("REGISTRATION_CHALLENGE_SECRET must contain at least 32 characters");

  const values = new Map([
    ...Object.entries(COMMON),
    ["REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY", adminKey],
    ["REGISTRATION_CHALLENGE_SECRET", challenge],
    ["PRODUCT_LIVE_RELEASE", mode === "public-live" ? binding : "false"],
  ]);
  if (mode === "private-candidate") {
    let rawCandidate;
    try {
      rawCandidate = await readFile(candidateSecretFile, "utf8");
    } catch {
      fail("ignored private-candidate secret file could not be read");
    }
    const candidate = parseEnvironment(rawCandidate, "private-candidate secret file");
    const username = required(
      candidate,
      "PRIVATE_CANDIDATE_INGRESS_USERNAME",
      "private-candidate secret file",
    );
    const password = required(
      candidate,
      "PRIVATE_CANDIDATE_INGRESS_PASSWORD",
      "private-candidate secret file",
    );
    if (
      username.length > 256 ||
      username.includes(":") ||
      !/^[\u0021-\u007e]+$/.test(username)
    ) {
      fail("PRIVATE_CANDIDATE_INGRESS_USERNAME must be bounded printable ASCII");
    }
    if (
      password.length < 32 ||
      password.length > 3_800 ||
      !/^[\u0020-\u007e]+$/.test(password)
    ) {
      fail("PRIVATE_CANDIDATE_INGRESS_PASSWORD must be a bounded printable ASCII secret");
    }
    values.set("PRIVATE_CANDIDATE_INGRESS_USERNAME", username);
    values.set("PRIVATE_CANDIDATE_INGRESS_PASSWORD", password);
    // Set the opt-in last so generated plans cannot represent an enabled gate
    // without both credentials.
    values.set("PRIVATE_CANDIDATE_MODE", "true");
  }
  return values;
}

export function redact(message, sensitiveValues) {
  let result = String(message ?? "");
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length > 0) result = result.split(value).join("[REDACTED]");
  }
  return result.replace(/[\r\n\t]+/g, " ").trim().slice(0, 500);
}

function runVercel(arguments_, stdin, sensitiveValues) {
  const executable = process.platform === "win32" ? "npx.cmd" : "npx";
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(executable, ["--yes", "vercel@50.28.0", ...arguments_], {
      cwd: process.cwd(),
      shell: process.platform === "win32",
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", rejectRun);
    child.on("close", (code) => {
      const output = Buffer.concat([...stdout, ...stderr]).toString("utf8");
      if (code === 0) resolveRun(output);
      else rejectRun(new Error(redact(output || `Vercel CLI exited ${code}`, sensitiveValues)));
    });
    child.stdin.end(stdin ?? "");
  });
}

async function removeVariable(name, sensitiveValues) {
  try {
    await runVercel(["env", "rm", name, "production", "--yes"], "", sensitiveValues);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Vercel env removal failed";
    if (!/not found|does not exist|could not find/i.test(message)) throw error;
  }
}

function isSensitiveVariable(name) {
  return /PRIVATE_KEY|SECRET|PASSWORD|INGRESS_USERNAME/.test(name);
}

async function setVariable(name, value, sensitiveValues) {
  await removeVariable(name, sensitiveValues);
  await runVercel([
    "env", "add", name, "production",
    ...(isSensitiveVariable(name) ? ["--sensitive"] : []),
  ], value, sensitiveValues);
}

export function variablesToRemove(values) {
  return [
    ...OPERATOR_ONLY,
    ...PRIVATE_CANDIDATE_RUNTIME,
  ].filter((name) => !values.has(name));
}

export async function main(argv = process.argv.slice(2)) {
  const { mode, binding, candidateSecretFile } = parseArguments(argv);
  const values = await loadValues(mode, binding, {
    ...(candidateSecretFile ? { candidateSecretFile } : {}),
  });
  const sensitiveValues = [...values.entries()]
    .filter(([name]) => isSensitiveVariable(name))
    .map(([, value]) => value);

  for (const [name, value] of values) await setVariable(name, value, sensitiveValues);
  const removals = variablesToRemove(values);
  for (const name of removals) await removeVariable(name, sensitiveValues);

  process.stdout.write(`${JSON.stringify({
    ok: true,
    mode,
    target: "production",
    siteUrl: SITE_URL,
    rpcUrl: RPC_URL,
    configured: [...values.keys()].sort(),
    removed: removals.sort(),
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Vercel release environment sync failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
