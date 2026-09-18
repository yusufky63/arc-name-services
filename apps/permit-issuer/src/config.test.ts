import { describe, expect, it } from "vitest";
import { localSignerPrivateKey, requiredServiceSecret } from "./config.js";
import { canonicalArcRpcUrl } from "./arc-rpc.js";

describe("permit issuer server secret policy", () => {
  it("accepts only the canonical Arc Mainnet RPC", () => {
    expect(canonicalArcRpcUrl("https://rpc.mainnet.arc.io")).toBe(
      "https://rpc.mainnet.arc.io",
    );
    expect(() => canonicalArcRpcUrl("https://rpc.example")).toThrow(/must exactly equal/);
  });

  it("requires every service bearer secret to contain at least 32 characters", () => {
    expect(() => requiredServiceSecret({ TOKEN: "short" }, "TOKEN")).toThrow("at least 32");
    expect(requiredServiceSecret({ TOKEN: "x".repeat(32) }, "TOKEN")).toHaveLength(32);
  });

  it("requires an exact valid secp256k1 private key", () => {
    const valid = `0x${"01".repeat(32)}`;
    expect(localSignerPrivateKey({ REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY: valid })).toBe(valid);
    for (const value of ["01".repeat(32), "0x1234", `0x${"00".repeat(32)}`]) {
      expect(() => localSignerPrivateKey({ REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY: value }))
        .toThrow(/32-byte|valid secp256k1/);
    }
  });
});
