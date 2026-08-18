import { afterEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { DeploymentManifest } from "@contour/config";
import deploymentManifest from "../../../../deployments/5042002.json";

vi.mock("server-only", () => ({}));

import {
  assertCanonicalIssuerBinding,
  createRegistrationChallengeProof,
  isSupportedWalletSignature,
  localPermitSignerAddress,
  registrationChallengeOrigin,
  validateRegistrationChallengeEnvelope,
  verifyRegistrationChallengeProof,
} from "./permit-issuer";

const fixturePrivateKey = `0x${"11".repeat(32)}` as const;
const fixtureAccount = privateKeyToAccount(fixturePrivateKey);

function activeFixture(): DeploymentManifest {
  const value = structuredClone(deploymentManifest) as unknown as DeploymentManifest;
  value.state = "active";
  value.permitIssuer.active = true;
  value.permitIssuer.signerAddress = fixtureAccount.address;
  value.permitIssuer.policyVersion = "1";
  value.permitIssuer.url = "https://names.example.test/api/registration/issuer/";
  return value;
}

function challengeMessage(issuedAt: number) {
  const lines = Array.from({ length: 21 }, (_, index) => `Field ${index}`);
  lines[18] = `Challenge: 0x${"ab".repeat(32)}`;
  lines[19] = `Issued at: ${issuedAt}`;
  lines[20] = `Expires at: ${issuedAt + 120}`;
  return lines.join("\n");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("integrated permit issuer secrets", () => {
  it("derives only the fixture signer and matches the pinned manifest", () => {
    vi.stubEnv("REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY", fixturePrivateKey);
    expect(localPermitSignerAddress(activeFixture())).toBe(fixtureAccount.address);
  });

  it("uses root PRIVATE_KEY as a server-only local-development fallback", () => {
    vi.stubEnv("REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY", "");
    vi.stubEnv("PRIVATE_KEY", fixturePrivateKey);
    expect(localPermitSignerAddress(activeFixture())).toBe(fixtureAccount.address);
  });

  it("normalizes a bare 32-byte root PRIVATE_KEY used by Foundry", () => {
    vi.stubEnv("REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY", "");
    vi.stubEnv("PRIVATE_KEY", fixturePrivateKey.slice(2));
    expect(localPermitSignerAddress(activeFixture())).toBe(fixtureAccount.address);
  });

  it("prefers the production-specific signer secret over PRIVATE_KEY", () => {
    vi.stubEnv("REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY", fixturePrivateKey);
    vi.stubEnv("PRIVATE_KEY", `0x${"22".repeat(32)}`);
    expect(localPermitSignerAddress(activeFixture())).toBe(fixtureAccount.address);
  });

  it("rejects a fixture key that does not match the pinned signer", () => {
    vi.stubEnv("REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY", `0x${"22".repeat(32)}`);
    expect(() => localPermitSignerAddress(activeFixture())).toThrow(/does not match/i);
  });

  it("authenticates the exact stateless challenge envelope", () => {
    vi.stubEnv("REGISTRATION_CHALLENGE_SECRET", "fixture-challenge-secret-with-32-characters");
    const id = "8c824ef0-0eb8-4fb9-8aa6-bc558f8f604c";
    const message = "Contour fixture challenge";
    const proof = createRegistrationChallengeProof(id, message);
    expect(proof).toMatch(/^0x[0-9a-f]{64}$/);
    expect(verifyRegistrationChallengeProof(id, message, proof)).toBe(true);
    expect(verifyRegistrationChallengeProof(id, `${message}!`, proof)).toBe(false);
  });

  it("pins production challenge requests to the configured origin", () => {
    vi.stubEnv("REGISTRATION_CHALLENGE_ORIGIN", "https://names.example.test");
    expect(registrationChallengeOrigin("https://names.example.test")).toBe(
      "https://names.example.test",
    );
    expect(() => registrationChallengeOrigin("https://preview.example.test")).toThrow(
      /configured release origin/i,
    );
  });

  it("bridges an explicitly opted-in development loopback to the manifest issuer origin", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("REGISTRATION_ALLOW_LOOPBACK_CANONICAL_ORIGIN", "true");
    vi.stubEnv("REGISTRATION_CHALLENGE_ORIGIN", "http://localhost:3002");
    expect(
      registrationChallengeOrigin("http://127.0.0.1:3002", activeFixture()),
    ).toBe("https://names.example.test");
  });

  it("never enables the loopback bridge in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("REGISTRATION_ALLOW_LOOPBACK_CANONICAL_ORIGIN", "true");
    vi.stubEnv("REGISTRATION_CHALLENGE_ORIGIN", "http://localhost:3002");
    expect(() =>
      registrationChallengeOrigin("http://127.0.0.1:3002", activeFixture()),
    ).toThrow(/configured release origin/i);
  });

  it("binds issuance to the manifest issuer origin and canonical base path", () => {
    const manifest = activeFixture();
    expect(assertCanonicalIssuerBinding(manifest, "https://names.example.test")).toBe(
      "https://names.example.test",
    );
    expect(() =>
      assertCanonicalIssuerBinding(manifest, "https://preview.example.test"),
    ).toThrow(/pinned issuer origin/i);

    manifest.permitIssuer.url = "https://names.example.test/api/registration/other/";
    expect(() =>
      assertCanonicalIssuerBinding(manifest, "https://names.example.test"),
    ).toThrow(/canonical same-origin API base/i);
  });

  it("accepts bounded EOA, compact and smart-account signatures", () => {
    expect(isSupportedWalletSignature(`0x${"11".repeat(65)}`)).toBe(true);
    expect(isSupportedWalletSignature(`0x${"22".repeat(64)}`)).toBe(true);
    expect(isSupportedWalletSignature(`0x${"33".repeat(512)}`)).toBe(true);
    expect(isSupportedWalletSignature("0x123")).toBe(false);
    expect(isSupportedWalletSignature(`0x${"44".repeat(4_097)}`)).toBe(false);
  });

  it("accepts only a fresh, exact HMAC-authenticated 120-second envelope", () => {
    vi.stubEnv("REGISTRATION_CHALLENGE_SECRET", "fixture-challenge-secret-with-32-characters");
    const id = "8c824ef0-0eb8-4fb9-8aa6-bc558f8f604c";
    const issuedAt = 2_000_000_000;
    const message = challengeMessage(issuedAt);
    const proof = createRegistrationChallengeProof(id, message);
    expect(validateRegistrationChallengeEnvelope({
      id,
      message,
      proof,
      now: issuedAt + 30,
    })).toMatchObject({ issuedAt, expiresAt: issuedAt + 120, now: issuedAt + 30 });
    expect(() => validateRegistrationChallengeEnvelope({
      id,
      message,
      proof,
      now: issuedAt + 120,
    })).toThrow(/expired/i);
    expect(() => validateRegistrationChallengeEnvelope({
      id,
      message: `${message}!`,
      proof,
      now: issuedAt + 30,
    })).toThrow(/proof is invalid/i);
  });
});
