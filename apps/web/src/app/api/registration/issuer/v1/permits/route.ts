import { NextRequest, NextResponse } from "next/server";
import { readSmallJsonObject, RequestBodyTooLargeError } from "@/lib/api-validation";
import { ApiAdmissionError, withApiAdmission } from "@/lib/api-admission";
import { getDeploymentManifest, protocolCapabilities } from "@/lib/manifest";
import {
  issueRegistrationPermit,
  LocalIssuerRequestError,
  registrationChallengeOrigin,
} from "@/lib/permit-issuer";
import {
  IssuerAdapterInputError,
  jsonSafe,
  parseIssuerPermitRequest,
} from "../_shared";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const noStore = { "cache-control": "no-store" };

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return NextResponse.json(body, { status, headers: { ...noStore, ...headers } });
}

export async function POST(request: NextRequest) {
  if (!protocolCapabilities.registration) {
    return response(
      { error: "Registration is temporarily unavailable.", code: "REGISTRATION_UNAVAILABLE" },
      503,
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await readSmallJsonObject(request, 16_384);
  } catch (error) {
    return error instanceof RequestBodyTooLargeError
      ? response({ error: "Request body is too large." }, 413)
      : response({ error: "Invalid JSON request." }, 400);
  }

  try {
    const input = parseIssuerPermitRequest(body);
    const manifest = getDeploymentManifest();
    return await withApiAdmission("registration:issuer:v1:permits", 4, async () => {
      const issued = await issueRegistrationPermit({
        manifest,
        origin: registrationChallengeOrigin(request.nextUrl.origin, manifest),
        ...input,
      });
      return response({
        normalizedLabel: issued.normalizedLabel,
        permit: jsonSafe(issued.permit),
        signature: issued.signature,
      });
    });
  } catch (error) {
    if (error instanceof IssuerAdapterInputError) {
      return response({ error: error.message, code: "INVALID_PERMIT_REQUEST" }, 400);
    }
    if (error instanceof ApiAdmissionError) {
      return response(
        { error: "The registration service is busy. Retry shortly.", code: "SERVICE_BUSY" },
        503,
        { "retry-after": "2" },
      );
    }
    if (error instanceof LocalIssuerRequestError) {
      return response(
        {
          error: error.message,
          code: error.code,
          ...(error.retryAfter ? { retryAfter: error.retryAfter } : {}),
        },
        error.status,
        error.retryAfter ? { "retry-after": error.retryAfter } : {},
      );
    }
    return response(
      { error: "Registration is temporarily unavailable.", code: "PERMIT_ISSUER_UNAVAILABLE" },
      503,
    );
  }
}
