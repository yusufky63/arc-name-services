"use client";

import { useRouter } from "next/navigation";
import { FormEvent, useRef, useState } from "react";
import {
  getAddress,
  isAddress,
  isHex,
  verifyTypedData,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { requireActivatedContract } from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";
import {
  prepareApprovalPlan,
  prepareRegistrationPlan,
  registrationPermitDomain,
  registrationPermitTypes,
  resolverDataHash,
  type RegistrationPermit,
  type UnsignedTransactionPlan,
} from "@contour/sdk";
import { BRAND } from "@/lib/brand";
import { getDeploymentManifest } from "@/lib/manifest";
import { labelPrice } from "@/lib/names";
import { ARC_CHAIN_HEX } from "@/lib/network";
import {
  assertArcWalletAccount,
  ensureArcWallet,
  walletErrorMessage,
  walletReadRequest,
} from "@/lib/wallet-protocol";
import { RegistrationDurationSelect } from "@/components/registration-duration-select";
import { useWalletManager } from "@/components/wallet-manager";

type RegistrationTransaction = {
  to: `0x${string}`;
  data: `0x${string}`;
  value?: `0x${string}`;
};

type RegistrationPlan = {
  registrationTransaction: RegistrationTransaction;
  permitId: `0x${string}`;
  validUntil: string;
  permit: unknown;
  signature: Hex;
};

type PreflightPlan = {
  normalizedLabel: string;
  expectedAmount: string;
  approvalTransaction: RegistrationTransaction | null;
};

type Readiness = {
  ready?: boolean;
  error?: string;
};

type Verification = {
  verified: boolean;
  issuerReconciled?: boolean;
  error?: string;
};

type PendingRegistration = {
  version: 1;
  intentKey: string;
  requestId: string;
  permitId: `0x${string}`;
  transactionHash: `0x${string}`;
  rawLabel: string;
  requester: Address;
  recipient: Address;
};

type StoredRegistrationIntent = {
  version: 1;
  intentKey: string;
  requestId: string;
  createdAt: number;
};

type FlowState =
  | "idle"
  | "connecting"
  | "preparing"
  | "authorizing"
  | "registering"
  | "confirming"
  | "success"
  | "error";

const stateLabel: Record<FlowState, string> = {
  idle: "",
  connecting: "Connect wallet",
  preparing: "Preparing registration",
  authorizing: "Approve USDC",
  registering: "Register in wallet",
  confirming: "Confirming registration",
  success: "Name registered",
  error: "Try again",
};

const PENDING_REGISTRATION_KEY = "contour.pending-registration.v1";
const REGISTRATION_INTENT_KEY = "contour.registration-intent.v1";

class TransactionRevertedError extends Error {
  constructor() {
    super("The Arc transaction reverted.");
    this.name = "TransactionRevertedError";
  }
}

class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function canSafelyRotateRequestId(error: ApiRequestError) {
  if (error.code === "INTENT_STALE" || error.code === "QUOTE_CHANGED") return true;
  if (error.code !== "REQUEST_ID_EXPIRED") return false;
  const retryAt = error.retryAfter ? Date.parse(error.retryAfter) : Number.NaN;
  return !Number.isFinite(retryAt) || retryAt <= Date.now();
}

function readPendingRegistration(): PendingRegistration | null {
  try {
    const raw = sessionStorage.getItem(PENDING_REGISTRATION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<PendingRegistration>;
    if (
      value.version !== 1 ||
      typeof value.intentKey !== "string" ||
      typeof value.requestId !== "string" ||
      typeof value.rawLabel !== "string" ||
      typeof value.permitId !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.permitId) ||
      typeof value.transactionHash !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(value.transactionHash) ||
      typeof value.requester !== "string" ||
      !isAddress(value.requester) ||
      typeof value.recipient !== "string" ||
      !isAddress(value.recipient)
    ) {
      sessionStorage.removeItem(PENDING_REGISTRATION_KEY);
      return null;
    }
    return value as PendingRegistration;
  } catch {
    return null;
  }
}

function savePendingRegistration(value: PendingRegistration) {
  try {
    sessionStorage.setItem(PENDING_REGISTRATION_KEY, JSON.stringify(value));
  } catch {
    // The active flow still verifies the receipt; storage is recovery-only.
  }
}

function clearPendingRegistration(intentKey: string) {
  const pending = readPendingRegistration();
  if (pending?.intentKey === intentKey) {
    try {
      sessionStorage.removeItem(PENDING_REGISTRATION_KEY);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }
}

function readStoredIntent(): StoredRegistrationIntent | null {
  try {
    const raw = sessionStorage.getItem(REGISTRATION_INTENT_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredRegistrationIntent>;
    if (
      value.version !== 1 ||
      typeof value.intentKey !== "string" ||
      typeof value.requestId !== "string" ||
      value.requestId.length < 8 ||
      value.requestId.length > 128 ||
      typeof value.createdAt !== "number" ||
      !Number.isFinite(value.createdAt)
    ) {
      sessionStorage.removeItem(REGISTRATION_INTENT_KEY);
      return null;
    }
    return value as StoredRegistrationIntent;
  } catch {
    return null;
  }
}

function saveStoredIntent(value: StoredRegistrationIntent) {
  try {
    sessionStorage.setItem(REGISTRATION_INTENT_KEY, JSON.stringify(value));
  } catch {
    // In-memory idempotency remains available for the active page.
  }
}

function clearStoredIntent(intentKey: string) {
  const stored = readStoredIntent();
  if (stored?.intentKey === intentKey) {
    try {
      sessionStorage.removeItem(REGISTRATION_INTENT_KEY);
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }
}

const numericPermitFields = [
  "chainId",
  "durationYears",
  "expectedAmount",
  "expectedReferralBps",
  "nonce",
  "issuedAt",
  "validAfter",
  "validUntil",
] as const;

const addressPermitFields = [
  "controller",
  "requester",
  "recipient",
  "payer",
  "authorizedExecutor",
  "referrer",
  "settlementAsset",
] as const;

const hashPermitFields = [
  "releaseId",
  "normalizationProfileHash",
  "normalizedLabelHash",
  "namehash",
  "resolverDataHash",
  "permitId",
] as const;

function decodeWirePermit(value: unknown): RegistrationPermit {
  if (!value || typeof value !== "object") {
    throw new Error("Registration details are invalid. Please try again.");
  }
  const wire = value as Record<string, unknown>;
  const decoded = { ...wire } as Record<string, unknown>;
  for (const field of numericPermitFields) {
    const item = wire[field];
    if (typeof item !== "string" || !/^\d+$/.test(item)) {
      throw new Error(`Registration details are invalid (${field}). Please try again.`);
    }
    decoded[field] = BigInt(item);
  }
  for (const field of addressPermitFields) {
    if (typeof wire[field] !== "string" || !isAddress(wire[field])) {
      throw new Error(`Registration details are invalid (${field}). Please try again.`);
    }
  }
  for (const field of hashPermitFields) {
    if (typeof wire[field] !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(wire[field])) {
      throw new Error(`Registration details are invalid (${field}). Please try again.`);
    }
  }
  return decoded as unknown as RegistrationPermit;
}

function assertTransactionMatches(
  serverTransaction: RegistrationTransaction,
  localPlan: UnsignedTransactionPlan,
) {
  if (
    !isAddress(serverTransaction.to) ||
    !isHex(serverTransaction.data) ||
    !isHex(serverTransaction.value ?? "0x0") ||
    getAddress(serverTransaction.to) !== getAddress(localPlan.to) ||
    serverTransaction.data.toLowerCase() !== localPlan.data.toLowerCase() ||
    BigInt(serverTransaction.value ?? "0x0") !== localPlan.value
  ) {
    throw new Error("The server transaction does not match the independently prepared plan.");
  }
}

function verifyPreflightLocally(
  rawLabel: string,
  normalizationAccepted: boolean,
  durationYears: number,
  preflight: PreflightPlan,
) {
  const manifest = getDeploymentManifest();
  const suffix = manifest.namespace.suffix;
  if (!suffix) throw new Error("The pinned namespace is not active.");
  const identity = deriveNameIdentity(rawLabel, suffix);
  if (identity.changed && !normalizationAccepted) {
    throw new Error("ENSIP-15 normalization acceptance is required.");
  }
  if (preflight.normalizedLabel !== identity.normalized) {
    throw new Error("The preflight label does not match local ENSIP-15 normalization.");
  }
  const quote = BigInt(preflight.expectedAmount);
  const localQuotedAmount = BigInt(
    Math.round(labelPrice(identity.normalized, durationYears) * 1_000_000),
  );
  if (quote !== localQuotedAmount) {
    throw new Error("The Arc quote does not match the pinned pricing policy.");
  }
  if (preflight.approvalTransaction) {
    assertTransactionMatches(
      preflight.approvalTransaction,
      prepareApprovalPlan(manifest, quote),
    );
  }
}

async function verifyRegistrationPlanLocally(
  payload: RegistrationPlan,
  input: {
    rawLabel: string;
    normalizationAccepted: boolean;
    durationYears: number;
    payer: Address;
    recipient: Address;
    expectedAmount: string;
  },
) {
  const manifest = getDeploymentManifest();
  const suffix = manifest.namespace.suffix;
  const signer = manifest.permitIssuer.signerAddress;
  if (!suffix || !signer) throw new Error("The pinned registration release is incomplete.");
  const identity = deriveNameIdentity(input.rawLabel, suffix);
  const permit = decodeWirePermit(payload.permit);
  if (
    getAddress(permit.requester) !== input.payer ||
    getAddress(permit.payer) !== input.payer ||
    getAddress(permit.authorizedExecutor) !== input.payer ||
    getAddress(permit.recipient) !== input.recipient ||
    getAddress(permit.referrer) !== zeroAddress ||
    permit.durationYears !== BigInt(input.durationYears) ||
    permit.expectedAmount !== BigInt(input.expectedAmount) ||
    permit.expectedReferralBps !== 0n ||
    permit.resolverDataHash.toLowerCase() !== resolverDataHash([]) ||
    permit.normalizedLabelHash.toLowerCase() !== identity.labelhash ||
    permit.namehash.toLowerCase() !== identity.namehash ||
    permit.permitId.toLowerCase() !== payload.permitId.toLowerCase() ||
    permit.validUntil.toString() !== payload.validUntil
  ) {
    throw new Error("Registration details changed. Please try again.");
  }
  const now = BigInt(Math.floor(Date.now() / 1_000));
  if (
    permit.validAfter > permit.issuedAt ||
    permit.issuedAt > permit.validUntil ||
    permit.issuedAt - permit.validAfter > 5n ||
    permit.validUntil - permit.validAfter > 300n ||
    now < permit.validAfter ||
    permit.validUntil - now < 30n
  ) {
    throw new Error("This registration request expired. Please try again.");
  }
  if (!isHex(payload.signature)) {
    throw new Error("Registration approval is invalid. Please try again.");
  }
  const signatureValid = await verifyTypedData({
    address: getAddress(signer),
    domain: registrationPermitDomain(permit.controller),
    types: registrationPermitTypes,
    primaryType: "RegistrationPermit",
    message: permit,
    signature: payload.signature,
  });
  if (!signatureValid) {
    throw new Error("Registration approval could not be verified. Please try again.");
  }
  const localPlan = prepareRegistrationPlan({
    manifest,
    rawLabel: input.rawLabel,
    normalizationAccepted: input.normalizationAccepted,
    permit,
    signature: payload.signature,
    resolverData: [],
  });
  assertTransactionMatches(payload.registrationTransaction, localPlan);
}

async function readJson<T>(
  response: Response,
): Promise<T & { error?: string; code?: string; retryAfter?: string }> {
  try {
    return (await response.json()) as T & {
      error?: string;
      code?: string;
      retryAfter?: string;
    };
  } catch {
    throw new Error("Registration could not be prepared. Please try again.");
  }
}

function assertRegistrationContext(
  invalidated: { current: boolean },
) {
  if (invalidated.current) {
    throw new Error("Wallet account or Arc network changed. Restart registration.");
  }
}

async function waitForReceipt(
  provider: EthereumProvider,
  hash: string,
  invalidated?: { current: boolean },
) {
  const started = Date.now();
  while (Date.now() - started < 60_000) {
    if (invalidated?.current) {
      throw new Error("Wallet account or Arc network changed. Restart registration.");
    }
    const receipt = (await walletReadRequest(provider, {
      method: "eth_getTransactionReceipt",
      params: [hash],
    })) as { status?: string } | null;
    if (receipt) {
      if (receipt.status && BigInt(receipt.status) === 0n) {
        throw new TransactionRevertedError();
      }
      return;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
  }
  throw new Error("Receipt confirmation timed out. Check ArcScan before retrying.");
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await readJson<T>(response);
  if (!response.ok) {
    throw new ApiRequestError(
      payload.error ?? "Registration could not continue. Please try again.",
      payload.code,
      payload.retryAfter,
    );
  }
  return payload;
}

export function RegisterPanel({
  label,
  rawLabel,
  normalizationRequired,
  deploymentReady,
  nameAvailable,
}: {
  label: string;
  rawLabel: string;
  normalizationRequired: boolean;
  deploymentReady: boolean;
  nameAvailable?: boolean | undefined;
}) {
  const router = useRouter();
  const wallet = useWalletManager();
  const [years, setYears] = useState(1);
  const [normalizationAccepted, setNormalizationAccepted] = useState(!normalizationRequired);
  const [state, setState] = useState<FlowState>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const requestRef = useRef<{ key: string; id: string } | null>(null);
  const invalidatedRef = useRef(false);
  const price = labelPrice(label, years);

  function stableRequestId(key: string) {
    if (requestRef.current?.key === key) return requestRef.current.id;
    const stored = readStoredIntent();
    if (stored?.intentKey === key) {
      requestRef.current = { key, id: stored.requestId };
      return stored.requestId;
    }
    const id = crypto.randomUUID();
    requestRef.current = { key, id };
    saveStoredIntent({ version: 1, intentKey: key, requestId: id, createdAt: Date.now() });
    return id;
  }

  async function register(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);

    if (!deploymentReady) {
      setState("error");
      setMessage(
        "Registration is temporarily unavailable. Your wallet was not opened and no payment was made.",
      );
      return;
    }
    if (nameAvailable === false) {
      setState("error");
      setMessage(`${label}${BRAND.suffix} is already registered or still in its grace period.`);
      return;
    }
    if (normalizationRequired && !normalizationAccepted) {
      setState("error");
      setMessage(`Accept the ENSIP-15 normalization to ${label}${BRAND.suffix} first.`);
      return;
    }
    try {
      setState("preparing");
      const readinessResponse = await fetch("/api/registration/readiness", {
        cache: "no-store",
      });
      const readiness = await readJson<Readiness>(readinessResponse);
      if (readinessResponse.ok && readiness.ready === true) {
        // Only a live, release-matched issuer may precede wallet access.
      } else {
        throw new Error(
          readiness.error ??
            "Registration is temporarily unavailable. Your wallet was not opened and no payment was made.",
        );
      }
    } catch (error) {
      setState("error");
      setMessage(
        error instanceof Error
          ? error.message
          :
          "Registration is temporarily unavailable. Your wallet was not opened and no payment was made.",
      );
      return;
    }

    let selectedProvider: EthereumProvider | null = null;
    const invalidate = () => {
      invalidatedRef.current = true;
      setMessage("Wallet account or Arc network changed. Restart registration.");
    };

    try {
      setState("connecting");
      const connection = await wallet.requireConnection();
      const provider = connection.provider;
      const payer = connection.account;
      selectedProvider = provider;
      if (getAddress(payer) === zeroAddress) {
        throw new Error("No valid wallet account was selected.");
      }
      await ensureArcWallet(provider);
      invalidatedRef.current = false;
      provider.on?.("accountsChanged", invalidate);
      provider.on?.("chainChanged", invalidate);
      assertRegistrationContext(invalidatedRef);

      const recipient = payer;
      const executionManifest = getDeploymentManifest();
      const intentKey = JSON.stringify([
        rawLabel,
        years,
        payer,
        recipient,
        executionManifest.releaseId,
        requireActivatedContract(executionManifest, "controller"),
        executionManifest.normalization.profileHash,
        resolverDataHash([]),
        zeroAddress,
      ]);
      const pending = readPendingRegistration();
      if (pending) {
        setTxHash(pending.transactionHash);
        if (
          pending.intentKey !== intentKey ||
          pending.rawLabel !== rawLabel ||
          getAddress(pending.requester) !== payer ||
          getAddress(pending.recipient) !== recipient
        ) {
          throw new Error(
            "A different registration is still pending in this browser. Resolve its ArcScan transaction before starting another.",
          );
        }
        requestRef.current = { key: intentKey, id: pending.requestId };
        saveStoredIntent({
          version: 1,
          intentKey,
          requestId: pending.requestId,
          createdAt: Date.now(),
        });
        setState("confirming");
        try {
          await waitForReceipt(provider, pending.transactionHash, invalidatedRef);
        } catch (error) {
          if (error instanceof TransactionRevertedError) {
            clearPendingRegistration(intentKey);
          }
          throw error;
        }
        assertRegistrationContext(invalidatedRef);
        const recovered = await postJson<Verification>("/api/registration/verify", {
          transactionHash: pending.transactionHash,
          rawLabel: pending.rawLabel,
          recipient: pending.recipient,
          requester: pending.requester,
          permitId: pending.permitId,
        });
        assertRegistrationContext(invalidatedRef);
        if (!recovered.verified) {
          throw new Error(recovered.error ?? "Arc state did not confirm the pending registration.");
        }
        if (!recovered.issuerReconciled) {
          throw new Error(
            "Your name is registered, but the app is still confirming it. Please try again.",
          );
        }
        clearPendingRegistration(intentKey);
        clearStoredIntent(intentKey);
        requestRef.current = null;
        setState("success");
        setMessage(`${label}${BRAND.suffix} is now yours on Arc Testnet.`);
        router.refresh();
        return;
      }

      setTxHash(null);
      const requestId = stableRequestId(intentKey);

      setState("preparing");
      let preflight = await postJson<PreflightPlan>("/api/registration/preflight", {
        rawLabel,
        normalizationAccepted,
        durationYears: years,
        payer,
      });
      verifyPreflightLocally(
        rawLabel,
        normalizationAccepted,
        years,
        preflight,
      );
      assertRegistrationContext(invalidatedRef);

      if (preflight.approvalTransaction) {
        setState("authorizing");
        await assertArcWalletAccount(provider, payer);
        const approvalHash = (await provider.request({
          method: "eth_sendTransaction",
          params: [{
            from: payer,
            to: preflight.approvalTransaction.to,
            data: preflight.approvalTransaction.data,
            value: preflight.approvalTransaction.value ?? "0x0",
            chainId: ARC_CHAIN_HEX,
          }],
        })) as string;
        if (!/^0x[0-9a-fA-F]{64}$/.test(approvalHash)) {
          throw new Error("The wallet returned an invalid approval transaction hash.");
        }
        await waitForReceipt(provider, approvalHash, invalidatedRef);
        assertRegistrationContext(invalidatedRef);

        const approvedAmount = preflight.expectedAmount;
        preflight = await postJson<PreflightPlan>("/api/registration/preflight", {
          rawLabel,
          normalizationAccepted,
          durationYears: years,
          payer,
        });
        if (
          preflight.approvalTransaction ||
          preflight.expectedAmount !== approvedAmount
        ) {
          throw new Error("USDC authorization could not be confirmed against current Arc state.");
        }
        verifyPreflightLocally(
          rawLabel,
          normalizationAccepted,
          years,
          preflight,
        );
        assertRegistrationContext(invalidatedRef);
      }

      setState("preparing");
      let payload: RegistrationPlan;
      try {
        payload = await postJson<RegistrationPlan>("/api/registration/prepare", {
          rawLabel,
          normalizationAccepted,
          durationYears: years,
          requester: payer,
          payer,
          recipient,
          requestId,
        });
      } catch (error) {
        if (error instanceof ApiRequestError && canSafelyRotateRequestId(error)) {
          clearStoredIntent(intentKey);
          requestRef.current = null;
          throw new Error("Your previous request expired. Please try again.");
        }
        throw error;
      }
      await verifyRegistrationPlanLocally(payload, {
        rawLabel,
        normalizationAccepted,
        durationYears: years,
        payer,
        recipient,
        expectedAmount: preflight.expectedAmount,
      });
      assertRegistrationContext(invalidatedRef);

      setState("registering");
      await assertArcWalletAccount(provider, payer);
      const hash = (await provider.request({
        method: "eth_sendTransaction",
        params: [{
          from: payer,
          to: payload.registrationTransaction.to,
          data: payload.registrationTransaction.data,
          value: payload.registrationTransaction.value ?? "0x0",
          chainId: ARC_CHAIN_HEX,
        }],
      })) as string;
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new Error("The wallet returned an invalid registration transaction hash.");
      }
      setTxHash(hash);
      const pendingRegistration: PendingRegistration = {
        version: 1,
        intentKey,
        requestId,
        permitId: payload.permitId,
        transactionHash: hash as `0x${string}`,
        rawLabel,
        requester: payer,
        recipient,
      };
      savePendingRegistration(pendingRegistration);
      setState("confirming");
      try {
        await waitForReceipt(provider, hash, invalidatedRef);
      } catch (error) {
        if (error instanceof TransactionRevertedError) {
          clearPendingRegistration(intentKey);
        }
        throw error;
      }
      assertRegistrationContext(invalidatedRef);
      const verification = await postJson<Verification>("/api/registration/verify", {
        transactionHash: hash,
        rawLabel,
        recipient,
        requester: payer,
        permitId: payload.permitId,
      });
      assertRegistrationContext(invalidatedRef);
      if (!verification.verified) {
        throw new Error(verification.error ?? "Arc state did not confirm registration.");
      }
      if (!verification.issuerReconciled) {
        throw new Error(
          "Your name is registered, but the app is still confirming it. Please try again.",
        );
      }

      clearPendingRegistration(intentKey);
      clearStoredIntent(intentKey);
      requestRef.current = null;
      setState("success");
      setMessage(`${label}${BRAND.suffix} is now yours on Arc Testnet.`);
      router.refresh();
    } catch (error) {
      setState("error");
      setMessage(walletErrorMessage(error, "Registration could not continue. Please try again."));
    } finally {
      selectedProvider?.removeListener?.("accountsChanged", invalidate);
      selectedProvider?.removeListener?.("chainChanged", invalidate);
    }
  }

  const working = !["idle", "error"].includes(state);
  const normalizationBlocked = normalizationRequired && !normalizationAccepted;

  return (
    <form
      id="registration-panel"
      className="register-panel"
      aria-labelledby="registration-panel-title"
      onSubmit={register}
    >
      <div className="register-panel__heading">
        <span>Register your name</span>
        <strong id="registration-panel-title">{label}{BRAND.suffix}</strong>
      </div>
      {normalizationRequired ? (
        <label className="normalization-acceptance">
          <input
            type="checkbox"
            checked={normalizationAccepted}
            onChange={(event) => setNormalizationAccepted(event.target.checked)}
            disabled={working}
          />
          <span>
            I understand <code>{rawLabel}</code> will be registered as{" "}
            <strong>{label}{BRAND.suffix}</strong>.
          </span>
        </label>
      ) : null}
      <div className="register-field">
        <label id="registration-years-label" htmlFor="registration-years">Duration</label>
        <RegistrationDurationSelect
          value={years}
          onChange={setYears}
          disabled={working}
        />
      </div>
      <div className="register-summary">
        <div><span>Name price</span><strong>{price.toFixed(2)} USDC</strong></div>
        <div><span>Network fee</span><strong>Wallet estimate</strong></div>
        <div><span>Payment</span><strong>USDC on Arc</strong></div>
      </div>
      {!deploymentReady ? (
        <div className="secure-unavailable" role="status">
          <strong>Registration is temporarily unavailable.</strong>
          <span>Your wallet was not opened and no payment was made.</span>
        </div>
      ) : null}
      {deploymentReady && nameAvailable === false ? (
        <div className="secure-unavailable" role="status">
          <strong>This name cannot be registered now.</strong>
          <span>It is registered or still protected by the 90-day grace period.</span>
        </div>
      ) : null}
      <button
        className="register-submit"
        type="submit"
        disabled={working || normalizationBlocked || !deploymentReady || nameAvailable === false}
      >
        {state === "success" ? stateLabel.success : working ? stateLabel[state] : `Register ${label}${BRAND.suffix}`}
        <span aria-hidden="true">↗</span>
      </button>
      <p className="register-panel__approval">
        Click Register to connect your wallet. If approval is needed, your wallet
        will ask for the exact USDC amount before the registration transaction.
      </p>
      {state !== "idle" ? (
        <div className={`registration-status registration-status--${state}`} role="status">
          <span>{stateLabel[state]}</span>
          {message ? <p>{message}</p> : null}
          {txHash ? (
            <a href={`https://testnet.arcscan.app/tx/${txHash}`} target="_blank" rel="noreferrer">
              View transaction ↗
            </a>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
