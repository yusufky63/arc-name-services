"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  parseNameReadRetryState,
  scheduleNextNameReadRetry,
} from "@/lib/name-read-recovery";

const STORAGE_PREFIX = "contour:name-read-retry:v1:";
const inMemoryRetries = new Map<string, ReturnType<typeof parseNameReadRetryState>>();

function storageKey(label: string) {
  return `${STORAGE_PREFIX}${label}`;
}

export function NameReadRecovery({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [cycle, setCycle] = useState(0);

  useEffect(() => {
    const key = storageKey(label);
    if (!active) {
      inMemoryRetries.delete(key);
      try {
        window.sessionStorage.removeItem(key);
      } catch {
        // Storage can be unavailable in privacy-restricted browser contexts.
      }
      return;
    }
    if (isPending) return;

    let stored: string | null = null;
    try {
      stored = window.sessionStorage.getItem(key);
    } catch {
      // A bounded in-memory attempt is still safe when storage is unavailable.
    }
    const current = parseNameReadRetryState(stored) ?? inMemoryRetries.get(key) ?? null;
    const next = scheduleNextNameReadRetry(current, Date.now());
    if (!next) return;

    const timer = window.setTimeout(() => {
      inMemoryRetries.set(key, next.state);
      try {
        window.sessionStorage.setItem(key, JSON.stringify(next.state));
      } catch {
        // The server read remains fail-closed even if retry bookkeeping cannot persist.
      }
      startTransition(() => router.refresh());
      setCycle((value) => value + 1);
    }, next.delayMs);

    return () => window.clearTimeout(timer);
  }, [active, cycle, isPending, label, router, startTransition]);

  return null;
}
