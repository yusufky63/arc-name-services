import { describe, expect, it } from "vitest";
import type { DeploymentManifest } from "@contour/config";
import { zeroAddress } from "viem";
import { preparePermitHttpRequest } from "./permit-request.js";

const manifest = {
  state: "active",
  releaseId: `0x${"99".repeat(32)}`,
  registrarVersion: "v2",
  namespace: { suffix: "contour" },
  permitIssuer: { active: true, url: "https://names.example.com/api/registration/issuer/" },
  activationEvidence: {
    controllerPolicy: { registrationsPaused: false },
  },
} as DeploymentManifest;

describe("permit issuer HTTP schema", () => {
  it("uses the same complete canonical intent for challenge and permit", () => {
    const prepared = preparePermitHttpRequest(manifest, {
      requestId: "request-0001",
      rawLabel: "alice",
      normalizationAccepted: true,
      requester: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      durationYears: 2,
      resolverDataHash: `0x${"00".repeat(32)}`,
    });
    expect(prepared.releaseId).toBe(manifest.releaseId);
    expect(prepared.challenge.body).toEqual({
      requestId: "request-0001",
      rawLabel: "alice",
      normalizationAccepted: true,
      requester: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      payer: "0x1111111111111111111111111111111111111111",
      authorizedExecutor: "0x1111111111111111111111111111111111111111",
      durationYears: 2,
      resolverDataHash: `0x${"00".repeat(32)}`,
      referrer: zeroAddress,
    });
    expect(prepared.challenge.url).toBe(
      "https://names.example.com/api/registration/issuer/v1/challenges",
    );
    expect(prepared.permit.url).toBe(
      "https://names.example.com/api/registration/issuer/v1/permits",
    );
    expect(prepared.challenge.responseFields).toEqual({
      challengeId: "id",
      challengeMessage: "message",
      challengeProof: "proof",
    });
    const {
      challengeId,
      challengeMessage,
      challengeProof,
      challengeSignature,
      ...permitIntent
    } = prepared.permit.bodyAfterChallengeSignature;
    expect(challengeId).toBeNull();
    expect(challengeMessage).toBeNull();
    expect(challengeProof).toBeNull();
    expect(challengeSignature).toBeNull();
    expect(permitIntent).toEqual(prepared.challenge.body);
  });

  it("joins a base URL without a trailing slash as a directory", () => {
    const withoutSlash = structuredClone(manifest);
    withoutSlash.permitIssuer.url = "https://names.example.com/api/registration/issuer";
    const prepared = preparePermitHttpRequest(withoutSlash, {
      requestId: "request-0002",
      rawLabel: "alice",
      normalizationAccepted: true,
      requester: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      durationYears: 1,
      resolverDataHash: `0x${"00".repeat(32)}`,
    });
    expect(prepared.challenge.url).toBe(
      "https://names.example.com/api/registration/issuer/v1/challenges",
    );
  });

  it("rejects unsafe issuer URLs and unsupported non-zero referrers", () => {
    const unsafe = structuredClone(manifest);
    unsafe.permitIssuer.url = "https://user:secret@names.example.com/api/registration/issuer/";
    const input = {
      requestId: "request-0003",
      rawLabel: "alice",
      normalizationAccepted: true,
      requester: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      durationYears: 1,
      resolverDataHash: `0x${"00".repeat(32)}`,
    };
    expect(() => preparePermitHttpRequest(unsafe, input)).toThrow(/credential-free HTTPS/);
    expect(() => preparePermitHttpRequest(manifest, {
      ...input,
      referrer: "0x3333333333333333333333333333333333333333",
    })).toThrow(/referrals are not active/);
  });

  it("does not prepare issuer requests from a paused manifest", () => {
    const paused = structuredClone(manifest);
    paused.activationEvidence.controllerPolicy.registrationsPaused = true;
    expect(() => preparePermitHttpRequest(paused, {
      requestId: "request-0004",
      rawLabel: "alice",
      normalizationAccepted: true,
      requester: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      durationYears: 1,
      resolverDataHash: `0x${"00".repeat(32)}`,
    })).toThrow(/registration is unavailable/);
  });

  it("does not prepare a new registration request for a legacy V1 release", () => {
    const legacy = structuredClone(manifest);
    legacy.registrarVersion = "v1";
    expect(() => preparePermitHttpRequest(legacy, {
      requestId: "request-0005",
      rawLabel: "alice",
      normalizationAccepted: true,
      requester: "0x1111111111111111111111111111111111111111",
      recipient: "0x2222222222222222222222222222222222222222",
      durationYears: 1,
      resolverDataHash: `0x${"00".repeat(32)}`,
    })).toThrow(/registration is unavailable/);
  });
});
