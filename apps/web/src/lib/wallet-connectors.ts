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

function isCoinbase(connector: Connector) {
  return (
    connector.type === "coinbaseWallet" ||
    connector.id.toLowerCase().includes("coinbase") ||
    connectorRdns(connector).some((rdns) => rdns.toLowerCase().includes("coinbase"))
  );
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
  const eip6963 = uniqueConnectors(
    connectors.filter(
      (connector) =>
        connector.type === "injected" && connectorRdns(connector).length > 0,
    ),
  );
  const detectedCoinbase = eip6963.find(isCoinbase) ?? null;
  const configuredCoinbase = connectors.find(
    (connector) => connector.type === "coinbaseWallet",
  ) ?? null;
  const genericInjected = connectors.find(
    (connector) =>
      connector.type === "injected" && connectorRdns(connector).length === 0,
  ) ?? null;

  return {
    detected: eip6963.filter((connector) => !isCoinbase(connector)),
    coinbase: detectedCoinbase ?? configuredCoinbase,
    injectedFallback: eip6963.length > 0 ? null : genericInjected,
  };
}
