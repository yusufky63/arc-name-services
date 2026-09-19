import { describe, expect, it } from "vitest";
import type { Connector } from "wagmi";
import {
  groupWalletConnectors,
  resolveConnectorDisplayName,
} from "./wallet-connectors";

function connector(
  name: string,
  type: string,
  rdns?: string,
): Connector {
  return {
    id: `${type}-${name}`,
    name,
    type,
    uid: `${type}-${name}-uid`,
    rdns,
  } as unknown as Connector;
}

describe("wallet connector grouping", () => {
  it("shows every named browser wallet without the ambiguous injected fallback", () => {
    const metamask = connector("MetaMask", "injected", "io.metamask");
    const rabby = connector("Rabby Wallet", "injected", "io.rabby");
    const generic = connector("Injected", "injected");
    const coinbase = connector("Coinbase Wallet", "coinbaseWallet");

    const groups = groupWalletConnectors([
      generic,
      metamask,
      rabby,
      coinbase,
    ]);

    expect(groups.detected).toEqual([metamask, rabby]);
    expect(groups.injectedFallback).toBeNull();
    expect(groups.coinbase).toBe(coinbase);
  });

  it("detects Rabby and OKX Wallet by name even without explicit rdns", () => {
    const okx = connector("OKX Wallet", "injected");
    const rabby = connector("Rabby Wallet", "injected");
    const groups = groupWalletConnectors([okx, rabby]);

    expect(groups.detected).toEqual([okx, rabby]);
    expect(groups.injectedFallback).toBeNull();
  });

  it("keeps a generic browser-wallet option when EIP-6963 finds no named wallet", () => {
    const generic = connector("Injected", "injected");
    const groups = groupWalletConnectors([generic]);

    expect(groups.detected).toEqual([]);
    expect(groups.injectedFallback).toBe(generic);
  });

  it("deduplicates EIP-6963 announcements and prefers detected Coinbase", () => {
    const coinbaseExtension = connector("Coinbase Wallet", "injected", "com.coinbase.wallet");
    const duplicate = connector("Coinbase Duplicate", "injected", "com.coinbase.wallet");
    const configuredCoinbase = connector("Coinbase SDK", "coinbaseWallet");
    const groups = groupWalletConnectors([
      coinbaseExtension,
      duplicate,
      configuredCoinbase,
    ]);

    expect(groups.detected).toEqual([]);
    expect(groups.coinbase).toBe(coinbaseExtension);
  });

  it("resolves connector display names correctly", () => {
    expect(resolveConnectorDisplayName(connector("Coinbase", "injected"))).toBe("Coinbase Wallet");
    expect(resolveConnectorDisplayName(connector("Coinbase Wallet", "coinbaseWallet"))).toBe("Coinbase Wallet");
    expect(resolveConnectorDisplayName(connector("Rabby Wallet", "injected"))).toBe("Rabby Wallet");
    expect(resolveConnectorDisplayName(connector("OKX Wallet", "injected"))).toBe("OKX Wallet");
    expect(resolveConnectorDisplayName(connector("Injected", "injected"))).toBe("Browser wallet");
  });
});
