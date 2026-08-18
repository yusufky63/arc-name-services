import { getAddress, isAddress, zeroAddress } from "viem";
import { NextRequest, NextResponse } from "next/server";
import {
  isPositiveUint256Decimal,
  isUint256Decimal,
  readSmallJsonObject,
  RequestBodyTooLargeError,
} from "@/lib/api-validation";
import {
  PendingProtocolTransactionError,
  ProtocolVerificationBusyError,
  publicVerificationError,
  verifyMarketPurchase,
} from "@/lib/protocol-transaction-verification";
import {
  invalidateAccountSnapshot,
  invalidateMarketSnapshot,
} from "@/lib/protocol-read-model";
import { getReadableReleaseManifest } from "@/lib/manifest";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HASH = /^0x[0-9a-fA-F]{64}$/;
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
    typeof body.transactionHash !== "string" ||
    !HASH.test(body.transactionHash) ||
    typeof body.releaseId !== "string" ||
    !HASH.test(body.releaseId) ||
    typeof body.buyer !== "string" ||
    !isAddress(body.buyer) ||
    getAddress(body.buyer) === zeroAddress ||
    typeof body.seller !== "string" ||
    !isAddress(body.seller) ||
    getAddress(body.seller) === zeroAddress ||
    !isUint256Decimal(body.tokenId) ||
    !isPositiveUint256Decimal(body.expectedPrice) ||
    typeof body.expectedFeeBps !== "number" ||
    !Number.isInteger(body.expectedFeeBps) ||
    body.expectedFeeBps < 0 ||
    body.expectedFeeBps > 1_000
  ) {
    return NextResponse.json({ error: "Invalid purchase verification request." }, { status: 400 });
  }
  try {
    if (getReadableReleaseManifest(body.releaseId) === null) {
      return NextResponse.json(
        { error: "Unknown purchase release." },
        { status: 400 },
      );
    }
  } catch {
    return NextResponse.json(
      { error: "Release manifest is unavailable." },
      { status: 503 },
    );
  }
  try {
    const buyer = getAddress(body.buyer);
    const seller = getAddress(body.seller);
    const result = await verifyMarketPurchase({
      releaseId: body.releaseId as `0x${string}`,
      transactionHash: body.transactionHash as `0x${string}`,
      buyer,
      seller,
      tokenId: BigInt(body.tokenId),
      expectedPrice: BigInt(body.expectedPrice),
      expectedFeeBps: body.expectedFeeBps,
    });
    invalidateMarketSnapshot();
    invalidateAccountSnapshot(buyer);
    invalidateAccountSnapshot(seller);
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
      { verified: false, error: publicVerificationError(error, "Purchase verification failed.") },
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
}
