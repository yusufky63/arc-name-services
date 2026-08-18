import assert from "node:assert/strict";
import test from "node:test";
import { normalizeOperatorPrivateKey } from "./lib/operator-key.mjs";

test("operator key accepts prefixed and local env 64-hex forms without logging the value", () => {
  const body = "ab".repeat(32);
  assert.equal(normalizeOperatorPrivateKey(body), `0x${body}`);
  assert.equal(normalizeOperatorPrivateKey(`0x${body}`), `0x${body}`);
});

test("operator key fails closed on malformed input", () => {
  assert.throws(() => normalizeOperatorPrivateKey("not-a-key"), /PRIVATE_KEY is missing or malformed/);
});
