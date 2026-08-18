import Fastify from "fastify";
import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";
import { createChainPolicyReader } from "./chain.js";
import { validateIssuerBoundary } from "./boundary.js";
import { loadConfig } from "./config.js";
import { MemoryLeaseStore } from "./domain.js";
import {
  IdempotencyConflictError,
  IntentStaleError,
  IssuerNotReadyError,
  LeaseConflictError,
  PermitIssuerService,
  RequestIdExpiredError,
  type PermitIntentRequest,
  type PermitRequest,
} from "./service.js";
import { LocalPrivateKeySigner } from "./signer.js";

function jsonSafe(value: unknown) {
  return JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
}

const config = await loadConfig();

const store = new MemoryLeaseStore();
const chain = createChainPolicyReader(config.manifest, config.rpcUrl);
const signer = new LocalPrivateKeySigner(config.signerPrivateKey, config.signerAddress);
const service = new PermitIssuerService(
  config.manifest,
  store,
  signer,
  chain,
  { ttlSeconds: config.ttlSeconds, challengeTtlSeconds: 120, maxDurationYears: 10 },
  config.challengeOrigin,
);

const app = Fastify({
  trustProxy: config.trustedProxyCidrs.length > 0 ? config.trustedProxyCidrs : false,
  logger: {
    level: "info",
    redact: [
      "req.headers.authorization",
      'req.headers["x-contour-client-key"]',
      'req.headers["x-contour-client-signature"]',
      "req.body.rawLabel",
      "req.body.challengeSignature",
    ],
  },
  bodyLimit: 16_384,
  requestTimeout: 10_000,
});
const authenticatedClientKeys = new WeakMap<object, string>();
app.addHook("onRequest", async (request, reply) => {
  const pathname = new URL(request.url, "http://permit-issuer.invalid").pathname;
  if (!pathname.startsWith("/v1/")) return;
  try {
    const clientKey = validateIssuerBoundary(
      request.headers,
      request.method,
      pathname,
      config.issuerServiceBearerToken,
      config.ingressClientKeyHmacSecret,
    );
    authenticatedClientKeys.set(request, clientKey);
  } catch {
    return reply.header("cache-control", "no-store").code(401).send({ code: "ISSUER_BOUNDARY_AUTH_REQUIRED" });
  }
});

function rateLimitClientKey(request: object): string {
  const clientKey = authenticatedClientKeys.get(request);
  if (!clientKey) throw new Error("authenticated client key missing after issuer boundary hook");
  return clientKey;
}
const cleanupMemoryState = setInterval(() => {
  void store.cleanupExpiredState(new Date(), 15 * 60_000)
    .catch((error: unknown) => app.log.warn({ err: error instanceof Error ? error.message : "unknown" }, "memory-state cleanup failed"));
}, 5 * 60_000);
cleanupMemoryState.unref();
let reconciliationRunning = false;
const reconcileSubmitted = setInterval(() => {
  if (reconciliationRunning) return;
  reconciliationRunning = true;
  void service.reconcileSubmitted(100)
    .catch((error: unknown) => app.log.warn({ err: error instanceof Error ? error.message : "unknown" }, "submitted permit reconciliation failed"))
    .finally(() => { reconciliationRunning = false; });
}, 5_000);
reconcileSubmitted.unref();

type HealthResult = { status: 200 | 503; body: Record<string, unknown> };
let healthCache: { expiresAt: number; promise: Promise<HealthResult> } | null = null;

async function computeHealth(): Promise<HealthResult> {
  try {
    const dependencies = Promise.all([chain.health(), signer.health()]);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timed = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => reject(new Error("health dependency deadline exceeded")), 4_000);
      timeout.unref();
    });
    const [live, signerHealth] = await Promise.race([dependencies, timed]);
    if (timeout) clearTimeout(timeout);
    const expectedSigner = getAddress(config.manifest.permitIssuer.signerAddress!);
    const expectedPolicyVersion = config.manifest.permitIssuer.policyVersion!;
    const ready = live.chainId === 5_042_002 && getAddress(live.permitSigner) === expectedSigner &&
      getAddress(signerHealth.signerAddress) === expectedSigner &&
      live.signerPolicyVersion.toString() === expectedPolicyVersion && !live.registrationsPaused;
    const body = {
      ok: ready,
      productLive: config.productLive,
      storage: "memory",
      coordinationScope: "single-process",
      durable: false,
      chainId: live.chainId,
      controller: config.manifest.contracts.controller.address,
      releaseId: config.manifest.releaseId,
      normalizationProfileHash: config.manifest.normalization.profileHash,
      signerAddress: live.permitSigner,
      configuredSignerAddress: expectedSigner,
      localSignerAddress: signerHealth.signerAddress,
      signerKind: signerHealth.signerKind,
      signerReady: true,
      policyVersion: expectedPolicyVersion,
      onchainPolicyVersion: live.signerPolicyVersion.toString(),
      registrationsPaused: live.registrationsPaused,
    };
    return ready ? { status: 200, body } : { status: 503, body: { ...body, code: "ISSUER_NOT_READY" } };
  } catch {
    return {
      status: 503,
      body: {
        ok: false,
        productLive: config.productLive,
        storage: "memory",
        coordinationScope: "single-process",
        durable: false,
        code: "ISSUER_DEPENDENCY_UNAVAILABLE",
        chainId: 5_042_002,
        controller: config.manifest.contracts.controller.address,
        releaseId: config.manifest.releaseId,
        normalizationProfileHash: config.manifest.normalization.profileHash,
        signerAddress: config.manifest.permitIssuer.signerAddress,
        signerReady: false,
        policyVersion: config.manifest.permitIssuer.policyVersion,
      },
    };
  }
}

