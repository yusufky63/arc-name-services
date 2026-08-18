import { http, type Transport } from "viem";
import { ARC_TESTNET_RPC_URL } from "@contour/config";

const REQUEST_INTERVAL_MS = 2_100;
const MAX_ATTEMPTS = 3;
let nextRequestAt = 0;
let queue: Promise<void> = Promise.resolve();

export function canonicalArcRpcUrl(value: string | undefined): typeof ARC_TESTNET_RPC_URL {
  const configured = value?.trim();
  if (configured !== ARC_TESTNET_RPC_URL) {
    throw new Error(`ARC_RPC_URL must exactly equal ${ARC_TESTNET_RPC_URL}`);
  }
  return ARC_TESTNET_RPC_URL;
}

async function waitForSlot() {
  const slot = queue.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
    nextRequestAt = Date.now() + REQUEST_INTERVAL_MS;
  });
  queue = slot.catch(() => undefined);
  await slot;
}

function isRateLimit(error: unknown, depth = 0): boolean {
  if (depth > 5 || !error || typeof error !== "object") return false;
  const value = error as {
    code?: unknown; status?: unknown; statusCode?: unknown; message?: unknown;
    shortMessage?: unknown; details?: unknown; cause?: unknown;
  };
  if (value.code === -32_011 || value.status === 429 || value.statusCode === 429) return true;
  const text = [value.message, value.shortMessage, value.details]
    .filter((item): item is string => typeof item === "string")
    .join(" ")
    .toLowerCase();
  return text.includes("request limit reached") || text.includes("rate limit") ||
    text.includes("too many requests") || /(^|\D)429(\D|$)/.test(text) ||
    isRateLimit(value.cause, depth + 1);
}

export function rateLimitedArcHttp(url: string): Transport<"http"> {
  const canonical = canonicalArcRpcUrl(url);
  const base = http(canonical, { retryCount: 0, timeout: 30_000 });
  return (options) => {
    const transport = base(options);
    return {
      ...transport,
      config: { ...transport.config, name: "Rate-limited Arc HTTP JSON-RPC" },
      request: async (args) => {
        let lastError: unknown;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
          await waitForSlot();
          try { return await transport.request(args); }
          catch (error) {
            lastError = error;
            if (!isRateLimit(error) || attempt === MAX_ATTEMPTS) throw error;
            await new Promise<void>((resolve) => setTimeout(resolve, REQUEST_INTERVAL_MS * attempt));
          }
        }
        throw lastError;
      },
    };
  };
}
