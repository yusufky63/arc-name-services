"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  requireActivatedContract,
  type DeploymentManifest,
} from "@contour/config";
import {
  baseRegistrarAbi,
  erc20Abi,
  marketplaceAbi,
  prepareBuyPlan,
  prepareMarketplaceApprovalPlan,
} from "@contour/sdk";
import {
  isPositiveUint256Decimal,
  isUint256Decimal,
} from "@/lib/api-validation";
import type { LiveMarketListing, MarketSnapshot } from "@/lib/market-data";
import { requireReadableReleaseManifest } from "@/lib/manifest";
import { useWalletSession } from "@/lib/use-wallet-session";
import {
  assertArcWalletAccount,
  sendWalletPlan,
  simulateWalletPlan,
  waitForWalletReceipt,
  walletErrorMessage,
  walletMulticall,
} from "@/lib/wallet-protocol";
import { SearchIcon } from "./icons";

type PendingPurchase = {
  version: 2;
  releaseId: Hex;
  transactionHash: `0x${string}`;
  buyer: Address;
  seller: Address;
  tokenId: string;
  expectedPrice: string;
  expectedFeeBps: number;
};

type WalletListing = {
  seller: Address;
  price: bigint;
  validUntil: bigint;
  feeBps: number;
  paused: boolean;
  owner: Address;
  active: boolean;
  expiry: bigint;
  allowance: bigint;
};

const PENDING_KEY = "contour.pending-market-purchase.v2";

function shortAddress(address: string) {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatDate(timestamp: string) {
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Number(timestamp) * 1_000));
}

function readPendingPurchase(): PendingPurchase | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingPurchase>;
    if (
      value.version !== 2 ||
      typeof value.releaseId !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.releaseId) ||
      typeof value.transactionHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.transactionHash) ||
      typeof value.buyer !== "string" ||
      !isAddress(value.buyer) ||
      typeof value.seller !== "string" ||
      !isAddress(value.seller) ||
      !isUint256Decimal(value.tokenId) ||
      !isPositiveUint256Decimal(value.expectedPrice) ||
      typeof value.expectedFeeBps !== "number" ||
      !Number.isInteger(value.expectedFeeBps) ||
      value.expectedFeeBps < 0 ||
      value.expectedFeeBps > 1_000
    ) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return value as PendingPurchase;
  } catch {
    return null;
  }
}

function savePendingPurchase(value: PendingPurchase) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    // The active flow still verifies; storage is recovery-only.
  }
}

function clearPendingPurchase() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // A verified active flow must not be reported as failed because storage is unavailable.
  }
}

async function readJson<T>(response: Response): Promise<T & { error?: string; pending?: boolean }> {
  try {
    return (await response.json()) as T & { error?: string; pending?: boolean };
  } catch {
    throw new Error("The marketplace API returned an invalid response.");
  }
}

async function fetchMarket(fresh = false): Promise<MarketSnapshot> {
  const response = await fetch(fresh ? "/api/market?fresh=1" : "/api/market", {
    cache: fresh ? "no-store" : "default",
  });
  const payload = await readJson<MarketSnapshot>(response);
  if (!response.ok) throw new Error(payload.error ?? "Marketplace read failed.");
  if (payload.chainId !== 5_042_002 || !Array.isArray(payload.listings)) {
    throw new Error("The marketplace API returned an invalid Arc snapshot.");
  }
  return payload;
}

async function verifyPending(pending: PendingPurchase) {
  const response = await fetch("/api/market/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(pending),
  });
  const payload = await readJson<{ verified: boolean }>(response);
  if (response.status === 202 && payload.pending) {
    throw new Error("Purchase broadcast found; waiting for its confirmed Arc receipt.");
  }
  if (!response.ok || !payload.verified) {
    throw new Error(payload.error ?? "Arc state did not verify the purchase.");
  }
}

