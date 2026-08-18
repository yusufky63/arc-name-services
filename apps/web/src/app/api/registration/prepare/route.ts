import { NextRequest, NextResponse } from "next/server";
import {
  createPublicClient,
  getAddress,
  isAddress,
  verifyTypedData,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { requireActivatedContract } from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";
import {
  assertPermitWindow,
  controllerAbi,
  prepareRegistrationPlan,
  registrationPermitDomain,
  registrationPermitTypes,
  resolverDataHash,
} from "@contour/sdk";
import { PRODUCT_DEFAULTS } from "@/lib/brand";
import { readSmallJsonObject, RequestBodyTooLargeError } from "@/lib/api-validation";
import { getDeploymentManifest, protocolCapabilities } from "@/lib/manifest";
import {
  issueDirectRegistrationPermit,
  LocalIssuerRequestError,
  registrationChallengeOrigin,
} from "@/lib/permit-issuer";
import { ApiAdmissionError, withApiAdmission } from "@/lib/api-admission";
import { rateLimitedArcHttp } from "@/lib/arc-rpc";
import { arcTestnet } from "@/lib/network";
import {
  buildPaymentRequirements,
  isX402Enabled,
  verifyPaymentAuthorization,
} from "@/lib/x402";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type PrepareBody = {
  rawLabel?: unknown;
  normalizationAccepted?: unknown;
  durationYears?: unknown;
  account?: unknown;
  requester?: unknown;
  payer?: unknown;
  recipient?: unknown;
  requestId?: unknown;
  paymentMethod?: unknown;
  paymentSignature?: unknown;
};

function sameAddress(left: Address, right: unknown) {
  return typeof right === "string" && isAddress(right) && getAddress(right) === getAddress(left);
}

function wirePermit(value: unknown) {
  return JSON.parse(
    JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)),
  ) as unknown;
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

  let body: PrepareBody;
  try {
    body = (await readSmallJsonObject(request, 16_384)) as PrepareBody;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return NextResponse.json({ error: "Request body is too large." }, { status: 413 });
    }
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  const durationYears = body.durationYears;
  const requesterCandidate = body.requester ?? body.account;
  const payerCandidate = body.payer ?? body.account;
  const recipientCandidate = body.recipient ?? body.account;
  const addresses = [requesterCandidate, payerCandidate, recipientCandidate];
  if (
    typeof body.rawLabel !== "string" ||
    body.rawLabel.length === 0 ||
    body.rawLabel.length > 256 ||
    typeof body.normalizationAccepted !== "boolean" ||
    typeof durationYears !== "number" ||
    !Number.isInteger(durationYears) ||
    durationYears < PRODUCT_DEFAULTS.minRegistrationYears ||
    durationYears > PRODUCT_DEFAULTS.maxRegistrationYears ||
    addresses.some((value) => typeof value !== "string" || !isAddress(value)) ||
    typeof body.requestId !== "string" ||
    body.requestId.length < 8 ||
    body.requestId.length > 128
  ) {
    return NextResponse.json({ error: "Invalid registration request." }, { status: 400 });
  }
  if (addresses.some((value) => getAddress(value as string) === zeroAddress)) {
    return NextResponse.json(
      { error: "Registration parties cannot use the zero address." },
      { status: 400 },
    );
  }

  const deployment = getDeploymentManifest();
  const suffix = deployment.namespace.suffix;
  if (!suffix) {
    return NextResponse.json({ error: "The namespace is not active." }, { status: 503 });
  }
  let identity: ReturnType<typeof deriveNameIdentity>;
  try {
    identity = deriveNameIdentity(body.rawLabel, suffix);
    if (identity.changed && !body.normalizationAccepted) {
      return NextResponse.json(
        { error: `The label normalizes to ${identity.normalized}. Explicit acceptance is required.` },
        { status: 409 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "The label is not valid under ENSIP-15." },
      { status: 400 },
    );
  }

  const requester = getAddress(requesterCandidate as string);
  const payer = getAddress(payerCandidate as string);
  const recipient = getAddress(recipientCandidate as string);
  if (requester !== payer || requester !== recipient) {
    return NextResponse.json(
      { error: "Wallet-bound registration requires requester, recipient, and payer to match." },
      { status: 400 },
    );
  }

  const paymentSignatureHeader =
    request.headers.get("PAYMENT-SIGNATURE") ??
    request.headers.get("payment-signature");
  const rawPaymentSignature =
    paymentSignatureHeader ?? body.paymentSignature;
  const isX402Requested =
    body.paymentMethod === "x402" ||
    request.headers.get("x-payment-method") === "x402" ||
    Boolean(rawPaymentSignature);

  let verifiedPaymentIdentifier: Hex | null = null;
  if (isX402Requested) {
    if (!isX402Enabled()) {
      return NextResponse.json(
        {
          error: "Circle x402 nanopayments are not currently active on this deployment.",
          code: "X402_NOT_CONFIGURED",
        },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }

    const controllerAddress = requireActivatedContract(deployment, "controller");
    const client = createPublicClient({
      batch: { multicall: { wait: 25 } },
      chain: arcTestnet,
      transport: rateLimitedArcHttp(deployment.chain.rpcUrl),
    });

    const expectedAmount = await client.readContract({
      address: controllerAddress,
      abi: controllerAbi,
      functionName: "quote",
      args: [identity.normalized, BigInt(durationYears)],
    });

    const fallbackTreasury = deployment.contracts.controller.address;
    if (!fallbackTreasury) {
      throw new Error("controller contract address is missing from deployment manifest");
    }
    const treasuryAddress = getAddress(
      deployment.activationEvidence.governance.account ?? fallbackTreasury,
    );

    if (!rawPaymentSignature) {
      const requirements = buildPaymentRequirements({
        amount: expectedAmount,
        payTo: treasuryAddress,
        resourcePath: "/api/registration/prepare",
      });

      return NextResponse.json(
        {
          code: "PAYMENT_REQUIRED",
          error: "Payment required for registration via Circle x402.",
          paymentRequired: requirements,
        },
        {
          status: 402,
          headers: {
            "PAYMENT-REQUIRED": JSON.stringify(requirements),
            "cache-control": "no-store",
          },
        },
      );
    }

    const verification = await verifyPaymentAuthorization({
      paymentSignature: rawPaymentSignature,
      expectedAmount,
      expectedPayTo: treasuryAddress,
    });

    if (!verification.valid) {
      const statusCode =
        verification.code === "PAYMENT_REPLAYED" || verification.code === "PAYMENT_EXPIRED"
          ? 409
          : verification.code === "PAYMENT_INSUFFICIENT"
          ? 402
          : 400;

      return NextResponse.json(
        {
          error: verification.error ?? "Invalid payment authorization.",
          code: verification.code ?? "PAYMENT_INVALID",
        },
        { status: statusCode, headers: { "cache-control": "no-store" } },
      );
    }
    verifiedPaymentIdentifier = verification.paymentIdentifier ?? null;
  }

  try {
    return await withApiAdmission("registration:prepare", 4, async () => {
      const issued = await issueDirectRegistrationPermit({
        manifest: deployment,
        origin: registrationChallengeOrigin(request.nextUrl.origin, deployment),
        intent: {
          requestId: body.requestId as string,
          rawLabel: body.rawLabel as string,
          normalizationAccepted: body.normalizationAccepted as boolean,
          requester,
          recipient,
          payer,
          authorizedExecutor: requester,
          durationYears,
          resolverDataHash: resolverDataHash([]),
          referrer: zeroAddress,
        },
      });
      if (issued.normalizedLabel !== identity.normalized) {
        throw new Error("issuer normalization mismatch");
      }

      const permit = issued.permit;
      const manifestSigner = deployment.permitIssuer.signerAddress;
      const controller = requireActivatedContract(deployment, "controller");
      if (!manifestSigner || !isAddress(manifestSigner) || !deployment.releaseId) {
        throw new Error("manifest signer metadata is incomplete");
      }
      if (
        !sameAddress(requester, permit.requester) ||
        !sameAddress(payer, permit.payer) ||
        !sameAddress(requester, permit.authorizedExecutor) ||
        !sameAddress(recipient, permit.recipient) ||
        !sameAddress(controller, permit.controller) ||
        !sameAddress(deployment.settlement.erc20Address, permit.settlementAsset) ||
        permit.chainId !== BigInt(deployment.chain.id) ||
        permit.releaseId.toLowerCase() !== deployment.releaseId.toLowerCase() ||
        permit.normalizationProfileHash.toLowerCase() !==
          deployment.normalization.profileHash.toLowerCase() ||
        permit.normalizedLabelHash.toLowerCase() !== identity.labelhash.toLowerCase() ||
        permit.namehash.toLowerCase() !== identity.namehash.toLowerCase() ||
        permit.resolverDataHash.toLowerCase() !== resolverDataHash([]).toLowerCase() ||
        permit.durationYears !== BigInt(durationYears) ||
        permit.referrer !== zeroAddress ||
        permit.expectedReferralBps !== 0n
      ) {
        throw new Error("permit does not match the requested release intent");
      }

      const now = BigInt(Math.floor(Date.now() / 1_000));
      if (now > permit.validUntil || permit.validUntil - now < 30n) {
        return NextResponse.json(
          {
            error: "The permit window is too close to expiry. Start a fresh registration request.",
            code: "CHALLENGE_EXPIRED",
          },
          { status: 409 },
        );
      }
      assertPermitWindow(permit, now);
      if (
        permit.validUntil - permit.validAfter > 300n ||
        !/^0x[0-9a-fA-F]{64}$/.test(permit.permitId) ||
        permit.permitId === `0x${"0".repeat(64)}`
      ) {
        throw new Error("permit policy mismatch");
      }

      const client = createPublicClient({
        batch: { multicall: { wait: 25 } },
        chain: arcTestnet,
        transport: rateLimitedArcHttp(deployment.chain.rpcUrl),
      });
      const signatureValid = await verifyTypedData({
        address: getAddress(manifestSigner),
        domain: registrationPermitDomain(controller),
        types: registrationPermitTypes,
        primaryType: "RegistrationPermit",
        message: permit,
        signature: issued.signature,
      });
      if (!signatureValid) throw new Error("permit signature is invalid");

      const registration = prepareRegistrationPlan({
        manifest: deployment,
        rawLabel: body.rawLabel as string,
        normalizationAccepted: body.normalizationAccepted as boolean,
        permit,
        signature: issued.signature,
        resolverData: [],
      });
      if (getAddress(registration.to) !== getAddress(controller) || registration.value !== 0n) {
        throw new Error("unsafe registration transaction");
      }
      await client.call({
        account: requester,
        to: registration.to,
        data: registration.data,
        value: 0n,
      });
      return NextResponse.json(
        {
          registrationTransaction: {
            to: registration.to,
            data: registration.data,
            value: "0x0",
          },
          permitId: permit.permitId,
          validUntil: permit.validUntil.toString(),
          permit: wirePermit(permit),
          signature: issued.signature,
          ...(verifiedPaymentIdentifier
            ? { paymentVerified: true, paymentIdentifier: verifiedPaymentIdentifier }
            : {}),
        },
        { headers: { "cache-control": "no-store" } },
      );
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
    const details = error instanceof Error ? error.message : "Internal transaction preparation failed.";
    return NextResponse.json(
      {
        error: details,
        code: "PERMIT_PREPARATION_FAILED",
      },
      { status: 503 },
    );
  }
}
