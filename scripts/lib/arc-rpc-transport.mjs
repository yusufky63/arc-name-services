import { http } from "viem";

export const ARC_PUBLIC_RPC_REQUEST_INTERVAL_MS = 2_100;
export const ARC_PUBLIC_RPC_MAX_ATTEMPTS = 3;
export const ARC_PROMOTION_RPC_RETRY_OPTIONS = Object.freeze({
  intervalMs: 6_000,
  maxAttempts: 6,
  maxBackoffMs: 18_000,
});

let nextRequestAt = 0;
let requestQueue = Promise.resolve();

async function waitForSlot(intervalMs = ARC_PUBLIC_RPC_REQUEST_INTERVAL_MS) {
  const slot = requestQueue.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextRequestAt = Date.now() + intervalMs;
  });
  requestQueue = slot.catch(() => undefined);
  return slot;
}

function isRateLimit(error, depth = 0) {
  if (depth > 5 || !error || typeof error !== "object") return false;
  if (error.code === -32_011 || error.status === 429 || error.statusCode === 429) return true;
  const text = [error.message, error.shortMessage, error.details]
    .filter((value) => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (
    text.includes("request limit reached") || text.includes("rate limit") ||
    text.includes("too many requests") || /(^|\D)429(\D|$)/.test(text)
  ) return true;
  return isRateLimit(error.cause, depth + 1);
}

export async function requestWithArcRpcRetry(request, {
  maxAttempts = ARC_PUBLIC_RPC_MAX_ATTEMPTS,
  wait = waitForSlot,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  intervalMs = ARC_PUBLIC_RPC_REQUEST_INTERVAL_MS,
  maxBackoffMs = 15_000,
} = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await wait(intervalMs);
    try {
      return await request();
    } catch (error) {
      lastError = error;
      if (!isRateLimit(error) || attempt === maxAttempts) throw error;
      await sleep(Math.min(intervalMs * attempt, maxBackoffMs));
    }
  }
  throw lastError;
}

export function rateLimitedArcHttp(url, retryOptions = {}) {
  const base = http(url, { retryCount: 0, timeout: 30_000 });
  return (options) => {
    const transport = base(options);
    return {
      ...transport,
      config: { ...transport.config, name: "Rate-limited Arc HTTP JSON-RPC" },
      request: (args) => requestWithArcRpcRetry(() => transport.request(args), retryOptions),
    };
  };
}
