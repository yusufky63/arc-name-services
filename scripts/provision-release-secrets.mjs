#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const OUTPUT_PATH = resolve(".local-keystores", "release-activation.env");
const BASIC_AUTH_PATH = resolve(".local-keystores", "candidate-basic-auth.txt");
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function parseEnvironment(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error("release secret file is malformed");
    const name = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(name) || !value || values.has(name)) {
      throw new Error("release secret file is malformed");
    }
    values.set(name, value);
  }
  return values;
}

function validate(values) {
  for (const name of ["E2E_BUYER_PRIVATE_KEY", "PROMOTION_REVIEWER_PRIVATE_KEY"]) {
    if (!PRIVATE_KEY_PATTERN.test(values.get(name) ?? "")) {
      throw new Error(`${name} is missing or malformed`);
    }
  }
  const username = values.get("PRIVATE_CANDIDATE_INGRESS_USERNAME") ?? "";
  const password = values.get("PRIVATE_CANDIDATE_INGRESS_PASSWORD") ?? "";
  if (!username || username.includes(":") || password.length < 32) {
    throw new Error("candidate ingress credentials are missing or malformed");
  }
  const buyer = privateKeyToAccount(values.get("E2E_BUYER_PRIVATE_KEY"));
  const reviewer = privateKeyToAccount(values.get("PROMOTION_REVIEWER_PRIVATE_KEY"));
  if (buyer.address.toLowerCase() === reviewer.address.toLowerCase()) {
    throw new Error("buyer and reviewer accounts must be distinct");
  }
  const reviewerAllowlist = values.get("PROMOTION_REVIEWER_ADDRESSES");
  if (reviewerAllowlist && reviewerAllowlist.toLowerCase() !== reviewer.address.toLowerCase()) {
    throw new Error("PROMOTION_REVIEWER_ADDRESSES must contain the provisioned independent reviewer");
  }
  for (const alias of ["PROMOTION_CANDIDATE_INGRESS_USERNAME", "PROMOTION_CANDIDATE_INGRESS_PASSWORD"]) {
    const expected = alias.endsWith("USERNAME") ? username : password;
    if (values.has(alias) && values.get(alias) !== expected) {
      throw new Error(`${alias} must match the private candidate ingress credential`);
    }
  }
  return { buyer, reviewer, username, password };
}

async function existingSecrets() {
  try {
    return parseEnvironment(await readFile(OUTPUT_PATH, "utf8"));
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return null;
    throw error;
  }
}

async function provision() {
  await mkdir(dirname(OUTPUT_PATH), { recursive: true, mode: 0o700 });
  let values = await existingSecrets();
  let created = false;
  if (!values) {
    values = new Map([
      ["E2E_BUYER_PRIVATE_KEY", generatePrivateKey()],
      ["PROMOTION_REVIEWER_PRIVATE_KEY", generatePrivateKey()],
      ["PRIVATE_CANDIDATE_INGRESS_USERNAME", "contour-operator"],
      ["PRIVATE_CANDIDATE_INGRESS_PASSWORD", randomBytes(48).toString("base64url")],
    ]);
    const bytes = `${[...values].map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
    await writeFile(OUTPUT_PATH, bytes, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
  }

  const { buyer, reviewer, username, password } = validate(values);
  const derivedValues = new Map([
    ["PROMOTION_CANDIDATE_INGRESS_USERNAME", username],
    ["PROMOTION_CANDIDATE_INGRESS_PASSWORD", password],
    ["PROMOTION_REVIEWER_ADDRESSES", reviewer.address],
  ]);
  let augmented = false;
  for (const [name, value] of derivedValues) {
    if (!values.has(name)) {
      values.set(name, value);
      augmented = true;
    }
  }
  if (augmented) {
    const bytes = `${[...values].map(([name, value]) => `${name}=${value}`).join("\n")}\n`;
    await writeFile(OUTPUT_PATH, bytes, { encoding: "utf8", mode: 0o600 });
  }
  const basicAuth = `${username}:${password}\n`;
  try {
    await writeFile(BASIC_AUTH_PATH, basicAuth, { encoding: "utf8", flag: "wx", mode: 0o600 });
  } catch (error) {
    if (!error || typeof error !== "object" || error.code !== "EEXIST") throw error;
    if ((await readFile(BASIC_AUTH_PATH, "utf8")) !== basicAuth) {
      throw new Error("candidate Basic auth file does not match the provisioned credentials");
    }
  }

  process.stdout.write(`${JSON.stringify({
    ok: true,
    created,
    augmented,
    secretFile: OUTPUT_PATH,
    basicAuthFile: BASIC_AUTH_PATH,
    buyerAddress: buyer.address,
    reviewerAddress: reviewer.address,
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  provision().catch((error) => {
    const message = error instanceof Error ? error.message : "release secret provisioning failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
