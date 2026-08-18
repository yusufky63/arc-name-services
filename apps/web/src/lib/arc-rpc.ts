import { http, type Transport } from "viem";
import { ARC_TESTNET_RPC_URL } from "@contour/config";

const ARC_PUBLIC_RPC_MIN_INTERVAL_MS = 250;
const ARC_PUBLIC_RPC_BACKOFF_MS = 2_100;
const ARC_PUBLIC_RPC_MAX_ATTEMPTS = 3;

const inFlightReads = new Map<string, Promise<unknown>>();

export function createArcRpcRequestScheduler(options: {
  minimumIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
} = {}) {
  const minimumIntervalMs = options.minimumIntervalMs ?? ARC_PUBLIC_RPC_MIN_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let queue = Promise.resolve();
  let nextStartAt = 0;

  return {
    waitForSlot() {
      const slot = queue.then(async () => {
        const waitMs = Math.max(0, nextStartAt - now());
        if (waitMs > 0) await sleep(waitMs);
        const startedAt = Math.max(nextStartAt, now());
        nextStartAt = startedAt + minimumIntervalMs;
      });
      queue = slot.catch(() => undefined);
      return slot;
    },
    defer(milliseconds: number) {
      nextStartAt = Math.max(nextStartAt, now() + milliseconds);
    },
  };
}

const arcRpcScheduler = createArcRpcRequestScheduler();

export function resolveCanonicalArcRpcUrl(
  configuredUrl: string | undefined,
  manifestUrl: string = ARC_TESTNET_RPC_URL,
): typeof ARC_TESTNET_RPC_URL {
  if (manifestUrl.trim() !== ARC_TESTNET_RPC_URL) {
    throw new Error("Deployment manifest Arc RPC is not canonical.");
  }
  const configured = configuredUrl?.trim();
  if (configured && configured !== ARC_TESTNET_RPC_URL) {
    throw new Error(`ARC_RPC_URL must exactly equal ${ARC_TESTNET_RPC_URL}.`);
  }
  return ARC_TESTNET_RPC_URL;
}

function rateLimitSignal(error: unknown, depth = 0): boolean {
  if (depth > 5 || !error || typeof error !== "object") return false;
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    message?: unknown;
    shortMessage?: unknown;
    details?: unknown;
    cause?: unknown;
    data?: unknown;
    error?: unknown;
  };
  if (
    candidate.code === -32_005 ||
    candidate.code === -32_011 ||
    candidate.status === 429 ||
    candidate.statusCode === 429
  ) {
    return true;
  }
  const text = [candidate.message, candidate.shortMessage, candidate.details]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (
    text.includes("request limit reached") ||
    text.includes("rate limit") ||
    text.includes("too many requests") ||
    /(^|\D)429(\D|$)/.test(text)
  ) {
    return true;
  }
  return (
    rateLimitSignal(candidate.cause, depth + 1) ||
    rateLimitSignal(candidate.data, depth + 1) ||
    rateLimitSignal(candidate.error, depth + 1)
  );
}

export async function requestWithArcRpcRetry<T>(
  request: () => Promise<T>,
  options: {
    maxAttempts?: number;
    waitForSlot?: () => Promise<void>;
    deferRequests?: (milliseconds: number) => void;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? ARC_PUBLIC_RPC_MAX_ATTEMPTS;
  const usesSharedScheduler = options.waitForSlot === undefined;
  const waitForSlot = options.waitForSlot ?? (() => arcRpcScheduler.waitForSlot());
  const deferRequests = options.deferRequests ?? (
    usesSharedScheduler ? (milliseconds: number) => arcRpcScheduler.defer(milliseconds) : () => undefined
  );
  const sleep = options.sleep ?? ((milliseconds) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await waitForSlot();
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!rateLimitSignal(error) || attempt === maxAttempts) throw error;
      const delay = ARC_PUBLIC_RPC_BACKOFF_MS * attempt;
      deferRequests(delay);
      await sleep(delay);
    }
  }
  throw lastError;
}

/** Coalesces only simultaneous identical reads. Settled results are never cached,
 * so a readiness response cannot carry a stale ready state across blocks. */
export function coalesceArcRpcRead<T>(key: string, read: () => Promise<T>): Promise<T> {
  const existing = inFlightReads.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const pending = Promise.resolve().then(read);
  inFlightReads.set(key, pending);
  void pending.then(
    () => {
      if (inFlightReads.get(key) === pending) inFlightReads.delete(key);
    },
    () => {
      if (inFlightReads.get(key) === pending) inFlightReads.delete(key);
    },
  );
  return pending;
}

export function rateLimitedArcHttp(url: string): Transport<"http"> {
  const base = http(url, {
    // The wrapper below owns bounded retries so JSON-RPC -32011 and HTTP 429
    // follow the same global request schedule instead of creating a burst.
    retryCount: 0,
    timeout: 30_000,
  });

  return (options) => {
    const transport = base(options);
    const request: typeof transport.request = async (args) => {
      return requestWithArcRpcRetry(() => transport.request(args));
    };

    return {
      ...transport,
      config: { ...transport.config, name: "Arc HTTP JSON-RPC with bounded retry" },
      request,
    };
  };
}
