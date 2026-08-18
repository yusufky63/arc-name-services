#!/usr/bin/env node

import {
  createCipheriv,
  randomBytes,
  randomUUID,
  scrypt as scryptCallback,
} from "node:crypto";
import {
  access,
  mkdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getAddress, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const scrypt = promisify(scryptCallback);
const PRIVATE_KEY_PATTERN = /^(?:0x)?[0-9a-fA-F]{64}$/;
const OUTPUT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const KEYSTORE_DIRECTORY = resolve(".local-keystores");
const DEFAULT_OUTPUT_NAME = "contour-v2-deployer";
const SCRYPT_PARAMS = Object.freeze({
  dklen: 32,
  n: 262_144,
  p: 1,
  r: 8,
});
const SCRYPT_MAX_MEMORY = 512 * 1024 * 1024;

function hex(buffer) {
  return Buffer.from(buffer).toString("hex");
}

function normalizePrivateKey(privateKey) {
  if (!PRIVATE_KEY_PATTERN.test(privateKey ?? "")) {
    throw new Error("PRIVATE_KEY is missing or malformed");
  }
  return privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
}

function privateKeyBytes(privateKey) {
  return Buffer.from(normalizePrivateKey(privateKey).slice(2), "hex");
}

export async function encryptPrivateKey(
  privateKey,
  password,
  {
    salt = randomBytes(32),
    iv = randomBytes(16),
    id = randomUUID(),
  } = {},
) {
  const normalizedPrivateKey = normalizePrivateKey(privateKey);
  const keyBytes = privateKeyBytes(normalizedPrivateKey);
  if (typeof password !== "string" || password.length < 32) {
    throw new Error("keystore password must contain at least 32 characters");
  }
  if (!Buffer.isBuffer(salt) || salt.length !== 32) {
    throw new Error("keystore salt must contain 32 bytes");
  }
  if (!Buffer.isBuffer(iv) || iv.length !== 16) {
    throw new Error("keystore IV must contain 16 bytes");
  }

  const derivedKey = await scrypt(password, salt, SCRYPT_PARAMS.dklen, {
    N: SCRYPT_PARAMS.n,
    p: SCRYPT_PARAMS.p,
    r: SCRYPT_PARAMS.r,
    maxmem: SCRYPT_MAX_MEMORY,
  });
  const cipher = createCipheriv("aes-128-ctr", derivedKey.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(keyBytes), cipher.final()]);
  const macMaterial = Buffer.concat([
    derivedKey.subarray(16, 32),
    ciphertext,
  ]);
  const account = privateKeyToAccount(normalizedPrivateKey);

  return {
    version: 3,
    id,
    address: account.address.slice(2).toLowerCase(),
    crypto: {
      cipher: "aes-128-ctr",
      cipherparams: { iv: hex(iv) },
      ciphertext: hex(ciphertext),
      kdf: "scrypt",
      kdfparams: {
        dklen: SCRYPT_PARAMS.dklen,
        n: SCRYPT_PARAMS.n,
        p: SCRYPT_PARAMS.p,
        r: SCRYPT_PARAMS.r,
        salt: hex(salt),
      },
      mac: keccak256(`0x${hex(macMaterial)}`).slice(2),
    },
  };
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function parseOutputName(argv) {
  if (argv.length === 0) return DEFAULT_OUTPUT_NAME;
  if (
    argv.length !== 2 ||
    argv[0] !== "--output-name" ||
    !OUTPUT_NAME_PATTERN.test(argv[1] ?? "")
  ) {
    throw new Error(
      "usage: provision-deployer-keystore [--output-name <safe-name>]",
    );
  }
  return argv[1];
}

export async function provisionDeployerKeystore({
  privateKey = process.env.PRIVATE_KEY,
  expectedAddress = process.env.DEPLOYER_ADDRESS,
  outputName = DEFAULT_OUTPUT_NAME,
} = {}) {
  if (!OUTPUT_NAME_PATTERN.test(outputName)) {
    throw new Error("keystore output name is invalid");
  }
  const normalizedPrivateKey = normalizePrivateKey(privateKey);
  const keyBytes = privateKeyBytes(normalizedPrivateKey);
  keyBytes.fill(0);
  if (!expectedAddress) {
    throw new Error("DEPLOYER_ADDRESS is required");
  }
  const account = privateKeyToAccount(normalizedPrivateKey);
  if (getAddress(expectedAddress) !== account.address) {
    throw new Error("PRIVATE_KEY does not match DEPLOYER_ADDRESS");
  }

  const keystorePath = resolve(KEYSTORE_DIRECTORY, outputName);
  const passwordPath = resolve(KEYSTORE_DIRECTORY, `${outputName}.password`);
  if (await exists(keystorePath) || await exists(passwordPath)) {
    throw new Error(
      "refusing to overwrite an existing deployer keystore or password file",
    );
  }

  await mkdir(KEYSTORE_DIRECTORY, { recursive: true, mode: 0o700 });
  const password = randomBytes(48).toString("base64url");
  const keyfile = await encryptPrivateKey(normalizedPrivateKey, password);
  const nonce = randomUUID();
  const temporaryKeystore = resolve(
    KEYSTORE_DIRECTORY,
    `.${outputName}.${nonce}.tmp`,
  );
  const temporaryPassword = resolve(
    KEYSTORE_DIRECTORY,
    `.${outputName}.${nonce}.password.tmp`,
  );
  let installedKeystore = false;
  let installedPassword = false;
  try {
    await writeFile(
      temporaryKeystore,
      `${JSON.stringify(keyfile, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await writeFile(temporaryPassword, `${password}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryKeystore, keystorePath);
    installedKeystore = true;
    await rename(temporaryPassword, passwordPath);
    installedPassword = true;
  } catch (error) {
    await rm(temporaryKeystore, { force: true });
    await rm(temporaryPassword, { force: true });
    if (installedKeystore) await rm(keystorePath, { force: true });
    if (installedPassword) await rm(passwordPath, { force: true });
    throw error;
  }

  return Object.freeze({
    ok: true,
    address: account.address,
    keystorePath,
    passwordPath,
  });
}

async function main() {
  const outputName = parseOutputName(process.argv.slice(2));
  const result = await provisionDeployerKeystore({ outputName });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message =
      error instanceof Error ? error.message : "deployer keystore provisioning failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
