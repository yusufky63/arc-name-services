"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { registrarVersionOf } from "@contour/config";
import type { Address, Hex } from "viem";
import { getReadableReleases } from "@/lib/manifest";
import {
  explorerAddress,
  explorerTransaction,
  formatBps,
  formatUsdc,
  getAdminReleaseContext,
  loadAdminActivity,
  readAdminSnapshot,
  resolveAdminAccess,
  shortAddress,
  type AdminAccess,
  type AdminActivityCategory,
  type AdminActivityData,
  type AdminSnapshot,
} from "@/lib/admin-protocol";
import { walletErrorMessage } from "@/lib/wallet-protocol";
import { useWalletSession } from "@/lib/use-wallet-session";
import {
  AdminControls,
  adminSnapshotMatchesSelectedRelease,
} from "./admin-controls";

export type AdminTab = "overview" | "activity" | "controls";

const ADMIN_TABS = ["overview", "activity", "controls"] as const;

type AdminWorkspaceProps = {
  initialTab: AdminTab;
  initialReleaseId: Hex;
};

const categoryLabels: Record<AdminActivityCategory | "all", string> = {
  all: "All",
  registration: "Registration",
  marketplace: "Marketplace",
  treasury: "Treasury",
  signer: "Signer",
  configuration: "Configuration",
  ownership: "Ownership",
};

