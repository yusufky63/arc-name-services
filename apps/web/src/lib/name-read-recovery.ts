export const NAME_READ_RETRY_DELAYS_MS = [1_250, 2_500, 5_000] as const;

export type NameReadRetryState = {
  attempts: number;
  startedAt: number;
};

export type ScheduledNameReadRetry = {
  delayMs: number;
  state: NameReadRetryState;
};

export function parseNameReadRetryState(value: string | null): NameReadRetryState | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<NameReadRetryState>;
    if (
      !Number.isInteger(parsed.attempts) ||
      (parsed.attempts ?? -1) < 0 ||
      typeof parsed.startedAt !== "number" ||
      !Number.isFinite(parsed.startedAt)
    ) {
      return null;
    }
    return { attempts: parsed.attempts as number, startedAt: parsed.startedAt };
  } catch {
    return null;
  }
}

export function scheduleNextNameReadRetry(
  current: NameReadRetryState | null,
  now: number,
): ScheduledNameReadRetry | null {
  const usable = current ?? { attempts: 0, startedAt: now };

  const delayMs = NAME_READ_RETRY_DELAYS_MS[usable.attempts];
  if (delayMs === undefined) return null;

  return {
    delayMs,
    state: {
      attempts: usable.attempts + 1,
      startedAt: usable.startedAt,
    },
  };
}
