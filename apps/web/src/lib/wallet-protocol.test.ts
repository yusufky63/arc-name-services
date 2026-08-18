import { encodeFunctionResult, parseAbi } from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  isWalletRateLimitError,
  waitForWalletReceipt,
  WalletTransactionRevertedError,
  walletErrorMessage,
  walletMulticall,
} from "./wallet-protocol";

const aggregate3Abi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);

describe("wallet RPC errors", () => {
  it("recognizes MetaMask's nested Arc 429 response", () => {
    const error = {
      code: -32_005,
      message: "Request is being rate limited.",
      data: { httpStatus: 429, cause: null },
    };

    expect(isWalletRateLimitError(error)).toBe(true);
    expect(walletErrorMessage(error, "Wallet failed.")).toContain("Arc RPC is busy");
    expect(walletErrorMessage(error, "Wallet failed.").toLowerCase()).toContain(
      "no transaction was automatically repeated",
    );
  });

  it("recognizes rate limits wrapped by a connector", () => {
    expect(isWalletRateLimitError({
      message: "Connector request failed",
      cause: { details: "HTTP 429 too many requests" },
    })).toBe(true);
  });

  it("keeps explicit rejection and fallback messages distinct", () => {
    expect(walletErrorMessage({ code: 4001 }, "Wallet failed.")).toContain("rejected");
    expect(walletErrorMessage(new Error("Wrong network"), "Wallet failed.")).toBe("Wrong network");
    expect(walletErrorMessage(null, "Wallet failed.")).toBe("Wallet failed.");
  });

  it("batches related contract reads into one wallet eth_call", async () => {
    const request = vi.fn().mockResolvedValue(encodeFunctionResult({
      abi: aggregate3Abi,
      functionName: "aggregate3",
      result: [
        { success: true, returnData: "0x1234" },
        { success: true, returnData: "0xabcd" },
      ],
    }));
    const provider = { request } as EthereumProvider;
    const account = "0x1111111111111111111111111111111111111111";
    const results = await walletMulticall(provider, account, [
      { target: account, callData: "0xaaaa" },
      { target: account, callData: "0xbbbb" },
    ]);

    expect(results).toEqual(["0x1234", "0xabcd"]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ method: "eth_call" }));
  });

  it("classifies a reverted receipt as terminal", async () => {
    const account = "0x1111111111111111111111111111111111111111";
    const request = vi.fn(async ({ method }: { method: string }) => {
      if (method === "eth_chainId") return "0x4cef52";
      if (method === "eth_accounts") return [account];
      if (method === "eth_getTransactionReceipt") return { status: "0x0" };
      throw new Error(`unexpected method ${method}`);
    });

    await expect(waitForWalletReceipt(
      { request } as EthereumProvider,
      `0x${"11".repeat(32)}`,
      account,
    )).rejects.toBeInstanceOf(WalletTransactionRevertedError);
  });
});
