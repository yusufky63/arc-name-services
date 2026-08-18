import { describe, expect, it } from "vitest";
import {
  NAME_READ_RETRY_DELAYS_MS,
  parseNameReadRetryState,
  scheduleNextNameReadRetry,
} from "./name-read-recovery";

describe("name read recovery", () => {
  it("schedules three bounded retries with increasing backoff", () => {
    const now = 10_000;
    const first = scheduleNextNameReadRetry(null, now);
    const second = scheduleNextNameReadRetry(first?.state ?? null, now + 2_000);
    const third = scheduleNextNameReadRetry(second?.state ?? null, now + 5_000);

    expect(first).toEqual({
      delayMs: NAME_READ_RETRY_DELAYS_MS[0],
      state: { attempts: 1, startedAt: now },
    });
    expect(second?.delayMs).toBe(NAME_READ_RETRY_DELAYS_MS[1]);
    expect(third?.delayMs).toBe(NAME_READ_RETRY_DELAYS_MS[2]);
    expect(scheduleNextNameReadRetry(third?.state ?? null, now + 12_000)).toBeNull();
  });

  it("never restarts an exhausted automatic retry sequence", () => {
    expect(scheduleNextNameReadRetry(
      { attempts: 3, startedAt: 1 },
      100_000,
    )).toBeNull();
  });

  it("rejects malformed persisted retry state", () => {
    expect(parseNameReadRetryState('{"attempts":"3","startedAt":1}')).toBeNull();
    expect(parseNameReadRetryState("not-json")).toBeNull();
    expect(parseNameReadRetryState('{"attempts":2,"startedAt":100}')).toEqual({
      attempts: 2,
      startedAt: 100,
    });
  });
});
