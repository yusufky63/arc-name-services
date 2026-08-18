import { describe, expect, it } from "vitest";
import { durationNavigationTarget } from "./registration-duration";

describe("registration duration keyboard navigation", () => {
  it("moves within the bounded option list", () => {
    expect(durationNavigationTarget(1, "ArrowDown", 5)).toBe(2);
    expect(durationNavigationTarget(1, "ArrowUp", 5)).toBe(0);
    expect(durationNavigationTarget(4, "ArrowDown", 5)).toBe(4);
    expect(durationNavigationTarget(0, "ArrowUp", 5)).toBe(0);
  });

  it("supports Home and End and safely handles empty lists", () => {
    expect(durationNavigationTarget(3, "Home", 5)).toBe(0);
    expect(durationNavigationTarget(1, "End", 5)).toBe(4);
    expect(durationNavigationTarget(9, "Home", 0)).toBe(0);
  });
});