function readCachedHealth(): Promise<HealthResult> {
  const now = Date.now();
  if (!healthCache || healthCache.expiresAt <= now) {
    const promise = computeHealth();
    healthCache = { expiresAt: now + 5_000, promise };
  }
  return healthCache.promise;
}

app.get("/healthz", async (_request, reply) => {
  const result = await readCachedHealth();
  return reply.header("cache-control", "no-store").code(result.status).send(result.body);
});

function parseIntent(body: Record<string, unknown> | null | undefined): PermitIntentRequest | null {
  const addresses = ["requester", "recipient", "payer", "authorizedExecutor"] as const;
  if (!body || addresses.some((key) => typeof body[key] !== "string" || !isAddress(body[key] as string))) return null;
  if (
    typeof body.requestId !== "string" || body.requestId.length < 8 || body.requestId.length > 128 ||
    typeof body.rawLabel !== "string" || body.rawLabel.length === 0 || body.rawLabel.length > 256 ||
    typeof body.normalizationAccepted !== "boolean" || typeof body.durationYears !== "number" ||
    typeof body.resolverDataHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.resolverDataHash) ||
    (body.referrer !== undefined && (typeof body.referrer !== "string" || !isAddress(body.referrer)))
  ) return null;
  const parsed = Object.fromEntries(addresses.map((key) => [key, getAddress(body[key] as string)])) as Record<(typeof addresses)[number], Address>;
  if (Object.values(parsed).some((address) => address === "0x0000000000000000000000000000000000000000")) return null;
  return {
    requestId: body.requestId,
    rawLabel: body.rawLabel,
    normalizationAccepted: body.normalizationAccepted,
    requester: parsed.requester,
    recipient: parsed.recipient,
    payer: parsed.payer,
    authorizedExecutor: parsed.authorizedExecutor,
    durationYears: body.durationYears,
    resolverDataHash: body.resolverDataHash as Hex,
    ...(typeof body.referrer === "string" ? { referrer: getAddress(body.referrer) } : {}),
  };
}

app.post<{ Body: Record<string, unknown> }>("/v1/challenges", async (request, reply) => {
  const now = new Date();
  const clientAllowed = await store.consumeRateLimit(
    `client:${rateLimitClientKey(request)}`, now, config.challengeRateWindowSeconds, config.challengeClientLimit,
  );
  if (!clientAllowed) {
    return reply.header("Retry-After", String(config.challengeRateWindowSeconds)).code(429).send({ code: "CHALLENGE_RATE_LIMITED" });
  }
  const intent = parseIntent(request.body);
  if (!intent) return reply.code(400).send({ code: "INVALID_INTENT" });
  const walletAllowed = await store.consumeRateLimit(
    `wallet:${intent.requester.toLowerCase()}`, now, config.challengeRateWindowSeconds, config.challengeWalletLimit,
  );
  if (!walletAllowed) {
    return reply.header("Retry-After", String(config.challengeRateWindowSeconds)).code(429).send({ code: "CHALLENGE_RATE_LIMITED" });
  }
  try { return jsonSafe(await service.createChallenge(intent)); }
  catch (error) {
    if (error instanceof IssuerNotReadyError) {
      return reply.code(503).send({ code: "ISSUER_NOT_READY" });
    }
    if (error instanceof IdempotencyConflictError || (error instanceof Error && /idempotency key reused/i.test(error.message))) {
      return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
    }
    request.log.warn(
      { errorType: error instanceof Error ? error.name : "UnknownError" },
      "challenge request rejected",
    );
    return reply.code(422).send({ code: "CHALLENGE_REJECTED" });
  }
});