function same(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

function statusClass(value: boolean) {
  return value ? "ready" : "warning";
}

function AdminGate({
  state,
  account,
  message,
}: {
  state: "connect" | "network" | "loading" | "denied" | "error";
  account?: Address | null;
  message?: string | null;
}) {
  const wallet = useWalletSession();
  const copy = {
    connect: ["WALLET REQUIRED", "Connect the governance wallet.", "Live service status remains public on the Status page. Contract state and controls open only after connected-wallet authorization."],
    network: ["ARC TESTNET REQUIRED", "Switch the wallet network.", "Admin reads, simulations, and writes are pinned to Arc Testnet chain ID 5042002."],
    loading: ["VERIFYING ACCESS", "Reading live contract authority.", "Controller, marketplace, registrar, registry, signer, liability, and release state are read in one Arc multicall."],
    denied: ["ACCESS DENIED", "This wallet is not an administrator.", "Use the live governance, contract owner, or exact pending-owner wallet. Client visibility is not the contract authorization boundary."],
    error: ["ADMIN READ FAILED", "Live administration state is unavailable.", message ?? "No transaction was requested. Retry the read after checking Arc RPC and wallet state."],
  }[state];

  return (
    <section className="admin-gate content-shell" aria-labelledby="admin-gate-title">
      <span>{copy[0]}</span>
      <h2 id="admin-gate-title">{copy[1]}</h2>
      <p>{copy[2]}</p>
      {account ? <code>{account}</code> : null}
      {state === "connect" || state === "denied" ? (
        <button className="admin-button" type="button" onClick={wallet.openWalletOptions} disabled={wallet.busy}>
          {state === "denied" ? "Choose another wallet" : "Connect wallet"}
        </button>
      ) : null}
      {state === "network" ? (
        <button className="admin-button" type="button" onClick={() => void wallet.switchToArc().catch(() => undefined)} disabled={wallet.busy}>
          Switch to Arc Testnet
        </button>
      ) : null}
    </section>
  );
}

function AdminOverview({ snapshot }: { snapshot: AdminSnapshot }) {
  const { manifest } = getAdminReleaseContext(snapshot.releaseId);
  const controllerSolvent = snapshot.controller.surplus !== null;
  const marketSolvent = snapshot.marketplace.surplus !== null;
  const ownerParity = [
    snapshot.controller.owner,
    snapshot.marketplace.owner,
    snapshot.registrar.owner,
    snapshot.registry.rootOwner,
    snapshot.registry.reverseRootOwner,
  ].every((address) => same(address, snapshot.governance))
    && snapshot.controller.pendingOwner === null
    && snapshot.marketplace.pendingOwner === null
    && snapshot.registrar.pendingOwner === null;
  const treasuryParity = same(snapshot.controller.treasury, snapshot.governance) && same(snapshot.marketplace.treasury, snapshot.governance);
  const signerParity = same(snapshot.controller.permitSigner, manifest.permitIssuer.signerAddress)
    && snapshot.controller.signerPolicyVersion.toString() === manifest.permitIssuer.policyVersion
    && snapshot.controller.pendingPermitSigner === null
    && snapshot.controller.pendingPermitSignerValidAfter === 0n;
  const policyParity = snapshot.controller.registrationsPaused === manifest.activationEvidence.controllerPolicy.registrationsPaused
    && snapshot.controller.referralBps === manifest.activationEvidence.controllerPolicy.referralBps
    && snapshot.marketplace.paused === manifest.activationEvidence.marketplacePolicy.paused
    && snapshot.marketplace.feeBps === manifest.activationEvidence.marketplacePolicy.feeBps;
  const wiringParity = snapshot.registrar.canonicalControllerEnabled
    && same(snapshot.registry.baseNodeOwner, snapshot.registrar.address)
    && same(
      snapshot.registry.reverseNodeOwner,
      requireManifestAddress(snapshot.releaseId, "reverseRegistrar"),
    );
  const releaseParity = snapshot.controller.releaseId.toLowerCase() === snapshot.releaseId.toLowerCase();
  const parity = ownerParity && treasuryParity && signerParity && policyParity && wiringParity && releaseParity;
  const rows = [
    ["CONTROLLER BALANCE", formatUsdc(snapshot.controller.balance)],
    ["REFERRAL LIABILITY", formatUsdc(snapshot.controller.liability)],
    ["CONTROLLER SURPLUS", formatUsdc(snapshot.controller.surplus)],
    ["MARKET BALANCE", formatUsdc(snapshot.marketplace.balance)],
    ["SELLER LIABILITY", formatUsdc(snapshot.marketplace.liability)],
    ["MARKET SURPLUS", formatUsdc(snapshot.marketplace.surplus)],
    ["REFERRAL RATE", formatBps(snapshot.controller.referralBps)],
    ["MARKET FEE", formatBps(snapshot.marketplace.feeBps)],
  ] as const;

  return (
    <div className="admin-overview">
      <section className="admin-health-band" aria-label="Protocol health">
        <div data-state={statusClass(controllerSolvent && marketSolvent)}><span>ACCOUNTING</span><strong>{controllerSolvent && marketSolvent ? "SOLVENT" : "ACTION REQUIRED"}</strong></div>
        <div data-state={snapshot.controller.registrationsPaused ? "paused" : "ready"}><span>REGISTRATION</span><strong>{snapshot.controller.registrationsPaused ? "PAUSED" : "OPEN"}</strong></div>
        <div data-state={snapshot.marketplace.paused ? "paused" : "ready"}><span>MARKETPLACE</span><strong>{snapshot.marketplace.paused ? "PAUSED" : "OPEN"}</strong></div>
        <div data-state={parity ? "ready" : "warning"}><span>MANIFEST PARITY</span><strong>{parity ? "MATCH" : "DRIFT"}</strong></div>
        <div data-state={snapshot.productLive ? "ready" : "warning"}><span>PRODUCT LIVE</span><strong>{snapshot.productLive ? "TRUE" : "FALSE"}</strong></div>
      </section>

      <section className="admin-overview-section">
        <header><span>01 / FUNDS</span><h3>Balances and protected liabilities</h3></header>
        <div className="admin-metric-grid">
          {rows.map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}
        </div>
      </section>

      <section className="admin-overview-section">
        <header><span>02 / SIGNER</span><h3>Permit policy</h3></header>
        <dl className="admin-detail-grid">
          <div><dt>ACTIVE SIGNER</dt><dd>{snapshot.controller.permitSigner}</dd></div>
          <div><dt>PENDING SIGNER</dt><dd>{snapshot.controller.pendingPermitSigner ?? "None"}</dd></div>
          <div><dt>ACTIVATABLE AFTER</dt><dd>{snapshot.controller.pendingPermitSigner ? new Date(Number(snapshot.controller.pendingPermitSignerValidAfter) * 1000).toLocaleString() : "—"}</dd></div>
          <div><dt>POLICY VERSION</dt><dd>{snapshot.controller.signerPolicyVersion.toString()}</dd></div>
        </dl>
      </section>

      <section className="admin-overview-section">
        <header><span>03 / AUTHORITY</span><h3>Owners, treasuries, and wiring</h3></header>
        <dl className="admin-detail-grid">
          <div><dt>GOVERNANCE</dt><dd>{snapshot.governance}</dd></div>
          <div><dt>CONTROLLER OWNER</dt><dd>{snapshot.controller.owner}</dd></div>
          <div><dt>CONTROLLER PENDING</dt><dd>{snapshot.controller.pendingOwner ?? "None"}</dd></div>
          <div><dt>CONTROLLER TREASURY</dt><dd>{snapshot.controller.treasury}</dd></div>
          <div><dt>MARKET OWNER</dt><dd>{snapshot.marketplace.owner}</dd></div>
          <div><dt>MARKET PENDING</dt><dd>{snapshot.marketplace.pendingOwner ?? "None"}</dd></div>
          <div><dt>MARKET TREASURY</dt><dd>{snapshot.marketplace.treasury}</dd></div>
          <div><dt>REGISTRAR OWNER</dt><dd>{snapshot.registrar.owner}</dd></div>
          <div><dt>REGISTRAR PENDING</dt><dd>{snapshot.registrar.pendingOwner ?? "None"}</dd></div>
          <div><dt>RELEASE CONTROLLER</dt><dd>{snapshot.registrar.canonicalControllerEnabled ? "Enabled" : "Disabled"}</dd></div>
          <div><dt>REGISTRY ROOT OWNER</dt><dd>{snapshot.registry.rootOwner}</dd></div>
          <div><dt>BASE NODE OWNER</dt><dd>{snapshot.registry.baseNodeOwner}</dd></div>
          <div><dt>REVERSE ROOT OWNER</dt><dd>{snapshot.registry.reverseRootOwner}</dd></div>
          <div><dt>ADDR.REVERSE OWNER</dt><dd>{snapshot.registry.reverseNodeOwner}</dd></div>
        </dl>
      </section>

      <section className="admin-overview-section">
        <header><span>04 / RELEASE</span><h3>{snapshot.canonical ? "Canonical deployment" : "Retained V1 deployment"}</h3></header>
        <div className="admin-contract-list">
          {([
            ["Controller", snapshot.controller.address],
            ["Marketplace", snapshot.marketplace.address],
            ["Base registrar", snapshot.registrar.address],
            ["Registry", snapshot.registry.address],
          ] as const).map(([label, address]) => (
            <a key={label} href={explorerAddress(snapshot.releaseId, address)} target="_blank" rel="noreferrer"><span>{label}</span><code>{address}</code><b>↗</b></a>
          ))}
        </div>
        <dl className="admin-detail-grid admin-detail-grid--release">
          <div><dt>RELEASE ID</dt><dd>{snapshot.releaseId}</dd></div>
          <div><dt>AS OF BLOCK</dt><dd>{snapshot.blockNumber.toString()}</dd></div>
          <div><dt>CHAIN TIME</dt><dd>{new Date(Number(snapshot.blockTimestamp) * 1000).toLocaleString()}</dd></div>
          <div><dt>STATE</dt><dd>{manifest.state.toUpperCase()}</dd></div>
        </dl>
      </section>
    </div>
  );
}

function requireManifestAddress(releaseId: string, key: "reverseRegistrar") {
  const value =
    getAdminReleaseContext(releaseId).manifest.contracts[key].address;
  if (!value) throw new Error(`${key} is unavailable.`);
  return value;
}

function AdminActivity({
  releaseId,
  data,
  loading,
  progress,
  error,
  onRefresh,
  onLoadOlder,
}: {
  releaseId: Hex;
  data: AdminActivityData | null;
  loading: boolean;
  progress: string | null;
  error: string | null;
  onRefresh(): void;
  onLoadOlder(): void;
}) {
  const [category, setCategory] = useState<AdminActivityCategory | "all">("all");
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(50);
  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (data?.events ?? []).filter((event) => {
      if (!same(event.releaseId, releaseId)) return false;
      if (category !== "all" && event.category !== category) return false;
      if (!normalized) return true;
      return `${event.title} ${event.detail} ${event.contract} ${event.eventName} ${event.transactionHash}`.toLowerCase().includes(normalized);
    });
  }, [category, data?.events, query, releaseId]);

  return (
    <div className="admin-activity">
      <div className="admin-activity__toolbar">
        <label><span>SEARCH ACTIVITY</span><input value={query} onChange={(event) => { setQuery(event.target.value); setLimit(50); }} placeholder="Event, address, transaction…" /></label>
        <button className="admin-button" type="button" onClick={onRefresh} disabled={loading}>{loading ? "Scanning…" : data ? "Refresh recent" : "Load activity"}</button>
      </div>
      <div className="admin-activity__categories" role="group" aria-label="Activity category">
        {(Object.keys(categoryLabels) as Array<AdminActivityCategory | "all">).map((value) => (
          <button key={value} type="button" aria-pressed={category === value} onClick={() => { setCategory(value); setLimit(50); }}>{categoryLabels[value]}</button>
        ))}
      </div>
      {progress ? <p className="admin-activity__progress" role="status">{progress}</p> : null}
      {error ? <p className="admin-form-error" role="alert">{error}</p> : null}
      {data ? (
        <div className="admin-activity__meta"><span>{filtered.length} matching / {data.totalDecoded} decoded</span><span>Blocks {data.scannedFromBlock.toString()}–{data.scannedToBlock.toString()}</span>{data.eventLimitReached ? <span>At least one page reached the 1,000-event cap</span> : null}</div>
      ) : null}
      {!loading && data && filtered.length === 0 ? <div className="admin-empty"><span>NO EVENTS</span><h3>No administration events match this view.</h3></div> : null}
      <ol className="admin-event-list">
        {filtered.slice(0, limit).map((event, index) => (
          <li key={event.id}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <div><small>{event.category.toUpperCase()} / {event.contract.toUpperCase()} / {event.eventName}</small><h3>{event.title}</h3><p>{event.detail}</p></div>
            <div><code>BLOCK {event.blockNumber.toString()}</code><a href={explorerTransaction(event.releaseId, event.transactionHash)} target="_blank" rel="noreferrer">{shortAddress(event.transactionHash)} ↗</a></div>
          </li>
        ))}
      </ol>
      {filtered.length > limit ? <button className="admin-button admin-button--quiet admin-load-more" type="button" onClick={() => setLimit((value) => value + 50)}>Load more</button> : null}
      {data?.hasOlder ? <button className="admin-button admin-button--quiet admin-load-more" type="button" disabled={loading} onClick={onLoadOlder}>Load older 200,000 blocks</button> : null}
    </div>
  );
}

