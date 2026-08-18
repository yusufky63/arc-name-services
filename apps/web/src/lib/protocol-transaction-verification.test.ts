import { describe, expect, it } from "vitest";
import { getAddress, zeroAddress } from "viem";
import { listingInvalidationOutcomeMatches } from "./protocol-transaction-verification";

const formerSeller = getAddress("0x1111111111111111111111111111111111111111");
const otherSeller = getAddress("0x2222222222222222222222222222222222222222");

describe("stale listing verification", () => {
  it("accepts the exact invalidation event and cleared receipt-block state", () => {
    expect(listingInvalidationOutcomeMatches({
      tokenId: 7n,
      formerSeller,
      events: [{ tokenId: 7n, formerSeller }],
      liveSeller: zeroAddress,
      rawSeller: zeroAddress,
    })).toBe(true);
  });

  it("accepts a permissionless cleanup race that cleared state before the submitted call mined", () => {
    expect(listingInvalidationOutcomeMatches({
      tokenId: 7n,
      formerSeller,
      events: [],
      liveSeller: zeroAddress,
      rawSeller: zeroAddress,
    })).toBe(true);
  });

  it("rejects uncleared state or a conflicting emitted invalidation", () => {
    expect(listingInvalidationOutcomeMatches({
      tokenId: 7n,
      formerSeller,
      events: [],
      liveSeller: zeroAddress,
      rawSeller: formerSeller,
    })).toBe(false);
    expect(listingInvalidationOutcomeMatches({
      tokenId: 7n,
      formerSeller,
      events: [{ tokenId: 7n, formerSeller: otherSeller }],
      liveSeller: zeroAddress,
      rawSeller: zeroAddress,
    })).toBe(false);
  });
});
