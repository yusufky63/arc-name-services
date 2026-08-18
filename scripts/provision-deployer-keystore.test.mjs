import {
  createDecipheriv,
  scrypt as scryptCallback,
} from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { promisify } from "node:util";
import { keccak256 } from "viem";

import { encryptPrivateKey } from "./provision-deployer-keystore.mjs";

const scrypt = promisify(scryptCallback);
const TEST_PRIVATE_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_PASSWORD = "contour-test-keystore-password-00000001";

test("builds a standard Web3 Secret Storage v3 keyfile", async () => {
  const salt = Buffer.alloc(32, 0x11);
  const iv = Buffer.alloc(16, 0x22);
  const keyfile = await encryptPrivateKey(TEST_PRIVATE_KEY, TEST_PASSWORD, {
    salt,
    iv,
    id: "00000000-0000-4000-8000-000000000001",
  });

  assert.equal(keyfile.version, 3);
  assert.equal(
    keyfile.address,
    "f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  );
  assert.equal(keyfile.crypto.cipher, "aes-128-ctr");
  assert.equal(keyfile.crypto.kdf, "scrypt");
  assert.equal(keyfile.crypto.kdfparams.n, 262_144);

  const derivedKey = await scrypt(
    TEST_PASSWORD,
    Buffer.from(keyfile.crypto.kdfparams.salt, "hex"),
    keyfile.crypto.kdfparams.dklen,
    {
      N: keyfile.crypto.kdfparams.n,
      p: keyfile.crypto.kdfparams.p,
      r: keyfile.crypto.kdfparams.r,
      maxmem: 512 * 1024 * 1024,
    },
  );
  const ciphertext = Buffer.from(keyfile.crypto.ciphertext, "hex");
  const expectedMac = keccak256(
    `0x${Buffer.concat([
      derivedKey.subarray(16, 32),
      ciphertext,
    ]).toString("hex")}`,
  ).slice(2);
  assert.equal(keyfile.crypto.mac, expectedMac);

  const decipher = createDecipheriv(
    "aes-128-ctr",
    derivedKey.subarray(0, 16),
    Buffer.from(keyfile.crypto.cipherparams.iv, "hex"),
  );
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  assert.equal(`0x${decrypted.toString("hex")}`, TEST_PRIVATE_KEY);
});

test("rejects malformed key material and weak passwords", async () => {
  await assert.rejects(
    encryptPrivateKey("0x1234", TEST_PASSWORD),
    /PRIVATE_KEY is missing or malformed/,
  );
  await assert.rejects(
    encryptPrivateKey(TEST_PRIVATE_KEY, "too-short"),
    /at least 32 characters/,
  );
});

test("accepts the repository's prefixless local key format", async () => {
  const keyfile = await encryptPrivateKey(
    TEST_PRIVATE_KEY.slice(2),
    TEST_PASSWORD,
    {
      salt: Buffer.alloc(32, 0x33),
      iv: Buffer.alloc(16, 0x44),
      id: "00000000-0000-4000-8000-000000000002",
    },
  );
  assert.equal(
    keyfile.address,
    "f39fd6e51aad88f6f4ce6ab8827279cfffb92266",
  );
});
