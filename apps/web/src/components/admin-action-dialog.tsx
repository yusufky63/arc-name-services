"use client";

import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import {
  explorerTransaction,
  type AdminAccess,
  type AdminPostStateExpectation,
  type AdminSnapshot,
  type AdminTransactionPlan,
} from "@/lib/admin-protocol";

export type AdminActionStep = {
  plan: AdminTransactionPlan;
  expectation: AdminPostStateExpectation;
  isSatisfied?(snapshot: AdminSnapshot): boolean;
  isAuthorized?(access: AdminAccess): boolean;
  validate?(snapshot: AdminSnapshot): string | null;
  verify?(snapshot: AdminSnapshot): boolean;
  verificationError?: string;
};

export type AdminAction = {
  id: string;
  releaseId: Hex;
  title: string;
  description: string;
  confirmLabel: string;
  details: readonly { label: string; value: string }[];
  steps: readonly AdminActionStep[];
  danger?: boolean;
  confirmationText?: string;
  preflight?(provider: EthereumProvider, snapshot: AdminSnapshot): Promise<void>;
  finalVerify?(snapshot: AdminSnapshot): boolean;
  finalVerificationError?: string;
  successMessage: string;
};

export type AdminActionProgress = {
  phase: "idle" | "checking" | "wallet" | "confirming" | "verifying" | "success" | "error";
  step: number;
  total: number;
  hash: Hex | null;
  error: string | null;
};

type AdminActionDialogProps = {
  action: AdminAction | null;
  progress: AdminActionProgress;
  onConfirm(): void;
  onClose(): void;
};

const phaseCopy: Record<AdminActionProgress["phase"], string> = {
  idle: "Review the exact change before continuing.",
  checking: "Checking the selected release and fresh on-chain authorization.",
  wallet: "Confirm the exact transaction in your wallet.",
  confirming: "Waiting for the Arc transaction receipt.",
  verifying: "Verifying transaction input and the resulting on-chain state.",
  success: "Every required transaction and post-state check passed.",
  error: "The operation stopped. No failed step was automatically retried.",
};

export function AdminActionDialog({
  action,
  progress,
  onConfirm,
  onClose,
}: AdminActionDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirmation, setConfirmation] = useState("");
  const busy = !["idle", "success", "error"].includes(progress.phase);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !action) return;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [action]);

  if (!action) return null;
  const confirmationReady =
    !action.confirmationText || confirmation === action.confirmationText;

  return (
    <dialog
      ref={dialogRef}
      className="admin-dialog"
      aria-labelledby="admin-dialog-title"
      aria-describedby="admin-dialog-description"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div className="admin-dialog__panel" data-danger={action.danger === true}>
        <header>
          <span>{action.danger ? "CRITICAL ADMIN ACTION" : "ADMIN ACTION REVIEW"}</span>
          <button type="button" onClick={onClose} disabled={busy} aria-label="Close admin action">
            ×
          </button>
          <h2 id="admin-dialog-title">{action.title}</h2>
          <p id="admin-dialog-description">{action.description}</p>
        </header>

        <dl className="admin-dialog__details">
          <div>
            <dt>RELEASE ID</dt>
            <dd>{action.releaseId}</dd>
          </div>
          {action.details.map((detail) => (
            <div key={detail.label}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </div>
          ))}
          <div>
            <dt>TRANSACTIONS</dt>
            <dd>{action.steps.length}</dd>
          </div>
        </dl>

        {action.confirmationText && progress.phase !== "success" ? (
          <label className="admin-dialog__confirmation">
            <span>Type <code>{action.confirmationText}</code> to continue</span>
            <input
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              disabled={busy}
            />
          </label>
        ) : null}

        <div className="admin-dialog__status" data-phase={progress.phase} role="status">
          <span>{progress.phase.toUpperCase()}</span>
          <p>{progress.error ?? phaseCopy[progress.phase]}</p>
          {progress.total > 0 && progress.phase !== "idle" ? (
            <code>STEP {Math.min(progress.step + 1, progress.total)} / {progress.total}</code>
          ) : null}
          {progress.hash ? (
            <a href={explorerTransaction(action.releaseId, progress.hash)} target="_blank" rel="noreferrer">
              View transaction ↗
            </a>
          ) : null}
        </div>

        <footer>
          <button type="button" className="admin-button admin-button--quiet" onClick={onClose} disabled={busy}>
            {progress.phase === "success" ? "Done" : "Cancel"}
          </button>
          {progress.phase !== "success" ? (
            <button
              type="button"
              className={action.danger ? "admin-button admin-button--danger" : "admin-button"}
              onClick={onConfirm}
              disabled={busy || !confirmationReady}
            >
              {busy
                ? "Processing…"
                : progress.phase === "error"
                  ? progress.hash ? "Retry pending verification" : "Retry checks"
                  : action.confirmLabel}
            </button>
          ) : null}
        </footer>
      </div>
    </dialog>
  );
}
