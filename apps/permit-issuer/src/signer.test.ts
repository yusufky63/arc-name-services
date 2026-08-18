import { describe, expect, it } from "vitest";
import { verifyTypedData, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  registrationPermitDomain,
  registrationPermitTypes,
  type RegistrationPermit,
} from "@contour/sdk";
import { LocalPrivateKeySigner } from "./signer.js";

const privateKey = `0x${"01".repeat(32)}` as Hex;
const account = privateKeyToAccount(privateKey);

const permit: RegistrationPermit = {
  chainId: 5_042_002n,
  controller: "0x2222222222222222222222222222222222222222",
  releaseId: `0x${"10".repeat(32)}`,
  normalizationProfileHash: `0x${"11".repeat(32)}`,
  normalizedLabelHash: `0x${"12".repeat(32)}`,
  namehash: `0x${"13".repeat(32)}`,
  requester: "0x1111111111111111111111111111111111111111",
  recipient: "0x1111111111111111111111111111111111111111",
  payer: "0x1111111111111111111111111111111111111111",
  authorizedExecutor: "0x1111111111111111111111111111111111111111",
  durationYears: 1n,
  resolverDataHash: `0x${"00".repeat(32)}`,
  referrer: "0x0000000000000000000000000000000000000000",
  settlementAsset: "0x3600000000000000000000000000000000000000",
  expectedAmount: 1_000_000n,
  expectedReferralBps: 0n,
  permitId: `0x${"14".repeat(32)}`,
  nonce: 7n,
  issuedAt: 1_893_456_000n,
  validAfter: 1_893_455_995n,
  validUntil: 1_893_456_180n,
};

describe("local registration permit signer", () => {
  it("signs EIP-712 data recoverable to the manifest signer", async () => {
    const signer = new LocalPrivateKeySigner(privateKey, account.address);
    const signature = await signer.sign(permit);
    await expect(verifyTypedData({
      address: account.address,
      domain: registrationPermitDomain(permit.controller),
      types: registrationPermitTypes,
      primaryType: "RegistrationPermit",
      message: permit,
      signature,
    })).resolves.toBe(true);
    await expect(signer.health()).resolves.toEqual({
      signerAddress: account.address,
      signerKind: "local-private-key",
    });
  });

  it("refuses a key that does not match the manifest signer", () => {
    expect(() => new LocalPrivateKeySigner(privateKey, "0x1111111111111111111111111111111111111111"))
      .toThrow(/does not match the manifest signer/);
  });
});
