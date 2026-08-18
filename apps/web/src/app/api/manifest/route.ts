import { NextResponse } from "next/server";
import { getDeploymentManifest } from "@/lib/manifest";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    return NextResponse.json(getDeploymentManifest(), {
      headers: {
        "cache-control": "public, max-age=60, stale-while-revalidate=300",
        "access-control-allow-origin": "*",
      },
    });
  } catch {
    return NextResponse.json(
      { code: "RELEASE_MANIFEST_UNAVAILABLE" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
