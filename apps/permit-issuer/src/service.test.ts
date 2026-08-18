import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CANONICAL_NORMALIZATION, EXPECTED_RESOLVER_CAPABILITIES, parseDeploymentManifest } from "@contour/config";
import type { RegistrationPermit } from "@contour/sdk";
import { MemoryLeaseStore, type Lease } from "./domain.js";
import {
  IssuerNotReadyError,
  PermitIssuerService,
  RequestIdExpiredError,
  type ChainPolicyReader,
  type PermitIntentRequest,
} from "./service.js";
import type { PermitSigner } from "./signer.js";

function permitFixture(requester: Address, labelHash: Hex, permitId: Hex): RegistrationPermit {
  return {
    chainId: 5_042_002n,
    controller: "0x2222222222222222222222222222222222222222",
    releaseId: `0x${"10".repeat(32)}`,
    normalizationProfileHash: `0x${"11".repeat(32)}`,
    normalizedLabelHash: labelHash,
    namehash: `0x${"12".repeat(32)}`,
    requester,
    recipient: requester,
    payer: requester,
    authorizedExecutor: requester,
    durationYears: 1n,
    resolverDataHash: `0x${"00".repeat(32)}`,
    referrer: "0x0000000000000000000000000000000000000000",
    settlementAsset: "0x3600000000000000000000000000000000000000",
    expectedAmount: 1_000_000n,
    expectedReferralBps: 0n,
    permitId,
    nonce: 0n,
    issuedAt: 1_893_456_000n,
    validAfter: 1_893_455_995n,
    validUntil: 1_893_456_180n,
  };
}

function activeManifest(signerAddress: Address) {
  const contracts = Object.fromEntries(
    ["registry", "baseRegistrar", "controller", "publicResolver", "reverseRegistrar", "universalResolver", "marketplace"].map((key, index) => [
      key,
      {
        address: `0x${(index + 1).toString(16).padStart(40, "0")}`,
        deploymentBlock: index + 100,
        transactionHash: `0x${(index + 1).toString(16).padStart(64, "0")}`,
        runtimeCodeHash: `0x${(index + 10).toString(16).padStart(64, "0")}`,
        abiUrl: `https://example.com/${key}.json`,
        abiSha256: `0x${(index + 20).toString(16).padStart(64, "0")}`,
        sourceVerified: true,
        sourceVerificationUrl: `https://testnet.arcscan.app/api/v2/smart-contracts/0x${(index + 1).toString(16).padStart(40, "0")}`,
        sourceVerificationSha256: `0x${(index + 30).toString(16).padStart(64, "0")}`,
      },
    ]),
  );
  return parseDeploymentManifest({
    schemaVersion: "1.1.0", state: "active", releaseId: `0x${"99".repeat(32)}`, testnet: true,
    chain: {
      id: 5_042_002, caip2: "eip155:5042002", rpcUrl: "https://rpc.testnet.arc.network",
      websocketUrl: "wss://rpc.testnet.arc.network", explorerUrl: "https://testnet.arcscan.app",
      multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11", confirmations: 1,
    },
    settlement: {
      symbol: "USDC", erc20Address: "0x3600000000000000000000000000000000000000",
      applicationDecimals: 6, nativeInterfaceDecimals: 18, sharedUnderlyingBalance: true,
    },
    namespace: {
      brand: "Contour Name Protocol", suffix: "contour",
      baseNode: "0xb0622ac8c513b1e04f26418271b595fae314dbed2e3dea63916fc45cde7c5bbe",
    },
    normalization: { ...CANONICAL_NORMALIZATION },
    contracts,
    activationEvidence: {
      productLive: true,
      verifiedAtBlock: 200,
      artifacts: {
        deploymentReceipts: { url: "https://example.com/evidence/deployments.json", sha256: `0x${"40".repeat(32)}` },
        constructorWiring: { url: "https://example.com/evidence/wiring.json", sha256: `0x${"41".repeat(32)}` },
        governanceRoles: { url: "https://example.com/evidence/governance.json", sha256: `0x${"42".repeat(32)}` },
        treasuryControls: { url: "https://example.com/evidence/treasury.json", sha256: `0x${"43".repeat(32)}` },
        signerPolicy: { url: "https://example.com/evidence/signer.json", sha256: `0x${"44".repeat(32)}` },
        releaseAttestation: { url: "https://example.com/evidence/release.json", sha256: `0x${"45".repeat(32)}` },
        fundedEndToEnd: { url: "https://example.com/evidence/funded.json", sha256: `0x${"46".repeat(32)}` },
        operationsDrill: { url: "https://example.com/evidence/operations.json", sha256: `0x${"47".repeat(32)}` },
      },
      governance: {
        account: signerAddress,
      },
      controllerPolicy: {
        permitSigner: signerAddress,
        signerPolicyVersion: "1",
        referralBps: 250,
        registrationsPaused: false,
      },
      marketplacePolicy: { feeBps: 250, paused: false },
    },
    permitIssuer: {
      url: "https://issuer.example.com", signerAddress, publicKey: null, policyVersion: "1", active: true,
    },
    resolverCapabilities: { ...EXPECTED_RESOLVER_CAPABILITIES },
    discovery: { manifestUrl: null, agentManifestUrl: null, mcpUrl: null, openApiUrl: null },
    bens: { protocolConfigured: false, subgraphSynced: false, apiUrl: null, subgraphUrl: null, hostedArcscanActive: false },
    x402: {
      active: false, network: "eip155:5042002", asset: "0x3600000000000000000000000000000000000000",
      scheme: "exact", facilitatorUrl: null,
    },
  });
}

