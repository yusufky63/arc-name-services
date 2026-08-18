import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy, resolvePrivateCandidateGate } from "./proxy";

const PASSWORD = "p".repeat(40);
const CANDIDATE_ENVIRONMENT_KEYS = [
  "PRIVATE_CANDIDATE_MODE",
  "PRIVATE_CANDIDATE_INGRESS_USERNAME",
  "PRIVATE_CANDIDATE_INGRESS_PASSWORD",
  "PROMOTION_CANDIDATE_INGRESS_USERNAME",
  "PROMOTION_CANDIDATE_INGRESS_PASSWORD",
  "PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE",
  "PRODUCT_LIVE_RELEASE",
] as const;

function privateCandidateEnvironment() {
  vi.stubEnv("PRIVATE_CANDIDATE_MODE", "true");
  vi.stubEnv("PRIVATE_CANDIDATE_INGRESS_USERNAME", "operator");
  vi.stubEnv("PRIVATE_CANDIDATE_INGRESS_PASSWORD", PASSWORD);
  vi.stubEnv("PRODUCT_LIVE_RELEASE", "false");
}

beforeEach(() => {
  for (const name of CANDIDATE_ENVIRONMENT_KEYS) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("public proxy boundary", () => {
  it.each([
    "/",
    "/market",
    "/api/manifest",
    "/api/registration/readiness",
    "/api/registration/issuer/healthz",
    "/evidence/contour-v1/index.json",
  ])("passes %s without an authentication challenge", (pathname) => {
    const response = proxy(new NextRequest(`https://names.example${pathname}`));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("never forwards caller authorization or spoofed internal identity headers", () => {
    const response = proxy(new NextRequest("https://names.example/api/manifest", {
      headers: {
        authorization: "Bearer caller-secret",
        "x-contour-internal-client-key": "spoofed",
        "x-contour-internal-client-proof": "spoofed",
        "x-middleware-subrequest": "spoofed",
      },
    }));
    const overridden = response.headers.get("x-middleware-override-headers") ?? "";

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-request-authorization")).toBeNull();
    expect(response.headers.get("x-middleware-request-x-contour-internal-client-key")).toBeNull();
    expect(response.headers.get("x-middleware-request-x-contour-internal-client-proof")).toBeNull();
    expect(overridden).not.toContain("authorization");
    expect(overridden).not.toContain("x-contour-internal-client");
  });
});

describe("private candidate proxy boundary", () => {
  it.each([
    undefined,
    "Basic d3Jvbmc6Y3JlZGVudGlhbA==",
    "Bearer not-basic",
  ])("rejects anonymous or wrong credentials with an uncacheable Basic challenge", (authorization) => {
    privateCandidateEnvironment();
    const response = proxy(new NextRequest("https://candidate.example/api/manifest", {
      ...(authorization ? { headers: { authorization } } : {}),
    }));

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic\b/i);
    expect(response.headers.get("cache-control")).toMatch(/\bno-store\b/i);
    expect(response.headers.get("pragma")).toBe("no-cache");
    expect(response.headers.get("x-middleware-next")).toBeNull();
  });

  it("passes exact Basic credentials and strips Authorization before app code", () => {
    privateCandidateEnvironment();
    const authorization = `Basic ${Buffer.from(`operator:${PASSWORD}`, "ascii").toString("base64")}`;
    const response = proxy(new NextRequest("https://candidate.example/api/manifest", {
      headers: { authorization },
    }));
    const overridden = response.headers.get("x-middleware-override-headers") ?? "";

    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("www-authenticate")).toBeNull();
    expect(response.headers.get("x-middleware-request-authorization")).toBeNull();
    expect(overridden).not.toContain("authorization");
  });

  it("fails closed when private mode credentials are missing or outside the ASCII bounds", () => {
    expect(resolvePrivateCandidateGate({
      PRIVATE_CANDIDATE_MODE: "true",
      PRIVATE_CANDIDATE_INGRESS_USERNAME: "operator",
    }).mode).toBe("invalid");
    expect(resolvePrivateCandidateGate({
      PRIVATE_CANDIDATE_MODE: "true",
      PRIVATE_CANDIDATE_INGRESS_USERNAME: "operatör",
      PRIVATE_CANDIDATE_INGRESS_PASSWORD: PASSWORD,
    }).mode).toBe("invalid");
    expect(resolvePrivateCandidateGate({
      PRIVATE_CANDIDATE_MODE: "true",
      PRIVATE_CANDIDATE_INGRESS_USERNAME: "operator",
      PRIVATE_CANDIDATE_INGRESS_PASSWORD: "short",
    }).mode).toBe("invalid");

    vi.stubEnv("PRIVATE_CANDIDATE_MODE", "true");
    const response = proxy(new NextRequest("https://candidate.example/"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toMatch(/\bno-store\b/i);
  });

  it.each([
    { PRIVATE_CANDIDATE_INGRESS_USERNAME: "stale" },
    { PRIVATE_CANDIDATE_INGRESS_PASSWORD: PASSWORD },
    {
      PRIVATE_CANDIDATE_INGRESS_USERNAME: "stale",
      PRIVATE_CANDIDATE_INGRESS_PASSWORD: PASSWORD,
    },
    { PROMOTION_CANDIDATE_INGRESS_USERNAME: "operator" },
    { PROMOTION_CANDIDATE_INGRESS_PASSWORD: PASSWORD },
    { PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE: "false" },
  ])(
    "fails closed when candidate credentials or operator candidate residue exist without exact private mode: %o",
    (residue) => {
      expect(resolvePrivateCandidateGate(residue).mode).toBe("invalid");
      expect(resolvePrivateCandidateGate({
        ...residue,
        PRIVATE_CANDIDATE_MODE: "false",
      }).mode).toBe("invalid");

      for (const [name, value] of Object.entries(residue)) vi.stubEnv(name, value);
      const response = proxy(new NextRequest("https://candidate.example/api/manifest"));
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toMatch(/\bno-store\b/i);
      expect(response.headers.get("pragma")).toBe("no-cache");
      expect(response.headers.get("www-authenticate")).toBeNull();
      expect(response.headers.get("x-middleware-next")).toBeNull();
    },
  );

  it("keeps an explicit false mode public only when no candidate residue exists", () => {
    expect(resolvePrivateCandidateGate({
      PRIVATE_CANDIDATE_MODE: "false",
      PRODUCT_LIVE_RELEASE: "false",
    }).mode).toBe("public");
  });

  it.each([
    { PRIVATE_CANDIDATE_MODE: "true" },
    { PRIVATE_CANDIDATE_MODE: "false" },
    { PRIVATE_CANDIDATE_INGRESS_USERNAME: "stale" },
    { PRIVATE_CANDIDATE_INGRESS_PASSWORD: PASSWORD },
    { PROMOTION_CANDIDATE_INGRESS_USERNAME: "operator" },
    { PROMOTION_CANDIDATE_INGRESS_PASSWORD: PASSWORD },
    { PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE: "false" },
  ])("rejects every candidate flag, credential, or operator residue from product-live: %o", (residue) => {
    const liveBinding = `${"0x" + "11".repeat(32)}:${"0x" + "22".repeat(32)}:123`;
    expect(resolvePrivateCandidateGate({
      PRODUCT_LIVE_RELEASE: liveBinding,
      ...residue,
    }).mode).toBe("invalid");

    vi.stubEnv("PRODUCT_LIVE_RELEASE", liveBinding);
    for (const [name, value] of Object.entries(residue)) vi.stubEnv(name, value);
    const response = proxy(new NextRequest("https://names.example/api/manifest"));
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toMatch(/\bno-store\b/i);
    expect(response.headers.get("www-authenticate")).toBeNull();
  });

  it("keeps a product-live runtime public only when all candidate residue is absent", () => {
    const liveBinding = `${"0x" + "11".repeat(32)}:${"0x" + "22".repeat(32)}:123`;
    expect(resolvePrivateCandidateGate({
      PRODUCT_LIVE_RELEASE: liveBinding,
    }).mode).toBe("public");
  });
});
