"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import {
  assertAdminDeployment,
  adminPostStateMatches,
  buildAdminPlan,
  formatBps,
  formatUsdc,
  getAdminReleaseContext,
  parseAdminAddress,
  parseAdminPostStateExpectation,
  parsePercentToBps,
  parseUsdcAmount,
  readAdminSnapshot,
  resolveAdminAccess,
  shortAddress,
  verifyAdminTransaction,
  type AdminAccess,
  type AdminContractTarget,
  type AdminPostStateExpectation,
  type AdminSnapshot,
  type AdminTransactionPlan,
} from "@/lib/admin-protocol";
import {
  assertArcWalletAccount,
  sendWalletPlan,
  simulateWalletPlan,
  WalletTransactionRevertedError,
  walletErrorMessage,
  walletReadRequest,
} from "@/lib/wallet-protocol";
import { useWalletSession } from "@/lib/use-wallet-session";
import {
  AdminActionDialog,
  type AdminAction,
  type AdminActionProgress,
  type AdminActionStep,
} from "./admin-action-dialog";

const PENDING_ADMIN_KEY = "contour.pending-admin-action.v2";
const LEGACY_PENDING_ADMIN_KEY = "contour.pending-admin-action.v1";

const idleProgress: AdminActionProgress = {
  phase: "idle",
  step: 0,
  total: 0,
  hash: null,
  error: null,
};

type PendingAdminTransaction = {
  version: 2;
  account: Address;
  hash: Hex;
  plan: AdminTransactionPlan;
  expectation: AdminPostStateExpectation;
};

function savePending(value: PendingAdminTransaction) {
  try {
    sessionStorage.setItem(PENDING_ADMIN_KEY, JSON.stringify({
      ...value,
      plan: {
        ...value.plan,
        value: value.plan.value.toString(),
      },
    }));
  } catch {
    // Receipt verification still runs in the active page when storage is unavailable.
  }
}

function clearPending() {
  try {
    sessionStorage.removeItem(PENDING_ADMIN_KEY);
    sessionStorage.removeItem(LEGACY_PENDING_ADMIN_KEY);
  } catch {
    // Nothing else is required after an already verified receipt.
  }
}

function readPending(): PendingAdminTransaction | null {
  try {
    const raw = sessionStorage.getItem(PENDING_ADMIN_KEY);
    if (!raw) {
      sessionStorage.removeItem(LEGACY_PENDING_ADMIN_KEY);
      return null;
    }
    const value = JSON.parse(raw) as {
      version?: unknown;
      account?: unknown;
      hash?: unknown;
      expectation?: unknown;
      plan?: {
        releaseId?: unknown;
        target?: unknown;
        to?: unknown;
        data?: unknown;
        value?: unknown;
        description?: unknown;
      };
    };
    const expectation = parseAdminPostStateExpectation(value.expectation);
    if (
      value.version !== 2 ||
      typeof value.account !== "string" || !isAddress(value.account) ||
      typeof value.hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(value.hash) ||
      !value.plan ||
      typeof value.plan.releaseId !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.plan.releaseId) ||
      typeof value.plan.target !== "string" ||
      !["controller", "marketplace", "registrar"].includes(value.plan.target) ||
      typeof value.plan.to !== "string" || !isAddress(value.plan.to) ||
      typeof value.plan.data !== "string" || !isHex(value.plan.data) ||
      value.plan.value !== "0" ||
      !expectation
    ) {
      clearPending();
      return null;
    }
    const releaseId = value.plan.releaseId as Hex;
    getAdminReleaseContext(releaseId);
    return {
      version: 2,
      account: getAddress(value.account),
      hash: value.hash as Hex,
      plan: {
        releaseId,
        target: value.plan.target as AdminContractTarget,
        to: getAddress(value.plan.to),
        data: value.plan.data,
        value: 0n,
        description: String(value.plan.description ?? "Recovered admin transaction"),
      },
      expectation,
    };
  } catch {
    clearPending();
    return null;
  }
}

function same(left: string | null | undefined, right: string | null | undefined) {
  return Boolean(left && right && left.toLowerCase() === right.toLowerCase());
}

export function adminSnapshotMatchesSelectedRelease(
  snapshot: Pick<AdminSnapshot, "releaseId">,
  selectedReleaseId: string,
) {
  return same(snapshot.releaseId, selectedReleaseId);
}

function ownerAuthorization(target: AdminContractTarget) {
  return (access: AdminAccess) => target === "controller"
    ? access.isControllerOwner
    : target === "marketplace"
      ? access.isMarketplaceOwner
      : access.isRegistrarOwner;
}

function ownerStep(
  plan: AdminTransactionPlan,
  options: Omit<AdminActionStep, "plan" | "isAuthorized">,
): AdminActionStep {
  return { plan, isAuthorized: ownerAuthorization(plan.target), ...options };
}

function contractState(snapshot: AdminSnapshot, target: AdminContractTarget) {
  return target === "controller"
    ? snapshot.controller
    : target === "marketplace"
      ? snapshot.marketplace
      : snapshot.registrar;
}

function treasuryState(snapshot: AdminSnapshot, target: "controller" | "marketplace") {
  return target === "controller" ? snapshot.controller : snapshot.marketplace;
}

async function confirmPendingAdminTransaction(
  provider: EthereumProvider,
  account: Address,
  pending: PendingAdminTransaction,
): Promise<AdminSnapshot> {
  await assertAdminDeployment(
    provider,
    account,
    pending.plan.releaseId,
    [pending.plan],
  );
  await verifyAdminTransaction(provider, pending.hash, account, pending.plan);
  const fresh = await readAdminSnapshot(
    provider,
    account,
    pending.plan.releaseId,
  );
  if (fresh.releaseId.toLowerCase() !== fresh.controller.releaseId.toLowerCase()) {
    throw new Error("The confirmed transaction belongs to a controller with an unexpected release ID.");
  }
  if (!adminPostStateMatches(fresh, pending.expectation)) {
    throw new Error("The confirmed transaction did not produce the reviewed post-state. Keep the recovery record and inspect the contract before any new write.");
  }
  return fresh;
}

export async function assertIssuerPreparedForOpening(snapshot: AdminSnapshot): Promise<void> {
  if (!snapshot.canonical) {
    throw new Error(
      "Retained V1 registration is permanently closed after the V2 cutover.",
    );
  }
  const manifest = getAdminReleaseContext(snapshot.releaseId).manifest;
  let response: Response;
  try {
    response = await fetch("/api/registration/issuer/healthz", { cache: "no-store" });
  } catch (error) {
    throw new Error("The permit issuer health endpoint could not be reached.", { cause: error });
  }
  const body = await response.json().catch(() => null) as Record<string, unknown> | null;
  const signer = snapshot.controller.permitSigner;
  const policyVersion = snapshot.controller.signerPolicyVersion.toString();
  if (
    !body ||
    body.chainId !== manifest.chain.id ||
    typeof body.controller !== "string" || !same(body.controller, snapshot.controller.address) ||
    typeof body.releaseId !== "string" || body.releaseId.toLowerCase() !== snapshot.releaseId.toLowerCase() ||
    body.signerReady !== true ||
    typeof body.signerAddress !== "string" || !same(body.signerAddress, signer) ||
    typeof body.configuredSignerAddress !== "string" || !same(body.configuredSignerAddress, signer) ||
    typeof body.localSignerAddress !== "string" || !same(body.localSignerAddress, signer) ||
    body.policyVersion !== policyVersion ||
    body.onchainPolicyVersion !== policyVersion ||
    body.registrationsPaused !== snapshot.controller.registrationsPaused ||
    body.registrarControllerEnabled !== snapshot.registrar.canonicalControllerEnabled
  ) {
    throw new Error("Registration cannot open until the local issuer health, signer, policy version, and live controller state all match.");
  }
}