app.post<{ Body: Record<string, unknown> }>("/v1/permits", async (request, reply) => {
  const now = new Date();
  const clientAllowed = await store.consumeRateLimit(
    `permit-client:${rateLimitClientKey(request)}`, now, config.challengeRateWindowSeconds, config.challengeClientLimit,
  );
  if (!clientAllowed) {
    return reply.header("Retry-After", String(config.challengeRateWindowSeconds)).code(429).send({ code: "PERMIT_RATE_LIMITED" });
  }
  const body = request.body;
  const intent = parseIntent(body);
  if (!intent) return reply.code(400).send({ code: "INVALID_INTENT" });
  const walletAllowed = await store.consumeRateLimit(
    `permit-wallet:${intent.requester.toLowerCase()}`,
    now,
    config.challengeRateWindowSeconds,
    config.challengeWalletLimit,
  );
  if (!walletAllowed) {
    return reply.header("Retry-After", String(config.challengeRateWindowSeconds)).code(429).send({ code: "PERMIT_RATE_LIMITED" });
  }
  if (typeof body.challengeId !== "string" || typeof body.challengeSignature !== "string" || !isHex(body.challengeSignature)) {
    return reply.code(400).send({ code: "INVALID_REQUEST" });
  }

  const input: PermitRequest = {
    ...intent,
    challengeId: body.challengeId,
    challengeSignature: body.challengeSignature as Hex,
  };
  try {
    const result = await service.issue(input);
    return jsonSafe(result);
  } catch (error) {
    if (error instanceof IssuerNotReadyError) {
      return reply.code(503).send({ code: "ISSUER_NOT_READY" });
    }
    if (error instanceof LeaseConflictError) {
      return reply.code(409).send({ code: "LABEL_LEASED", retryAfter: error.expiresAt.toISOString() });
    }
    if (error instanceof IdempotencyConflictError) {
      return reply.code(409).send({ code: "IDEMPOTENCY_CONFLICT" });
    }
    if (error instanceof RequestIdExpiredError) {
      return reply.code(409).send({ code: "REQUEST_ID_EXPIRED", retryAfter: error.retryAfter.toISOString() });
    }
    if (error instanceof IntentStaleError) {
      return reply.code(409).send({ code: "INTENT_STALE" });
    }
    request.log.warn(
      { errorType: error instanceof Error ? error.name : "UnknownError" },
      "permit request rejected",
    );
    return reply.code(422).send({ code: "PERMIT_REJECTED" });
  }
});

app.post<{ Body: Record<string, unknown> }>("/v1/submissions", async (request, reply) => {
  const now = new Date();
  const clientAllowed = await store.consumeRateLimit(
    `submission-client:${rateLimitClientKey(request)}`, now, config.challengeRateWindowSeconds, config.challengeClientLimit,
  );
  if (!clientAllowed) {
    return reply.header("Retry-After", String(config.challengeRateWindowSeconds)).code(429).send({ code: "SUBMISSION_RATE_LIMITED" });
  }
  const body = request.body;
  if (!body || typeof body.requester !== "string" || !isAddress(body.requester) ||
      getAddress(body.requester) === "0x0000000000000000000000000000000000000000" ||
      typeof body.permitId !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.permitId) ||
      typeof body.txHash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.txHash)) {
    return reply.code(400).send({ code: "INVALID_SUBMISSION" });
  }
  const requester = getAddress(body.requester);
  const walletAllowed = await store.consumeRateLimit(
    `submission-wallet:${requester.toLowerCase()}`,
    now,
    config.challengeRateWindowSeconds,
    config.challengeWalletLimit,
  );
  if (!walletAllowed) {
    return reply.header("Retry-After", String(config.challengeRateWindowSeconds)).code(429).send({ code: "SUBMISSION_RATE_LIMITED" });
  }
  try {
    return jsonSafe(await service.recordSubmission({
      requester,
      permitId: body.permitId as Hex,
      txHash: body.txHash as Hex,
    }));
  } catch (error) {
    request.log.warn(
      { errorType: error instanceof Error ? error.name : "UnknownError" },
      "submission proof rejected",
    );
    return reply.code(422).send({ code: "SUBMISSION_REJECTED" });
  }
});

const close = async () => {
  clearInterval(cleanupMemoryState);
  clearInterval(reconcileSubmitted);
  await app.close();
};
process.on("SIGTERM", close);
process.on("SIGINT", close);
await app.listen({ host: "0.0.0.0", port: config.port });
