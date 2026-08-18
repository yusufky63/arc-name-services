import { NextRequest, NextResponse } from "next/server";
import { getAddress, isAddress } from "viem";
import { getDeploymentManifest, protocolCapabilities } from "@/lib/manifest";
import {
  readLocalIssuerHealth,
  registrationChallengeOrigin,
} from "@/lib/permit-issuer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let manifest;
  try {
    manifest = getDeploymentManifest();
  } catch {
    return NextResponse.json(
      {
        ready: false,
        code: "READINESS_DEPENDENCY_UNAVAILABLE",
        reasons: ["READINESS_DEPENDENCY_UNAVAILABLE"],
        error:
          "Registration is temporarily unavailable. No wallet request or payment was made.",
        releaseId: null,
        chainId: null,
        controller: null,
        signerAddress: null,
        registrationsPaused: null,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const controller = manifest.contracts.controller.address;
  const signer = manifest.permitIssuer.signerAddress;

  if (!protocolCapabilities.registration) {
    return NextResponse.json(
      {
        ready: false,
        code: "EXECUTION_SURFACE_DISABLED",
        reasons: ["EXECUTION_SURFACE_DISABLED"],
        error:
          "Registration is temporarily unavailable. No wallet request or payment was made.",
        releaseId: manifest.releaseId,
        chainId: manifest.chain.id,
        controller,
        signerAddress: signer,
        registrationsPaused:
          manifest.activationEvidence.controllerPolicy.registrationsPaused,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  try {
    registrationChallengeOrigin(request.nextUrl.origin, manifest);
    if (!manifest.permitIssuer.url) {
      throw new Error("issuer URL is missing from manifest");
    }
    const pinnedIssuerUrl = new URL(manifest.permitIssuer.url);
    if (pinnedIssuerUrl.pathname !== "/api/registration/issuer/") {
      throw new Error("issuer URL does not match the pinned same-origin route");
    }

    const health = await readLocalIssuerHealth(manifest);
    const body = health.body;
    const policyVersion = manifest.permitIssuer.policyVersion;
    const reasons: string[] = [];

    if (health.status !== 200 || body.ok !== true) {
      reasons.push("PERMIT_ISSUER_UNAVAILABLE");
    }
    if (body.chainId !== manifest.chain.id) {
      reasons.push("CHAIN_MISMATCH");
    }
    if (body.releaseId !== manifest.releaseId) {
      reasons.push("DEPLOYMENT_MISMATCH");
    }
    if (
      typeof body.controller !== "string" ||
      !isAddress(body.controller) ||
      !controller ||
      getAddress(body.controller) !== getAddress(controller)
    ) {
      reasons.push("CONTROLLER_MISMATCH");
    }
    if (
      body.normalizationProfileHash.toLowerCase() !==
      manifest.normalization.profileHash.toLowerCase()
    ) {
      reasons.push("NORMALIZATION_PROFILE_MISMATCH");
    }
    if (
      typeof body.signerAddress !== "string" ||
      !isAddress(body.signerAddress) ||
      !signer ||
      getAddress(body.signerAddress) !== getAddress(signer) ||
      body.signerReady !== true
    ) {
      reasons.push("SIGNER_MISMATCH");
    }
    if (
      body.policyVersion !== policyVersion ||
      body.onchainPolicyVersion !== policyVersion
    ) {
      reasons.push("POLICY_VERSION_MISMATCH");
    }
    if (body.registrationsPaused !== false) {
      reasons.push("REGISTRATIONS_PAUSED");
    }
    if (body.registrarControllerEnabled === false) {
      reasons.push("REGISTRAR_CONTROLLER_DISABLED");
    }

    if (reasons.length > 0) {
      const primaryCode = reasons.includes("REGISTRATIONS_PAUSED")
        ? "REGISTRATIONS_PAUSED"
        : reasons.includes("PERMIT_ISSUER_UNAVAILABLE")
        ? "PERMIT_ISSUER_UNAVAILABLE"
        : reasons.includes("CHAIN_MISMATCH")
        ? "CHAIN_MISMATCH"
        : "REGISTRATION_NOT_READY";

      return NextResponse.json(
        {
          ready: false,
          code: primaryCode,
          reasons,
          error:
            "Registration is temporarily unavailable. No wallet request or payment was made.",
          releaseId: manifest.releaseId,
          chainId: manifest.chain.id,
          controller,
          signerAddress: signer,
          registrationsPaused: body.registrationsPaused,
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }

    return NextResponse.json(
      {
        ready: true,
        releaseId: manifest.releaseId,
        chainId: manifest.chain.id,
        controller,
        signerAddress: signer,
        registrationsPaused: false,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return NextResponse.json(
      {
        ready: false,
        code: "READINESS_DEPENDENCY_UNAVAILABLE",
        reasons: ["READINESS_DEPENDENCY_UNAVAILABLE"],
        error:
          "Registration is temporarily unavailable. No wallet request or payment was made.",
        releaseId: manifest.releaseId,
        chainId: manifest.chain.id,
        controller,
        signerAddress: signer,
        registrationsPaused:
          manifest.activationEvidence.controllerPolicy.registrationsPaused,
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
