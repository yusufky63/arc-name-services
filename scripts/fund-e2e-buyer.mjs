#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  formatUnits,
  getAddress,
  parseAbi,
  parseUnits,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { rateLimitedArcHttp } from "./lib/arc-rpc-transport.mjs";
import { normalizeOperatorPrivateKey } from "./lib/operator-key.mjs";

const CHAIN_ID = 5_042_002;
const RPC_URL = "https://rpc.testnet.arc.network";
const GOVERNANCE = getAddress("0x78de409a6306550882328E2a67160471368387FF");
const SETTLEMENT = getAddress("0x3600000000000000000000000000000000000000");
const erc20Abi = parseAbi(["function balanceOf(address account) view returns (uint256)"]);
const chain = Object.freeze({
  id: CHAIN_ID,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  testnet: true,
});

function fail(message) {
  throw new Error(`buyer funding refused: ${message}`);
}

function argumentsFrom(argv) {
  const values = new Map();
  let broadcast = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--broadcast") {
      if (broadcast) fail("--broadcast may only be supplied once");
      broadcast = true;
      continue;
    }
    if (!["--target-native", "--confirm-recipient"].includes(flag) || values.has(flag)) {
      fail(`unknown or duplicate argument ${String(flag)}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires exactly one value`);
    values.set(flag, value);
    index += 1;
  }
  const target = values.get("--target-native") ?? "100";
  let targetNative;
  try { targetNative = parseUnits(target, 18); }
  catch { fail("--target-native must be a decimal amount"); }
  if (targetNative <= 0n || targetNative > parseUnits("1000", 18)) {
    fail("--target-native must be greater than zero and no greater than 1000");
  }
  return { broadcast, targetNative, confirmRecipient: values.get("--confirm-recipient") ?? null };
}

function accountFrom(value, field) {
  let privateKey;
  try { privateKey = normalizeOperatorPrivateKey(value, field); }
  catch { fail(`${field} is missing or malformed`); }
  if (/^0x0{64}$/i.test(privateKey)) fail(`${field} is missing or malformed`);
  try { return privateKeyToAccount(privateKey); }
  catch { fail(`${field} is invalid`); }
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const options = argumentsFrom(argv);
  if ((env.ARC_RPC_URL?.trim() || RPC_URL) !== RPC_URL) {
    fail(`ARC_RPC_URL must exactly equal ${RPC_URL}`);
  }
  const sender = accountFrom(env.PRIVATE_KEY, "PRIVATE_KEY");
  const buyer = accountFrom(env.E2E_BUYER_PRIVATE_KEY, "E2E_BUYER_PRIVATE_KEY");
  if (getAddress(sender.address) !== GOVERNANCE) fail("PRIVATE_KEY is not the canonical governance account");
  if (getAddress(buyer.address) === GOVERNANCE) fail("buyer must be distinct from governance");
  if (options.broadcast && options.confirmRecipient !== getAddress(buyer.address)) {
    fail(`--broadcast requires --confirm-recipient ${getAddress(buyer.address)}`);
  }

  const transport = rateLimitedArcHttp(RPC_URL);
  const publicClient = createPublicClient({
    chain,
    transport,
    batch: { multicall: { wait: 25 } },
  });
  const chainId = await publicClient.getChainId();
  if (chainId !== CHAIN_ID) fail("RPC chain ID mismatch");
  const [senderNativeBefore, buyerNativeBefore, buyerSettlementBefore] = await Promise.all([
    publicClient.getBalance({ address: sender.address }),
    publicClient.getBalance({ address: buyer.address }),
    publicClient.readContract({ address: SETTLEMENT, abi: erc20Abi, functionName: "balanceOf", args: [buyer.address] }),
  ]);
  const value = buyerNativeBefore >= options.targetNative ? 0n : options.targetNative - buyerNativeBefore;
  const plan = {
    ok: true,
    mode: options.broadcast ? "BROADCAST" : "DRY_RUN",
    chainId,
    rpcUrl: RPC_URL,
    sender: getAddress(sender.address),
    recipient: getAddress(buyer.address),
    targetNative: formatUnits(options.targetNative, 18),
    topUpNative: formatUnits(value, 18),
    senderNativeBefore: formatUnits(senderNativeBefore, 18),
    buyerNativeBefore: formatUnits(buyerNativeBefore, 18),
    buyerSettlementBefore: formatUnits(buyerSettlementBefore, 6),
  };
  if (!options.broadcast || value === 0n) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  }

  if (senderNativeBefore <= value) fail("governance balance is insufficient for the requested top-up and gas");
  const walletClient = createWalletClient({ account: sender, chain, transport });
  const hash = await walletClient.sendTransaction({ account: sender, chain, to: buyer.address, value });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") fail("funding transaction reverted");
  const [buyerNativeAfter, buyerSettlementAfter] = await Promise.all([
    publicClient.getBalance({ address: buyer.address, blockNumber: receipt.blockNumber }),
    publicClient.readContract({
      address: SETTLEMENT,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [buyer.address],
      blockNumber: receipt.blockNumber,
    }),
  ]);
  if (buyerNativeAfter < options.targetNative) fail("buyer balance did not reach the requested target");
  const result = {
    ...plan,
    transactionHash: hash,
    blockNumber: receipt.blockNumber.toString(),
    buyerNativeAfter: formatUnits(buyerNativeAfter, 18),
    buyerSettlementAfter: formatUnits(buyerSettlementAfter, 6),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "buyer funding failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
