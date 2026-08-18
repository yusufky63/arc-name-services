import type { Address, Hex } from "viem";
import type { RegistrationPermit } from "@contour/sdk";

export type LeaseState = "leased" | "submitted" | "confirmed" | "expired" | "released" | "failed" | "manual_review";

export interface Lease {
  labelHash: Hex;
  requester: Address;
  requestId: string;
  permitId: Hex;
  requestFingerprint: Hex;
  state: LeaseState;
  permit: RegistrationPermit;
  expiresAt: Date;
  txHash: Hex | null;
  tokenId: string | null;
}

export type AcquireLeaseResult =
  | { outcome: "acquired" | "idempotent"; lease: Lease }
  | { outcome: "conflict"; expiresAt: Date }
  | { outcome: "idempotency_conflict" };

export interface Challenge {
  id: string;
  requester: Address;
  requestId: string;
  requestFingerprint: Hex;
  normalizedLabel: string;
  expectedAmount: bigint;
  message: string;
  expiresAt: Date;
}

export type StoredChallenge = Challenge;

export interface LeaseStore {
  createChallenge(challenge: Challenge, now: Date): Promise<{ challenge: StoredChallenge; idempotent: boolean }>;
  getChallenge(id: string, requester: Address, now: Date): Promise<StoredChallenge | null>;
  consumeChallenge(id: string, requester: Address, requestFingerprint: Hex, now: Date): Promise<boolean>;
  consumeRateLimit(key: string, now: Date, windowSeconds: number, limit: number): Promise<boolean>;
  cleanupChallenges(cutoff: Date): Promise<number>;
  cleanupExpiredState(now: Date, retentionMs: number): Promise<{
    challenges: number;
    leases: number;
    rateLimits: number;
  }>;
  withRequesterLock<T>(requester: Address, task: () => Promise<T>): Promise<T>;
  acquireLease(candidate: Lease, now: Date): Promise<AcquireLeaseResult>;
  saveSignedPermit(permitId: Hex, permit: RegistrationPermit, signature: Hex): Promise<void>;
  getSignedPermit(permitId: Hex): Promise<{ permit: RegistrationPermit; signature: Hex } | null>;
  getLease(permitId: Hex): Promise<Lease | null>;
  listSubmitted(limit: number): Promise<Lease[]>;
  markSubmitted(permitId: Hex, txHash: Hex): Promise<boolean>;
  markConfirmed(permitId: Hex, txHash: Hex, tokenId: bigint): Promise<boolean>;
  markFailed(permitId: Hex, txHash: Hex): Promise<boolean>;
  markManualReview(permitId: Hex, txHash: Hex): Promise<boolean>;
  markExpired(permitId: Hex, txHash: Hex): Promise<boolean>;
  release(permitId: Hex, requester: Address): Promise<boolean>;
}

/**
 * Process-local Arc Testnet coordination store.
 *
 * Keep the issuer at one replica: leases, idempotency records and rate-limit
 * buckets intentionally live in this process, are retention-bounded, and reset
 * when it restarts.
 */
export class MemoryLeaseStore implements LeaseStore {
  readonly challenges = new Map<string, StoredChallenge>();
  readonly challengesByRequest = new Map<string, string>();
  readonly leasesByLabel = new Map<string, Lease>();
  readonly leasesByRequest = new Map<string, Lease>();
  readonly signed = new Map<string, { permit: RegistrationPermit; signature: Hex }>();
  readonly rateLimits = new Map<string, { bucket: number; count: number; expiresAt: number }>();
  private readonly requesterTails = new Map<string, Promise<void>>();

  async createChallenge(challenge: Challenge, now: Date) {
    const requestKey = `${challenge.requester}:${challenge.requestId}`;
    const existingId = this.challengesByRequest.get(requestKey);
    if (existingId) {
      const existing = this.challenges.get(existingId)!;
      if (existing.requestFingerprint !== challenge.requestFingerprint) throw new Error("idempotency key reused with different request");
      if (existing.expiresAt <= now) {
        this.challenges.delete(existingId);
        this.challenges.set(challenge.id, { ...challenge });
        this.challengesByRequest.set(requestKey, challenge.id);
        return { challenge, idempotent: false };
      }
      return { challenge: existing, idempotent: true };
    }
    this.challenges.set(challenge.id, { ...challenge });
    this.challengesByRequest.set(requestKey, challenge.id);
    return { challenge, idempotent: false };
  }

