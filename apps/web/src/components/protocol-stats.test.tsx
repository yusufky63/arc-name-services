import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ProtocolStatsRibbon } from "./protocol-stats";

vi.stubGlobal("React", React);

describe("ProtocolStatsRibbon", () => {
  it("renders nothing when readEnabled is false", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProtocolStatsRibbon, { readEnabled: false }),
    );
    expect(markup).toBe("");
  });

  it("renders stats structure when readEnabled is true", () => {
    const markup = renderToStaticMarkup(
      React.createElement(ProtocolStatsRibbon, { readEnabled: true }),
    );
    expect(markup).toContain("REGISTERED NAMES");
    expect(markup).toContain("NAMES FOR SALE");
    expect(markup).toContain("ACTIVE USERS");
    expect(markup).toContain("100% USDC");
  });
});
