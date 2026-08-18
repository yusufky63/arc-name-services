import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SiteFooter } from "./site-footer";

vi.mock("./wordmark", () => ({
  Wordmark: () => "Contour",
}));

describe("site footer", () => {
  it("keeps public service status discoverable without exposing admin navigation", () => {
    vi.stubGlobal("React", React);
    const markup = renderToStaticMarkup(React.createElement(SiteFooter));

    expect(markup).toContain('href="/status"');
    expect(markup).not.toContain('href="/admin"');
    expect(markup).not.toContain("Operations");
    expect(markup).toContain("ARC TESTNET");
    expect(markup).toContain("CHAIN 5042002");
  });
});
