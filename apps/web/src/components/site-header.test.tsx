import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SiteHeader } from "./site-header";

const walletState = vi.hoisted(() => ({
  account: null as string | null,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
}));

vi.mock("./wallet-manager", () => ({
  useWalletManager: () => walletState,
}));

vi.mock("./wallet-control", () => ({
  WalletControl: () => "Wallet",
}));

vi.mock("./wordmark", () => ({
  Wordmark: () => "Contour",
}));

vi.mock("./icons", () => ({
  CloseIcon: () => null,
  MenuIcon: () => null,
}));

const ADMIN = "0x78de409a6306550882328E2a67160471368387FF";

function renderHeader() {
  vi.stubGlobal("React", React);
  return renderToStaticMarkup(
    React.createElement(SiteHeader, { governanceAccount: ADMIN }),
  );
}

describe("site header navigation", () => {
  beforeEach(() => {
    walletState.account = null;
  });

  it("keeps Status and Admin out of public navigation", () => {
    const markup = renderHeader();

    expect(markup).not.toContain('href="/status"');
    expect(markup).not.toContain('href="/admin"');
    expect(markup).toContain('href="/developers"');
  });

  it("shows Admin only for the configured connected governance wallet", () => {
    walletState.account = "0x1111111111111111111111111111111111111111";
    expect(renderHeader()).not.toContain('href="/admin"');

    walletState.account = ADMIN.toLowerCase();
    expect(renderHeader()).toContain('href="/admin"');
  });
});
