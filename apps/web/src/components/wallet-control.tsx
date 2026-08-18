"use client";

import { useWalletManager } from "./wallet-manager";
import { WalletIcon } from "./icons";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletControl() {
  const wallet = useWalletManager();

  if (!wallet.account) {
    return (
      <div className="wallet-shell">
        <button
          className="wallet-button"
          type="button"
          onClick={wallet.openWalletOptions}
          disabled={wallet.busy}
        >
          <WalletIcon />
          <span>{wallet.busy ? "Connecting" : "Connect"}</span>
        </button>
        {wallet.message ? (
          <span className="wallet-message" role="status">{wallet.message}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="wallet-shell wallet-shell--connected">
      {!wallet.onArc ? (
        <button
          className="wallet-button wallet-button--warning"
          type="button"
          onClick={() => void wallet.switchToArc().catch(() => undefined)}
          disabled={wallet.busy}
        >
          Switch to Arc
        </button>
      ) : (
        <span className="wallet-account">
          <i aria-hidden="true" />
          {shortAddress(wallet.account)}
        </span>
      )}
      <button
        className="wallet-disconnect"
        type="button"
        onClick={() => void wallet.disconnect().catch(() => undefined)}
        disabled={wallet.busy}
      >
        Disconnect
      </button>
      {wallet.message ? (
        <span className="wallet-message" role="status">{wallet.message}</span>
      ) : null}
    </div>
  );
}
