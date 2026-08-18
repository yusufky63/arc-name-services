import { describe, expect, it } from "vitest";
import { shouldShowAdminNavigation } from "./navigation-access";

const ADMIN = "0x78de409a6306550882328E2a67160471368387FF";

describe("admin navigation visibility", () => {
  it("shows the link only for the configured connected governance wallet", () => {
    expect(shouldShowAdminNavigation(ADMIN, ADMIN)).toBe(true);
    expect(shouldShowAdminNavigation(ADMIN.toLowerCase(), ADMIN)).toBe(true);
    expect(
      shouldShowAdminNavigation(
        "0x1111111111111111111111111111111111111111",
        ADMIN,
      ),
    ).toBe(false);
  });

  it("stays hidden without both wallet addresses", () => {
    expect(shouldShowAdminNavigation(null, ADMIN)).toBe(false);
    expect(shouldShowAdminNavigation(ADMIN, null)).toBe(false);
  });
});
