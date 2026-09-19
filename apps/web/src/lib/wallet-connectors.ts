import type { Connector } from "wagmi";

export type WalletConnectorGroups = {
  detected: readonly Connector[];
  coinbase: Connector | null;
  injectedFallback: Connector | null;
};

function connectorRdns(connector: Connector): readonly string[] {
  if (!connector.rdns) return [];
  return typeof connector.rdns === "string" ? [connector.rdns] : connector.rdns;
}

function isGenericInjected(connector: Connector): boolean {
  const name = connector.name?.trim().toLowerCase();
  return (
    connector.type === "injected" &&
    connectorRdns(connector).length === 0 &&
    (name === "injected" || name === "browser wallet" || !name)
  );
}

export function isCoinbase(connector: Connector): boolean {
  return (
    connector.type === "coinbaseWallet" ||
    connector.id.toLowerCase().includes("coinbase") ||
    connector.name.toLowerCase().includes("coinbase") ||
    connectorRdns(connector).some((rdns) => rdns.toLowerCase().includes("coinbase"))
  );
}

export function resolveConnectorDisplayName(connector: Connector): string {
  if (isCoinbase(connector)) {
    return "Coinbase Wallet";
  }
  const name = connector.name?.trim();
  if (name && name.toLowerCase() !== "injected" && name.toLowerCase() !== "browser wallet") {
    return name;
  }
  if (typeof window !== "undefined") {
    const win = window as unknown as {
      ethereum?: {
        isRabby?: boolean;
        isOKExWallet?: boolean;
        isOkxWallet?: boolean;
        isMetaMask?: boolean;
        isCoinbaseWallet?: boolean;
        isBraveWallet?: boolean;
      };
      okxwallet?: unknown;
      rabby?: unknown;
    };
    if (win.ethereum?.isRabby || Boolean(win.rabby)) return "Rabby Wallet";
    if (win.ethereum?.isOkxWallet || win.ethereum?.isOKExWallet || Boolean(win.okxwallet)) return "OKX Wallet";
    if (win.ethereum?.isCoinbaseWallet) return "Coinbase Wallet";
    if (win.ethereum?.isMetaMask) return "MetaMask";
    if (win.ethereum?.isBraveWallet) return "Brave Wallet";
  }
  return name && name.toLowerCase() !== "injected" ? name : "Browser wallet";
}

function uniqueConnectors(connectors: readonly Connector[]) {
  const seen = new Set<string>();
  return connectors.filter((connector) => {
    const identity =
      connectorRdns(connector)[0]?.toLowerCase() ||
      `${connector.type}:${connector.name}`.toLowerCase();
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

export function groupWalletConnectors(
  connectors: readonly Connector[],
): WalletConnectorGroups {
  const detectedCandidates = uniqueConnectors(
    connectors.filter(
      (connector) =>
        connector.type === "injected" &&
        !isGenericInjected(connector),
    ),
  );
  const detectedCoinbase = detectedCandidates.find(isCoinbase) ?? null;
  const configuredCoinbase = connectors.find(
    (connector) => connector.type === "coinbaseWallet",
  ) ?? null;
  const genericInjected = connectors.find(isGenericInjected) ?? null;

  return {
    detected: detectedCandidates.filter((connector) => !isCoinbase(connector)),
    coinbase: detectedCoinbase ?? configuredCoinbase,
    injectedFallback: detectedCandidates.length > 0 ? null : genericInjected,
  };
}
