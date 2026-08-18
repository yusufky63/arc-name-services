import { isHex, type Hex } from "viem";
import {
  deploymentManifestDigest,
  type ActivationState,
  type DeploymentManifest,
} from "./manifest.js";

export interface PromotionAttestation {
  schemaVersion: "1.0.0";
  verifier: "contour-live-promotion-v1";
  manifestSha256: Hex;
  state: ActivationState;
  productLive: boolean;
  liveVerified: boolean;
  releaseId: Hex | null;
  verifiedAtBlock: number | null;
  checkedAtBlock: string | null;
}

export type PromotionVerificationMode = "bootstrap" | "live" | "attested-live";

function fail(message: string): never {
  throw new Error(`promotion attestation invalid: ${message}`);
}

/**
 * Validates that a build artifact was produced for this exact semantic
 * manifest. Callers decide whether a live verification result is required.
 */
export function assertPromotionAttestation(
  value: unknown,
  manifest: DeploymentManifest,
  requireLiveVerification: boolean,
): asserts value is PromotionAttestation {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("expected an object");
  const attestation = value as PromotionAttestation;
  if (attestation.schemaVersion !== "1.0.0" || attestation.verifier !== "contour-live-promotion-v1") {
    fail("unsupported verifier schema");
  }
  if (!isHex(attestation.manifestSha256, { strict: true }) || attestation.manifestSha256.length !== 66) {
    fail("manifestSha256 must be bytes32");
  }
  if (attestation.manifestSha256.toLowerCase() !== deploymentManifestDigest(manifest).toLowerCase()) {
    fail("manifest digest mismatch");
  }
  if (
    attestation.state !== manifest.state ||
    attestation.productLive !== manifest.activationEvidence.productLive ||
    attestation.releaseId !== manifest.releaseId ||
    attestation.verifiedAtBlock !== manifest.activationEvidence.verifiedAtBlock
  ) {
    fail("manifest metadata mismatch");
  }
  if (typeof attestation.liveVerified !== "boolean") fail("liveVerified must be boolean");
  if (attestation.checkedAtBlock !== null && !/^[1-9][0-9]*$/.test(attestation.checkedAtBlock)) {
    fail("checkedAtBlock must be a positive integer string or null");
  }
  if (attestation.liveVerified !== (attestation.checkedAtBlock !== null)) {
    fail("liveVerified and checkedAtBlock must describe the same verification phase");
  }
  if (attestation.liveVerified) {
    if (manifest.state !== "verified" && manifest.state !== "active") {
      fail("only a verified/active manifest can carry a live result");
    }
    if (
      manifest.activationEvidence.verifiedAtBlock === null ||
      BigInt(attestation.checkedAtBlock!) < BigInt(manifest.activationEvidence.verifiedAtBlock)
    ) {
      fail("checkedAtBlock cannot precede the manifest verification block");
    }
  }
  if (requireLiveVerification && !attestation.liveVerified) fail("live verification is required");
}

/**
 * Chooses the CI/build verification phase without allowing private-candidate
 * bootstrap to weaken a public product release. An active non-public candidate
 * may emit an exact digest-bound non-live attestation only when the operator has
 * explicitly enabled the private candidate mode. Every other verified/active
 * build still performs live promotion verification. A product-live build
 * consumes an already live-verified exact target attestation produced by the
 * authenticated candidate-source ceremony, avoiding self-health circularity.
 */
export function promotionVerificationMode(
  manifest: DeploymentManifest,
  privateCandidateMode: boolean,
): PromotionVerificationMode {
  if (privateCandidateMode) {
    if (manifest.state !== "active" || manifest.activationEvidence.productLive) {
      fail("private candidate bootstrap requires an active non-product-live manifest");
    }
    return "bootstrap";
  }
  if (manifest.state === "active" && manifest.activationEvidence.productLive) {
    return "attested-live";
  }
  return manifest.state === "verified" || manifest.state === "active" ? "live" : "bootstrap";
}

/**
 * Release-bound consumers such as the activated BENS renderer must not treat a
 * private active candidate (or a merely verified manifest) as a public runtime
 * release. This composes the exact-manifest/live-result checks above with the
 * product-live state gate so every consumer applies the same rule.
 */
export function assertProductLivePromotionAttestation(
  value: unknown,
  manifest: DeploymentManifest,
): asserts value is PromotionAttestation {
  assertPromotionAttestation(value, manifest, true);
  if (manifest.state !== "active" || manifest.activationEvidence.productLive !== true) {
    fail("an active product-live release is required");
  }
}

export function createPromotionAttestation(
  manifest: DeploymentManifest,
  checkedAtBlock: string | null,
): PromotionAttestation {
  const liveVerified = checkedAtBlock !== null;
  return {
    schemaVersion: "1.0.0",
    verifier: "contour-live-promotion-v1",
    manifestSha256: deploymentManifestDigest(manifest),
    state: manifest.state,
    productLive: manifest.activationEvidence.productLive,
    liveVerified,
    releaseId: manifest.releaseId,
    verifiedAtBlock: manifest.activationEvidence.verifiedAtBlock,
    checkedAtBlock,
  };
}