async function readWalletListing(
  provider: EthereumProvider,
  buyer: Address,
  tokenId: bigint,
  manifest: DeploymentManifest,
): Promise<WalletListing> {
  const market = requireActivatedContract(manifest, "marketplace");
  const registrar = requireActivatedContract(manifest, "baseRegistrar");
  const [listingData, feeData, pausedData, ownerData, activeData, expiryData, allowanceData] =
    await walletMulticall(provider, buyer, [
      { target: market, callData: encodeFunctionData({ abi: marketplaceAbi, functionName: "listingOf", args: [tokenId] }) },
      { target: market, callData: encodeFunctionData({ abi: marketplaceAbi, functionName: "feeBps" }) },
      { target: market, callData: encodeFunctionData({ abi: marketplaceAbi, functionName: "paused" }) },
      { target: registrar, callData: encodeFunctionData({ abi: baseRegistrarAbi, functionName: "ownerOf", args: [tokenId] }) },
      { target: registrar, callData: encodeFunctionData({ abi: baseRegistrarAbi, functionName: "isActive", args: [tokenId] }) },
      { target: registrar, callData: encodeFunctionData({ abi: baseRegistrarAbi, functionName: "nameExpires", args: [tokenId] }) },
      {
        target: manifest.settlement.erc20Address,
        callData: encodeFunctionData({
          abi: erc20Abi,
          functionName: "allowance",
          args: [buyer, market],
        }),
      },
    ]);
  const listing = decodeFunctionResult({
    abi: marketplaceAbi,
    functionName: "listingOf",
    data: listingData,
  });
  return {
    seller: getAddress(listing[0]),
    price: listing[1],
    validUntil: BigInt(listing[2]),
    feeBps: decodeFunctionResult({ abi: marketplaceAbi, functionName: "feeBps", data: feeData }),
    paused: decodeFunctionResult({ abi: marketplaceAbi, functionName: "paused", data: pausedData }),
    owner: getAddress(
      decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "ownerOf", data: ownerData }),
    ),
    active: decodeFunctionResult({ abi: baseRegistrarAbi, functionName: "isActive", data: activeData }),
    expiry: decodeFunctionResult({
      abi: baseRegistrarAbi,
      functionName: "nameExpires",
      data: expiryData,
    }),
    allowance: decodeFunctionResult({ abi: erc20Abi, functionName: "allowance", data: allowanceData }),
  };
}

function assertExactListing(row: LiveMarketListing, state: WalletListing, buyer: Address) {
  if (
    state.seller === zeroAddress ||
    state.seller !== getAddress(row.seller) ||
    state.price !== BigInt(row.price) ||
    state.validUntil !== BigInt(row.validUntil) ||
    state.feeBps !== row.feeBps ||
    state.owner !== state.seller ||
    !state.active ||
    state.expiry < state.validUntil ||
    state.paused
  ) {
    throw new Error("The listing changed or is no longer purchasable on Arc.");
  }
  if (state.seller === getAddress(buyer)) throw new Error("A seller cannot buy their own name.");
}