  async getChallenge(id: string, requester: Address, now: Date) {
    const challenge = this.challenges.get(id);
    if (!challenge || challenge.requester !== requester || challenge.expiresAt <= now) return null;
    return challenge;
  }

  async consumeChallenge(id: string, requester: Address, requestFingerprint: Hex, now: Date) {
    const challenge = await this.getChallenge(id, requester, now);
    if (!challenge) return false;
    return challenge.requestFingerprint === requestFingerprint;
  }

  async consumeRateLimit(key: string, now: Date, windowSeconds: number, limit: number) {
    const windowMs = windowSeconds * 1_000;
    const bucket = Math.floor(now.getTime() / windowMs);
    const previous = this.rateLimits.get(key);
    const count = previous?.bucket === bucket ? previous.count + 1 : 1;
    this.rateLimits.set(key, { bucket, count, expiresAt: (bucket + 1) * windowMs });
    return count <= limit;
  }

  async cleanupChallenges(cutoff: Date) {
    let removed = 0;
    for (const [id, challenge] of this.challenges) {
      if (challenge.expiresAt > cutoff) continue;
      this.challenges.delete(id);
      const requestKey = `${challenge.requester}:${challenge.requestId}`;
      if (this.challengesByRequest.get(requestKey) === id) this.challengesByRequest.delete(requestKey);
      removed += 1;
    }
    return removed;
  }