export function registrationOpeningValidationError(state: AdminSnapshot): string | null {
  if (!state.canonical) {
    return "Retained V1 registration cannot be reopened after the V2 cutover.";
  }
  const manifest = getAdminReleaseContext(state.releaseId).manifest;
  // productLive is release evidence, not an executable safety control. Reopening
  // is gated by the live signer, policy, issuer health, and registrar wiring.
  if (state.controller.permitSigner === "0x0000000000000000000000000000000000000000") return "Registration cannot open without an active permit signer.";
  if (state.controller.pendingPermitSigner) return "Finish or revoke the pending signer rotation before opening registration.";
  if (!same(state.controller.permitSigner, manifest.permitIssuer.signerAddress)) return "The active signer does not match the canonical issuer manifest.";
  if (state.controller.signerPolicyVersion.toString() !== manifest.permitIssuer.policyVersion) return "The on-chain signer policy version does not match the canonical issuer manifest.";
  if (!state.registrar.canonicalControllerEnabled) return "Registration cannot open until the canonical registrar controller is enabled.";
  return null;
}

export function marketplaceOpeningValidationError(
  state: AdminSnapshot,
): string | null {
  if (!state.canonical) return null;
  return state.controller.registrationsPaused
    ? "Open registration and verify its readiness before reopening the marketplace."
    : null;
}

export function registrarControllerAction(snapshot: AdminSnapshot): AdminAction {
  const enabled = !snapshot.registrar.canonicalControllerEnabled;
  const steps: AdminActionStep[] = [];
  if (!enabled) {
    steps.push(ownerStep(
      buildAdminPlan(
        snapshot.releaseId,
        "controller",
        "setRegistrationsPaused",
        [true],
        "Pause registration before disabling the registrar controller",
      ),
      {
        expectation: { kind: "registration-pause", paused: true },
        isSatisfied: (state) => state.controller.registrationsPaused,
        verify: (state) => state.controller.registrationsPaused,
      },
    ));
  }
  steps.push(ownerStep(
    buildAdminPlan(
      snapshot.releaseId,
      "registrar",
      "setController",
      [snapshot.controller.address, enabled],
      `${enabled ? "Enable" : "Disable"} release controller`,
    ),
    {
      expectation: { kind: "registrar-controller", enabled },
      isSatisfied: (state) => state.registrar.canonicalControllerEnabled === enabled,
      verify: (state) => state.registrar.canonicalControllerEnabled === enabled,
    },
  ));

  return {
    id: "registrar-controller",
    releaseId: snapshot.releaseId,
    title: `${enabled ? "Enable" : "Disable"} registrar controller`,
    description: enabled
      ? "Restores this release controller's ability to register and renew names. Registration remains paused until its separate issuer-gated opening action succeeds."
      : "Pauses new registration first, then disables both registration and renewal at the registrar.",
    confirmLabel: enabled ? "Enable controller" : "Pause and disable",
    danger: !enabled,
    confirmationText: enabled ? "ENABLE CONTROLLER" : "PAUSE AND DISABLE",
    details: [
      { label: "CONTROLLER", value: snapshot.controller.address },
      { label: "NEW STATE", value: enabled ? "Authorized" : "Registration paused / controller disabled" },
    ],
    steps,
    finalVerify: enabled
      ? (state) => state.registrar.canonicalControllerEnabled
      : (state) => state.controller.registrationsPaused && !state.registrar.canonicalControllerEnabled,
    finalVerificationError: "The registrar controller action did not reach its reviewed fail-safe state.",
    successMessage: enabled
      ? "Registrar controller enabled. Registration remains under its separate pause and issuer readiness gate."
      : "Registration is paused and the registrar controller is disabled.",
  };
}

type AdminControlsProps = {
  snapshot: AdminSnapshot;
  access: AdminAccess;
  onUpdated(snapshot: AdminSnapshot): void;
  onActivityStale(): void;
};

