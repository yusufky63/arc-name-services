"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatUnits,
  getAddress,
  isAddress,
  type Address,
  type Hex,
} from "viem";
import {
  prepareClaimProceedsPlan,
  prepareClaimReferralPlan,
} from "@contour/sdk";
import type { AccountSnapshot } from "@/lib/market-data";
import { requireReadableReleaseManifest } from "@/lib/manifest";
import { useWalletSession } from "@/lib/use-wallet-session";
import {
  assertArcWalletAccount,
  sendWalletPlan,
  simulateWalletPlan,
  waitForWalletReceipt,
  walletErrorMessage,
} from "@/lib/wallet-protocol";

type PendingAccountAction = {
  version: 2;
  releaseId: Hex;
  action: "claim-proceeds" | "claim-referral";
  transactionHash: `0x${string}`;
  owner: Address;
};

export function liabilityClaimAvailable(input: {
  actionsEnabled: boolean;
  amount: string;
  marketPaused: boolean;
}) {
  // Marketplace pause blocks new listings and purchases, not withdrawal of
  // liabilities already owed to sellers or referrers.
  return input.actionsEnabled && BigInt(input.amount) > 0n;
}

const PENDING_KEY = "contour.pending-account-action.v2";

function dateLabel(timestamp: string) {
  if (timestamp === "0") return "—";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Number(timestamp) * 1_000));
}

async function readJson<T>(response: Response): Promise<T & { error?: string; pending?: boolean }> {
  try {
    return (await response.json()) as T & { error?: string; pending?: boolean };
  } catch {
    throw new Error("The account API returned an invalid response.");
  }
}

async function fetchAccount(owner: Address, fresh = false): Promise<AccountSnapshot> {
  const response = await fetch(`/api/account?owner=${encodeURIComponent(owner)}${fresh ? "&fresh=1" : ""}`, {
    cache: fresh ? "no-store" : "default",
  });
  const payload = await readJson<AccountSnapshot>(response);
  if (!response.ok) throw new Error(payload.error ?? "Account read failed.");
  if (
    payload.chainId !== 5_042_002 ||
    !isAddress(payload.owner) ||
    getAddress(payload.owner) !== owner ||
    !Array.isArray(payload.names) ||
    !Array.isArray(payload.releases)
  ) {
    throw new Error("The account API returned an invalid snapshot.");
  }
  return payload;
}

function readPending(): PendingAccountAction | null {
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingAccountAction>;
    if (
      value.version !== 2 ||
      typeof value.releaseId !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.releaseId) ||
      !["claim-proceeds", "claim-referral"].includes(value.action ?? "") ||
      typeof value.transactionHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.transactionHash) ||
      typeof value.owner !== "string" ||
      !isAddress(value.owner)
    ) {
      sessionStorage.removeItem(PENDING_KEY);
      return null;
    }
    return value as PendingAccountAction;
  } catch {
    return null;
  }
}

function savePending(value: PendingAccountAction) {
  try {
    sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    // The active flow still verifies; storage is recovery-only.
  }
}

function clearPending() {
  try {
    sessionStorage.removeItem(PENDING_KEY);
  } catch {
    // A verified active flow must not be reported as failed because storage is unavailable.
  }
}

