import { NextRequest, NextResponse } from "next/server";
import {
  invalidateMarketSnapshot,
  readMarketSnapshot,
} from "@/lib/protocol-read-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const fresh = request.nextUrl.searchParams.get("fresh") === "1";
    if (fresh) invalidateMarketSnapshot();
    const snapshot = await readMarketSnapshot();
    return NextResponse.json(snapshot, {
      headers: {
        "cache-control": fresh
          ? "no-store"
          : "public, max-age=5, s-maxage=15, stale-while-revalidate=45",
      },
    });
  } catch (error) {
    console.error("Arc marketplace read failed.", error);
    return NextResponse.json(
      { error: "Marketplace data is temporarily unavailable." },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "2" } },
    );
  }
}
