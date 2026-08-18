import {
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  isHex,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { ARC_TESTNET_MULTICALL3 } from "@contour/config";
import type { UnsignedTransactionPlan } from "@contour/sdk";
import { ARC_ADD_CHAIN_PARAMS, ARC_CHAIN_HEX } from "./network";

const WALLET_READ_MAX_ATTEMPTS = 4;
const multicall3Abi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

export type ZeroValueWalletPlan = Pick<UnsignedTransactionPlan, "to" | "data" | "value">;

export class WalletTransactionRevertedError extends Error {
  constructor() {
    super("The Arc transaction reverted. It is final and will not be retried.");
    this.name = "WalletTransactionRevertedError";
  }
}

export function isWalletRateLimitError(error: unknown, depth = 0): boolean {
  if (depth > 6 || !error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    shortMessage?: unknown;
    details?: unknown;
    cause?: unknown;
    data?: { httpStatus?: unknown };
  };
  if (
    value.code === -32_005 ||
    value.code === -32_011 ||
    value.status === 429 ||
    value.statusCode === 429 ||
    value.data?.httpStatus === 429
  ) {
    return true;
  }
  const message = [value.message, value.shortMessage, value.details]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();
  if (
    message.includes("rate limit") ||
    message.includes("request limit reached") ||
    message.includes("too many requests") ||
    /(^|\D)429(\D|$)/.test(message)
  ) {
    return true;
  }
  return isWalletRateLimitError(value.cause, depth + 1);
}

export function walletErrorMessage(error: unknown, fallback: string): string {
  if (isWalletRateLimitError(error)) {
    return "Arc RPC is busy. Wait about 20 seconds, then retry once. No transaction was automatically repeated.";
  }
  const message = error instanceof Error ? error.message : "";
  const normalized = message.toLowerCase();
  if (normalized.includes("reject") || normalized.includes("denied") || (error as { code?: unknown })?.code === 4001) {
    return "The wallet request was rejected. Retry when you are ready.";
  }
  return message || fallback;
}

export async function walletReadRequest(
  provider: EthereumProvider,
  args: { method: string; params?: unknown[] | object },
): Promise<unknown> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= WALLET_READ_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await provider.request(args);
    } catch (error) {
      lastError = error;
      if (!isWalletRateLimitError(error) || attempt === WALLET_READ_MAX_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 1_250));
    }
  }
  throw lastError;
}

export async function ensureArcWallet(provider: EthereumProvider): Promise<void> {
  const current = await walletReadRequest(provider, { method: "eth_chainId" });
  if (typeof current !== "string") throw new Error("The wallet returned an invalid chain ID.");
  if (current.toLowerCase() !== ARC_CHAIN_HEX.toLowerCase()) {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: ARC_CHAIN_HEX }],
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [ARC_ADD_CHAIN_PARAMS],
      });
    }
  }
  const selected = await walletReadRequest(provider, { method: "eth_chainId" });
  if (
    typeof selected !== "string" ||
    selected.toLowerCase() !== ARC_CHAIN_HEX.toLowerCase()
  ) {
    throw new Error("Switch your wallet to Arc Testnet before continuing.");
  }
}

export async function assertArcWalletAccount(
  provider: EthereumProvider,
  expected: Address,
): Promise<void> {
  const [chain, accounts] = await Promise.all([
    walletReadRequest(provider, { method: "eth_chainId" }),
    walletReadRequest(provider, { method: "eth_accounts" }),
  ]);
  const active = Array.isArray(accounts) ? accounts[0] : null;
  if (
    typeof chain !== "string" ||
    chain.toLowerCase() !== ARC_CHAIN_HEX.toLowerCase() ||
    typeof active !== "string" ||
    !isAddress(active) ||
    getAddress(active) !== getAddress(expected)
  ) {
    throw new Error("Wallet account or Arc network changed. Restart the action.");
  }
}

export async function walletContractCall(
  provider: EthereumProvider,
  from: Address,
  to: Address,
  data: Hex,
): Promise<Hex> {
  const result = await walletReadRequest(provider, {
    method: "eth_call",
    params: [{ from, to, data, value: "0x0" }, "latest"],
  });
  if (typeof result !== "string" || !isHex(result)) {
    throw new Error("The wallet returned an invalid Arc contract read.");
  }
  return result;
}

/** Collapses related wallet state checks into one Arc eth_call. */
export async function walletMulticall<
  const Calls extends readonly { target: Address; callData: Hex }[],
>(
  provider: EthereumProvider,
  from: Address,
  calls: Calls,
): Promise<{ readonly [Index in keyof Calls]: Hex }> {
  if (calls.length === 0) {
    return [] as unknown as { readonly [Index in keyof Calls]: Hex };
  }
  const result = await walletContractCall(
    provider,
    from,
    ARC_TESTNET_MULTICALL3,
    encodeFunctionData({
      abi: multicall3Abi,
      functionName: "aggregate3",
      args: [calls.map(({ target, callData }) => ({
        target,
        allowFailure: false,
        callData,
      }))],
    }),
  );
  const decoded = decodeFunctionResult({
    abi: multicall3Abi,
    functionName: "aggregate3",
    data: result,
  });
  return decoded.map((item) => {
    if (!item.success || !isHex(item.returnData)) {
      throw new Error("The wallet returned an invalid Arc multicall result.");
    }
    return item.returnData;
  }) as unknown as { readonly [Index in keyof Calls]: Hex };
}

export async function simulateWalletPlan(
  provider: EthereumProvider,
  from: Address,
  plan: ZeroValueWalletPlan,
): Promise<Hex> {
  if (plan.value !== 0n) throw new Error("Native-value protocol actions are forbidden.");
  await assertArcWalletAccount(provider, from);
  return walletContractCall(provider, from, plan.to, plan.data);
}

export async function sendWalletPlan(
  provider: EthereumProvider,
  from: Address,
  plan: ZeroValueWalletPlan,
): Promise<`0x${string}`> {
  if (plan.value !== 0n) throw new Error("Native-value protocol actions are forbidden.");
  await assertArcWalletAccount(provider, from);
  const hash = await provider.request({
    method: "eth_sendTransaction",
    params: [{
      from,
      to: plan.to,
      data: plan.data,
      value: "0x0",
      chainId: ARC_CHAIN_HEX,
    }],
  });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new Error("The wallet returned an invalid transaction hash.");
  }
  return hash as `0x${string}`;
}

export async function waitForWalletReceipt(
  provider: EthereumProvider,
  hash: `0x${string}`,
  expected: Address,
): Promise<void> {
  await assertArcWalletAccount(provider, expected);
  const started = Date.now();
  while (Date.now() - started < 90_000) {
    const receipt = await walletReadRequest(provider, {
      method: "eth_getTransactionReceipt",
      params: [hash],
    });
    if (receipt && typeof receipt === "object") {
      const status = (receipt as { status?: unknown }).status;
      if (typeof status !== "string" || !/^0x[0-9a-fA-F]+$/.test(status)) {
        throw new Error("The wallet returned an invalid transaction receipt.");
      }
      if (BigInt(status) !== 1n) throw new WalletTransactionRevertedError();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("Receipt confirmation timed out. Check ArcScan before retrying.");
}
