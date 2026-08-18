import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  getAddress,
  verifyMessage,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import {
  ARC_TESTNET_CHAIN_ID,
  requireActivatedContract,
  type DeploymentManifest,
} from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";
import type { RegistrationPermit } from "@contour/sdk";
import type { Lease, LeaseStore } from "./domain.js";
import type { PermitSigner } from "./signer.js";

export interface ChainPolicyReader {
  quote(normalizedLabel: string, durationYears: bigint): Promise<bigint>;
  nonce(requester: Address): Promise<bigint>;
  available(tokenId: bigint): Promise<boolean>;
  allowance(payer: Address): Promise<bigint>;
  referralBps(): Promise<bigint>;
  health(): Promise<{ chainId: number; permitSigner: Address; signerPolicyVersion: bigint; registrationsPaused: boolean }>;
  inspectSubmission(txHash: Hex): Promise<SubmissionInspection>;
  expiryProof(permit: RegistrationPermit): Promise<{
    blockTimestamp: bigint;
    usedPermit: boolean;
    requesterNonce: bigint;
    available: boolean;
  }>;
}

export type SubmissionInspection =
  | { state: "unknown" }
  | {
      state: "pending" | "reverted" | "invalid" | "success";
      transactionFrom: Address;
      transactionTo: Address;
      permitId: Hex;
      requester: Address;
      labelHash: Hex;
      tokenId?: bigint;
    };

export interface PermitIssuerPolicy {
  ttlSeconds: number;
  challengeTtlSeconds: number;
  maxDurationYears: number;
}

export interface PermitIntentRequest {
  requestId: string;
  rawLabel: string;
  normalizationAccepted: boolean;
  requester: Address;
  recipient: Address;
  payer: Address;
  authorizedExecutor: Address;
  durationYears: number;
  resolverDataHash: Hex;
  referrer?: Address;
}

export interface ChallengeRequest extends PermitIntentRequest {}

export interface PermitRequest extends PermitIntentRequest {
  challengeId: string;
  challengeSignature: Hex;
}

export class LeaseConflictError extends Error {
  constructor(readonly expiresAt: Date) {
    super("label currently has an active registration permit");
    this.name = "LeaseConflictError";
  }
}

export class IdempotencyConflictError extends Error {
  constructor() {
    super("requestId was already used for a different registration intent");
    this.name = "IdempotencyConflictError";
  }
}

export class RequestIdExpiredError extends Error {
  constructor(readonly retryAfter: Date) {
    super("the stored permit for this requestId expired; rotate requestId after the lease safety window");
    this.name = "RequestIdExpiredError";
  }
}

export class IntentStaleError extends Error {
  constructor() {
    super("signed registration intent no longer matches current quote or policy");
    this.name = "IntentStaleError";
  }
}

export class IssuerNotReadyError extends Error {
  constructor() {
    super("permit issuer live policy is not ready");
    this.name = "IssuerNotReadyError";
  }
}