export function AdminControls({
  snapshot,
  access,
  onUpdated,
  onActivityStale,
}: AdminControlsProps) {
  const wallet = useWalletSession();
  const walletRef = useRef(wallet);
  walletRef.current = wallet;
  const [action, setAction] = useState<AdminAction | null>(null);
  const [progress, setProgress] = useState<AdminActionProgress>(idleProgress);
  const [formError, setFormError] = useState<string | null>(null);
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const [hasPending, setHasPending] = useState(false);
  const pendingRef = useRef<PendingAdminTransaction | null>(null);
  const mountedRef = useRef(true);
  const recoveryRunRef = useRef(0);
  const [referralPercent, setReferralPercent] = useState("");
  const [marketFeePercent, setMarketFeePercent] = useState("");
  const [treasuryAddress, setTreasuryAddress] = useState("");
  const [treasuryTarget, setTreasuryTarget] = useState<"controller" | "marketplace" | "both">("both");
  const [controllerWithdrawal, setControllerWithdrawal] = useState("");
  const [marketWithdrawal, setMarketWithdrawal] = useState("");
  const [signerAddress, setSignerAddress] = useState("");
  const [ownershipAddress, setOwnershipAddress] = useState("");
  const [ownershipTarget, setOwnershipTarget] = useState<AdminContractTarget | "suite">("suite");
  const manifest = getAdminReleaseContext(snapshot.releaseId).manifest;
  const retainedRelease = !snapshot.canonical;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      recoveryRunRef.current += 1;
    };
  }, []);

  const recoverPending = useCallback(async (candidate?: PendingAdminTransaction) => {
    const recoveryRun = recoveryRunRef.current + 1;
    recoveryRunRef.current = recoveryRun;
    const recoveryReleaseId = snapshot.releaseId;
    const isCurrentRecovery = () =>
      mountedRef.current
      && recoveryRunRef.current === recoveryRun
      && same(recoveryReleaseId, snapshot.releaseId);
    const pending = candidate ?? pendingRef.current ?? readPending();
    if (!pending) {
      if (isCurrentRecovery()) setHasPending(false);
      return null;
    }
    if (!isCurrentRecovery()) return null;
    pendingRef.current = pending;
    setHasPending(true);
    if (!same(pending.plan.releaseId, snapshot.releaseId)) {
      throw new Error(
        `Switch to release ${pending.plan.releaseId} to verify its pending admin transaction.`,
      );
    }
    try {
      setRecoveryMessage(`Verifying submitted transaction ${pending.hash.slice(0, 10)}… No new transaction will be sent.`);
      if (!walletRef.current.onArc) await walletRef.current.switchToArc();
      if (!isCurrentRecovery()) return null;
      const { provider, account } = await walletRef.current.requireConnection();
      if (!isCurrentRecovery()) return null;
      await assertArcWalletAccount(provider, account);
      if (!isCurrentRecovery()) return null;
      if (!same(account, pending.account)) {
        throw new Error(`Reconnect the submitting wallet ${pending.account} before recovering this transaction.`);
      }
      const fresh = await confirmPendingAdminTransaction(provider, account, pending);
      if (
        !isCurrentRecovery()
        || !adminSnapshotMatchesSelectedRelease(fresh, recoveryReleaseId)
      ) {
        return null;
      }
      clearPending();
      pendingRef.current = null;
      setHasPending(false);
      onUpdated(fresh);
      onActivityStale();
      setRecoveryMessage("The submitted transaction, exact calldata, receipt, and expected post-state were verified. Re-review any remaining multi-step action.");
      return fresh;
    } catch (error) {
      if (!isCurrentRecovery()) return null;
      if (error instanceof WalletTransactionRevertedError) {
        clearPending();
        pendingRef.current = null;
        setHasPending(false);
        onActivityStale();
        setRecoveryMessage("The submitted transaction reverted and its terminal recovery record was cleared. Refresh live state before reviewing another write.");
      }
      throw error;
    }
  }, [onActivityStale, onUpdated, snapshot.releaseId]);

  const review = useCallback((factory: () => AdminAction) => {
    try {
      const unresolved = pendingRef.current ?? readPending();
      if (unresolved) {
        pendingRef.current = unresolved;
        setHasPending(true);
        throw new Error("A submitted admin transaction still needs receipt and post-state verification. Recover it before reviewing another write.");
      }
      setFormError(null);
      setProgress(idleProgress);
      setAction(factory());
    } catch (error) {
      setFormError(error instanceof Error ? error.message : "The admin input is invalid.");
    }
  }, []);

  const closeAction = useCallback(() => {
    if (!["idle", "success", "error"].includes(progress.phase)) return;
    setAction(null);
    setProgress(idleProgress);
  }, [progress.phase]);

  const executeAction = useCallback(async () => {
    if (!action) return;
    if (
      !same(action.releaseId, snapshot.releaseId) ||
      action.steps.some((step) => !same(step.plan.releaseId, action.releaseId))
    ) {
      setProgress({
        phase: "error",
        step: 0,
        total: action.steps.length,
        hash: null,
        error: "The reviewed admin action does not belong to the selected release.",
      });
      return;
    }
    const unresolved = pendingRef.current ?? readPending();
    if (unresolved) {
      setProgress({ phase: "confirming", step: 0, total: 1, hash: unresolved.hash, error: null });
      try {
        const recovered = await recoverPending(unresolved);
        if (!recovered) return;
        setProgress({ phase: "success", step: 1, total: 1, hash: unresolved.hash, error: null });
      } catch (error) {
        setProgress({
          phase: "error",
          step: 0,
          total: 1,
          hash: unresolved.hash,
          error: walletErrorMessage(error, "Pending admin verification could not finish."),
        });
      }
      return;
    }
    setProgress({ phase: "checking", step: 0, total: action.steps.length, hash: null, error: null });
    try {
      const connection = await wallet.requireConnection();
      if (!wallet.onArc) await wallet.switchToArc();
      const { provider, account } = connection;
      await assertArcWalletAccount(provider, account);
      let fresh = await readAdminSnapshot(
        provider,
        account,
        action.releaseId,
      );
      if (fresh.releaseId.toLowerCase() !== fresh.controller.releaseId.toLowerCase()) {
        throw new Error("The controller release ID does not match the selected trusted release.");
      }
      let freshAccess = resolveAdminAccess(account, fresh);
      if (!freshAccess.authorized) throw new Error("The connected wallet is no longer an authorized administrator.");
      await assertAdminDeployment(
        provider,
        account,
        action.releaseId,
        action.steps.map((step) => step.plan),
      );
      await action.preflight?.(provider, fresh);

      for (let index = 0; index < action.steps.length; index += 1) {
        const step = action.steps[index];
        if (!step) throw new Error("The reviewed admin step is missing.");
        setProgress({ phase: "checking", step: index, total: action.steps.length, hash: null, error: null });
        if (step.isSatisfied?.(fresh)) continue;
        if (step.isAuthorized && !step.isAuthorized(freshAccess)) {
          throw new Error(`The connected wallet is not the live ${step.plan.target} owner.`);
        }
        const validationError = step.validate?.(fresh);
        if (validationError) throw new Error(validationError);
        await simulateWalletPlan(provider, account, step.plan);
        await assertArcWalletAccount(provider, account);
        fresh = await readAdminSnapshot(
          provider,
          account,
          action.releaseId,
        );
        freshAccess = resolveAdminAccess(account, fresh);
        if (step.isSatisfied?.(fresh)) continue;
        if (step.isAuthorized && !step.isAuthorized(freshAccess)) {
          throw new Error(`The connected wallet is no longer the live ${step.plan.target} owner.`);
        }
        const postSimulationValidationError = step.validate?.(fresh);
        if (postSimulationValidationError) throw new Error(postSimulationValidationError);
        await action.preflight?.(provider, fresh);
        setProgress({ phase: "wallet", step: index, total: action.steps.length, hash: null, error: null });
        const hash = await sendWalletPlan(provider, account, step.plan);
        const pending: PendingAdminTransaction = {
          version: 2,
          account,
          hash,
          plan: step.plan,
          expectation: step.expectation,
        };
        pendingRef.current = pending;
        setHasPending(true);
        savePending(pending);
        setProgress({ phase: "confirming", step: index, total: action.steps.length, hash, error: null });
        fresh = await confirmPendingAdminTransaction(provider, account, pending);
        setProgress({ phase: "verifying", step: index, total: action.steps.length, hash, error: null });
        freshAccess = resolveAdminAccess(account, fresh);
        if (step.verify && !step.verify(fresh)) {
          throw new Error(step.verificationError ?? "The confirmed admin post-state did not match the reviewed action.");
        }
        clearPending();
        pendingRef.current = null;
        setHasPending(false);
      }

      if (action.finalVerify && !action.finalVerify(fresh)) {
        throw new Error(action.finalVerificationError ?? "The final admin state did not satisfy the reviewed action.");
      }
      onUpdated(fresh);
      onActivityStale();
      setProgress({ phase: "success", step: action.steps.length, total: action.steps.length, hash: null, error: null });
      setRecoveryMessage(action.successMessage);
    } catch (error) {
      if (error instanceof WalletTransactionRevertedError) {
        clearPending();
        pendingRef.current = null;
        setHasPending(false);
        onActivityStale();
      }
      setProgress((current) => ({
        ...current,
        phase: "error",
        error: walletErrorMessage(error, "The admin operation stopped."),
      }));
    }
  }, [
    action,
    onActivityStale,
    onUpdated,
    recoverPending,
    snapshot.releaseId,
    wallet,
  ]);

  useEffect(() => {
    if (!wallet.account || !wallet.onArc) return;
    const pending = readPending();
    if (!pending) return;
    pendingRef.current = pending;
    let cancelled = false;
    void recoverPending(pending).catch((error) => {
      if (!cancelled) setRecoveryMessage(walletErrorMessage(error, "Pending admin verification could not finish."));
    });
    return () => {
      cancelled = true;
      recoveryRunRef.current += 1;
    };
  }, [recoverPending, wallet.account, wallet.onArc]);

  const roleSummary = useMemo(() => access.roles.map((role) => role.replaceAll("-", " ")).join(" / "), [access.roles]);
  const controllerOwner = access.isControllerOwner;
  const marketOwner = access.isMarketplaceOwner;
  const registrarOwner = access.isRegistrarOwner;
  const signerActivationReady = Boolean(
    snapshot.controller.pendingPermitSigner &&
    snapshot.blockTimestamp >= snapshot.controller.pendingPermitSignerValidAfter,
  );

  function registrationAction(paused: boolean): AdminAction {
    if (!paused && retainedRelease) {
      throw new Error(
        "Retained V1 registration cannot be reopened after the V2 cutover.",
      );
    }
    return {
      id: paused ? "pause-registration" : "open-registration",
      releaseId: snapshot.releaseId,
      title: paused ? "Pause new registrations" : "Open new registrations",
      description: paused
        ? "New registrations stop immediately; renewals and referral claims remain available."
        : "Registration execution reopens against the currently active permit signer and canonical registrar controller.",
      confirmLabel: paused ? "Pause registration" : "Open registration",
      danger: paused,
      ...(paused ? {} : { confirmationText: "OPEN REGISTRATION" }),
      details: [
        { label: "CURRENT", value: snapshot.controller.registrationsPaused ? "Paused" : "Open" },
        { label: "NEW", value: paused ? "Paused" : "Open" },
        { label: "CONTROLLER", value: shortAddress(snapshot.controller.address) },
      ],
      ...(!paused ? {
        preflight: async (provider: EthereumProvider, state: AdminSnapshot) => {
          void provider;
          await assertIssuerPreparedForOpening(state);
        },
      } : {}),
      steps: [ownerStep(
        buildAdminPlan(snapshot.releaseId, "controller", "setRegistrationsPaused", [paused], paused ? "Pause registrations" : "Open registrations"),
        {
          expectation: { kind: "registration-pause", paused },
          isSatisfied: (state) => state.controller.registrationsPaused === paused,
          validate: (state) => paused ? null : registrationOpeningValidationError(state),
          verify: (state) => state.controller.registrationsPaused === paused,
        },
      )],
      successMessage: paused ? "New registrations are paused." : "New registrations are open.",
    };
  }

  function marketPauseAction(paused: boolean): AdminAction {
    return {
      id: paused ? "pause-market" : "open-market",
      releaseId: snapshot.releaseId,
      title: paused ? "Pause marketplace execution" : "Open marketplace execution",
      description: paused
        ? "New listings and purchases stop; cancellation, invalidation, and seller claims remain available."
        : retainedRelease
          ? "New listings and purchases reopen for retained V1 names while registration remains permanently closed."
          : "New listings and purchases reopen. Registration must already be operational.",
      confirmLabel: paused ? "Pause marketplace" : "Open marketplace",
      danger: paused,
      ...(paused ? {} : { confirmationText: "OPEN MARKET" }),
      details: [
        { label: "CURRENT", value: snapshot.marketplace.paused ? "Paused" : "Open" },
        { label: "NEW", value: paused ? "Paused" : "Open" },
        { label: "MARKETPLACE", value: shortAddress(snapshot.marketplace.address) },
      ],
      steps: [ownerStep(
        buildAdminPlan(snapshot.releaseId, "marketplace", "setPaused", [paused], paused ? "Pause marketplace" : "Open marketplace"),
        {
          expectation: { kind: "marketplace-pause", paused },
          isSatisfied: (state) => state.marketplace.paused === paused,
          validate: (state) =>
            paused ? null : marketplaceOpeningValidationError(state),
          verify: (state) => state.marketplace.paused === paused,
        },
      )],
      successMessage: paused ? "Marketplace execution is paused." : "Marketplace execution is open.",
    };
  }

  function pauseAllAction(): AdminAction {
    if (snapshot.marketplace.paused && snapshot.controller.registrationsPaused) {
      throw new Error("Registration and marketplace are already paused.");
    }
    const steps: AdminActionStep[] = [
      ownerStep(
        buildAdminPlan(snapshot.releaseId, "marketplace", "setPaused", [true], "Pause marketplace"),
        {
          expectation: { kind: "marketplace-pause", paused: true },
          isSatisfied: (state) => state.marketplace.paused,
          verify: (state) => state.marketplace.paused,
        },
      ),
      ownerStep(
        buildAdminPlan(snapshot.releaseId, "controller", "setRegistrationsPaused", [true], "Pause registrations"),
        {
          expectation: { kind: "registration-pause", paused: true },
          isSatisfied: (state) => state.controller.registrationsPaused,
          verify: (state) => state.controller.registrationsPaused,
        },
      ),
    ];
    return {
      id: "pause-all",
      releaseId: snapshot.releaseId,
      title: "Pause all new risk paths",
      description: "Marketplace execution is paused first, then new registration. Existing claims, cancellation, and renewal escape paths stay available.",
      confirmLabel: "Pause all",
      danger: true,
      confirmationText: "PAUSE ALL",
      details: [
        { label: "ORDER", value: "Marketplace → Registration" },
        { label: "ESCAPE PATHS", value: "Claims / cancellation / renewal remain open" },
      ],
      steps,
      finalVerify: (state) => state.marketplace.paused && state.controller.registrationsPaused,
      finalVerificationError: "The emergency action did not leave both marketplace and registration paused.",
      successMessage: "Marketplace and new registration paths are paused.",
    };
  }

  function treasuryTargets() {
    return treasuryTarget === "both" ? ["controller", "marketplace"] as const : [treasuryTarget] as const;
  }

  function ownershipTargets() {
    return ownershipTarget === "suite"
      ? ["controller", "marketplace", "registrar"] as const
      : [ownershipTarget] as const;
  }

  return (
    <div className="admin-controls">
      <div className="admin-permission-strip">
        <span>CONNECTED AUTHORITY</span>
        <strong>{roleSummary || "READ ONLY"}</strong>
        <p>Every write is simulated, signed by the connected wallet, receipt-checked, and followed by a fresh state read. The site never receives an admin private key.</p>
      </div>
      {retainedRelease ? (
        <div className="admin-retained-release-note" role="note">
          <strong>RETAINED V1 SAFETY BOUNDARY</strong>
          <span>
            New registration cannot be reopened. Marketplace recovery,
            cancellation, claims, treasury, ownership, and emergency controls
            remain available for existing V1 user value.
          </span>
        </div>
      ) : null}

      {formError ? <p className="admin-form-error" role="alert">{formError}</p> : null}
      {recoveryMessage ? (
        <div className="admin-recovery-message" role="status">
          <span>{recoveryMessage}</span>
          {hasPending ? (
            <button type="button" className="admin-inline-link" onClick={() => {
              void recoverPending().catch((error) => {
                setRecoveryMessage(walletErrorMessage(error, "Pending admin verification could not finish."));
              });
            }}>
              Retry pending verification
            </button>
          ) : null}
        </div>
      ) : null}

      <section className="admin-control-section" aria-labelledby="admin-emergency-heading">
        <header><span>01 / EMERGENCY</span><h2 id="admin-emergency-heading">Execution switches</h2><p>Stop new risk paths without blocking user escape paths.</p></header>
        <div className="admin-switch-grid">
          <article>
            <span>REGISTRATION</span>
            <strong data-state={snapshot.controller.registrationsPaused ? "paused" : "live"}>{snapshot.controller.registrationsPaused ? "PAUSED" : "OPEN"}</strong>
            <p>{retainedRelease ? "V1 registration stays closed; renewal and referral claims remain available." : "Renewal and referral claims remain available during a pause."}</p>
            <button className={snapshot.controller.registrationsPaused ? "admin-button" : "admin-button admin-button--danger"} type="button" disabled={!controllerOwner || (retainedRelease && snapshot.controller.registrationsPaused)} onClick={() => review(() => registrationAction(!snapshot.controller.registrationsPaused))}>
              {snapshot.controller.registrationsPaused
                ? retainedRelease ? "Permanently closed" : "Review opening"
                : "Pause now"}
            </button>
          </article>
          <article>
            <span>MARKETPLACE</span>
            <strong data-state={snapshot.marketplace.paused ? "paused" : "live"}>{snapshot.marketplace.paused ? "PAUSED" : "OPEN"}</strong>
            <p>Cancellation, stale cleanup, and proceeds claims remain available.</p>
            <button className={snapshot.marketplace.paused ? "admin-button" : "admin-button admin-button--danger"} type="button" disabled={!marketOwner} onClick={() => review(() => marketPauseAction(!snapshot.marketplace.paused))}>
              {snapshot.marketplace.paused ? "Review opening" : "Pause now"}
            </button>
          </article>
          <article className="admin-switch-grid__critical">
            <span>ALL NEW RISK PATHS</span>
            <strong>EMERGENCY STOP</strong>
            <p>Runs up to two explicit wallet transactions: marketplace first, registration second.</p>
            <button className="admin-button admin-button--danger" type="button" disabled={!controllerOwner || !marketOwner || (snapshot.controller.registrationsPaused && snapshot.marketplace.paused)} onClick={() => review(pauseAllAction)}>
              Review pause all
            </button>
          </article>
        </div>
      </section>

      <section className="admin-control-section" aria-labelledby="admin-economics-heading">
        <header><span>02 / ECONOMICS</span><h2 id="admin-economics-heading">Fees and fixed pricing</h2><p>Only referral and marketplace percentages are mutable. Registration price tiers are immutable in this release.</p></header>
        <div className="admin-fixed-prices">
          {snapshot.controller.prices.map((price, index) => (
            <div key={index}><span>{index < 3 ? `${index + 1} CODE POINT` : "4+ CODE POINTS"}</span><strong>{formatUsdc(price)} / YEAR</strong></div>
          ))}
        </div>
        <div className="admin-form-grid">
          <form onSubmit={(event) => {
            event.preventDefault();
            review(() => {
              const next = parsePercentToBps(referralPercent, snapshot.controller.maxReferralBps);
              return {
                id: "referral-bps",
                releaseId: snapshot.releaseId,
                title: "Update referral reward",
                description: "The new rate applies to future registrations. Outstanding credits are unchanged; already issued non-zero-referrer permits may become stale.",
                confirmLabel: "Update referral rate",
                confirmationText: "CHANGE REFERRAL RATE",
                details: [{ label: "CURRENT", value: formatBps(snapshot.controller.referralBps) }, { label: "NEW", value: formatBps(next) }],
                steps: [ownerStep(buildAdminPlan(snapshot.releaseId, "controller", "setReferralBps", [next], "Update referral BPS"), {
                  expectation: { kind: "referral-bps", bps: next },
                  isSatisfied: (state) => state.controller.referralBps === next,
                  verify: (state) => state.controller.referralBps === next,
                })],
                successMessage: `Referral rate is now ${formatBps(next)}. Reconcile the manifest and issuer policy before claiming release parity.`,
              };
            });
          }}>
            <label htmlFor="admin-referral-rate">Referral reward (%)</label>
            <input id="admin-referral-rate" inputMode="decimal" value={referralPercent} onChange={(event) => setReferralPercent(event.target.value)} placeholder={(snapshot.controller.referralBps / 100).toString()} disabled={!controllerOwner} />
            <small>Current {formatBps(snapshot.controller.referralBps)} · max {formatBps(snapshot.controller.maxReferralBps)}</small>
            <button className="admin-button" type="submit" disabled={!controllerOwner}>Review change</button>
          </form>
          <form onSubmit={(event) => {
            event.preventDefault();
            review(() => {
              const next = parsePercentToBps(marketFeePercent, snapshot.marketplace.maxFeeBps);
              return {
                id: "market-fee",
                releaseId: snapshot.releaseId,
                title: "Update marketplace fee",
                description: "The marketplace reads fee policy at purchase time, so the new value also affects existing live listings.",
                confirmLabel: "Update marketplace fee",
                confirmationText: "CHANGE MARKET FEE",
                details: [{ label: "CURRENT", value: formatBps(snapshot.marketplace.feeBps) }, { label: "NEW", value: formatBps(next) }],
                steps: [ownerStep(buildAdminPlan(snapshot.releaseId, "marketplace", "setFeeBps", [next], "Update marketplace fee BPS"), {
                  expectation: { kind: "marketplace-fee-bps", bps: next },
                  isSatisfied: (state) => state.marketplace.feeBps === next,
                  verify: (state) => state.marketplace.feeBps === next,
                })],
                successMessage: `Marketplace fee is now ${formatBps(next)}. Update the canonical manifest before restoring readiness parity.`,
              };
            });
          }}>
            <label htmlFor="admin-market-fee">Marketplace fee (%)</label>
            <input id="admin-market-fee" inputMode="decimal" value={marketFeePercent} onChange={(event) => setMarketFeePercent(event.target.value)} placeholder={(snapshot.marketplace.feeBps / 100).toString()} disabled={!marketOwner} />
            <small>Current {formatBps(snapshot.marketplace.feeBps)} · max {formatBps(snapshot.marketplace.maxFeeBps)}</small>
            <button className="admin-button" type="submit" disabled={!marketOwner}>Review change</button>
          </form>
        </div>
      </section>

      <section className="admin-control-section" aria-labelledby="admin-treasury-heading">
        <header><span>03 / TREASURY</span><h2 id="admin-treasury-heading">Treasury and surplus</h2><p>Referral and seller liabilities are calculated first; only the remaining USDC surplus can be withdrawn.</p></header>
        <div className="admin-liability-grid">
          <div><span>CONTROLLER BALANCE</span><strong>{formatUsdc(snapshot.controller.balance)}</strong><small>Protected {formatUsdc(snapshot.controller.liability)}</small></div>
          <div><span>CONTROLLER SURPLUS</span><strong>{formatUsdc(snapshot.controller.surplus)}</strong><small>Recipient {shortAddress(snapshot.controller.treasury)}</small></div>
          <div><span>MARKET BALANCE</span><strong>{formatUsdc(snapshot.marketplace.balance)}</strong><small>Protected {formatUsdc(snapshot.marketplace.liability)}</small></div>
          <div><span>MARKET SURPLUS</span><strong>{formatUsdc(snapshot.marketplace.surplus)}</strong><small>Recipient {shortAddress(snapshot.marketplace.treasury)}</small></div>
        </div>
        <div className="admin-form-grid">
          <form onSubmit={(event) => {
            event.preventDefault();
            review(() => {
              const next = parseAdminAddress(treasuryAddress, {
                forbidden: [snapshot.controller.address, snapshot.marketplace.address],
              });
              const targets = treasuryTargets();
              const steps = targets.map((target) => ownerStep(
                buildAdminPlan(snapshot.releaseId, target, "setTreasury", [next], `Update ${target} treasury`),
                {
                  expectation: { kind: "treasury", target, treasury: next },
                  isSatisfied: (state) => same(treasuryState(state, target).treasury, next),
                  verify: (state) => same(treasuryState(state, target).treasury, next),
                },
              ));
              return {
                id: "treasury-address",
                releaseId: snapshot.releaseId,
                title: "Change treasury destination",
                description: "This changes future surplus recipients; it does not move protected liabilities or existing funds by itself.",
                confirmLabel: "Change treasury",
                danger: true,
                confirmationText: "CHANGE TREASURY",
                details: [{ label: "TARGET", value: treasuryTarget.toUpperCase() }, { label: "NEW TREASURY", value: next }],
                steps,
                successMessage: `Treasury destination updated for ${treasuryTarget}. Reconcile governance and manifest evidence.`,
              };
            });
          }}>
            <label htmlFor="admin-treasury-target">Contracts to update</label>
            <select id="admin-treasury-target" value={treasuryTarget} onChange={(event) => setTreasuryTarget(event.target.value as typeof treasuryTarget)}>
              <option value="both">Controller + marketplace</option>
              <option value="controller">Controller only</option>
              <option value="marketplace">Marketplace only</option>
            </select>
            <label htmlFor="admin-treasury-address">Treasury destination</label>
            <input id="admin-treasury-address" value={treasuryAddress} onChange={(event) => setTreasuryAddress(event.target.value)} placeholder="0x…" />
            <button className="admin-button admin-button--danger" type="submit" disabled={(treasuryTarget !== "marketplace" && !controllerOwner) || (treasuryTarget !== "controller" && !marketOwner)}>Review destination</button>
          </form>
          <form onSubmit={(event) => {
            event.preventDefault();
            review(() => {
              const amount = parseUsdcAmount(controllerWithdrawal, snapshot.controller.surplus ?? undefined);
              return {
                id: "controller-withdrawal",
                releaseId: snapshot.releaseId,
                title: "Withdraw controller surplus",
                description: "The exact amount is sent to the current controller treasury. Referral liabilities stay protected.",
                confirmLabel: "Withdraw USDC",
                danger: true,
                confirmationText: "WITHDRAW CONTROLLER",
                details: [{ label: "AMOUNT", value: formatUsdc(amount) }, { label: "RECIPIENT", value: snapshot.controller.treasury }, { label: "PROTECTED", value: formatUsdc(snapshot.controller.liability) }],
                steps: [ownerStep(buildAdminPlan(snapshot.releaseId, "controller", "withdrawTreasurySurplus", [amount], "Withdraw controller surplus"), {
                  expectation: { kind: "withdrawal", target: "controller", treasury: snapshot.controller.treasury },
                  validate: (state) => !same(state.controller.treasury, snapshot.controller.treasury)
                    ? "The controller treasury changed after review; cancel and review the recipient again."
                    : state.controller.surplus === null || state.controller.surplus < amount
                      ? "The live controller surplus is below the reviewed amount."
                      : null,
                  verify: (state) => state.controller.liability <= state.controller.balance,
                })],
                successMessage: `${formatUsdc(amount)} was withdrawn to the controller treasury.`,
              };
            });
          }}>
            <label htmlFor="admin-controller-withdraw">Controller withdrawal</label>
            <input id="admin-controller-withdraw" inputMode="decimal" value={controllerWithdrawal} onChange={(event) => setControllerWithdrawal(event.target.value)} placeholder="0.00" disabled={!controllerOwner || snapshot.controller.surplus === null} />
            <button type="button" className="admin-inline-link" disabled={snapshot.controller.surplus === null} onClick={() => setControllerWithdrawal(snapshot.controller.surplus === null ? "" : formatUsdc(snapshot.controller.surplus).replace(" USDC", ""))}>Use maximum</button>
            <button className="admin-button" type="submit" disabled={!controllerOwner || !snapshot.controller.surplus}>Review withdrawal</button>
          </form>
          <form onSubmit={(event) => {
            event.preventDefault();
            review(() => {
              const amount = parseUsdcAmount(marketWithdrawal, snapshot.marketplace.surplus ?? undefined);
              return {
                id: "market-withdrawal",
                releaseId: snapshot.releaseId,
                title: "Withdraw marketplace fee surplus",
                description: "The exact amount is sent to the current marketplace treasury. Seller proceeds stay protected.",
                confirmLabel: "Withdraw USDC",
                danger: true,
                confirmationText: "WITHDRAW MARKET",
                details: [{ label: "AMOUNT", value: formatUsdc(amount) }, { label: "RECIPIENT", value: snapshot.marketplace.treasury }, { label: "PROTECTED", value: formatUsdc(snapshot.marketplace.liability) }],
                steps: [ownerStep(buildAdminPlan(snapshot.releaseId, "marketplace", "withdrawFeeSurplus", [amount], "Withdraw marketplace fee surplus"), {
                  expectation: { kind: "withdrawal", target: "marketplace", treasury: snapshot.marketplace.treasury },
                  validate: (state) => !same(state.marketplace.treasury, snapshot.marketplace.treasury)
                    ? "The marketplace treasury changed after review; cancel and review the recipient again."
                    : state.marketplace.surplus === null || state.marketplace.surplus < amount
                      ? "The live marketplace surplus is below the reviewed amount."
                      : null,
                  verify: (state) => state.marketplace.liability <= state.marketplace.balance,
                })],
                successMessage: `${formatUsdc(amount)} was withdrawn to the marketplace treasury.`,
              };
            });
          }}>
            <label htmlFor="admin-market-withdraw">Marketplace withdrawal</label>
            <input id="admin-market-withdraw" inputMode="decimal" value={marketWithdrawal} onChange={(event) => setMarketWithdrawal(event.target.value)} placeholder="0.00" disabled={!marketOwner || snapshot.marketplace.surplus === null} />
            <button type="button" className="admin-inline-link" disabled={snapshot.marketplace.surplus === null} onClick={() => setMarketWithdrawal(snapshot.marketplace.surplus === null ? "" : formatUsdc(snapshot.marketplace.surplus).replace(" USDC", ""))}>Use maximum</button>
            <button className="admin-button" type="submit" disabled={!marketOwner || !snapshot.marketplace.surplus}>Review withdrawal</button>
          </form>
        </div>
      </section>

      <section className="admin-control-section" aria-labelledby="admin-signer-heading">
        <header><span>04 / PERMIT SIGNER</span><h2 id="admin-signer-heading">Signer lifecycle</h2><p>Proposal starts a 24-hour delay and immediately advances the policy version. Private keys never enter this form.</p></header>
        <div className="admin-signer-state">
          <div><span>ACTIVE</span><strong>{snapshot.controller.permitSigner === "0x0000000000000000000000000000000000000000" ? "REVOKED" : shortAddress(snapshot.controller.permitSigner)}</strong></div>
          <div><span>PENDING</span><strong>{snapshot.controller.pendingPermitSigner ? shortAddress(snapshot.controller.pendingPermitSigner) : "NONE"}</strong></div>
          <div><span>ACTIVATION</span><strong>{snapshot.controller.pendingPermitSigner ? (signerActivationReady ? "READY" : new Date(Number(snapshot.controller.pendingPermitSignerValidAfter) * 1000).toLocaleString()) : "—"}</strong></div>
          <div><span>POLICY VERSION</span><strong>{snapshot.controller.signerPolicyVersion.toString()}</strong></div>
        </div>
        <div className="admin-form-grid">
          <form onSubmit={(event) => {
            event.preventDefault();
            review(() => {
              const signer = parseAdminAddress(signerAddress, { forbidden: [snapshot.controller.address] });
              const reviewedActiveSigner = snapshot.controller.permitSigner;
              const reviewedPendingSigner = snapshot.controller.pendingPermitSigner;
              const reviewedPolicyVersion = snapshot.controller.signerPolicyVersion;
              return {
                id: "propose-signer",
                releaseId: snapshot.releaseId,
                title: "Propose a permit signer",
                description: "The proposal becomes activatable after the on-chain delay. Issuer secrets and manifest policy must be prepared separately.",
                confirmLabel: "Propose signer",
                danger: true,
                confirmationText: "PROPOSE SIGNER",
                details: [{ label: "CURRENT", value: snapshot.controller.permitSigner }, { label: "PROPOSED", value: signer }, { label: "DELAY", value: `${snapshot.controller.signerActivationDelay / 3600n} hours` }],
                preflight: async (provider) => {
                  const code = await walletReadRequest(provider, { method: "eth_getCode", params: [signer, "latest"] });
                  if (code !== "0x") throw new Error("The permit signer must be an EOA; contract signers are unsupported.");
                },
                steps: [ownerStep(buildAdminPlan(snapshot.releaseId, "controller", "proposePermitSigner", [signer], "Propose permit signer"), {
                  expectation: { kind: "signer-proposal", signer, policyVersion: (reviewedPolicyVersion + 1n).toString() },
                  validate: (state) => !same(state.controller.permitSigner, reviewedActiveSigner)
                    || state.controller.pendingPermitSigner !== reviewedPendingSigner
                    || state.controller.signerPolicyVersion !== reviewedPolicyVersion
                    ? "Signer state changed after review; refresh and review the proposal again."
                    : null,
                  verify: (state) => same(state.controller.pendingPermitSigner, signer),
                })],
                successMessage: "Permit signer proposal confirmed. Registration readiness remains fail-closed until policy, secret, activation, and manifest parity are complete.",
              };
            });
          }}>
            <label htmlFor="admin-signer-address">New signer EOA</label>
            <input id="admin-signer-address" value={signerAddress} onChange={(event) => setSignerAddress(event.target.value)} placeholder="0x…" disabled={!controllerOwner} />
            <button className="admin-button" type="submit" disabled={!controllerOwner}>Review proposal</button>
          </form>
          <div className="admin-action-card">
            <span>ACTIVATE PENDING SIGNER</span>
            <p>Activation is permissionless after the delay, but this workspace still requires an authorized connected wallet.</p>
            <button className="admin-button" type="button" disabled={!snapshot.controller.pendingPermitSigner || !signerActivationReady} onClick={() => review(() => {
              const pending = snapshot.controller.pendingPermitSigner;
              if (!pending) throw new Error("There is no pending signer.");
              const reviewedPolicyVersion = snapshot.controller.signerPolicyVersion;
              const reviewedValidAfter = snapshot.controller.pendingPermitSignerValidAfter;
              return {
                id: "activate-signer",
                releaseId: snapshot.releaseId,
                title: "Activate pending permit signer",
                description: "The pending EOA becomes the active EIP-712 signer. Confirm server secret and manifest preparation before activation.",
                confirmLabel: "Activate signer",
                danger: true,
                confirmationText: "ACTIVATE SIGNER",
                details: [{ label: "NEW SIGNER", value: pending }, { label: "POLICY", value: snapshot.controller.signerPolicyVersion.toString() }],
                steps: [{
                  plan: buildAdminPlan(snapshot.releaseId, "controller", "activatePermitSigner", [], "Activate permit signer"),
                  expectation: { kind: "signer-activation", signer: pending, policyVersion: reviewedPolicyVersion.toString() },
                  validate: (state) => !same(state.controller.pendingPermitSigner, pending)
                    || state.controller.signerPolicyVersion !== reviewedPolicyVersion
                    || state.controller.pendingPermitSignerValidAfter !== reviewedValidAfter
                    ? "The pending signer or policy changed after review; refresh before activation."
                    : state.blockTimestamp < reviewedValidAfter
                      ? "The on-chain signer delay has not elapsed."
                      : null,
                  verify: (state) => same(state.controller.permitSigner, pending) && state.controller.pendingPermitSigner === null,
                }],
                successMessage: "Pending permit signer activated. Verify the issuer runtime and publish reconciled release evidence.",
              };
            })}>Review activation</button>
          </div>
          <div className="admin-action-card admin-action-card--danger">
            <span>EMERGENCY REVOKE</span>
            <p>Pauses new registration first when necessary, then revokes both active and pending signer state.</p>
            <button className="admin-button admin-button--danger" type="button" disabled={!controllerOwner || (snapshot.controller.permitSigner === "0x0000000000000000000000000000000000000000" && !snapshot.controller.pendingPermitSigner)} onClick={() => review(() => {
              const steps: AdminActionStep[] = [
                ownerStep(buildAdminPlan(snapshot.releaseId, "controller", "setRegistrationsPaused", [true], "Pause registrations before signer revoke"), {
                  expectation: { kind: "registration-pause", paused: true },
                  isSatisfied: (state) => state.controller.registrationsPaused,
                  verify: (state) => state.controller.registrationsPaused,
                }),
                ownerStep(buildAdminPlan(snapshot.releaseId, "controller", "revokePermitSigner", [], "Revoke permit signer"), {
                  expectation: { kind: "signer-revocation" },
                  isSatisfied: (state) => state.controller.registrationsPaused && state.controller.permitSigner === "0x0000000000000000000000000000000000000000" && state.controller.pendingPermitSigner === null,
                  verify: (state) => state.controller.registrationsPaused && state.controller.permitSigner === "0x0000000000000000000000000000000000000000" && state.controller.pendingPermitSigner === null,
                }),
              ];
              return {
                id: "revoke-signer",
                releaseId: snapshot.releaseId,
                title: "Pause and revoke permit signer",
                description: "This is a fail-closed emergency action. Registration cannot resume until a new signer completes proposal, delay, activation, runtime setup, and evidence reconciliation.",
                confirmLabel: "Pause and revoke",
                danger: true,
                confirmationText: "REVOKE SIGNER",
                details: [{ label: "ACTIVE SIGNER", value: snapshot.controller.permitSigner }, { label: "ORDER", value: "Pause registration → Revoke signer" }],
                steps,
                finalVerify: (state) => state.controller.registrationsPaused && state.controller.permitSigner === "0x0000000000000000000000000000000000000000" && state.controller.pendingPermitSigner === null,
                finalVerificationError: "The emergency signer action did not leave registration paused with active and pending signers cleared.",
                successMessage: "Registration is paused and the permit signer is revoked.",
              };
            })}>Review emergency revoke</button>
          </div>
        </div>
      </section>

      <section className="admin-control-section" aria-labelledby="admin-wiring-heading">
        <header><span>05 / REGISTRAR</span><h2 id="admin-wiring-heading">Release controller authorization</h2><p>The registrar owner can enable or disable this release&apos;s exact controller. Arbitrary controller addresses are intentionally not accepted by this UI.</p></header>
        <div className="admin-wiring-row">
          <div><span>SELECTED CONTROLLER</span><strong>{snapshot.controller.address}</strong><small>{snapshot.registrar.canonicalControllerEnabled ? "AUTHORIZED" : "DISABLED"}</small></div>
          <button
            className={snapshot.registrar.canonicalControllerEnabled ? "admin-button admin-button--danger" : "admin-button"}
            type="button"
            disabled={!registrarOwner || (snapshot.registrar.canonicalControllerEnabled && !controllerOwner)}
            onClick={() => review(() => registrarControllerAction(snapshot))}
          >
            {snapshot.registrar.canonicalControllerEnabled ? "Review pause & disable" : "Review enable"}
          </button>
        </div>
        <p className="admin-boundary-note">Registry root/subnode mutations are deliberately read-only here. They are node-owner recovery operations capable of replacing namespace wiring and therefore remain in audited deployment/recovery tooling.</p>
      </section>

      <section className="admin-control-section" aria-labelledby="admin-ownership-heading">
        <header><span>06 / OWNERSHIP</span><h2 id="admin-ownership-heading">Two-step ownership</h2><p>Controller, marketplace, and registrar ownership are independent. Suite transfer uses three explicit wallet transactions.</p></header>
        <div className="admin-owner-grid">
          {(["controller", "marketplace", "registrar"] as const).map((target) => {
            const state = contractState(snapshot, target);
            const pendingOwner = state.pendingOwner;
            const pendingRole = target === "controller" ? access.isControllerPendingOwner : target === "marketplace" ? access.isMarketplacePendingOwner : access.isRegistrarPendingOwner;
            return (
              <article key={target}>
                <span>{target.toUpperCase()}</span>
                <strong>{shortAddress(state.owner)}</strong>
                <small>Pending: {state.pendingOwner ? shortAddress(state.pendingOwner) : "none"}</small>
                {pendingOwner ? <button className="admin-button" type="button" disabled={!pendingRole} onClick={() => review(() => ({
                  id: `accept-${target}`,
                  releaseId: snapshot.releaseId,
                  title: `Accept ${target} ownership`,
                  description: "The connected pending-owner wallet becomes the live contract owner.",
                  confirmLabel: "Accept ownership",
                  danger: true,
                  confirmationText: "ACCEPT OWNERSHIP",
                  details: [{ label: "CONTRACT", value: target.toUpperCase() }, { label: "CURRENT", value: state.owner }, { label: "NEW", value: pendingOwner }],
                  steps: [{
                    plan: buildAdminPlan(snapshot.releaseId, target, "acceptOwnership", [], `Accept ${target} ownership`),
                    expectation: { kind: "owner", target, owner: pendingOwner },
                    isAuthorized: (currentAccess) => target === "controller" ? currentAccess.isControllerPendingOwner : target === "marketplace" ? currentAccess.isMarketplacePendingOwner : currentAccess.isRegistrarPendingOwner,
                    validate: (next) => same(contractState(next, target).pendingOwner, pendingOwner)
                      ? null
                      : "The pending owner changed after review.",
                    verify: (next) => same(contractState(next, target).owner, pendingOwner),
                  }],
                  successMessage: `${target} ownership accepted. Reconcile governance and manifest evidence.`,
                }))}>Accept</button> : null}
              </article>
            );
          })}
        </div>
        <form className="admin-wide-form" onSubmit={(event) => {
          event.preventDefault();
          review(() => {
            const nextOwner = parseAdminAddress(ownershipAddress, {
              forbidden: [snapshot.controller.address, snapshot.marketplace.address, snapshot.registrar.address],
            });
            const targets = ownershipTargets();
            const steps = targets.map((target) => ownerStep(
              buildAdminPlan(snapshot.releaseId, target, "transferOwnership", [nextOwner], `Nominate ${target} owner`),
              {
                expectation: { kind: "pending-owner", target, owner: nextOwner },
                isSatisfied: (state) => same(contractState(state, target).pendingOwner, nextOwner),
                verify: (state) => same(contractState(state, target).pendingOwner, nextOwner),
              },
            ));
            return {
              id: "transfer-ownership",
              releaseId: snapshot.releaseId,
              title: "Nominate a new contract owner",
              description: "This begins two-step ownership transfer. The nominated wallet must separately connect and accept each selected contract.",
              confirmLabel: "Start ownership transfer",
              danger: true,
              confirmationText: "TRANSFER OWNERSHIP",
              details: [{ label: "TARGET", value: ownershipTarget.toUpperCase() }, { label: "NEW OWNER", value: nextOwner }, { label: "STEPS", value: steps.length.toString() }],
              steps,
              successMessage: `Pending ownership set for ${ownershipTarget}. The new wallet must accept each contract.`,
            };
          });
        }}>
          <label htmlFor="admin-owner-target">Contracts to transfer</label>
          <select id="admin-owner-target" value={ownershipTarget} onChange={(event) => setOwnershipTarget(event.target.value as typeof ownershipTarget)}>
            <option value="suite">Entire owner suite</option>
            <option value="controller">Controller only</option>
            <option value="marketplace">Marketplace only</option>
            <option value="registrar">Registrar only</option>
          </select>
          <label htmlFor="admin-owner-address">New owner or multisig</label>
          <input id="admin-owner-address" value={ownershipAddress} onChange={(event) => setOwnershipAddress(event.target.value)} placeholder="0x…" />
          <button className="admin-button admin-button--danger" type="submit" disabled={(ownershipTarget === "suite" && (!controllerOwner || !marketOwner || !registrarOwner)) || (ownershipTarget === "controller" && !controllerOwner) || (ownershipTarget === "marketplace" && !marketOwner) || (ownershipTarget === "registrar" && !registrarOwner)}>Review transfer</button>
        </form>
      </section>

      <section className="admin-control-section admin-control-section--boundary" aria-labelledby="admin-release-heading">
        <header><span>07 / RELEASE BOUNDARY</span><h2 id="admin-release-heading">Not browser-mutable</h2><p>These properties require a reviewed release artifact or a new deployment rather than an owner transaction.</p></header>
        <div className="admin-immutable-grid">
          <div><span>PRODUCT LIVE</span><strong>{snapshot.productLive ? "TRUE" : "FALSE"}</strong></div>
          <div><span>RELEASE ID</span><strong>{shortAddress(snapshot.releaseId)}</strong></div>
          <div><span>SETTLEMENT</span><strong>{manifest.settlement.symbol} / 6 DECIMALS</strong></div>
          <div><span>IMMUTABLE</span><strong>PRICES · SUFFIX · GRACE · ASSET · RELEASE</strong></div>
        </div>
      </section>

      <AdminActionDialog
        key={action?.id ?? "admin-action-closed"}
        action={action}
        progress={progress}
        onConfirm={() => void executeAction()}
        onClose={closeAction}
      />
    </div>
  );
}
