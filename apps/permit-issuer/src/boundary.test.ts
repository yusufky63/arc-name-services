import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { validateIssuerBoundary } from "./boundary.js";

const bearer = "b".repeat(32);
const secret = "s".repeat(32);
const clientKey = "a".repeat(64);
const timestamp = "1893456000";

function headers(path = "/v1/challenges") {
  return {
    authorization: `Bearer ${bearer}`,
    "x-contour-client-key": clientKey,
    "x-contour-client-timestamp": timestamp,
    "x-contour-client-signature": createHmac("sha256", secret)
      .update(`contour-issuer-boundary/v1\n${timestamp}\nPOST\n${path}\n${clientKey}`)
      .digest("hex"),
  };
}

describe("issuer service boundary", () => {
  it("accepts only a fresh route-bound opaque client key", () => {
    expect(validateIssuerBoundary(headers(), "POST", "/v1/challenges", bearer, secret, 1_893_456_000))
      .toBe(clientKey);
    expect(() => validateIssuerBoundary(headers(), "POST", "/v1/permits", bearer, secret, 1_893_456_000))
      .toThrow(/signature/);
    expect(() => validateIssuerBoundary(headers(), "POST", "/v1/challenges", bearer, secret, 1_893_456_061))
      .toThrow(/stale/);
  });

  it("rejects a missing bearer and attacker-selected unsigned key", () => {
    expect(() => validateIssuerBoundary({ ...headers(), authorization: "Bearer wrong" }, "POST", "/v1/challenges", bearer, secret, 1_893_456_000))
      .toThrow(/bearer/);
    expect(() => validateIssuerBoundary({ ...headers(), "x-contour-client-key": "c".repeat(64) }, "POST", "/v1/challenges", bearer, secret, 1_893_456_000))
      .toThrow(/signature/);
  });
});