function chainPolicy(overrides: Partial<ChainPolicyReader> = {}): ChainPolicyReader {
  return {
    quote: async (_label, duration) => duration * 1_000_000n,
    nonce: async () => 7n,
    available: async () => true,
    allowance: async () => 100_000_000n,
    referralBps: async () => 250n,
    health: async () => ({
      chainId: 5_042_002,
      permitSigner: signerAccount.address,
      signerPolicyVersion: 1n,
      registrationsPaused: false,
    }),
    inspectSubmission: async () => ({ state: "unknown" }),
    expiryProof: async (permit) => ({
      blockTimestamp: permit.validUntil + 1n,
      usedPermit: false,
      requesterNonce: permit.nonce,
      available: true,
    }),
    ...overrides,
  };
}

const signerAccount = privateKeyToAccount(`0x${"01".repeat(32)}`);
const localSignerHealth = async () => ({ signerAddress: signerAccount.address, signerKind: "local-private-key" as const });

function intent(overrides: Partial<PermitIntentRequest> = {}): PermitIntentRequest {
  return {
    requestId: "request-0001",
    rawLabel: "alice",
    normalizationAccepted: true,
    requester: signerAccount.address,
    recipient: signerAccount.address,
    payer: signerAccount.address,
    authorizedExecutor: signerAccount.address,
    durationYears: 1,
    resolverDataHash: `0x${"00".repeat(32)}`,
    ...overrides,
  };
}

const lease = (
  fingerprint: `0x${string}`,
  requester: Address = "0x1111111111111111111111111111111111111111",
  requestId = "request-0001",
  labelHash: `0x${string}` = `0x${"aa".repeat(32)}`,
): Lease => ({
  labelHash,
  requester,
  requestId,
  permitId: `0x${"bb".repeat(32)}`,
  requestFingerprint: fingerprint,
  state: "leased",
  permit: permitFixture(requester, labelHash, `0x${"bb".repeat(32)}`),
  expiresAt: new Date("2030-01-01T00:01:00Z"),
  txHash: null,
  tokenId: null,
});

