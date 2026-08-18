import { describe, expect, it } from "vitest";
import { getAddress, zeroAddress } from "viem";
import {
  assertExactPurchaseState,
  isTemporaryVerifierResponse,
  listingCancellationAvailable,
  parsePendingNameAction,
  type NameListingView,
  type PendingNameAction,
  type PurchaseState,
} from "./name-management-panel";

const seller = getAddress("0x1111111111111111111111111111111111111111");
const buyer = getAddress("0x2222222222222222222222222222222222222222");
const releaseId = `0x${"33".repeat(32)}` as const;

const listing: NameListingView = {
  seller,
  price: "25000000",
  validUntil: "1900000000",
  feeBps: 250,
};

const state: PurchaseState = {
  seller,
  price: 25_000_000n,
  validUntil: 1_900_000_000n,
  feeBps: 250,
  paused: false,
  owner: seller,
  active: true,
  expiry: 1_900_100_000n,
  allowance: 25_000_000n,
};

describe("exact name-page purchase state", () => {
  it("accepts the exact reviewed listing", () => {
    expect(() => assertExactPurchaseState(listing, state, buyer)).not.toThrow();
  });

  it("rejects terms changed while an approval is confirming", () => {
    expect(() => assertExactPurchaseState(listing, { ...state, feeBps: 300 }, buyer))
      .toThrow(/listing changed/i);
    expect(() => assertExactPurchaseState(listing, { ...state, price: 30_000_000n }, buyer))
      .toThrow(/listing changed/i);
  });

  it("rejects an invalid owner, paused market, or self-purchase", () => {
    expect(() => assertExactPurchaseState(listing, { ...state, owner: zeroAddress }, buyer))
      .toThrow(/listing changed/i);
    expect(() => assertExactPurchaseState(listing, { ...state, paused: true }, buyer))
      .toThrow(/listing changed/i);
    expect(() => assertExactPurchaseState(listing, state, seller))
      .toThrow(/own name/i);
  });
});

describe("marketplace cancellation escape path", () => {
  it("keeps a live listing cancellable while the market is paused", () => {
    expect(listingCancellationAvailable({
      marketplaceEscapeEnabled: true,
      marketPaused: true,
      hasListing: true,
    })).toBe(true);
  });

  it("still requires an active marketplace contract and a listing", () => {
    expect(listingCancellationAvailable({
      marketplaceEscapeEnabled: false,
      marketPaused: false,
      hasListing: true,
    })).toBe(false);
    expect(listingCancellationAvailable({
      marketplaceEscapeEnabled: true,
      marketPaused: false,
      hasListing: false,
    })).toBe(false);
  });
});

describe("pending name action recovery", () => {
  const pending: PendingNameAction = {
    version: 2,
    releaseId,
    action: "buy",
    transactionHash: `0x${"ab".repeat(32)}`,
    account: buyer,
    tokenId: "7",
    seller,
    price: "25000000",
    feeBps: 250,
  };

  it("accepts only a complete action for the expected token", () => {
    expect(parsePendingNameAction(JSON.stringify(pending), releaseId, "7")).toEqual(pending);
    expect(parsePendingNameAction(JSON.stringify(pending), releaseId, "8")).toBeNull();
    expect(parsePendingNameAction(
      JSON.stringify({ ...pending, releaseId: `0x${"44".repeat(32)}` }),
      releaseId,
      "7",
    )).toBeNull();
    expect(parsePendingNameAction(
      JSON.stringify({ ...pending, seller: undefined }),
      releaseId,
      "7",
    ))
      .toBeNull();
  });

  it("recovers approval removal and binds stale cleanup to its former seller", () => {
    const revoke = {
      version: 2,
      releaseId,
      action: "revoke-market-approval",
      transactionHash: pending.transactionHash,
      account: buyer,
      tokenId: "7",
    } satisfies PendingNameAction;
    const invalidate = {
      ...revoke,
      action: "invalidate",
      seller,
    } satisfies PendingNameAction;

    expect(parsePendingNameAction(JSON.stringify(revoke), releaseId, "7")).toEqual(revoke);
    expect(parsePendingNameAction(JSON.stringify(invalidate), releaseId, "7")).toEqual(invalidate);
    expect(parsePendingNameAction(
      JSON.stringify({ ...invalidate, seller: undefined }),
      releaseId,
      "7",
    )).toBeNull();
  });

  it("classifies verifier pending and rate limiting as temporary", () => {
    expect(isTemporaryVerifierResponse(202, true)).toBe(true);
    expect(isTemporaryVerifierResponse(429, false)).toBe(true);
    expect(isTemporaryVerifierResponse(409, true)).toBe(true);
    expect(isTemporaryVerifierResponse(409, false)).toBe(false);
  });
});
