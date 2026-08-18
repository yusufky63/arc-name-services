import assert from "node:assert/strict";
import test from "node:test";
import {
  ARC_PROMOTION_RPC_RETRY_OPTIONS,
  requestWithArcRpcRetry,
} from "./lib/arc-rpc-transport.mjs";

test("Arc RPC operator transport retries -32011 and nested HTTP 429", async () => {
  const waits = [];
  const sleeps = [];
  let calls = 0;
  const result = await requestWithArcRpcRetry(async () => {
    calls += 1;
    if (calls === 1) throw Object.assign(new Error("request limit reached"), { code: -32_011 });
    if (calls === 2) throw { cause: { status: 429, message: "Too Many Requests" } };
    return "ok";
  }, {
    wait: async (interval) => { waits.push(interval); },
    sleep: async (interval) => { sleeps.push(interval); },
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(waits, [2_100, 2_100, 2_100]);
  assert.deepEqual(sleeps, [2_100, 4_200]);
});

test("Arc RPC operator transport does not retry unrelated failures", async () => {
  const failure = new Error("execution reverted");
  let calls = 0;
  await assert.rejects(requestWithArcRpcRetry(async () => {
    calls += 1;
    throw failure;
  }, {
    wait: async () => undefined,
    sleep: async () => undefined,
  }), (error) => error === failure);
  assert.equal(calls, 1);
});

test("Arc promotion RPC profile exhausts six attempts with bounded backoff", async () => {
  const failure = Object.assign(new Error("request limit reached"), { code: -32_011 });
  const waits = [];
  const sleeps = [];
  let calls = 0;

  await assert.rejects(requestWithArcRpcRetry(async () => {
    calls += 1;
    throw failure;
  }, {
    ...ARC_PROMOTION_RPC_RETRY_OPTIONS,
    wait: async (interval) => { waits.push(interval); },
    sleep: async (interval) => { sleeps.push(interval); },
  }), (error) => error === failure);

  assert.equal(calls, 6);
  assert.deepEqual(waits, [6_000, 6_000, 6_000, 6_000, 6_000, 6_000]);
  assert.deepEqual(sleeps, [6_000, 12_000, 18_000, 18_000, 18_000]);
});
