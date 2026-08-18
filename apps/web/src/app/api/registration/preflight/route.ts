import { NextRequest, NextResponse } from "next/server";
import { createPublicClient, getAddress, isAddress, zeroAddress } from "viem";
import {
  controllerAbi,
  erc20Abi,
  prepareApprovalPlan,
} from "@contour/sdk";
import { requireActivatedContract } from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";
import { PRODUCT_DEFAULTS } from "@/lib/brand";
import { readSmallJsonObject, RequestBodyTooLargeError } from "@/lib/api-validation";
import { getDeploymentManifest, protocolCapabilities } from "@/lib/manifest";
import { ApiAdmissionError, withApiAdmission } from "@/lib/api-admission";
import { rateLimitedArcHttp } from "@/lib/arc-rpc";
import { arcTestnet } from "@/lib/network";
import { readRegistrationReleaseGate } from "@/lib/registration-release-gate";

type PreflightBody = {
  rawLabel?: unknown;
  normalizationAccepted?: unknown;
  durationYears?: unknown;
  payer?: unknown;
};

function transaction(plan: { to: `0x${string}`; data: `0x${string}` }) {
  return { to: plan.to, data: plan.data, value: "0x0" as const };
}

export async function POST(request: NextRequest) {
  if (!protocolCapabilities.registration) {
    return NextResponse.json(
      {
        error:
          "Registration is temporarily unavailable. No wallet request or payment was made.",
        code: "REGISTRATION_UNAVAILABLE",
      },
      { status: 503 },
    );
  }

  let body: PreflightBody;
  try {
    body = (await readSmallJsonObject(request, 16_384)) as PreflightBody;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  const durationYears = body.durationYears;
  if (
    typeof body.rawLabel !== "string" ||
    body.rawLabel.length === 0 ||
    body.rawLabel.length > 256 ||
    typeof body.normalizationAccepted !== "boolean" ||
    typeof durationYears !== "number" ||
    !Number.isInteger(durationYears) ||
    durationYears < PRODUCT_DEFAULTS.minRegistrationYears ||
    durationYears > PRODUCT_DEFAULTS.maxRegistrationYears ||
    typeof body.payer !== "string" ||
    !isAddress(body.payer)
  ) {
    return NextResponse.json({ error: "Invalid registration preflight." }, { status: 400 });
  }
  if (getAddress(body.payer) === zeroAddress) {
    return NextResponse.json({ error: "Payer cannot be the zero address." }, { status: 400 });
  }

  let identity: ReturnType<typeof deriveNameIdentity>;
  try {
    const suffix = getDeploymentManifest().namespace.suffix;
    if (!suffix) throw new Error("suffix missing");
    identity = deriveNameIdentity(body.rawLabel, suffix);
    if (identity.changed && !body.normalizationAccepted) {
      return NextResponse.json(
        {
          error: `The label normalizes to ${identity.normalized}. Explicit acceptance is required.`,
          code: "NORMALIZATION_ACCEPTANCE_REQUIRED",
          normalizedLabel: identity.normalized,
        },
        { status: 409 },
      );
    }
  } catch {
    return NextResponse.json({ error: "The label is not valid under ENSIP-15." }, { status: 400 });
  }

  try {
    return await withApiAdmission("registration:preflight", 8, async () => {
      const deployment = getDeploymentManifest();
      const controller = requireActivatedContract(deployment, "controller");
      const client = createPublicClient({
        batch: { multicall: { wait: 25 } },
        chain: arcTestnet,
        transport: rateLimitedArcHttp(deployment.chain.rpcUrl),
      });
      const payer = getAddress(body.payer as string);
      const gate = await readRegistrationReleaseGate({
        client,
        canonical: deployment,
        tokenId: identity.tokenId,
      });
      if (gate.releases[0]?.registrationsPaused) {
        return NextResponse.json(
          { error: "New registrations are paused. No approval was prepared.", code: "REGISTRATIONS_PAUSED" },
          { status: 503 },
        );
      }
      if (!gate.retainedReleasesClosed) {
        return NextResponse.json(
          {
            error: "Registration is unavailable until retained releases are closed.",
            code: "REGISTRATION_UNAVAILABLE",
          },
          { status: 503 },
        );
      }
      if (gate.availableEverywhere === false) {
        return NextResponse.json(
          { error: `${identity.name} is not available. No approval was prepared.`, code: "NAME_UNAVAILABLE" },
          { status: 409 },
        );
      }
      const [expectedAmount, allowance] = await Promise.all([
        client.readContract({
          address: controller,
          abi: controllerAbi,
          functionName: "quote",
          args: [identity.normalized, BigInt(durationYears)],
          blockNumber: gate.blockNumber,
        }),
        client.readContract({
          address: deployment.settlement.erc20Address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [payer, controller],
          blockNumber: gate.blockNumber,
        }),
      ]);
      const approval = allowance < expectedAmount
        ? prepareApprovalPlan(deployment, expectedAmount)
        : null;
      return NextResponse.json({
        normalizedLabel: identity.normalized,
        expectedAmount: expectedAmount.toString(),
        approvalTransaction: approval ? transaction(approval) : null,
      });
    });
  } catch (error) {
    if (error instanceof ApiAdmissionError) {
      return NextResponse.json(
        { error: "The registration service is busy. Retry shortly.", code: "SERVICE_BUSY" },
        { status: 503, headers: { "retry-after": "2" } },
      );
    }
    return NextResponse.json(
      { error: "Registration could not be prepared.", code: "PREFLIGHT_FAILED" },
      { status: 503 },
    );
  }
}
