import { getAddress, zeroAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  adminPostStateMatches,
  describeAdminEvent,
  isAdminLogRangeLimitError,
  parseAdminPostStateExpectation,
  type AdminSnapshot,
} from "./admin-protocol";

const governance = getAddress("0x1111111111111111111111111111111111111111");
const controller = getAddress("0x2222222222222222222222222222222222222222");
const marketplace = getAddress("0x3333333333333333333333333333333333333333");
const registrar = getAddress("0x4444444444444444444444444444444444444444");
const signer = getAddress("0x5555555555555555555555555555555555555555");
const releaseId = `0x${"11".repeat(32)}` as const;

function snapshot(): AdminSnapshot {
  return {
    blockNumber: 100n,
    blockTimestamp: 1_000n,
    governance,
    productLive: true,
    releaseId,
    releaseKey: "canonical",
    registrarVersion: "v2",
    canonical: true,
    controller: {
      address: controller,
      owner: governance,
      pendingOwner: null,
      releaseId,
      treasury: governance,
      permitSigner: signer,
      pendingPermitSigner: null,
      pendingPermitSignerValidAfter: 0n,
      signerPolicyVersion: 7n,
      referralBps: 500,
      registrationsPaused: true,
      balance: 5_000_000n,
      liability: 1_000_000n,
      surplus: 4_000_000n,
      prices: [1n, 2n, 3n, 4n],
      maxReferralBps: 3_000,
      signerActivationDelay: 86_400n,
    },
    marketplace: {
      address: marketplace,
      owner: governance,
      pendingOwner: null,
      treasury: governance,
      feeBps: 250,
      paused: false,
      balance: 3_000_000n,
      liability: 1_500_000n,
      surplus: 1_500_000n,
      maxFeeBps: 1_000,
    },
    registrar: {
      address: registrar,
      owner: governance,
      pendingOwner: null,
      canonicalControllerEnabled: true,
    },
    registry: {
      address: getAddress("0x6666666666666666666666666666666666666666"),
      rootOwner: governance,
      baseNodeOwner: registrar,
      reverseRootOwner: governance,
      reverseNodeOwner: getAddress("0x7777777777777777777777777777777777777777"),
      baseNodeResolver: null,
    },
  };
}

describe("admin post-state expectations", () => {
  it("checks exact mutable policy and ownership state", () => {
    const state = snapshot();
    expect(adminPostStateMatches(state, { kind: "registration-pause", paused: true })).toBe(true);
    expect(adminPostStateMatches(state, { kind: "marketplace-pause", paused: true })).toBe(false);
    expect(adminPostStateMatches(state, { kind: "referral-bps", bps: 500 })).toBe(true);
    expect(adminPostStateMatches(state, { kind: "marketplace-fee-bps", bps: 250 })).toBe(true);
    expect(adminPostStateMatches(state, { kind: "owner", target: "registrar", owner: governance })).toBe(true);
    expect(adminPostStateMatches(state, { kind: "withdrawal", target: "controller", treasury: governance })).toBe(true);
  });

  it("requires paused registration and both signer slots cleared for revocation recovery", () => {
    const state = snapshot();
    state.controller.permitSigner = zeroAddress;
    expect(adminPostStateMatches(state, { kind: "signer-revocation" })).toBe(true);
    state.controller.pendingPermitSigner = signer;
    expect(adminPostStateMatches(state, { kind: "signer-revocation" })).toBe(false);
  });

  it("normalizes valid stored expectations and rejects malformed recovery data", () => {
    expect(parseAdminPostStateExpectation({
      kind: "treasury",
      target: "controller",
      treasury: governance.toLowerCase(),
    })).toEqual({ kind: "treasury", target: "controller", treasury: governance });
    expect(parseAdminPostStateExpectation({ kind: "owner", target: "registry", owner: governance })).toBeNull();
    expect(parseAdminPostStateExpectation({ kind: "signer-activation", signer, policyVersion: "7x" })).toBeNull();
  });
});

describe("admin activity", () => {
  it("shows total registration charge including premium", () => {
    const event = describeAdminEvent("NameRegistered", {
      name: "one.arc",
      owner: governance,
      baseCost: 2_000_000n,
      premium: 3_500_000n,
    });
    expect(event.detail).toContain("5.5 USDC");
  });

  it("splits only explicit log range/result errors", () => {
    expect(isAdminLogRangeLimitError(new Error("requested block range is too large"))).toBe(true);
    expect(isAdminLogRangeLimitError(new Error("eth_getLogs is limited to a 10,000 range"))).toBe(true);
    expect(isAdminLogRangeLimitError({ code: -32_005, message: "HTTP 429 rate limit" })).toBe(false);
    expect(isAdminLogRangeLimitError(new Error("method eth_getLogs is unsupported"))).toBe(false);
    expect(isAdminLogRangeLimitError({ message: "query returned more than 10000 results" })).toBe(true);
  });
});
