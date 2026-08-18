import { getAddress, isAddress } from "viem";
import { NextRequest, NextResponse } from "next/server";
import {
  invalidateAccountSnapshot,
  readAccountSnapshot,
} from "@/lib/protocol-read-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const owner = request.nextUrl.searchParams.get("owner");
  if (!owner || !isAddress(owner)) {
    return NextResponse.json(
      { error: "A valid owner address is required." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    const address = getAddress(owner);
    const fresh = request.nextUrl.searchParams.get("fresh") === "1";
    if (fresh) invalidateAccountSnapshot(address);
    const snapshot = await readAccountSnapshot(address);
    return NextResponse.json(snapshot, {
      headers: {
        "cache-control": fresh
          ? "no-store"
          : "public, max-age=5, s-maxage=15, stale-while-revalidate=45",
      },
    });
  } catch {
    return NextResponse.json(
      { error: "Account data is temporarily unavailable." },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "2" } },
    );
  }
}
