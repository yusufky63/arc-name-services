import { describe, expect, it, vi } from "vitest";
import {
  coalesceArcRpcRead,
  createArcRpcRequestScheduler,
  requestWithArcRpcRetry,
  resolveCanonicalArcRpcUrl,
} from "./arc-rpc";

describe("Arc RPC rate-limit recovery", () => {
  it("paces production-style concurrent requests through one shared schedule", async () => {
    let now = 0;
    const waits: number[] = [];
    const scheduler = createArcRpcRequestScheduler({
      minimumIntervalMs: 250,
      now: () => now,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        now += milliseconds;
      },
    });

    await Promise.all([
      scheduler.waitForSlot(),
      scheduler.waitForSlot(),
      scheduler.waitForSlot(),
    ]);
    expect(waits).toEqual([250, 250]);

    scheduler.defer(2_100);
    await scheduler.waitForSlot();
    expect(waits).toEqual([250, 250, 2_100]);
  });

  it("accepts only the canonical Arc Testnet RPC", () => {
    expect(resolveCanonicalArcRpcUrl(undefined)).toBe("https://rpc.testnet.arc.network");
    expect(resolveCanonicalArcRpcUrl(" https://rpc.testnet.arc.network ")).toBe(
      "https://rpc.testnet.arc.network",
    );
    expect(() => resolveCanonicalArcRpcUrl("https://rpc.example")).toThrow(/must exactly equal/);
    expect(() => resolveCanonicalArcRpcUrl(undefined, "https://rpc.example")).toThrow(/not canonical/);
  });

  it("retries JSON-RPC -32011 on the bounded shared schedule", async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(Object.assign(new Error("request limit reached"), { code: -32_011 }))
      .mockRejectedValueOnce({ cause: { status: 429, message: "Too Many Requests" } })
      .mockResolvedValue("ok");
    const waits: number[] = [];
    const deferred: number[] = [];
    const slots = vi.fn(async () => undefined);

    await expect(requestWithArcRpcRetry(request, {
      waitForSlot: slots,
      deferRequests: (milliseconds) => { deferred.push(milliseconds); },
      sleep: async (milliseconds) => { waits.push(milliseconds); },
    })).resolves.toBe("ok");

    expect(request).toHaveBeenCalledTimes(3);
    expect(slots).toHaveBeenCalledTimes(3);
    expect(deferred).toEqual([2_100, 4_200]);
    expect(waits).toEqual([2_100, 4_200]);
  });

  it("does not retry unrelated RPC failures", async () => {
    const failure = new Error("execution reverted");
    const request = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(requestWithArcRpcRetry(request, {
      waitForSlot: async () => undefined,
      sleep: async () => undefined,
    })).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("fails closed after the third rate-limit response", async () => {
    const failure = Object.assign(new Error("request limit reached"), { code: -32_011 });
    const request = vi.fn<() => Promise<never>>().mockRejectedValue(failure);

    await expect(requestWithArcRpcRetry(request, {
      waitForSlot: async () => undefined,
      sleep: async () => undefined,
    })).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("coalesces only in-flight reads and never caches a settled readiness result", async () => {
    let releaseFirst!: (value: number) => void;
    const read = vi.fn(() => new Promise<number>((resolve) => { releaseFirst = resolve; }));
    const first = coalesceArcRpcRead("issuer:release-a", read);
    const simultaneous = coalesceArcRpcRead("issuer:release-a", read);
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    releaseFirst(7);
    await expect(Promise.all([first, simultaneous])).resolves.toEqual([7, 7]);

    const nextRead = vi.fn(async () => 8);
    await expect(coalesceArcRpcRead("issuer:release-a", nextRead)).resolves.toBe(8);
    expect(nextRead).toHaveBeenCalledTimes(1);
  });
});