describe("atomic label lease", () => {
  it("pre-binds a signed challenge to exactly one intent", async () => {
    const store = new MemoryLeaseStore();
    const requester: Address = "0x1111111111111111111111111111111111111111";
    const first = `0x${"01".repeat(32)}` as const;
    await store.createChallenge({
      id: "00000000-0000-4000-8000-000000000001", requester, requestId: "request-0001",
      requestFingerprint: first, normalizedLabel: "alice", expectedAmount: 1_000_000n,
      message: "challenge", expiresAt: new Date("2030-01-01T00:01:00Z"),
    }, new Date("2030-01-01T00:00:00Z"));
    expect(await store.consumeChallenge("00000000-0000-4000-8000-000000000001", requester, first, new Date("2030-01-01T00:00:00Z"))).toBe(true);
    expect(await store.consumeChallenge("00000000-0000-4000-8000-000000000001", requester, first, new Date("2030-01-01T00:00:01Z"))).toBe(true);
    expect(await store.consumeChallenge("00000000-0000-4000-8000-000000000001", requester, `0x${"02".repeat(32)}`, new Date("2030-01-01T00:00:01Z"))).toBe(false);
  });

  it("returns the same lease for an idempotent retry", async () => {
    const store = new MemoryLeaseStore();
    const first = await store.acquireLease(lease(`0x${"01".repeat(32)}`), new Date("2030-01-01T00:00:00Z"));
    const second = await store.acquireLease({ ...lease(`0x${"01".repeat(32)}`), permitId: `0x${"cc".repeat(32)}` }, new Date("2030-01-01T00:00:01Z"));
    expect(first.outcome).toBe("acquired");
    expect(second.outcome).toBe("idempotent");
    if (second.outcome === "idempotent" || second.outcome === "acquired") expect(second.lease.permitId).toBe(`0x${"bb".repeat(32)}`);
  });

  it("rejects a concurrent different request", async () => {
    const store = new MemoryLeaseStore();
    await store.acquireLease(lease(`0x${"01".repeat(32)}`), new Date("2030-01-01T00:00:00Z"));
    const raced = await store.acquireLease(lease(`0x${"02".repeat(32)}`, "0x2222222222222222222222222222222222222222"), new Date("2030-01-01T00:00:01Z"));
    expect(raced.outcome).toBe("conflict");
  });

  it("replaces an expired lease", async () => {
    const store = new MemoryLeaseStore();
    const old = lease(`0x${"01".repeat(32)}`);
    old.expiresAt = new Date("2030-01-01T00:00:02Z");
    await store.acquireLease(old, new Date("2030-01-01T00:00:00Z"));
    const next = lease(`0x${"02".repeat(32)}`, "0x2222222222222222222222222222222222222222");
    const result = await store.acquireLease(next, new Date("2030-01-01T00:00:03Z"));
    expect(result.outcome).toBe("acquired");
  });

  it("rejects requestId reuse globally even when the label differs", async () => {
    const store = new MemoryLeaseStore();
    await store.acquireLease(lease(`0x${"01".repeat(32)}`), new Date("2030-01-01T00:00:00Z"));
    const result = await store.acquireLease(
      lease(`0x${"02".repeat(32)}`, "0x1111111111111111111111111111111111111111", "request-0001", `0x${"dd".repeat(32)}`),
      new Date("2030-01-01T00:00:01Z"),
    );
    expect(result.outcome).toBe("idempotency_conflict");
  });

  it("allows only one active nonce-bearing lease per requester", async () => {
    const store = new MemoryLeaseStore();
    await store.acquireLease(lease(`0x${"01".repeat(32)}`), new Date("2030-01-01T00:00:00Z"));
    const result = await store.acquireLease(
      lease(`0x${"02".repeat(32)}`, "0x1111111111111111111111111111111111111111", "request-0002", `0x${"dd".repeat(32)}`),
      new Date("2030-01-01T00:00:01Z"),
    );
    expect(result.outcome).toBe("conflict");
  });

  it("serializes concurrent issuance work for one requester", async () => {
    const store = new MemoryLeaseStore();
    let active = 0;
    let maximum = 0;
    const requester = "0x1111111111111111111111111111111111111111";
    const task = () => store.withRequesterLock(requester, async () => {
      active += 1; maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
    });
    await Promise.all([task(), task()]);
    expect(maximum).toBe(1);
  });

  it("applies a shared fixed-window challenge limit", async () => {
    const store = new MemoryLeaseStore();
    const now = new Date("2030-01-01T00:00:00Z");
    expect(await store.consumeRateLimit("wallet:test", now, 60, 2)).toBe(true);
    expect(await store.consumeRateLimit("wallet:test", now, 60, 2)).toBe(true);
    expect(await store.consumeRateLimit("wallet:test", now, 60, 2)).toBe(false);
    expect(await store.consumeRateLimit("wallet:test", new Date("2030-01-01T00:01:00Z"), 60, 2)).toBe(true);
    expect(store.rateLimits.size).toBe(1);
  });

  it("bounds expired challenge, lease, signature and rate-limit state", async () => {
    const store = new MemoryLeaseStore();
    const requester: Address = "0x1111111111111111111111111111111111111111";
    const old = lease(`0x${"01".repeat(32)}`, requester);
    old.expiresAt = new Date("2030-01-01T00:01:00Z");
    await store.acquireLease(old, new Date("2030-01-01T00:00:00Z"));
    await store.saveSignedPermit(old.permitId, old.permit, `0x${"ab".repeat(65)}`);
    await store.createChallenge({
      id: "00000000-0000-4000-8000-000000000001", requester, requestId: "request-old",
      requestFingerprint: `0x${"03".repeat(32)}`, normalizedLabel: "old", expectedAmount: 1_000_000n,
      message: "old challenge", expiresAt: new Date("2030-01-01T00:01:00Z"),
    }, new Date("2030-01-01T00:00:00Z"));
    await store.consumeRateLimit("client:old", new Date("2030-01-01T00:00:00Z"), 60, 1);
    await store.consumeRateLimit("client:active", new Date("2030-01-01T00:20:10Z"), 60, 1);

    const active = lease(
      `0x${"02".repeat(32)}`, "0x2222222222222222222222222222222222222222",
      "request-active", `0x${"dd".repeat(32)}`,
    );
    active.permitId = `0x${"cc".repeat(32)}`;
    active.permit = permitFixture(active.requester, active.labelHash, active.permitId);
    active.expiresAt = new Date("2030-01-01T00:30:00Z");
    await store.acquireLease(active, new Date("2030-01-01T00:02:00Z"));
    await store.saveSignedPermit(active.permitId, active.permit, `0x${"cd".repeat(65)}`);

    await expect(store.cleanupExpiredState(new Date("2030-01-01T00:20:30Z"), 10 * 60_000))
      .resolves.toEqual({ challenges: 1, leases: 1, rateLimits: 1 });
    expect(await store.getLease(old.permitId)).toBeNull();
    expect(await store.getSignedPermit(old.permitId)).toBeNull();
    expect((await store.getLease(active.permitId))?.permitId).toBe(active.permitId);
    expect(await store.getSignedPermit(active.permitId)).not.toBeNull();
    expect(store.leasesByRequest.size).toBe(1);
    expect(store.rateLimits.size).toBe(1);
  });

  it("does not delete a newer label replacement while pruning its old request index", async () => {
    const store = new MemoryLeaseStore();
    const old = lease(`0x${"01".repeat(32)}`);
    old.expiresAt = new Date("2030-01-01T00:01:00Z");
    await store.acquireLease(old, new Date("2030-01-01T00:00:00Z"));

    const replacement = lease(
      `0x${"02".repeat(32)}`, "0x2222222222222222222222222222222222222222",
      "request-0002", old.labelHash,
    );
    replacement.permitId = `0x${"cc".repeat(32)}`;
    replacement.permit = permitFixture(replacement.requester, replacement.labelHash, replacement.permitId);
    replacement.expiresAt = new Date("2030-01-01T00:30:00Z");
    expect((await store.acquireLease(replacement, new Date("2030-01-01T00:02:00Z"))).outcome).toBe("acquired");

    await store.cleanupExpiredState(new Date("2030-01-01T00:20:30Z"), 10 * 60_000);
    expect((await store.getLease(replacement.permitId))?.permitId).toBe(replacement.permitId);
    expect(store.leasesByRequest.size).toBe(1);
  });
});

