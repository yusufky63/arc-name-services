import { describe, expect, it } from "vitest";
import { liabilityClaimAvailable } from "./account-dashboard";

describe("account liability escape paths", () => {
  it("keeps seller and referral liabilities claimable while the market is paused", () => {
    expect(liabilityClaimAvailable({
      actionsEnabled: true,
      amount: "500000",
      marketPaused: true,
    })).toBe(true);
  });

  it("still requires an enabled execution surface and a positive liability", () => {
    expect(liabilityClaimAvailable({
      actionsEnabled: false,
      amount: "500000",
      marketPaused: false,
    })).toBe(false);
    expect(liabilityClaimAvailable({
      actionsEnabled: true,
      amount: "0",
      marketPaused: false,
    })).toBe(false);
  });
});
