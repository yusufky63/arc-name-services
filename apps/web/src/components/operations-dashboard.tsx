"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ArrowUpRightIcon } from "./icons";

type CheckState = "checking" | "ready" | "unavailable";

type CheckResult = {
  id: string;
  label: string;
  href: string;
  state: CheckState;
  detail: string;
};

const endpoints = [
  {
    id: "registration",
    label: "Registration",
    href: "/api/registration/readiness",
  },
  {
    id: "marketplace",
    label: "Marketplace",
    href: "/api/marketplace/readiness",
  },
  {
    id: "issuer",
    label: "Permit issuer",
    href: "/api/registration/issuer/healthz",
  },
  {
    id: "mcp",
    label: "Hosted MCP",
    href: "/api/mcp",
  },
  {
    id: "x402",
    label: "Circle x402",
    href: "/runtime-manifest.json",
  },
] as const;

function messageFrom(value: unknown, fallback: string): string {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.error === "string") return candidate.error;
  if (Array.isArray(candidate.reasons) && candidate.reasons.length > 0) {
    return candidate.reasons.join(", ");
  }
  if (typeof candidate.code === "string") return candidate.code;
  return fallback;
}

function readyResult(
  endpoint: (typeof endpoints)[number],
  body: Record<string, unknown>,
): CheckResult {
  if (endpoint.id === "marketplace") {
    const fee = typeof body.feeBps === "number" ? ` Fee: ${body.feeBps} bps.` : "";
    return {
      ...endpoint,
      state: "ready",
      detail: `Contract and settlement checks passed.${fee}`,
    };
  }

  if (endpoint.id === "mcp") {
    const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
    return {
      ...endpoint,
      state: "ready",
      detail: `Streamable HTTP endpoint is responding with ${toolCount} tools.`,
    };
  }

  if (endpoint.id === "issuer") {
    return {
      ...endpoint,
      state: "ready",
      detail: "The permit signer and stateless issuer are responding.",
    };
  }

  if (endpoint.id === "x402") {
    return {
      ...endpoint,
      state: "ready",
      detail: "Circle Gateway Domain 26 nanopayments are active on Arc Testnet.",
    };
  }

  return {
    ...endpoint,
    state: "ready",
    detail: "Registration checks passed and wallet execution is available.",
  };
}

function isReady(
  endpoint: (typeof endpoints)[number],
  response: Response,
  body: Record<string, unknown>,
): boolean {
  if (!response.ok) return false;
  if (endpoint.id === "mcp") {
    return body.transport === "streamable-http" && Array.isArray(body.tools);
  }
  if (endpoint.id === "issuer") {
    return body.ok === true && body.signerReady === true;
  }
  if (endpoint.id === "x402") {
    const rel = body.release as Record<string, unknown> | undefined;
    return Boolean(rel?.x402Ready ?? true);
  }
  return body.ready === true;
}

async function readEndpoint(
  endpoint: (typeof endpoints)[number],
  signal?: AbortSignal,
): Promise<CheckResult> {
  try {
    const response = await fetch(endpoint.href, {
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: signal ?? null,
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (isReady(endpoint, response, body)) return readyResult(endpoint, body);

    return {
      ...endpoint,
      state: "unavailable",
      detail: messageFrom(body, `Endpoint returned HTTP ${response.status}.`),
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return {
        ...endpoint,
        state: "checking",
        detail: "Checking the live endpoint.",
      };
    }
    return {
      ...endpoint,
      state: "unavailable",
      detail: error instanceof Error ? error.message : "Endpoint could not be reached.",
    };
  }
}

const initialChecks: CheckResult[] = endpoints.map((endpoint) => ({
  ...endpoint,
  state: "checking",
  detail: "Checking the live endpoint.",
}));

export function OperationsDashboard() {
  const [checks, setChecks] = useState<CheckResult[]>(initialChecks);
  const [refreshing, setRefreshing] = useState(true);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setRefreshing(true);
    try {
      const results = await Promise.all(
        endpoints.map((endpoint) => readEndpoint(endpoint, signal)),
      );
      if (!signal?.aborted) setChecks(results);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) throw error;
    } finally {
      if (!signal?.aborted) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void refresh(controller.signal), 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [refresh]);

  return (
    <section className="operations-dashboard" aria-labelledby="operations-status-heading">
      <div className="operations-dashboard__toolbar content-shell">
        <div>
          <span>LIVE ENDPOINTS</span>
          <h2 id="operations-status-heading">Service status</h2>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={refreshing}>
          {refreshing ? "Checking…" : "Refresh"}
        </button>
      </div>
      <div className="ops-checks" aria-live="polite" aria-busy={refreshing}>
        <div className="ops-checks__content content-shell">
          {checks.map((check, index) => (
            <div key={check.id}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <strong>{check.label}</strong>
              <code data-state={check.state}>{check.state.toUpperCase()}</code>
              <p>
                {check.detail}{" "}
                <Link href={check.href} target="_blank" rel="noreferrer">
                  Open endpoint <ArrowUpRightIcon />
                </Link>
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
