import { getAddress, isAddress, zeroAddress } from "viem";
import { NextRequest, NextResponse } from "next/server";
import {
  isPositiveUint256Decimal,
  isPositiveUint64Decimal,
  isUint256Decimal,
  readSmallJsonObject,
  RequestBodyTooLargeError,
} from "@/lib/api-validation";
import {
  PendingProtocolTransactionError,
  ProtocolVerificationBusyError,
  publicVerificationError,
  verifyAccountAction,
  type AccountAction,
} from "@/lib/protocol-transaction-verification";
import {
  invalidateAccountSnapshot,
  invalidateMarketSnapshot,
} from "@/lib/protocol-read-model";
import { getReadableReleaseManifest } from "@/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HASH = /^0x[0-9a-fA-F]{64}$/;
const ACTIONS = new Set([
  "list",
  "cancel",
  "revoke-market-approval",
  "invalidate",
  "claim-proceeds",
  "claim-referral",
]);

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await readSmallJsonObject(request);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof RequestBodyTooLargeError ? error.message : "Invalid JSON body." },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
    );
  }
  if (
    typeof body.action !== "string" ||
    !ACTIONS.has(body.action) ||
    typeof body.transactionHash !== "string" ||
    !HASH.test(body.transactionHash) ||
    typeof body.releaseId !== "string" ||
    !HASH.test(body.releaseId) ||
    typeof body.owner !== "string" ||
    !isAddress(body.owner) ||
    getAddress(body.owner) === zeroAddress
  ) {
    return NextResponse.json({ error: "Invalid account verification request." }, { status: 400 });
  }
  try {
    if (getReadableReleaseManifest(body.releaseId) === null) {
      return NextResponse.json(
        { error: "Unknown account action release." },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Release manifest is unavailable." },
      { status: 503 },
    );
  }
  const base = {
    releaseId: body.releaseId as `0x${string}`,
    action: body.action,
    transactionHash: body.transactionHash as `0x${string}`,
    owner: getAddress(body.owner),
  };
  let input: AccountAction;
  if (body.action === "list") {
    if (
      !isUint256Decimal(body.tokenId) ||
      !isPositiveUint256Decimal(body.price) ||
      !isPositiveUint64Decimal(body.validUntil)
    ) {
      return NextResponse.json({ error: "Invalid listing verification request." }, { status: 400 });
    }
    input = {
      ...base,
      action: "list",
      tokenId: BigInt(body.tokenId),
      price: BigInt(body.price),
      validUntil: BigInt(body.validUntil),
    };
  } else if (body.action === "cancel" || body.action === "revoke-market-approval") {
    if (!isUint256Decimal(body.tokenId)) {
      return NextResponse.json({ error: "Invalid token action verification request." }, { status: 400 });
    }
    input = { ...base, action: body.action, tokenId: BigInt(body.tokenId) };
  } else if (body.action === "invalidate") {
    if (
      !isUint256Decimal(body.tokenId) ||
      typeof body.formerSeller !== "string" ||
      !isAddress(body.formerSeller) ||
      getAddress(body.formerSeller) === zeroAddress
    ) {
      return NextResponse.json({ error: "Invalid cleanup verification request." }, { status: 400 });
    }
    input = {
      ...base,
      action: "invalidate",
      tokenId: BigInt(body.tokenId),
      formerSeller: getAddress(body.formerSeller),
    };
  } else {
    input = { ...base, action: body.action } as AccountAction;
  }
  try {
    const result = await verifyAccountAction(input);
    invalidateAccountSnapshot(input.owner);
    invalidateMarketSnapshot();
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof ProtocolVerificationBusyError) {
      return NextResponse.json(
        { verified: false, error: error.message },
        { status: 429, headers: { "cache-control": "no-store", "retry-after": "2" } },
      );
    }
    if (error instanceof PendingProtocolTransactionError) {
      return NextResponse.json(
        { verified: false, pending: true, error: error.message },
        { status: 202, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.json(
      { verified: false, error: publicVerificationError(error, "Account verification failed.") },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
}
