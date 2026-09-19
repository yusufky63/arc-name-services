import { NextRequest, NextResponse } from "next/server";
import {
  invalidateMarketSnapshot,
  readProtocolStats,
} from "@/lib/protocol-read-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request: NextRequest) {
  try {
    const fresh = request.nextUrl.searchParams.get("fresh") === "1";
    if (fresh) invalidateMarketSnapshot();
    const stats = await readProtocolStats();
    return NextResponse.json(stats, {
      headers: {
        "cache-control": fresh
          ? "no-store"
          : "public, max-age=10, s-maxage=30, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    console.error("Arc protocol stats read failed.", error);
    return NextResponse.json(
      { error: "Protocol statistics are temporarily unavailable." },
      { status: 503, headers: { "cache-control": "no-store", "retry-after": "5" } },
    );
  }
}
