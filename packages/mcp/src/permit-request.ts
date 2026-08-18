import { getAddress, zeroAddress, type Address, type Hex } from "viem";
import { registrarVersionOf, type DeploymentManifest } from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";

export interface PermitIntentInput {
  rawLabel: string;
  normalizationAccepted: boolean;
  requester: string;
  recipient: string;
  durationYears: number;
  resolverDataHash: string;
  requestId: string;
  referrer?: string | undefined;
}

export const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;

function issuerEndpoint(base: string, path: "v1/challenges" | "v1/permits"): string {
  const issuer = new URL(base);
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash
  ) {
    throw new Error("permit issuer URL must be credential-free HTTPS");
  }
  issuer.pathname = issuer.pathname.endsWith("/") ? issuer.pathname : `${issuer.pathname}/`;
  return new URL(path, issuer).toString();
}

export function preparePermitHttpRequest(manifest: DeploymentManifest, input: PermitIntentInput) {
  if (
    registrarVersionOf(manifest) !== "v2" ||
    !manifest.releaseId ||
    manifest.state !== "active" ||
    !manifest.namespace.suffix ||
    !manifest.permitIssuer.url ||
    !manifest.permitIssuer.active ||
    manifest.activationEvidence.controllerPolicy.registrationsPaused !== false
  ) {
    throw new Error("secure registration is unavailable; no wallet request or payment was made");
  }
  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    throw new Error("requestId must contain 8-128 safe identifier characters");
  }
  if (!Number.isInteger(input.durationYears) || input.durationYears < 1 || input.durationYears > 10) {
    throw new Error("durationYears is outside policy");
  }
  if (!BYTES32_PATTERN.test(input.resolverDataHash)) {
    throw new Error("resolverDataHash must be bytes32");
  }
  const identity = deriveNameIdentity(input.rawLabel, manifest.namespace.suffix);
  if (identity.changed && !input.normalizationAccepted) {
    throw new Error(`normalization changed the label to ${identity.normalized}; explicit acceptance is required`);
  }
  const requester = getAddress(input.requester);
  const recipient = getAddress(input.recipient);
  const referrer = getAddress(input.referrer ?? zeroAddress);
  if (requester === zeroAddress || recipient === zeroAddress) throw new Error("requester and recipient must be non-zero");
  if (referrer !== zeroAddress && (referrer === requester || referrer === recipient)) {
    throw new Error("referrer must differ from payer and recipient");
  }
  if (referrer !== zeroAddress) {
    throw new Error("referrals are not active for this wallet-bound issuer route");
  }
  const body = {
    requestId: input.requestId,
    rawLabel: input.rawLabel,
    normalizationAccepted: input.normalizationAccepted,
    requester,
    recipient,
    payer: requester,
    authorizedExecutor: requester,
    durationYears: input.durationYears,
    resolverDataHash: input.resolverDataHash as Hex,
    referrer: referrer as Address,
  };
  return {
    releaseId: manifest.releaseId,
    challenge: {
      method: "POST" as const,
      url: issuerEndpoint(manifest.permitIssuer.url, "v1/challenges"),
      body,
      responseFields: {
        challengeId: "id",
        challengeMessage: "message",
        challengeProof: "proof",
      },
    },
    permit: {
      method: "POST" as const,
      url: issuerEndpoint(manifest.permitIssuer.url, "v1/permits"),
      bodyAfterChallengeSignature: {
        ...body,
        challengeId: null,
        challengeMessage: null,
        challengeProof: null,
        challengeSignature: null,
      },
    },
    warning: "A permit is not a registration. Ownership exists only after a confirmed Arc receipt.",
  };
}
