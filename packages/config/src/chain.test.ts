import { describe, expect, it } from "vitest";
import { ARC_TESTNET, ARC_TESTNET_RPC_URL } from "./chain.js";

describe("Arc runtime chain transport", () => {
  it("advertises only the canonical HTTPS RPC and no WebSocket transport", () => {
    expect(ARC_TESTNET.rpcUrls.default.http).toEqual([ARC_TESTNET_RPC_URL]);
    expect(ARC_TESTNET.rpcUrls.default).not.toHaveProperty("webSocket");
    expect(JSON.stringify(ARC_TESTNET.rpcUrls)).not.toContain("wss://");
  });
});
