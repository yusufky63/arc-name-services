import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import DevelopersPage from "./page";

vi.mock("server-only", () => ({}));

describe("developer SDK documentation", () => {
  it("uses the actual public npm package name in install and import examples", () => {
    vi.stubGlobal("React", React);
    const markup = renderToStaticMarkup(React.createElement(DevelopersPage));

    expect(markup).toContain("npm install contour-sdk viem");
    expect(markup).toContain("from &quot;contour-sdk&quot;");
    expect(markup).toContain("Curated SDK ABI surfaces");
    expect(markup).toContain("SERVICE STATUS");
    expect(markup).toContain('href="/status"');
    expect(markup).toContain("/api/registration/readiness");
    expect(markup).toContain("/api/marketplace/readiness");
    expect(markup).toContain("canonical V1 registrar does not implement ERC-721 Metadata or <code>tokenURI</code>");
    expect(markup).toContain("Contour provides application-hosted companion metadata and deterministic image endpoints");
    expect(markup).not.toContain("@sepbase/contour-sdk");
    expect(markup).not.toContain("All protocol and settlement ABIs");
    for (const tool of [
      "prepare_market_token_approval",
      "prepare_market_token_approval_revoke",
      "prepare_market_usdc_approval",
      "prepare_market_cancel",
      "prepare_claim_proceeds",
      "prepare_claim_referral",
      "prepare_transfer",
      "prepare_market_invalidate",
    ]) {
      expect(markup).toContain(tool);
    }
  });
});