export function MarketBrowser({
  readEnabled,
  purchaseEnabled,
}: {
  readEnabled: boolean;
  purchaseEnabled: boolean;
}) {
  const [query, setQuery] = useState("");
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [loading, setLoading] = useState(readEnabled);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyToken, setBusyToken] = useState<string | null>(null);
  const recoveryAttempted = useRef(false);
  const wallet = useWalletSession();

  const refresh = useCallback(async (fresh = false) => {
    if (!readEnabled) return;
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await fetchMarket(fresh));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Marketplace read failed.");
    } finally {
      setLoading(false);
    }
  }, [readEnabled]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!purchaseEnabled || !wallet.account || !wallet.onArc || recoveryAttempted.current) return;
    const pending = readPendingPurchase();
    if (!pending || getAddress(pending.buyer) !== wallet.account) return;
    recoveryAttempted.current = true;
    const timer = window.setTimeout(() => {
      setBusyToken(pending.tokenId);
      setMessage("Checking the pending Arc purchase…");
      void verifyPending(pending)
        .then(async () => {
          clearPendingPurchase();
          setMessage("Pending purchase completed on Arc.");
          await refresh(true);
        })
        .catch((recoveryError) => {
          setError(recoveryError instanceof Error ? recoveryError.message : "Pending verification failed.");
        })
        .finally(() => setBusyToken(null));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [purchaseEnabled, refresh, wallet.account, wallet.onArc]);

  async function buy(row: LiveMarketListing) {
    if (!purchaseEnabled) return;
    setBusyToken(row.tokenId);
    setError(null);
    setMessage(null);
    try {
      const { provider, account: buyer } = await wallet.requireConnection();
      if (!wallet.onArc) await wallet.switchToArc();
      await assertArcWalletAccount(provider, buyer);

      const current = await fetchMarket(true);
      await assertArcWalletAccount(provider, buyer);
      const freshRow = current.listings.find(
        (item) =>
          item.tokenId === row.tokenId &&
          item.releaseId.toLowerCase() === row.releaseId.toLowerCase(),
      );
      if (!freshRow) throw new Error("The listing is no longer active.");
      if (
        freshRow.price !== row.price ||
        freshRow.validUntil !== row.validUntil ||
        freshRow.feeBps !== row.feeBps ||
        getAddress(freshRow.seller) !== getAddress(row.seller)
      ) {
        throw new Error("The listing terms changed. Review the refreshed row before buying.");
      }

      const tokenId = BigInt(freshRow.tokenId);
      const manifest = requireReadableReleaseManifest(freshRow.releaseId);
      let walletState = await readWalletListing(
        provider,
        buyer,
        tokenId,
        manifest,
      );
      await assertArcWalletAccount(provider, buyer);
      assertExactListing(freshRow, walletState, buyer);
      if (walletState.allowance < walletState.price) {
        setMessage("Authorize the exact listing price in USDC.");
        const approval = prepareMarketplaceApprovalPlan(manifest, walletState.price);
        await simulateWalletPlan(provider, buyer, approval);
        await assertArcWalletAccount(provider, buyer);
        const approvalHash = await sendWalletPlan(provider, buyer, approval);
        await waitForWalletReceipt(provider, approvalHash, buyer);
        await assertArcWalletAccount(provider, buyer);
        walletState = await readWalletListing(
          provider,
          buyer,
          tokenId,
          manifest,
        );
        await assertArcWalletAccount(provider, buyer);
        assertExactListing(freshRow, walletState, buyer);
        if (walletState.allowance < walletState.price) {
          throw new Error("The exact marketplace allowance was not confirmed on Arc.");
        }
      }

      const purchase = prepareBuyPlan(
        manifest,
        tokenId,
        walletState.price,
        walletState.feeBps,
      );
      await simulateWalletPlan(provider, buyer, purchase);
      await assertArcWalletAccount(provider, buyer);
      setMessage("Confirm the fixed-price purchase in your wallet.");
      const transactionHash = await sendWalletPlan(provider, buyer, purchase);
      const pending: PendingPurchase = {
        version: 2,
        releaseId: freshRow.releaseId,
        transactionHash,
        buyer,
        seller: walletState.seller,
        tokenId: tokenId.toString(),
        expectedPrice: walletState.price.toString(),
        expectedFeeBps: walletState.feeBps,
      };
      savePendingPurchase(pending);
      await waitForWalletReceipt(provider, transactionHash, buyer);
      await assertArcWalletAccount(provider, buyer);
      await verifyPending(pending);
      clearPendingPurchase();
      setMessage(`${freshRow.name} is now yours on Arc.`);
      await refresh(true);
    } catch (buyError) {
      setError(walletErrorMessage(buyError, "Purchase stopped."));
    } finally {
      setBusyToken(null);
    }
  }

  if (!readEnabled) return null;

  const rows = (snapshot?.listings ?? []).filter((row) =>
    row.name.includes(query.trim().toLowerCase()),
  );
  return (
    <div className="market-browser market-browser--live">
      <div className="market-browser__content content-shell">
        <div className="market-toolbar market-toolbar--live">
          <label htmlFor="market-filter">Filter listings</label>
          <div><SearchIcon /><input id="market-filter" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter names" /></div>
          <span>{rows.length.toString().padStart(2, "0")} / RESULTS</span>
        </div>
        {purchaseEnabled && wallet.message ? <p className="market-feedback" role="status">{wallet.message}</p> : null}
        {message ? <p className="market-feedback" role="status">{message}</p> : null}
        {error ? <p className="market-feedback market-feedback--error" role="alert">{error}</p> : null}
        {loading ? <div className="market-empty">Loading listings…</div> : null}
        {!loading && !error && rows.length === 0 ? <div className="market-empty">No active fixed-price listing matches this filter.</div> : null}
        {rows.length ? (
          <div className="market-live-table" role="table" aria-label="Active fixed-price name listings">
            <div role="rowgroup">
              <div className="market-live-table__head" role="row"><span role="columnheader">Name</span><span role="columnheader">Price</span><span role="columnheader">Seller</span><span role="columnheader">Deadline</span>{purchaseEnabled ? <span role="columnheader">Action</span> : null}</div>
            </div>
            <div role="rowgroup">
              {rows.map((row, index) => (
              <div
                className="market-live-row"
                role="row"
                key={`${row.releaseId}:${row.tokenId}`}
              >
                <span>{String(index + 1).padStart(2, "0")}</span>
                <div className="market-live-name" role="cell">
                  <Link
                    href={`/name/${encodeURIComponent(row.label)}?release=${encodeURIComponent(row.releaseId)}`}
                  >
                    {row.name}
                  </Link>
                </div>
                <strong role="cell">
                  {formatUnits(BigInt(row.price), 6)} USDC
                  <small>{row.feeBps} BPS INCLUDED</small>
                </strong>
                <code role="cell" aria-label={`Seller ${row.seller}`}>{shortAddress(row.seller)}</code>
                <time role="cell" dateTime={new Date(Number(row.validUntil) * 1_000).toISOString()}>{formatDate(row.validUntil)}</time>
                {purchaseEnabled ? <div className="market-live-action" role="cell">
                  {wallet.account && getAddress(wallet.account) === getAddress(row.seller) ? (
                    <Link
                      className="market-manage-link"
                      href={`/name/${encodeURIComponent(row.label)}?release=${encodeURIComponent(row.releaseId)}`}
                    >
                      Manage
                    </Link>
                  ) : !row.marketPaused ? (
                    <button type="button" onClick={() => void buy(row)} disabled={busyToken !== null}>
                      {busyToken === row.tokenId ? "Buying…" : "Buy"}
                    </button>
                  ) : null}
                </div> : null}
              </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