export function AdminWorkspace({
  initialTab,
  initialReleaseId,
}: AdminWorkspaceProps) {
  const router = useRouter();
  const wallet = useWalletSession();
  const [tab, setTab] = useState<AdminTab>(initialTab);
  const [releaseId, setReleaseId] = useState<Hex>(initialReleaseId);
  const [snapshot, setSnapshot] = useState<AdminSnapshot | null>(null);
  const [access, setAccess] = useState<AdminAccess | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activity, setActivity] = useState<AdminActivityData | null>(null);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityProgress, setActivityProgress] = useState<string | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const selectedReleaseIdRef = useRef<Hex>(initialReleaseId);
  const releases = useMemo(() => getReadableReleases(), []);
  const selectedRelease = useMemo(
    () => releases.find(
      (release) =>
        release.manifest.releaseId?.toLowerCase() === releaseId.toLowerCase(),
    ),
    [releaseId, releases],
  );
  const refreshSnapshot = useCallback(async () => {
    if (!wallet.account || !wallet.onArc) {
      setSnapshot(null);
      setAccess(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { provider, account } = await wallet.requireConnection();
      const next = await readAdminSnapshot(provider, account, releaseId);
      if (!same(next.releaseId, selectedReleaseIdRef.current)) return;
      setSnapshot(next);
      setAccess(resolveAdminAccess(account, next));
    } catch (readError) {
      setSnapshot(null);
      setAccess(null);
      setError(walletErrorMessage(readError, "Live admin state could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, [releaseId, wallet]);

  const refreshActivity = useCallback(async (loadOlder = false) => {
    if (!wallet.account || !wallet.onArc || !access?.authorized) return;
    const requestedToBlock = loadOlder && activity?.hasOlder
      ? activity.scannedFromBlock - 1n
      : undefined;
    setActivityLoading(true);
    setActivityError(null);
    setActivityProgress(loadOlder
      ? "Scanning the previous bounded 200,000-block activity page…"
      : "Scanning the latest bounded 200,000-block activity page…");
    try {
      const { provider, account } = await wallet.requireConnection();
      const data = await loadAdminActivity(provider, account, releaseId, (completed, latest) => {
        setActivityProgress(`Scanned through block ${completed.toString()} of ${latest.toString()}…`);
      }, requestedToBlock);
      setActivity((current) => {
        if (!same(data.releaseId, selectedReleaseIdRef.current)) return current;
        if (!loadOlder || !current) return data;
        if (!same(current.releaseId, data.releaseId)) return data;
        const events = [...current.events, ...data.events]
          .filter((event, index, items) => items.findIndex((item) => item.id === event.id) === index)
          .sort((left, right) => left.blockNumber === right.blockNumber
            ? right.logIndex - left.logIndex
            : left.blockNumber > right.blockNumber ? -1 : 1);
        return {
          releaseId: data.releaseId,
          events,
          scannedFromBlock: data.scannedFromBlock,
          scannedToBlock: current.scannedToBlock,
          totalDecoded: current.totalDecoded + data.totalDecoded,
          hasOlder: data.hasOlder,
          eventLimitReached: current.eventLimitReached || data.eventLimitReached,
        };
      });
      setActivityProgress(null);
    } catch (activityReadError) {
      setActivityError(walletErrorMessage(activityReadError, "Administration activity could not be loaded."));
      setActivityProgress(null);
    } finally {
      setActivityLoading(false);
    }
  }, [access?.authorized, activity, releaseId, wallet]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshSnapshot(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshSnapshot]);

  useEffect(() => {
    if (!snapshot || !access?.authorized) return;
    const timer = window.setInterval(() => void refreshSnapshot(), 30_000);
    return () => window.clearInterval(timer);
  }, [access?.authorized, refreshSnapshot, snapshot]);

  function updateTab(next: AdminTab) {
    if (!selectedRelease?.manifest.releaseId) {
      setError("The selected admin release is not trusted.");
      return;
    }
    setTab(next);
    const query = new URLSearchParams();
    if (next !== "overview") query.set("tab", next);
    if (!selectedRelease.canonical) query.set("release", releaseId);
    const serialized = query.toString();
    router.replace(serialized ? `/admin?${serialized}` : "/admin", { scroll: false });
  }

  function updateRelease(nextReleaseId: string) {
    const next = releases.find(
      (release) =>
        release.manifest.releaseId?.toLowerCase() ===
        nextReleaseId.toLowerCase(),
    );
    if (!next?.manifest.releaseId) {
      setError("The requested admin release is not trusted.");
      return;
    }
    selectedReleaseIdRef.current = next.manifest.releaseId;
    setReleaseId(next.manifest.releaseId);
    setSnapshot(null);
    setAccess(null);
    setActivity(null);
    setActivityError(null);
    setActivityProgress(null);
    setError(null);
    const query = new URLSearchParams();
    if (tab !== "overview") query.set("tab", tab);
    if (!next.canonical) query.set("release", next.manifest.releaseId);
    const serialized = query.toString();
    router.replace(serialized ? `/admin?${serialized}` : "/admin", { scroll: false });
  }

  const acceptUpdatedSnapshot = useCallback((next: AdminSnapshot) => {
    if (
      !adminSnapshotMatchesSelectedRelease(
        next,
        selectedReleaseIdRef.current,
      )
    ) {
      return;
    }
    setSnapshot(next);
    if (wallet.account) setAccess(resolveAdminAccess(wallet.account, next));
  }, [wallet.account]);

  const markActivityStale = useCallback(() => {
    setActivity(null);
  }, []);

  return (
    <>
      <section className="admin-hero-surface">
        <div className="admin-hero content-shell">
          <span>CONTOUR / ADMINISTRATION</span>
          <h1>Protocol<br />operations.</h1>
          <p>Live contract authority, recorded activity, and owner-signed Arc Testnet controls.</p>
        </div>
      </section>

      <section className="admin-authority-surface" aria-labelledby="admin-authority-heading">
        <div className="admin-authority-heading content-shell">
          <span>OWNER WORKSPACE</span>
          <h2 id="admin-authority-heading">On-chain administration</h2>
          <button className="admin-button admin-button--quiet" type="button" onClick={() => void refreshSnapshot()} disabled={loading || !wallet.account || !wallet.onArc}>Refresh state</button>
        </div>
        {!wallet.account ? <AdminGate state="connect" /> : null}
        {wallet.account && !wallet.onArc ? <AdminGate state="network" account={wallet.account} /> : null}
        {wallet.account && wallet.onArc && loading && !snapshot ? <AdminGate state="loading" account={wallet.account} /> : null}
        {wallet.account && wallet.onArc && error ? <AdminGate state="error" account={wallet.account} message={error} /> : null}
        {wallet.account && wallet.onArc && snapshot && access && !access.authorized ? <AdminGate state="denied" account={wallet.account} /> : null}
        {wallet.account && wallet.onArc && snapshot && access?.authorized ? (
          <div className="admin-workspace content-shell max-w-7xl">
            <section className="admin-release-switcher" aria-labelledby="admin-release-switcher-title">
              <div>
                <span>SELECTED CONTRACT SUITE</span>
                <strong id="admin-release-switcher-title">
                  {snapshot.canonical ? "Canonical release" : "Retained user-value release"}
                </strong>
              </div>
              <div role="group" aria-label="Admin contract release">
                {releases.flatMap((release) => {
                  const optionReleaseId = release.manifest.releaseId;
                  if (!optionReleaseId) return [];
                  const selected = same(optionReleaseId, releaseId);
                  const version = registrarVersionOf(release.manifest).toUpperCase();
                  return [(
                    <button
                      key={optionReleaseId}
                      type="button"
                      aria-pressed={selected}
                      onClick={() => updateRelease(optionReleaseId)}
                    >
                      <span>{release.canonical ? "CANONICAL" : "RETAINED"}</span>
                      <strong>{version}</strong>
                      <code>{shortAddress(optionReleaseId)}</code>
                    </button>
                  )];
                })}
              </div>
            </section>
            <div className="admin-access-rail content-shell">
              <div className="admin-access-rail__heading">
                <span>AUTHORIZED WALLET</span>
                <small>ARC TESTNET / VERIFIED</small>
              </div>
              <code>{wallet.account}</code>
              <div className="admin-access-rail__meta">
                <div>
                  <span>ON-CHAIN ROLES</span>
                  <strong>{access.roles.map((role) => role.replaceAll("-", " ")).join(" / ")}</strong>
                </div>
                <div>
                  <span>STATE SNAPSHOT</span>
                  <strong>Block {snapshot.blockNumber.toString()}</strong>
                </div>
              </div>
            </div>
            <nav className="admin-tabs content-shell" aria-label="Admin workspace" role="tablist">
              {ADMIN_TABS.map((item, index) => (
                <button
                  key={item}
                  id={`admin-tab-${item}`}
                  role="tab"
                  tabIndex={tab === item ? 0 : -1}
                  aria-selected={tab === item}
                  aria-controls="admin-tabpanel"
                  onClick={() => updateTab(item)}
                  onKeyDown={(event) => {
                    let nextIndex: number | null = null;
                    if (event.key === "ArrowRight") nextIndex = (index + 1) % ADMIN_TABS.length;
                    if (event.key === "ArrowLeft") nextIndex = (index - 1 + ADMIN_TABS.length) % ADMIN_TABS.length;
                    if (event.key === "Home") nextIndex = 0;
                    if (event.key === "End") nextIndex = ADMIN_TABS.length - 1;
                    if (nextIndex === null) return;
                    event.preventDefault();
                    const next = ADMIN_TABS[nextIndex];
                    if (!next) return;
                    updateTab(next);
                    event.currentTarget.parentElement
                      ?.querySelectorAll<HTMLButtonElement>("[role='tab']")[nextIndex]
                      ?.focus();
                  }}
                ><span>0{index + 1}</span>{item}</button>
              ))}
            </nav>
            <div className="admin-tab-panel" id="admin-tabpanel" role="tabpanel" aria-labelledby={`admin-tab-${tab}`}>
              {tab === "overview" ? <AdminOverview snapshot={snapshot} /> : null}
              {tab === "activity" ? <AdminActivity key={releaseId} releaseId={releaseId} data={activity} loading={activityLoading} progress={activityProgress} error={activityError} onRefresh={() => void refreshActivity(false)} onLoadOlder={() => void refreshActivity(true)} /> : null}
              {tab === "controls" ? <AdminControls key={snapshot.releaseId} snapshot={snapshot} access={access} onUpdated={acceptUpdatedSnapshot} onActivityStale={markActivityStale} /> : null}
            </div>
          </div>
        ) : null}
      </section>
    </>
  );
}