function fingerprint(value: unknown): Hex {
  return `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

export class PermitIssuerService {
  private reconciliationInFlight: Promise<Array<{ permitId: Hex; state: string }>> | null = null;

  constructor(
    readonly manifest: DeploymentManifest,
    readonly store: LeaseStore,
    readonly signer: PermitSigner,
    readonly chain: ChainPolicyReader,
    readonly policy: PermitIssuerPolicy,
    readonly challengeOrigin: string,
    readonly now: () => Date = () => new Date(),
  ) {}

  private async assertLivePolicy(): Promise<void> {
    const expectedSigner = this.manifest.permitIssuer.signerAddress;
    const expectedPolicyVersion = this.manifest.permitIssuer.policyVersion;
    if (!expectedSigner || !expectedPolicyVersion || !this.manifest.permitIssuer.active) {
      throw new IssuerNotReadyError();
    }
    try {
      const live = await this.chain.health();
      if (
        live.chainId !== ARC_TESTNET_CHAIN_ID ||
        getAddress(live.permitSigner) !== getAddress(expectedSigner) ||
        live.signerPolicyVersion.toString() !== expectedPolicyVersion ||
        live.registrationsPaused
      ) {
        throw new IssuerNotReadyError();
      }
    } catch (error) {
      if (error instanceof IssuerNotReadyError) throw error;
      throw new IssuerNotReadyError();
    }
  }

  private prepareIntent(input: PermitIntentRequest) {
    if (input.requestId.length < 8 || input.requestId.length > 128) throw new Error("requestId is outside policy");
    if (!/^0x[0-9a-fA-F]{64}$/.test(input.resolverDataHash)) throw new Error("resolverDataHash must be bytes32");
    if (!Number.isInteger(input.durationYears) || input.durationYears < 1 || input.durationYears > this.policy.maxDurationYears) {
      throw new Error("durationYears is outside policy");
    }
    const requester = getAddress(input.requester);
    const recipient = getAddress(input.recipient);
    const payer = getAddress(input.payer);
    const executor = getAddress(input.authorizedExecutor);
    if ([requester, recipient, payer, executor].some((address) => address === zeroAddress)) {
      throw new Error("requester, recipient, payer and executor must be non-zero");
    }
    if (payer !== requester || executor !== requester) {
      throw new Error("wallet-bound route requires requester, payer and executor to match");
    }
    const suffix = this.manifest.namespace.suffix;
    const releaseId = this.manifest.releaseId;
    if (!suffix || !releaseId || !this.manifest.permitIssuer.active) throw new Error("permit issuance is not active");
    const identity = deriveNameIdentity(input.rawLabel, suffix);
    if (identity.changed && !input.normalizationAccepted) {
      throw new Error(`normalization changed the label to ${identity.normalized}; explicit acceptance is required`);
    }
    const referrer = getAddress(input.referrer ?? zeroAddress);
    if (referrer !== zeroAddress && (referrer === payer || referrer === recipient)) {
      throw new Error("referrer must differ from payer and recipient");
    }
    return {
      requestId: input.requestId,
      identity,
      requester,
      recipient,
      payer,
      executor,
      durationYears: input.durationYears,
      resolverDataHash: input.resolverDataHash,
      referrer,
      controller: requireActivatedContract(this.manifest, "controller"),
      releaseId,
      suffix,
    };
  }

  private intentFingerprint(
    prepared: ReturnType<PermitIssuerService["prepareIntent"]>,
    expectedAmount: bigint,
    expectedReferralBps: bigint,
  ) {
    return fingerprint({
      requestId: prepared.requestId,
      normalizedLabel: prepared.identity.normalized,
      labelHash: prepared.identity.labelhash,
      namehash: prepared.identity.namehash,
      requester: prepared.requester,
      recipient: prepared.recipient,
      payer: prepared.payer,
      authorizedExecutor: prepared.executor,
      durationYears: prepared.durationYears,
      resolverDataHash: prepared.resolverDataHash,
      referrer: prepared.referrer,
      chainId: ARC_TESTNET_CHAIN_ID,
      controller: prepared.controller,
      releaseId: prepared.releaseId,
      normalizationProfileHash: this.manifest.normalization.profileHash,
      settlementAsset: this.manifest.settlement.erc20Address,
      expectedAmount: expectedAmount.toString(),
      expectedReferralBps: expectedReferralBps.toString(),
      origin: this.challengeOrigin,
    });
  }

  private checkedReferralBps(referrer: Address, configured: bigint) {
    const expected = referrer === zeroAddress ? 0n : configured;
    if (expected < 0n || expected > 10_000n) throw new Error("controller referral BPS is invalid");
    return expected;
  }

  async createChallenge(input: ChallengeRequest) {
    const prepared = this.prepareIntent(input);
    await this.assertLivePolicy();
    const [expectedAmount, configuredReferralBps] = await Promise.all([
      this.chain.quote(prepared.identity.normalized, BigInt(prepared.durationYears)),
      this.chain.referralBps(),
    ]);
    if (expectedAmount <= 0n) throw new Error("controller returned a non-positive quote");
    const expectedReferralBps = this.checkedReferralBps(prepared.referrer, configuredReferralBps);
    const requestFingerprint = this.intentFingerprint(prepared, expectedAmount, expectedReferralBps);
    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.policy.challengeTtlSeconds * 1_000);
    const origin = new URL(this.challengeOrigin);
    const challenge = {
      id: randomUUID(),
      requester: prepared.requester,
      requestId: prepared.requestId,
      requestFingerprint,
      normalizedLabel: prepared.identity.normalized,
      expectedAmount,
      message: [
        "Contour Name Protocol registration intent",
        `Domain: ${origin.hostname}`,
        `Origin: ${origin.origin}`,
        `Chain ID: ${ARC_TESTNET_CHAIN_ID}`,
        `Controller: ${prepared.controller}`,
        `Release ID: ${prepared.releaseId}`,
        `Request ID: ${prepared.requestId}`,
        `Name: ${prepared.identity.name}`,
        `Requester: ${prepared.requester}`,
        `Recipient: ${prepared.recipient}`,
        `Payer: ${prepared.payer}`,
        `Authorized executor: ${prepared.executor}`,
        `Duration: ${prepared.durationYears} year(s)`,
        `Exact amount: ${expectedAmount} USDC base units`,
        `Resolver data hash: ${prepared.resolverDataHash}`,
        `Referrer: ${prepared.referrer}`,
        `Expected referral BPS: ${expectedReferralBps}`,
        `Intent fingerprint: ${requestFingerprint}`,
        `Challenge: 0x${randomBytes(32).toString("hex")}`,
        `Issued at: ${Math.floor(now.getTime() / 1000)}`,
        `Expires at: ${Math.floor(expiresAt.getTime() / 1000)}`,
      ].join("\n"),
      expiresAt,
    };
    const stored = await this.store.createChallenge(challenge, now);
    return {
      ...stored.challenge,
      fullName: `${stored.challenge.normalizedLabel}.${prepared.suffix}`,
      idempotent: stored.idempotent,
    };
  }

  async issue(input: PermitRequest): Promise<{ normalizedLabel: string; permit: RegistrationPermit; signature: Hex; idempotent: boolean }> {
    if (this.policy.ttlSeconds < 15 || this.policy.ttlSeconds > 295) {
      throw new Error("permit TTL must be in 15..295 seconds when using a 5-second validAfter skew");
    }
    const prepared = this.prepareIntent(input);
    const challengeNow = this.now();
    const challenge = await this.store.getChallenge(input.challengeId, prepared.requester, challengeNow);
    if (!challenge) throw new Error("challenge is invalid or expired");
    if (challenge.requestId !== prepared.requestId) throw new Error("challenge requestId does not match");
    const verified = await verifyMessage({ address: prepared.requester, message: challenge.message, signature: input.challengeSignature });
    if (!verified) throw new Error("wallet challenge signature is invalid");
    return this.store.withRequesterLock(prepared.requester, async () => {
      await this.assertLivePolicy();
      const issuanceNow = this.now();
      const durationYears = BigInt(prepared.durationYears);
      const [expectedAmount, nonce, available, configuredReferralBps] = await Promise.all([
        this.chain.quote(prepared.identity.normalized, durationYears),
        this.chain.nonce(prepared.requester),
        this.chain.available(prepared.identity.tokenId),
        this.chain.referralBps(),
      ]);
      const expectedReferralBps = this.checkedReferralBps(prepared.referrer, configuredReferralBps);
      if (expectedAmount <= 0n) throw new Error("controller returned a non-positive quote");
      const requestFingerprint = this.intentFingerprint(prepared, expectedAmount, expectedReferralBps);
      if (challenge.requestFingerprint !== requestFingerprint || challenge.expectedAmount !== expectedAmount) {
        throw new IntentStaleError();
      }
      if (!await this.store.consumeChallenge(input.challengeId, prepared.requester, requestFingerprint, issuanceNow)) {
        throw new Error("challenge was already consumed by a different request or expired");
      }
      if (!available) throw new Error("name is not available");
      if (await this.chain.allowance(prepared.payer) < expectedAmount) {
        throw new Error("USDC authorization is required before a registration permit can be issued");
      }
      const permitId = `0x${randomBytes(32).toString("hex")}` as Hex;
      const permitValidUntil = new Date(issuanceNow.getTime() + this.policy.ttlSeconds * 1_000);
      // The reservation stays closed for 30 seconds after signature expiry.
      const expiresAt = new Date(permitValidUntil.getTime() + 30_000);
      const issuedAt = BigInt(Math.floor(issuanceNow.getTime() / 1_000));
      const permit: RegistrationPermit = {
        chainId: BigInt(ARC_TESTNET_CHAIN_ID),
        controller: prepared.controller,
        releaseId: prepared.releaseId,
        normalizationProfileHash: this.manifest.normalization.profileHash,
        normalizedLabelHash: prepared.identity.labelhash,
        namehash: prepared.identity.namehash,
        requester: prepared.requester,
        recipient: prepared.recipient,
        payer: prepared.payer,
        authorizedExecutor: prepared.executor,
        durationYears,
        resolverDataHash: prepared.resolverDataHash,
        referrer: prepared.referrer,
        settlementAsset: this.manifest.settlement.erc20Address,
        expectedAmount,
        expectedReferralBps,
        permitId,
        nonce,
        issuedAt,
        validAfter: issuedAt - 5n,
        validUntil: BigInt(Math.floor(permitValidUntil.getTime() / 1_000)),
      };
      const candidate: Lease = {
        labelHash: prepared.identity.labelhash,
        requester: prepared.requester,
        requestId: prepared.requestId,
        permitId,
        requestFingerprint,
        state: "leased",
        permit,
        expiresAt,
        txHash: null,
        tokenId: null,
      };
      const acquired = await this.store.acquireLease(candidate, issuanceNow);
      if (acquired.outcome === "conflict") throw new LeaseConflictError(acquired.expiresAt);
      if (acquired.outcome === "idempotency_conflict") throw new IdempotencyConflictError();

      const storedPermit = acquired.lease.permit;
      if (storedPermit.validUntil < BigInt(Math.floor(issuanceNow.getTime() / 1_000)) || acquired.lease.expiresAt <= issuanceNow) {
        throw new RequestIdExpiredError(acquired.lease.expiresAt);
      }
      const existing = await this.store.getSignedPermit(acquired.lease.permitId);
      if (existing) return { normalizedLabel: prepared.identity.normalized, ...existing, idempotent: true };
      if (acquired.lease.state !== "leased") throw new Error("idempotent permit is no longer signable");

      const signature = await this.signer.sign(storedPermit);
      await this.store.saveSignedPermit(storedPermit.permitId, storedPermit, signature);
      return { normalizedLabel: prepared.identity.normalized, permit: storedPermit, signature, idempotent: acquired.outcome === "idempotent" };
    });
  }

  private inspectionMatches(lease: Lease, inspection: Exclude<SubmissionInspection, { state: "unknown" }>) {
    return getAddress(inspection.transactionFrom) === getAddress(lease.permit.authorizedExecutor) &&
      getAddress(inspection.transactionTo) === getAddress(lease.permit.controller) &&
      inspection.permitId.toLowerCase() === lease.permitId.toLowerCase() &&
      getAddress(inspection.requester) === getAddress(lease.requester) &&
      inspection.labelHash.toLowerCase() === lease.labelHash.toLowerCase();
  }

  async recordSubmission(input: { permitId: Hex; requester: Address; txHash: Hex }) {
    const requester = getAddress(input.requester);
    return this.store.withRequesterLock(requester, async () => {
      const lease = await this.store.getLease(input.permitId);
      if (!lease || getAddress(lease.requester) !== requester) throw new Error("permit lease not found");
      if (lease.txHash && lease.txHash.toLowerCase() !== input.txHash.toLowerCase()) {
        throw new Error("permit lease is already bound to a different transaction");
      }
      if (lease.txHash) {
        if (lease.state === "submitted" || lease.state === "failed" || lease.state === "manual_review") {
          return { permitId: lease.permitId, txHash: lease.txHash, state: lease.state };
        }
        if (lease.state === "confirmed" && lease.tokenId !== null) {
          return {
            permitId: lease.permitId,
            txHash: lease.txHash,
            tokenId: BigInt(lease.tokenId),
            state: "confirmed" as const,
          };
        }
      }
      const inspection = await this.chain.inspectSubmission(input.txHash);
      if (inspection.state === "unknown") throw new Error("registration transaction is not visible on Arc RPC");
      if (!this.inspectionMatches(lease, inspection)) throw new Error("registration transaction does not match the stored permit");
      if (lease.state === "confirmed" || lease.state === "failed" || lease.state === "manual_review") {
        throw new Error("stored submission state is missing its transaction binding");
      }
      if (lease.state !== "leased" && lease.state !== "submitted") throw new Error("lease cannot accept a submission");
      if (!await this.store.markSubmitted(lease.permitId, input.txHash)) throw new Error("lease cannot transition to submitted");
      if (inspection.state === "pending") return { permitId: lease.permitId, txHash: input.txHash, state: "submitted" as const };
      if (inspection.state === "reverted") {
        if (!await this.store.markFailed(lease.permitId, input.txHash)) throw new Error("lease cannot transition to failed");
        return { permitId: lease.permitId, txHash: input.txHash, state: "failed" as const };
      }
      if (inspection.state === "invalid" || inspection.tokenId !== BigInt(lease.labelHash)) {
        if (!await this.store.markManualReview(lease.permitId, input.txHash)) {
          throw new Error("lease cannot transition to manual review");
        }
        return { permitId: lease.permitId, txHash: input.txHash, state: "manual_review" as const };
      }
      if (!await this.store.markConfirmed(lease.permitId, input.txHash, inspection.tokenId)) {
        throw new Error("lease cannot transition to confirmed");
      }
      return { permitId: lease.permitId, txHash: input.txHash, tokenId: inspection.tokenId, state: "confirmed" as const };
    });
  }

  private async reconcileSubmittedOnce(limit: number) {
    const leases = await this.store.listSubmitted(limit);
    const results: Array<{ permitId: Hex; state: string }> = [];
    for (const candidate of leases) {
      if (!candidate.txHash) continue;
      try {
        const result = await this.store.withRequesterLock(candidate.requester, async () => {
          const lease = await this.store.getLease(candidate.permitId);
          if (!lease || lease.state !== "submitted" || !lease.txHash || lease.txHash !== candidate.txHash) return null;
          const inspection = await this.chain.inspectSubmission(lease.txHash);
          if (inspection.state === "unknown" || inspection.state === "pending") {
            if (this.now() < lease.expiresAt) return null;
            const proof = await this.chain.expiryProof(lease.permit);
            if (proof.blockTimestamp <= lease.permit.validUntil) return null;
            if (proof.usedPermit) {
              return await this.store.markManualReview(lease.permitId, lease.txHash)
                ? { permitId: lease.permitId, state: "manual_review" }
                : null;
            }
            return await this.store.markExpired(lease.permitId, lease.txHash)
              ? { permitId: lease.permitId, state: "expired" }
              : null;
          }
          if (!this.inspectionMatches(lease, inspection)) {
            return await this.store.markManualReview(lease.permitId, lease.txHash)
              ? { permitId: lease.permitId, state: "manual_review" }
              : null;
          }
          if (inspection.state === "reverted") {
            return await this.store.markFailed(lease.permitId, lease.txHash)
              ? { permitId: lease.permitId, state: "failed" }
              : null;
          }
          if (inspection.state === "success" && inspection.tokenId === BigInt(lease.labelHash)) {
            return await this.store.markConfirmed(lease.permitId, lease.txHash, inspection.tokenId)
              ? { permitId: lease.permitId, state: "confirmed" }
              : null;
          }
          return await this.store.markManualReview(lease.permitId, lease.txHash)
            ? { permitId: lease.permitId, state: "manual_review" }
            : null;
        });
        if (result) results.push(result);
      } catch {
        // A transient RPC failure leaves the submitted lease closed for retry.
      }
    }
    return results;
  }

  async reconcileSubmitted(limit = 100) {
    if (this.reconciliationInFlight) return this.reconciliationInFlight;
    const operation = this.reconcileSubmittedOnce(limit);
    this.reconciliationInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.reconciliationInFlight === operation) this.reconciliationInFlight = null;
    }
  }
}