describe("intent-bound permit issuance", () => {
  it("fails challenge creation closed on every live issuer policy mismatch", async () => {
    const healthy = await chainPolicy().health();
    const unhealthy = [
      { ...healthy, chainId: 1 },
      { ...healthy, permitSigner: "0x2222222222222222222222222222222222222222" as Address },
      { ...healthy, signerPolicyVersion: 2n },
      { ...healthy, registrationsPaused: true },
    ];
    for (const live of unhealthy) {
      const chain = chainPolicy({ health: async () => live });
      const service = new PermitIssuerService(
        activeManifest(signerAccount.address), new MemoryLeaseStore(),
        { sign: async () => `0x${"ab".repeat(65)}`, health: localSignerHealth }, chain,
        { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
        "https://names.example.com",
      );
      await expect(service.createChallenge(intent())).rejects.toBeInstanceOf(IssuerNotReadyError);
    }
  });

  it("revalidates live issuer policy inside the serialized issue path", async () => {
    let paused = false;
    const chain = chainPolicy({
      health: async () => ({
        chainId: 5_042_002,
        permitSigner: signerAccount.address,
        signerPolicyVersion: 1n,
        registrationsPaused: paused,
      }),
    });
    let signCalls = 0;
    const store = new MemoryLeaseStore();
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store,
      { sign: async () => { signCalls += 1; return `0x${"ab".repeat(65)}`; }, health: localSignerHealth }, chain,
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com",
    );
    const challenge = await service.createChallenge(intent());
    const signature = await signerAccount.signMessage({ message: challenge.message });
    paused = true;
    await expect(service.issue({ ...intent(), challengeId: challenge.id, challengeSignature: signature }))
      .rejects.toBeInstanceOf(IssuerNotReadyError);
    expect(signCalls).toBe(0);
    expect(store.leasesByLabel.size).toBe(0);
  });

  it("signs domain/origin/quote/expiry and rejects intent mutation", async () => {
    const store = new MemoryLeaseStore();
    const signer: PermitSigner = { sign: async () => `0x${"ab".repeat(65)}`, health: localSignerHealth };
    const now = new Date("2030-01-01T00:00:00Z");
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store, signer, chainPolicy(),
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com", () => now,
    );
    const challenge = await service.createChallenge(intent());
    expect(challenge.message).toContain("Origin: https://names.example.com");
    expect(challenge.message).toContain("Name: alice.contour");
    expect(challenge.message).toContain("Exact amount: 1000000 USDC base units");
    expect(challenge.message).toContain(`Intent fingerprint: ${challenge.requestFingerprint}`);
    expect(challenge.message).toContain("Expires at:");
    const signature = await signerAccount.signMessage({ message: challenge.message });
    await expect(service.issue({ ...intent({ durationYears: 2 }), challengeId: challenge.id, challengeSignature: signature }))
      .rejects.toThrow(/no longer matches current quote or policy/);
  });

  it("stores one unsigned payload and re-signs that exact timing/nonce after signer failure", async () => {
    const store = new MemoryLeaseStore();
    let attempts = 0;
    const signer: PermitSigner = {
      sign: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("local signer unavailable");
        return `0x${"ab".repeat(65)}`;
      },
      health: localSignerHealth,
    };
    let now = new Date("2030-01-01T00:00:00Z");
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store, signer, chainPolicy(),
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com", () => now,
    );
    const challenge = await service.createChallenge(intent());
    const challengeSignature = await signerAccount.signMessage({ message: challenge.message });
    await expect(service.issue({ ...intent(), challengeId: challenge.id, challengeSignature })).rejects.toThrow(/signer unavailable/);
    const stored = [...store.leasesByLabel.values()][0]!.permit;
    now = new Date("2030-01-01T00:01:00Z");
    const retried = await service.issue({ ...intent(), challengeId: challenge.id, challengeSignature });
    expect(retried.permit.permitId).toBe(stored.permitId);
    expect(retried.permit.nonce).toBe(stored.nonce);
    expect(retried.permit.issuedAt).toBe(stored.issuedAt);
    expect(retried.permit.validUntil).toBe(stored.validUntil);
  });

  it("replaces an expired same-intent challenge but never extends its stored permit", async () => {
    const store = new MemoryLeaseStore();
    const signer: PermitSigner = { sign: async () => `0x${"ab".repeat(65)}`, health: localSignerHealth };
    let now = new Date("2030-01-01T00:00:00Z");
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store, signer, chainPolicy(),
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com", () => now,
    );
    const first = await service.createChallenge(intent());
    const firstSignature = await signerAccount.signMessage({ message: first.message });
    await service.issue({ ...intent(), challengeId: first.id, challengeSignature: firstSignature });
    now = new Date("2030-01-01T00:03:20Z");
    const replacement = await service.createChallenge(intent());
    expect(replacement.id).not.toBe(first.id);
    expect(replacement.requestFingerprint).toBe(first.requestFingerprint);
    const replacementSignature = await signerAccount.signMessage({ message: replacement.message });
    await expect(service.issue({ ...intent(), challengeId: replacement.id, challengeSignature: replacementSignature }))
      .rejects.toBeInstanceOf(RequestIdExpiredError);
  });

  it("rejects zero parties and self-referrals before quote or signing", async () => {
    const store = new MemoryLeaseStore();
    const signer: PermitSigner = { sign: async () => `0x${"ab".repeat(65)}`, health: localSignerHealth };
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store, signer, chainPolicy(),
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com",
    );
    await expect(service.createChallenge(intent({ recipient: "0x0000000000000000000000000000000000000000" })))
      .rejects.toThrow(/must be non-zero/);
    await expect(service.createChallenge(intent({ referrer: signerAccount.address })))
      .rejects.toThrow(/referrer must differ/);
  });

  it("serializes one active nonce-bearing permit per requester across labels", async () => {
    const store = new MemoryLeaseStore();
    let signCalls = 0;
    const signer: PermitSigner = {
      sign: async () => {
        signCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return `0x${"ab".repeat(65)}`;
      },
      health: localSignerHealth,
    };
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store, signer, chainPolicy(),
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com",
    );
    const alice = intent();
    const bob = intent({ requestId: "request-0002", rawLabel: "bob" });
    const [aliceChallenge, bobChallenge] = await Promise.all([service.createChallenge(alice), service.createChallenge(bob)]);
    const [aliceSignature, bobSignature] = await Promise.all([
      signerAccount.signMessage({ message: aliceChallenge.message }),
      signerAccount.signMessage({ message: bobChallenge.message }),
    ]);
    const results = await Promise.allSettled([
      service.issue({ ...alice, challengeId: aliceChallenge.id, challengeSignature: aliceSignature }),
      service.issue({ ...bob, challengeId: bobChallenge.id, challengeSignature: bobSignature }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(signCalls).toBe(1);
  });

  it("records a calldata-bound pending transaction and deterministically confirms its receipt", async () => {
    const store = new MemoryLeaseStore();
    const candidate = lease(`0x${"01".repeat(32)}`, signerAccount.address);
    await store.acquireLease(candidate, new Date("2030-01-01T00:00:00Z"));
    const txHash = `0x${"ef".repeat(32)}` as Hex;
    let state: "pending" | "success" | "unavailable" = "pending";
    const chain = chainPolicy();
    chain.inspectSubmission = async () => {
      if (state === "unavailable") throw new Error("RPC unavailable");
      return ({
      state,
      transactionFrom: candidate.permit.authorizedExecutor,
      transactionTo: candidate.permit.controller,
      permitId: candidate.permitId,
      requester: candidate.requester,
      labelHash: candidate.labelHash,
      ...(state === "success" ? { tokenId: BigInt(candidate.labelHash) } : {}),
      });
    };
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store,
      { sign: async () => `0x${"ab".repeat(65)}`, health: localSignerHealth }, chain,
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com",
    );
    const submitted = await service.recordSubmission({ permitId: candidate.permitId, requester: candidate.requester, txHash });
    expect(submitted.state).toBe("submitted");
    state = "unavailable";
    expect((await service.recordSubmission({ permitId: candidate.permitId, requester: candidate.requester, txHash })).state).toBe("submitted");
    state = "success";
    expect(await service.reconcileSubmitted()).toEqual([{ permitId: candidate.permitId, state: "confirmed" }]);
    expect((await store.getLease(candidate.permitId))?.state).toBe("confirmed");
    const duplicate = await service.recordSubmission({ permitId: candidate.permitId, requester: candidate.requester, txHash });
    expect(duplicate.state).toBe("confirmed");
    expect(duplicate.tokenId).toBe(BigInt(candidate.labelHash));
  });

  it("returns one idempotent confirmation to concurrent duplicate submission calls", async () => {
    const store = new MemoryLeaseStore();
    const candidate = lease(`0x${"01".repeat(32)}`, signerAccount.address);
    await store.acquireLease(candidate, new Date("2030-01-01T00:00:00Z"));
    const txHash = `0x${"ef".repeat(32)}` as Hex;
    let inspections = 0;
    const chain = chainPolicy({
      inspectSubmission: async () => {
        inspections += 1;
        return {
          state: "success",
          transactionFrom: candidate.permit.authorizedExecutor,
          transactionTo: candidate.permit.controller,
          permitId: candidate.permitId,
          requester: candidate.requester,
          labelHash: candidate.labelHash,
          tokenId: BigInt(candidate.labelHash),
        };
      },
    });
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store,
      { sign: async () => `0x${"ab".repeat(65)}`, health: localSignerHealth }, chain,
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com",
    );

    const [first, second] = await Promise.all([
      service.recordSubmission({ permitId: candidate.permitId, requester: candidate.requester, txHash }),
      service.recordSubmission({ permitId: candidate.permitId, requester: candidate.requester, txHash }),
    ]);
    expect(first.state).toBe("confirmed");
    expect(second.state).toBe("confirmed");
    expect(inspections).toBe(1);
  });

  it("coalesces reconciliation and serializes it with a duplicate submission", async () => {
    const store = new MemoryLeaseStore();
    const candidate = lease(`0x${"01".repeat(32)}`, signerAccount.address);
    await store.acquireLease(candidate, new Date("2030-01-01T00:00:00Z"));
    const txHash = `0x${"ef".repeat(32)}` as Hex;
    await store.markSubmitted(candidate.permitId, txHash);
    let releaseInspection!: () => void;
    let inspectionStarted!: () => void;
    const inspectionGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
    const started = new Promise<void>((resolve) => { inspectionStarted = resolve; });
    let inspections = 0;
    const chain = chainPolicy({
      inspectSubmission: async () => {
        inspections += 1;
        inspectionStarted();
        await inspectionGate;
        return {
          state: "success",
          transactionFrom: candidate.permit.authorizedExecutor,
          transactionTo: candidate.permit.controller,
          permitId: candidate.permitId,
          requester: candidate.requester,
          labelHash: candidate.labelHash,
          tokenId: BigInt(candidate.labelHash),
        };
      },
    });
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store,
      { sign: async () => `0x${"ab".repeat(65)}`, health: localSignerHealth }, chain,
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com",
    );

    const firstReconciliation = service.reconcileSubmitted();
    const secondReconciliation = service.reconcileSubmitted();
    await started;
    const duplicateSubmission = service.recordSubmission({
      permitId: candidate.permitId, requester: candidate.requester, txHash,
    });
    releaseInspection();

    const [first, second, duplicate] = await Promise.all([
      firstReconciliation, secondReconciliation, duplicateSubmission,
    ]);
    expect(first).toEqual([{ permitId: candidate.permitId, state: "confirmed" }]);
    expect(second).toEqual(first);
    expect(duplicate.state).toBe("confirmed");
    expect(inspections).toBe(1);
  });

  it("keeps a reverted permit exclusive through its lease safety window", async () => {
    const store = new MemoryLeaseStore();
    const candidate = lease(`0x${"01".repeat(32)}`, signerAccount.address);
    await store.acquireLease(candidate, new Date("2030-01-01T00:00:00Z"));
    const txHash = `0x${"ef".repeat(32)}` as Hex;
    const chain = chainPolicy();
    chain.inspectSubmission = async () => ({
      state: "reverted",
      transactionFrom: candidate.permit.authorizedExecutor,
      transactionTo: candidate.permit.controller,
      permitId: candidate.permitId,
      requester: candidate.requester,
      labelHash: candidate.labelHash,
    });
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store,
      { sign: async () => `0x${"ab".repeat(65)}`, health: localSignerHealth }, chain,
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com",
    );
    expect((await service.recordSubmission({ permitId: candidate.permitId, requester: candidate.requester, txHash })).state).toBe("failed");
    expect((await service.recordSubmission({ permitId: candidate.permitId, requester: candidate.requester, txHash })).state).toBe("failed");
    const replacement = lease(
      `0x${"02".repeat(32)}`, signerAccount.address, "request-0002", `0x${"dd".repeat(32)}`,
    );
    expect((await store.acquireLease(replacement, new Date("2030-01-01T00:00:30Z"))).outcome).toBe("conflict");
    expect((await store.acquireLease(replacement, new Date("2030-01-01T00:01:01Z"))).outcome).toBe("acquired");
  });

  it("keeps manual-review leases fail-closed after their original safety window", async () => {
    const store = new MemoryLeaseStore();
    const candidate = lease(`0x${"01".repeat(32)}`, signerAccount.address);
    await store.acquireLease(candidate, new Date("2030-01-01T00:00:00Z"));
    const txHash = `0x${"ef".repeat(32)}` as Hex;
    expect(await store.markSubmitted(candidate.permitId, txHash)).toBe(true);
    expect(await store.markManualReview(candidate.permitId, txHash)).toBe(true);

    const replacement = lease(
      `0x${"02".repeat(32)}`, signerAccount.address, "request-0002", `0x${"dd".repeat(32)}`,
    );
    expect((await store.acquireLease(replacement, new Date("2030-01-01T00:10:00Z"))).outcome)
      .toBe("conflict");
  });

  it("keeps an expired submitted lease closed until Arc proves its permit deadline passed unused", async () => {
    const store = new MemoryLeaseStore();
    const candidate = lease(`0x${"01".repeat(32)}`, signerAccount.address);
    candidate.expiresAt = new Date("2030-01-01T00:01:00Z");
    candidate.permit.validUntil = 1_893_456_030n;
    await store.acquireLease(candidate, new Date("2030-01-01T00:00:00Z"));
    const txHash = `0x${"ef".repeat(32)}` as Hex;
    const chain = chainPolicy({
      inspectSubmission: async () => ({
        state: "pending",
        transactionFrom: candidate.permit.authorizedExecutor,
        transactionTo: candidate.permit.controller,
        permitId: candidate.permitId,
        requester: candidate.requester,
        labelHash: candidate.labelHash,
      }),
      expiryProof: async () => ({
        blockTimestamp: 1_893_456_031n,
        usedPermit: false,
        requesterNonce: candidate.permit.nonce,
        available: true,
      }),
    });
    const now = new Date("2030-01-01T00:01:01Z");
    const service = new PermitIssuerService(
      activeManifest(signerAccount.address), store,
      { sign: async () => `0x${"ab".repeat(65)}`, health: localSignerHealth }, chain,
      { ttlSeconds: 180, challengeTtlSeconds: 120, maxDurationYears: 10 },
      "https://names.example.com", () => now,
    );
    expect((await service.recordSubmission({ permitId: candidate.permitId, requester: candidate.requester, txHash })).state)
      .toBe("submitted");
    const replacement = lease(
      `0x${"02".repeat(32)}`, signerAccount.address, "request-0002", `0x${"dd".repeat(32)}`,
    );
    expect((await store.acquireLease(replacement, now)).outcome).toBe("conflict");
    expect(await service.reconcileSubmitted()).toEqual([{ permitId: candidate.permitId, state: "expired" }]);
    expect((await store.getLease(candidate.permitId))?.state).toBe("expired");
    expect((await store.acquireLease(replacement, now)).outcome).toBe("acquired");
  });
});
