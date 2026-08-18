"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from "react";
import { getAddress, type Address } from "viem";
import {
  useConnect,
  useConfig,
  useConnection,
  useConnectors,
  useDisconnect,
  useSwitchChain,
  type Connector,
} from "wagmi";
import { getConnection } from "wagmi/actions";
import { ARC_TESTNET } from "@/lib/network";
import { groupWalletConnectors } from "@/lib/wallet-connectors";

export type ConnectedWallet = {
  account: Address;
  provider: EthereumProvider;
};

type PendingConnection = {
  promise: Promise<ConnectedWallet>;
  resolve(value: ConnectedWallet): void;
  reject(reason: Error): void;
};

type WalletManagerValue = {
  account: Address | null;
  onArc: boolean;
  busy: boolean;
  message: string | null;
  openWalletOptions(): void;
  requireConnection(): Promise<ConnectedWallet>;
  switchToArc(): Promise<void>;
  disconnect(): Promise<void>;
};

const WalletManagerContext = createContext<WalletManagerValue | null>(null);

function inspectWalletError(error: unknown) {
  const codes = new Set<number>();
  const messages: string[] = [];
  const seen = new Set<unknown>();
  const pending: unknown[] = [error];

  while (pending.length > 0 && seen.size < 20) {
    const current = pending.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    const value = current as {
      code?: unknown;
      status?: unknown;
      message?: unknown;
      shortMessage?: unknown;
      details?: unknown;
      cause?: unknown;
      data?: unknown;
      error?: unknown;
    };
    if (typeof value.code === "number") codes.add(value.code);
    if (typeof value.status === "number") codes.add(value.status);
    for (const item of [value.shortMessage, value.details, value.message]) {
      if (typeof item === "string" && item.trim()) messages.push(item.trim());
    }
    pending.push(value.cause, value.data, value.error);
  }

  if (typeof error === "string" && error.trim()) messages.push(error.trim());
  return { codes, messages };
}

export function walletErrorMessage(error: unknown): string {
  const { codes, messages } = inspectWalletError(error);
  const combined = messages.join(" ");
  if (
    codes.has(-32005) ||
    codes.has(-32011) ||
    codes.has(429) ||
    /(?:-32005|-32011|\b429\b|rate[ -]?limit|request limit reached|too many requests)/i.test(combined)
  ) {
    return "Arc RPC is busy right now. Wait 20 seconds, then try again once.";
  }
  if (codes.has(4001) || /user rejected|user denied|request rejected/i.test(combined)) {
    return "The wallet request was cancelled.";
  }
  if (/provider not found|connector not found|not installed/i.test(combined)) {
    return "That wallet is not available in this browser.";
  }
  return messages[0] ?? "The wallet could not connect. Please try again.";
}

function asEthereumProvider(value: unknown): EthereumProvider {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as { request?: unknown }).request !== "function"
  ) {
    throw new Error("The selected wallet did not provide an EIP-1193 connection.");
  }
  return value as EthereumProvider;
}

function WalletOption({
  connector,
  busy,
  onSelect,
}: {
  connector: Connector;
  busy: boolean;
  onSelect(connector: Connector): void;
}) {
  const initial = connector.name.trim().slice(0, 1).toUpperCase() || "W";
  return (
    <button
      className="wallet-option"
      type="button"
      data-wallet-option
      disabled={busy}
      onClick={() => onSelect(connector)}
    >
      <span className="wallet-option__icon" aria-hidden="true">{initial}</span>
      <span>
        <strong>{connector.name}</strong>
        <small>Connect wallet</small>
      </span>
      <i aria-hidden="true">→</i>
    </button>
  );
}

function WalletOptionsDialog({
  open,
  busy,
  message,
  connectors,
  onDismiss,
  onSelect,
}: {
  open: boolean;
  busy: boolean;
  message: string | null;
  connectors: readonly Connector[];
  onDismiss(): void;
  onSelect(connector: Connector): void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const groups = groupWalletConnectors(connectors);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    let focusFrame: number | null = null;
    if (open && !dialog.open) {
      dialog.showModal();
      focusFrame = window.requestAnimationFrame(() => {
        dialog.querySelector<HTMLElement>("[data-wallet-option]")?.focus();
      });
    } else if (!open && dialog.open) {
      dialog.close();
    }
    return () => {
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    };
  }, [open]);

  function dismissFromBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === event.currentTarget) onDismiss();
  }

  const hasOptions =
    groups.detected.length > 0 ||
    groups.coinbase !== null ||
    groups.injectedFallback !== null;

  return (
    <dialog
      ref={dialogRef}
      className="wallet-modal"
      aria-labelledby="wallet-modal-title"
      aria-describedby="wallet-modal-description"
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onClick={dismissFromBackdrop}
    >
      <div className="wallet-modal__panel">
        <div className="wallet-modal__header">
          <div>
            <span>CONTOUR / WALLET</span>
            <h2 id="wallet-modal-title">Connect a wallet</h2>
          </div>
          <button
            className="wallet-modal__close"
            type="button"
            aria-label="Close wallet options"
            onClick={onDismiss}
            disabled={busy}
          >
            ×
          </button>
        </div>
        <p id="wallet-modal-description" className="wallet-modal__description">
          Choose the wallet you want to use on Arc Testnet.
        </p>

        {groups.detected.length > 0 ? (
          <section className="wallet-modal__group" aria-labelledby="detected-wallets-title">
            <h3 id="detected-wallets-title">Detected wallets</h3>
            <div className="wallet-option-list">
              {groups.detected.map((connector) => (
                <WalletOption
                  key={connector.uid}
                  connector={connector}
                  busy={busy}
                  onSelect={onSelect}
                />
              ))}
            </div>
          </section>
        ) : null}

        {groups.injectedFallback ? (
          <section className="wallet-modal__group" aria-labelledby="browser-wallet-title">
            <h3 id="browser-wallet-title">Browser wallet</h3>
            <WalletOption
              connector={groups.injectedFallback}
              busy={busy}
              onSelect={onSelect}
            />
          </section>
        ) : null}

        {groups.coinbase ? (
          <section className="wallet-modal__group" aria-labelledby="coinbase-wallet-title">
            <h3 id="coinbase-wallet-title">Coinbase</h3>
            <WalletOption connector={groups.coinbase} busy={busy} onSelect={onSelect} />
          </section>
        ) : null}

        {!hasOptions ? (
          <p className="wallet-modal__empty">
            No browser wallet was detected. Install one, then reload this page.
          </p>
        ) : null}
        {message ? <p className="wallet-modal__message" role="alert">{message}</p> : null}
      </div>
    </dialog>
  );
}

