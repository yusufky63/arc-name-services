#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const ARC_RPC_URL = "https://rpc.testnet.arc.network";
const MAX_RPC_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_RPC_ATTEMPTS = 3;
const RPC_REQUEST_INTERVAL_MS = 2_100;
let nextRpcRequestAt = 0;

function fail(message) {
  throw new Error(message);
}

function parseArguments(argv) {
  const values = new Map();
  const allowed = new Set(["--input", "--output", "--rpc-url"]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || value === undefined || value.startsWith("--") || values.has(flag)) {
      fail("usage: hydrate-broadcast-receipts --input <file> --output <new-file> --rpc-url <url>");
    }
    values.set(flag, value);
  }
  if (values.size !== allowed.size) {
    fail("--input, --output and --rpc-url are all required");
  }
  const inputPath = resolve(values.get("--input"));
  const outputPath = resolve(values.get("--output"));
  if (inputPath === outputPath) fail("input and output files must be different");

  if (values.get("--rpc-url") !== ARC_RPC_URL) {
    fail(`--rpc-url must exactly equal ${ARC_RPC_URL}`);
  }
  return { inputPath, outputPath, rpcUrl: ARC_RPC_URL };
}

function asRecord(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${field} must be an object`);
  return value;
}

async function readBoundedJson(response, index) {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RPC_RESPONSE_BYTES) {
    fail(`RPC receipt response ${index + 1} exceeds the size limit`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RPC_RESPONSE_BYTES) {
    fail(`RPC receipt response ${index + 1} exceeds the size limit`);
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(`RPC receipt response ${index + 1} is not valid JSON`);
  }
}

async function fetchRpcResult(rpcUrl, transactionHash, index, method, idOffset) {
  for (let attempt = 0; attempt < MAX_RPC_ATTEMPTS; attempt += 1) {
    const waitMs = Math.max(0, nextRpcRequestAt - Date.now());
    if (waitMs > 0) await new Promise((resolveDelay) => setTimeout(resolveDelay, waitMs));
    nextRpcRequestAt = Date.now() + RPC_REQUEST_INTERVAL_MS;
    let response;
    try {
      response = await fetch(rpcUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: idOffset + index + 1,
          method,
          params: [transactionHash],
        }),
      });
    } catch {
      if (attempt + 1 === MAX_RPC_ATTEMPTS) fail(`RPC receipt request ${index + 1} failed`);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, RPC_REQUEST_INTERVAL_MS * (attempt + 1)));
      continue;
    }
    if (!response.ok) {
      const retryable = [429, 502, 503, 504].includes(response.status);
      if (!retryable || attempt + 1 === MAX_RPC_ATTEMPTS) {
        fail(`RPC receipt request ${index + 1} returned HTTP ${response.status}`);
      }
      await response.body?.cancel();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, RPC_REQUEST_INTERVAL_MS * (attempt + 1)));
      continue;
    }
    const payload = asRecord(await readBoundedJson(response, index), `RPC response ${index + 1}`);
    if (payload.jsonrpc !== "2.0" || payload.id !== idOffset + index + 1) {
      fail(`RPC response ${index + 1} is not a matching JSON-RPC response`);
    }
    if (payload.error !== undefined) {
      const error = asRecord(payload.error, `RPC response ${index + 1}.error`);
      if (Number(error.code) === -32_011 && attempt + 1 < MAX_RPC_ATTEMPTS) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, RPC_REQUEST_INTERVAL_MS * (attempt + 1)));
        continue;
      }
      fail(`RPC response ${index + 1} is not a successful JSON-RPC response`);
    }
    return asRecord(payload.result, `RPC response ${index + 1}.result`);
  }
  fail(`RPC receipt request ${index + 1} failed`);
}

async function fetchReceipt(rpcUrl, transactionHash, index) {
  const receipt = await fetchRpcResult(
    rpcUrl,
    transactionHash,
    index,
    "eth_getTransactionReceipt",
    0,
  );
  if (
    typeof receipt.transactionHash !== "string" ||
    receipt.transactionHash.toLowerCase() !== transactionHash.toLowerCase()
  ) {
    fail(`RPC receipt response ${index + 1} transaction hash mismatch`);
  }
  if (typeof receipt.status !== "string" || receipt.status.toLowerCase() !== "0x1") {
    fail(`RPC receipt response ${index + 1} is not successful`);
  }
  return receipt;
}

async function fetchTransaction(rpcUrl, transactionHash, index) {
  const transaction = await fetchRpcResult(
    rpcUrl,
    transactionHash,
    index,
    "eth_getTransactionByHash",
    10_000,
  );
  if (
    typeof transaction.hash !== "string" ||
    transaction.hash.toLowerCase() !== transactionHash.toLowerCase()
  ) {
    fail(`RPC transaction response ${index + 1} hash mismatch`);
  }
  return transaction;
}

function quantity(value, field) {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) {
    fail(`${field} must be a hex quantity`);
  }
  return BigInt(value);
}

function optionalAddress(value, field) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    fail(`${field} must be an address or null`);
  }
  return value.toLowerCase();
}

function assertTransactionBodyMatches(local, remote, index) {
  const prefix = `transactions[${index}].transaction`;
  if (
    typeof local.from !== "string" || typeof remote.from !== "string" ||
    local.from.toLowerCase() !== remote.from.toLowerCase() ||
    optionalAddress(local.to ?? null, `${prefix}.to`) !==
      optionalAddress(remote.to ?? null, `RPC transaction ${index + 1}.to`) ||
    typeof local.input !== "string" || typeof remote.input !== "string" ||
    local.input.toLowerCase() !== remote.input.toLowerCase() ||
    quantity(local.value, `${prefix}.value`) !==
      quantity(remote.value, `RPC transaction ${index + 1}.value`)
  ) {
    fail(`${prefix} does not match the Arc RPC transaction at its nonce`);
  }
}

async function main() {
  const { inputPath, outputPath, rpcUrl } = parseArguments(process.argv.slice(2));
  let broadcast;
  try {
    broadcast = asRecord(JSON.parse(await readFile(inputPath, "utf8")), "broadcast");
  } catch (error) {
    if (error instanceof SyntaxError) fail("input broadcast is not valid JSON");
    throw error;
  }
  if (!Array.isArray(broadcast.transactions) || !Array.isArray(broadcast.receipts)) {
    fail("broadcast transactions and receipts must be arrays");
  }
  if (broadcast.transactions.length === 0 || broadcast.receipts.length !== broadcast.transactions.length) {
    fail("input broadcast must contain one receipt slot for every transaction");
  }

  const transactionHashes = broadcast.transactions.map((value, index) => {
    const transaction = asRecord(value, `transactions[${index}]`);
    if (typeof transaction.hash !== "string" || !HASH_PATTERN.test(transaction.hash)) {
      fail(`transactions[${index}].hash must be bytes32`);
    }
    return transaction.hash;
  });
  const uniqueTransactions = new Set(transactionHashes.map((hash) => hash.toLowerCase()));
  if (uniqueTransactions.size !== transactionHashes.length) fail("transaction hashes must be unique");

  // Foundry 1.7.1 may permute transactions[*].hash while leaving each local
  // transaction body and nonce in script order. Fetch the hash set from Arc,
  // then bind each body to its unique on-chain nonce before hydrating receipts.
  // Requests stay sequential because Arc's public RPC rate-limits bursts.
  const chainEntries = [];
  for (const [index, hash] of transactionHashes.entries()) {
    const transaction = await fetchTransaction(rpcUrl, hash, index);
    const receipt = await fetchReceipt(rpcUrl, hash, index);
    chainEntries.push({ transaction, receipt });
  }
  const entriesByNonce = new Map();
  for (const entry of chainEntries) {
    const nonce = quantity(entry.transaction.nonce, "RPC transaction nonce").toString();
    if (entriesByNonce.has(nonce)) fail("RPC transaction nonces must be unique");
    entriesByNonce.set(nonce, entry);
  }

  const correctedTransactions = [];
  const receipts = [];
  for (const [index, value] of broadcast.transactions.entries()) {
    const localEntry = asRecord(value, `transactions[${index}]`);
    const localTransaction = asRecord(localEntry.transaction, `transactions[${index}].transaction`);
    const nonce = quantity(localTransaction.nonce, `transactions[${index}].transaction.nonce`).toString();
    const chainEntry = entriesByNonce.get(nonce);
    if (!chainEntry) fail(`no Arc RPC transaction matches transactions[${index}] nonce`);
    assertTransactionBodyMatches(localTransaction, chainEntry.transaction, index);
    correctedTransactions.push({ ...localEntry, hash: chainEntry.transaction.hash });
    receipts.push(chainEntry.receipt);
  }
  if (receipts.length !== broadcast.transactions.length) fail("hydrated receipt count mismatch");
  const uniqueReceipts = new Set(receipts.map((receipt) => String(receipt.transactionHash).toLowerCase()));
  if (uniqueReceipts.size !== receipts.length) fail("hydrated receipt hashes must be unique");
  if ([...uniqueTransactions].some((hash) => !uniqueReceipts.has(hash))) {
    fail("hydrated receipts do not cover every transaction");
  }

  // Preserve reviewed local transaction bodies, correcting only their proven
  // on-chain hash binding and replacing receipts with independently fetched data.
  const hydrated = { ...broadcast, transactions: correctedTransactions, receipts };
  await writeFile(outputPath, `${JSON.stringify(hydrated, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  process.stdout.write(`Hydrated ${receipts.length} transaction receipts.\n`);
}

main().catch((error) => {
  const message = error instanceof Error && error.code === "EEXIST"
    ? "output file already exists"
    : error instanceof Error
      ? error.message
      : "unknown failure";
  process.stderr.write(`receipt hydration failed: ${message}\n`);
  process.exitCode = 1;
});
