import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress, zeroAddress, type Hex } from "viem";
import { deriveNameIdentity } from "@contour/normalization";
import { resolverDataHash } from "@contour/sdk";
import { PRODUCT_DEFAULTS } from "@/lib/brand";
import {
  readSmallJsonObject,
  RequestBodyTooLargeError,
} from "@/lib/api-validation";
import { getDeploymentManifest, protocolCapabilities } from "@/lib/manifest";
import {
  createRegistrationChallenge,
  LocalIssuerRequestError,
  registrationChallengeOrigin,
} from "@/lib/permit-issuer";
import { ApiAdmissionError, withApiAdmission } from "@/lib/api-admission";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ChallengeBody = {
  requestId?: unknown;
  rawLabel?: unknown;
  normalizationAccepted?: unknown;
  requester?: unknown;
  recipient?: unknown;
  payer?: unknown;
  authorizedExecutor?: unknown;
  durationYears?: unknown;
  resolverDataHash?: unknown;
  referrer?: unknown;
};

export async function POST(request: NextRequest) {
  if (!protocolCapabilities.registration) {
    return NextResponse.json(
      { error: "Registration is temporarily unavailable.", code: "REGISTRATION_UNAVAILABLE" },
      { status: 503 },
    );
  }

  let body: ChallengeBody;
  try {
    body = (await readSmallJsonObject(request, 16_384)) as ChallengeBody;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }
  const durationYears = body.durationYears;
  const parties = [body.requester, body.recipient, body.payer, body.authorizedExecutor];
  if (
    typeof body.requestId !== "string" ||
    body.requestId.length < 8 ||
    body.requestId.length > 128 ||
    typeof body.rawLabel !== "string" ||
    body.rawLabel.length === 0 ||
    body.rawLabel.length > 256 ||
    typeof body.normalizationAccepted !== "boolean" ||
    typeof durationYears !== "number" ||
    !Number.isInteger(durationYears) ||
    durationYears < PRODUCT_DEFAULTS.minRegistrationYears ||
    durationYears > PRODUCT_DEFAULTS.maxRegistrationYears ||
    parties.some((value) => typeof value !== "string" || !isAddress(value)) ||
    typeof body.resolverDataHash !== "string" ||
    body.resolverDataHash.toLowerCase() !== resolverDataHash([]) ||
    typeof body.referrer !== "string" ||
    !isAddress(body.referrer)
  ) {
    return NextResponse.json({ error: "Invalid registration intent." }, { status: 400 });
  }

  const requester = getAddress(body.requester as string);
  const recipient = getAddress(body.recipient as string);
  const payer = getAddress(body.payer as string);
  const authorizedExecutor = getAddress(body.authorizedExecutor as string);
  const referrer = getAddress(body.referrer);
  if (
    [requester, recipient, payer, authorizedExecutor].some((address) => address === zeroAddress) ||
    requester !== recipient ||
    requester !== payer ||
    requester !== authorizedExecutor ||
    referrer !== zeroAddress
  ) {
    return NextResponse.json({ error: "Unsafe registration parties." }, { status: 400 });
  }

  const deployment = getDeploymentManifest();
  const suffix = deployment.namespace.suffix;
  if (!suffix) {
    return NextResponse.json({ error: "The namespace is not active." }, { status: 503 });
  }
  try {
    const identity = deriveNameIdentity(body.rawLabel, suffix);
    if (identity.changed && !body.normalizationAccepted) {
      return NextResponse.json(
        { error: `The label normalizes to ${identity.normalized}. Explicit acceptance is required.` },
        { status: 409 },
      );
    }
  } catch {
    return NextResponse.json({ error: "The label is not valid under ENSIP-15." }, { status: 400 });
  }

  try {
    return await withApiAdmission("registration:challenge", 8, async () => {
      const result = await createRegistrationChallenge({
        manifest: deployment,
        origin: registrationChallengeOrigin(request.nextUrl.origin, deployment),
        intent: {
          requestId: body.requestId as string,
          rawLabel: body.rawLabel as string,
          normalizationAccepted: body.normalizationAccepted as boolean,
          requester,
          recipient,
          payer,
          authorizedExecutor,
          durationYears,
          resolverDataHash: body.resolverDataHash as Hex,
          referrer,
        },
      });
      return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
    });
  } catch (error) {
    if (error instanceof ApiAdmissionError) {
      return NextResponse.json(
        { error: "The registration service is busy. Retry shortly.", code: "SERVICE_BUSY" },
        { status: 503, headers: { "retry-after": "2" } },
      );
    }
    if (error instanceof LocalIssuerRequestError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
        },
        { status: error.status, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json(
      { error: "Registration is temporarily unavailable.", code: "PERMIT_ISSUER_UNAVAILABLE" },
      { status: 503 },
    );
  }
}