export function WalletManagerProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  const connection = useConnection();
  const connectors = useConnectors();
  const connectMutation = useConnect();
  const disconnectMutation = useDisconnect();
  const switchMutation = useSwitchChain();
  const [modalOpen, setModalOpen] = useState(false);
  const [localBusy, setLocalBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const pendingConnectionRef = useRef<PendingConnection | null>(null);

  const finishPending = useCallback((value: ConnectedWallet) => {
    pendingConnectionRef.current?.resolve(value);
    pendingConnectionRef.current = null;
  }, []);

  const rejectPending = useCallback((reason: Error) => {
    pendingConnectionRef.current?.reject(reason);
    pendingConnectionRef.current = null;
  }, []);

  const openWalletOptions = useCallback(() => {
    setMessage(null);
    setModalOpen(true);
  }, []);

  const dismissWalletOptions = useCallback(() => {
    if (localBusy) return;
    setModalOpen(false);
    rejectPending(new Error("Wallet selection was closed."));
  }, [localBusy, rejectPending]);

  const selectConnector = useCallback(async (connector: Connector) => {
    setLocalBusy(true);
    setMessage(null);
    try {
      const result = await connectMutation.mutateAsync({
        connector,
        chainId: ARC_TESTNET.id,
      });
      const provider = asEthereumProvider(
        await connector.getProvider({ chainId: result.chainId }),
      );
      const account = getAddress(result.accounts[0]);
      const connected = { account, provider };
      setModalOpen(false);
      finishPending(connected);
    } catch (error) {
      setMessage(walletErrorMessage(error));
    } finally {
      setLocalBusy(false);
    }
  }, [connectMutation, finishPending]);

  const requireConnection = useCallback(async (): Promise<ConnectedWallet> => {
    const current = getConnection(config);
    if (current.isConnected && current.address && current.connector) {
      const provider = asEthereumProvider(
        await current.connector.getProvider({ chainId: current.chainId }),
      );
      return { account: getAddress(current.address), provider };
    }

    if (pendingConnectionRef.current) return pendingConnectionRef.current.promise;

    let resolvePromise!: (value: ConnectedWallet) => void;
    let rejectPromise!: (reason: Error) => void;
    const promise = new Promise<ConnectedWallet>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    pendingConnectionRef.current = {
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    setMessage(null);
    setModalOpen(true);
    return promise;
  }, [config]);

  const switchToArc = useCallback(async () => {
    const current = getConnection(config);
    if (!current.isConnected) {
      await requireConnection();
      return;
    }
    if (current.chainId === ARC_TESTNET.id) return;
    setLocalBusy(true);
    setMessage(null);
    try {
      await switchMutation.mutateAsync({ chainId: ARC_TESTNET.id });
    } catch (error) {
      const text = walletErrorMessage(error);
      setMessage(text);
      throw new Error(text, { cause: error });
    } finally {
      setLocalBusy(false);
    }
  }, [config, requireConnection, switchMutation]);

  const disconnect = useCallback(async () => {
    setLocalBusy(true);
    setMessage(null);
    try {
      await disconnectMutation.mutateAsync();
      setModalOpen(false);
      rejectPending(new Error("Wallet disconnected."));
    } catch (error) {
      const text = walletErrorMessage(error);
      setMessage(text);
      throw new Error(text, { cause: error });
    } finally {
      setLocalBusy(false);
    }
  }, [disconnectMutation, rejectPending]);

  const busy =
    localBusy ||
    connectMutation.isPending ||
    disconnectMutation.isPending ||
    switchMutation.isPending;
  const account = connection.address ? getAddress(connection.address) : null;
  const value: WalletManagerValue = {
    account,
    onArc: connection.chainId === ARC_TESTNET.id,
    busy,
    message,
    openWalletOptions,
    requireConnection,
    switchToArc,
    disconnect,
  };

  return (
    <WalletManagerContext.Provider value={value}>
      {children}
      <WalletOptionsDialog
        open={modalOpen}
        busy={busy}
        message={message}
        connectors={connectors}
        onDismiss={dismissWalletOptions}
        onSelect={(connector) => void selectConnector(connector)}
      />
    </WalletManagerContext.Provider>
  );
}

export function useWalletManager(): WalletManagerValue {
  const value = useContext(WalletManagerContext);
  if (!value) throw new Error("useWalletManager must be used inside Providers.");
  return value;
}