  async cleanupExpiredState(now: Date, retentionMs: number) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
      throw new Error("memory retention must be a non-negative safe integer");
    }
    const cutoff = new Date(now.getTime() - retentionMs);
    const challenges = await this.cleanupChallenges(cutoff);
    const removedPermits = new Set<string>();
    let leases = 0;

    for (const [requestKey, lease] of this.leasesByRequest) {
      if (lease.expiresAt > cutoff) continue;
      this.leasesByRequest.delete(requestKey);
      const current = this.leasesByLabel.get(lease.labelHash);
      if (current?.permitId === lease.permitId) this.leasesByLabel.delete(lease.labelHash);
      this.signed.delete(lease.permitId);
      removedPermits.add(lease.permitId);
      leases += 1;
    }
    // Defensive cleanup for an orphaned label entry. Normal acquisition always
    // writes both indexes, but bounded memory must not rely on that invariant.
    for (const [labelHash, lease] of this.leasesByLabel) {
      if (lease.expiresAt > cutoff) continue;
      this.leasesByLabel.delete(labelHash);
      this.signed.delete(lease.permitId);
      if (!removedPermits.has(lease.permitId)) leases += 1;
    }

    let rateLimits = 0;
    for (const [key, bucket] of this.rateLimits) {
      if (bucket.expiresAt > now.getTime()) continue;
      this.rateLimits.delete(key);
      rateLimits += 1;
    }
    return { challenges, leases, rateLimits };
  }

  async withRequesterLock<T>(requester: Address, task: () => Promise<T>): Promise<T> {
    const key = requester.toLowerCase();
    const previous = this.requesterTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.requesterTails.set(key, tail);
    await previous;
    try { return await task(); }
    finally {
      release();
      if (this.requesterTails.get(key) === tail) this.requesterTails.delete(key);
    }
  }

  async acquireLease(candidate: Lease, now: Date): Promise<AcquireLeaseResult> {
    const requestKey = `${candidate.requester}:${candidate.requestId}`;
    const priorRequest = this.leasesByRequest.get(requestKey);
    if (priorRequest) {
      if (priorRequest.requestFingerprint !== candidate.requestFingerprint) return { outcome: "idempotency_conflict" };
      return { outcome: "idempotent", lease: priorRequest };
    }
    const exclusiveStates: LeaseState[] = ["leased", "submitted", "failed", "manual_review"];
    const requesterLease = [...this.leasesByLabel.values()].find((item) =>
      item.requester === candidate.requester && exclusiveStates.includes(item.state) &&
      (item.state === "submitted" || item.state === "manual_review" || item.expiresAt > now),
    );
    if (requesterLease) return { outcome: "conflict", expiresAt: requesterLease.expiresAt };
    const current = this.leasesByLabel.get(candidate.labelHash);
    if (current && exclusiveStates.includes(current.state) &&
        (current.state === "submitted" || current.state === "manual_review" || current.expiresAt > now)) {
      if (current.requester === candidate.requester && current.requestFingerprint === candidate.requestFingerprint) {
        return { outcome: "idempotent", lease: current };
      }
      return { outcome: "conflict", expiresAt: current.expiresAt };
    }
    if (current && current.state !== "submitted" && current.state !== "manual_review" &&
        exclusiveStates.includes(current.state) && current.expiresAt <= now) {
      current.state = "expired";
    }
    this.leasesByLabel.set(candidate.labelHash, candidate);
    this.leasesByRequest.set(requestKey, candidate);
    return { outcome: "acquired", lease: candidate };
  }

  async saveSignedPermit(permitId: Hex, permit: RegistrationPermit, signature: Hex) {
    const previous = this.signed.get(permitId);
    if (previous && previous.signature !== signature) throw new Error("permit signature is immutable");
    this.signed.set(permitId, { permit, signature });
  }

  async getSignedPermit(permitId: Hex) {
    return this.signed.get(permitId) ?? null;
  }

  async getLease(permitId: Hex) {
    return [...this.leasesByLabel.values()].find((item) => item.permitId === permitId) ?? null;
  }

  async listSubmitted(limit: number) {
    return [...this.leasesByLabel.values()].filter((item) => item.state === "submitted").slice(0, limit);
  }

  async markSubmitted(permitId: Hex, txHash: Hex) {
    const lease = [...this.leasesByLabel.values()].find((item) => item.permitId === permitId);
    if (!lease || (lease.state !== "leased" && !(lease.state === "submitted" && lease.txHash === txHash))) return false;
    lease.state = "submitted";
    lease.txHash = txHash;
    return true;
  }

  async markConfirmed(permitId: Hex, txHash: Hex, tokenId: bigint) {
    const lease = [...this.leasesByLabel.values()].find((item) => item.permitId === permitId);
    if (lease?.state === "confirmed") {
      return lease.txHash === txHash && lease.tokenId === tokenId.toString();
    }
    if (!lease || lease.state !== "submitted" || lease.txHash !== txHash) return false;
    lease.state = "confirmed";
    lease.tokenId = tokenId.toString();
    return true;
  }

  async markFailed(permitId: Hex, txHash: Hex) {
    const lease = await this.getLease(permitId);
    if (lease?.state === "failed") return lease.txHash === txHash;
    if (!lease || lease.state !== "submitted" || lease.txHash !== txHash) return false;
    lease.state = "failed";
    return true;
  }

  async markManualReview(permitId: Hex, txHash: Hex) {
    const lease = await this.getLease(permitId);
    if (lease?.state === "manual_review") return lease.txHash === txHash;
    if (!lease || lease.state !== "submitted" || lease.txHash !== txHash) return false;
    lease.state = "manual_review";
    return true;
  }

  async markExpired(permitId: Hex, txHash: Hex) {
    const lease = await this.getLease(permitId);
    if (lease?.state === "expired") return lease.txHash === txHash;
    if (!lease || lease.state !== "submitted" || lease.txHash !== txHash) return false;
    lease.state = "expired";
    return true;
  }

  async release(permitId: Hex, requester: Address) {
    const lease = [...this.leasesByLabel.values()].find((item) => item.permitId === permitId);
    if (!lease || lease.requester !== requester || lease.state !== "leased") return false;
    lease.state = "released";
    return true;
  }
}
