import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

const INTERNAL_CLIENT_KEY_HEADER = "x-contour-internal-client-key";
const INTERNAL_CLIENT_PROOF_HEADER = "x-contour-internal-client-proof";
const PRIVATE_CANDIDATE_REALM = "Contour private candidate";
const BASIC_TOKEN_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

type PrivateCandidateGate =
  | { mode: "public" }
  | { mode: "private"; username: string; password: string }
  | { mode: "invalid" };

function boundedCandidateCredentials(username: string, password: string): boolean {
  return (
    username.length >= 1 &&
    username.length <= 256 &&
    !username.includes(":") &&
    /^[\u0021-\u007e]+$/.test(username) &&
    password.length >= 32 &&
    password.length <= 3_800 &&
    /^[\u0020-\u007e]+$/.test(password)
  );
}

export function resolvePrivateCandidateGate(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): PrivateCandidateGate {
  const rawMode = environment.PRIVATE_CANDIDATE_MODE ?? "";
  const username = environment.PRIVATE_CANDIDATE_INGRESS_USERNAME ?? "";
  const password = environment.PRIVATE_CANDIDATE_INGRESS_PASSWORD ?? "";
  const liveBinding = environment.PRODUCT_LIVE_RELEASE ?? "";
  const productLive = liveBinding.length > 0 && liveBinding !== "false";
  const candidateCredentialsPresent = username.length > 0 || password.length > 0;
  const operatorCandidateConfigurationPresent = (
    (environment.PROMOTION_CANDIDATE_INGRESS_USERNAME ?? "").length > 0 ||
    (environment.PROMOTION_CANDIDATE_INGRESS_PASSWORD ?? "").length > 0 ||
    (environment.PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE ?? "").length > 0
  );
  const candidateConfigurationPresent = (
    rawMode.length > 0 ||
    candidateCredentialsPresent ||
    operatorCandidateConfigurationPresent
  );

  // Product-live is an irreversible public boundary: even a false candidate
  // flag or a stale credential makes the runtime unavailable until it is
  // removed from the deployment environment.
  if (productLive && candidateConfigurationPresent) return { mode: "invalid" };
  if (rawMode !== "" && rawMode !== "false" && rawMode !== "true") return { mode: "invalid" };
  if (
    rawMode !== "true" &&
    (candidateCredentialsPresent || operatorCandidateConfigurationPresent)
  ) {
    return { mode: "invalid" };
  }
  if (rawMode !== "true") return { mode: "public" };
  if (!boundedCandidateCredentials(username, password)) return { mode: "invalid" };
  return { mode: "private", username, password };
}

function basicCredentialsMatch(
  authorization: string | null,
  expectedUsername: string,
  expectedPassword: string,
): boolean {
  const match = authorization?.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i);
  const token = match?.[1];
  if (!token || token.length % 4 !== 0 || !BASIC_TOKEN_PATTERN.test(token)) return false;
  let actual: Buffer;
  try {
    actual = Buffer.from(token, "base64");
  } catch {
    return false;
  }
  if (actual.toString("base64") !== token) return false;
  const expected = Buffer.from(`${expectedUsername}:${expectedPassword}`, "ascii");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function privateBoundaryResponse(status: 401 | 503): NextResponse {
  return new NextResponse(null, {
    status,
    headers: {
      "cache-control": "no-store, max-age=0",
      pragma: "no-cache",
      ...(status === 401
        ? { "www-authenticate": `Basic realm="${PRIVATE_CANDIDATE_REALM}", charset="UTF-8"` }
        : {}),
    },
  });
}

export function proxy(request: NextRequest) {
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_CLIENT_KEY_HEADER);
  headers.delete(INTERNAL_CLIENT_PROOF_HEADER);
  headers.delete("x-middleware-subrequest");
  headers.delete("authorization");
  const gate = resolvePrivateCandidateGate();
  if (gate.mode === "invalid") return privateBoundaryResponse(503);
  if (
    gate.mode === "private" &&
    !basicCredentialsMatch(
      request.headers.get("authorization"),
      gate.username,
      gate.password,
    )
  ) {
    return privateBoundaryResponse(401);
  }
  if (request.nextUrl.pathname === "/favicon.ico") {
    return NextResponse.redirect(new URL("/icon.svg", request.url), 308);
  }
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: "/:path*" };