async function verifyPending(input: PendingAccountAction) {
  const response = await fetch("/api/account/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const payload = await readJson<{ verified: boolean }>(response);
  if (response.status === 202 && payload.pending) {
    throw new Error("Account action broadcast found; waiting for its confirmed receipt.");
  }
  if (!response.ok || !payload.verified) {
    throw new Error(payload.error ?? "The account action could not be verified.");
  }
}

export function AccountDashboard({ actionsEnabled }: { actionsEnabled: boolean }) {
  const wallet = useWalletSession();
  const [snapshot, setSnapshot] = useState<AccountSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const recoveryAttempted = useRef(false);

  const refresh = useCallback(async (fresh = false) => {
    if (!wallet.account || !wallet.onArc) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      setSnapshot(await fetchAccount(wallet.account, fresh));
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Account read failed.");
    } finally {
      setLoading(false);
    }
  }, [wallet.account, wallet.onArc]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    if (!actionsEnabled || !wallet.account || !wallet.onArc || recoveryAttempted.current) return;
    const pending = readPending();
    if (!pending || getAddress(pending.owner) !== wallet.account) return;
    recoveryAttempted.current = true;
    const timer = window.setTimeout(() => {
      setBusyAction("recovery");
      setMessage("Checking the pending account action…");
      void verifyPending(pending)
        .then(async () => {
          clearPending();
          setMessage("Pending claim completed.");
          await refresh(true);
        })
        .catch((recoveryError) => {
          setError(recoveryError instanceof Error ? recoveryError.message : "Pending verification failed.");
        })
        .finally(() => setBusyAction(null));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [actionsEnabled, refresh, wallet.account, wallet.onArc]);

  async function connectedContext() {
    const { provider, account } = await wallet.requireConnection();
    if (!wallet.onArc) await wallet.switchToArc();
    await assertArcWalletAccount(provider, account);
    return { provider, account };
  }

  async function finishAction(
    provider: EthereumProvider,
    account: Address,
    pending: PendingAccountAction,
  ) {
    savePending(pending);
    await waitForWalletReceipt(provider, pending.transactionHash, account);
    await assertArcWalletAccount(provider, account);
    await verifyPending(pending);
    clearPending();
    await refresh(true);
  }

  async function claim(
    action: "claim-proceeds" | "claim-referral",
    releaseId: Hex,
  ) {
    if (!actionsEnabled) return;
    const actionKey = `${action}:${releaseId.toLowerCase()}`;
    setBusyAction(actionKey);
    setError(null);
    setMessage(null);
    try {
      const { provider, account } = await connectedContext();
      const current = await fetchAccount(account, true);
      await assertArcWalletAccount(provider, account);
      const release = current.releases.find(
        (candidate) =>
          candidate.releaseId.toLowerCase() === releaseId.toLowerCase(),
      );
      if (!release) {
        throw new Error("This Contour release is no longer available for claims.");
      }
      const amount = BigInt(
        action === "claim-proceeds"
          ? release.sellerProceeds
          : release.referralCredits,
      );
      if (amount === 0n) throw new Error("There is no claimable USDC in this account.");
      const manifest = requireReadableReleaseManifest(release.releaseId);
      const plan = action === "claim-proceeds"
        ? prepareClaimProceedsPlan(manifest)
        : prepareClaimReferralPlan(manifest);
      await simulateWalletPlan(provider, account, plan);
      await assertArcWalletAccount(provider, account);
      const transactionHash = await sendWalletPlan(provider, account, plan);
      setMessage(`Claiming ${formatUnits(amount, 6)} USDC…`);
      await finishAction(provider, account, {
        version: 2,
        releaseId: release.releaseId,
        action,
        transactionHash,
        owner: account,
      });
      setMessage("USDC claimed.");
    } catch (claimError) {
      setError(walletErrorMessage(claimError, "Claim stopped."));
    } finally {
      setBusyAction(null);
    }
  }

  if (!wallet.account) {
    return (
      <section className="account-gate-surface">
        <div className="account-gate content-shell">
          <span>MY NAMES</span>
          <h2>Connect your wallet.</h2>
          <p>Use the Connect button in the header to view your names and proceeds.</p>
        </div>
      </section>
    );
  }

  if (!wallet.onArc) {
    return (
      <section className="account-gate-surface">
        <div className="account-gate content-shell">
          <span>WRONG NETWORK</span><h2>Arc Testnet required.</h2>
          <p>Switch your wallet to Arc Testnet to continue.</p>
          <button type="button" onClick={() => void wallet.switchToArc().catch(() => undefined)} disabled={wallet.busy}>Switch to Arc</button>
          {wallet.message ? <p role="status">{wallet.message}</p> : null}
        </div>
      </section>
    );
  }

  const activeNames = snapshot?.names.filter((name) => name.lifecycle === "active").length ?? 0;
  const referralClaims = snapshot?.releases.filter((release) =>
    liabilityClaimAvailable({
      actionsEnabled,
      amount: release.referralCredits,
      marketPaused: release.marketPaused,
    }),
  ) ?? [];
  const proceedsClaims = snapshot?.releases.filter((release) =>
    liabilityClaimAvailable({
      actionsEnabled,
      amount: release.sellerProceeds,
      marketPaused: release.marketPaused,
    }),
  ) ?? [];

  return (
    <section className="account-dashboard">
      <div className="account-dashboard__content content-shell">
        {message ? <p className="account-feedback" role="status">{message}</p> : null}
        {error ? <p className="account-feedback account-feedback--error" role="alert">{error}</p> : null}
        {loading && !snapshot ? <div className="account-empty">Loading your names…</div> : null}
        {snapshot ? (
          <>
            <div className="account-liabilities">
              <div>
                <span>01 / REFERRALS</span>
                <strong>{formatUnits(BigInt(snapshot.referralCredits), 6)} USDC</strong>
                {referralClaims.map((release) => {
                  const key = `claim-referral:${release.releaseId.toLowerCase()}`;
                  return (
                    <button
                      type="button"
                      key={release.releaseId}
                      onClick={() => void claim("claim-referral", release.releaseId)}
                      disabled={busyAction !== null}
                    >
                      {busyAction === key
                        ? "Claiming…"
                        : `Claim ${release.releaseKey === "canonical" ? "current" : "legacy"} referral`}
                    </button>
                  );
                })}
              </div>
              <div>
                <span>02 / PROCEEDS</span>
                <strong>{formatUnits(BigInt(snapshot.sellerProceeds), 6)} USDC</strong>
                {proceedsClaims.map((release) => {
                  const key = `claim-proceeds:${release.releaseId.toLowerCase()}`;
                  return (
                    <button
                      type="button"
                      key={release.releaseId}
                      onClick={() => void claim("claim-proceeds", release.releaseId)}
                      disabled={busyAction !== null}
                    >
                      {busyAction === key
                        ? "Claiming…"
                        : `Claim ${release.releaseKey === "canonical" ? "current" : "legacy"} proceeds`}
                    </button>
                  );
                })}
              </div>
              <div><span>03 / NAMES</span><strong>{snapshot.names.length.toString().padStart(2, "0")}</strong><em>{activeNames.toString().padStart(2, "0")} ACTIVE</em></div>
            </div>
            <div className="account-names-heading"><span>04 / YOUR NAMES</span><h2>Choose a name to manage</h2></div>
            {snapshot.names.length === 0 ? <div className="account-empty">No names were found for this wallet.</div> : null}
            <div className="account-name-list">
              {snapshot.names.map((name) => {
                const manageHref =
                  `/name/${encodeURIComponent(name.label)}?release=${encodeURIComponent(name.releaseId)}`;
                return (
                  <article
                    className="account-name-row"
                    key={`${name.releaseId}:${name.tokenId}`}
                  >
                    <div className="account-name-row__identity">
                      <span>{name.lifecycle.toUpperCase()}</span>
                      <Link href={manageHref}>{name.name}</Link>
                      <time dateTime={new Date(Number(name.expiry) * 1_000).toISOString()}>EXPIRES {dateLabel(name.expiry)}</time>
                    </div>
                    <div className="account-name-row__listing">
                      <span>{name.listing ? "LISTED" : "NOT LISTED"}</span>
                      <strong>{name.listing ? `${formatUnits(BigInt(name.listing.price), 6)} USDC` : "No active listing"}</strong>
                      <time>{name.listing ? `UNTIL ${dateLabel(name.listing.validUntil)}` : "Renew, transfer, set primary, or sell"}</time>
                      <Link href={manageHref}>Manage name →</Link>
                    </div>
                  </article>
                );
              })}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
