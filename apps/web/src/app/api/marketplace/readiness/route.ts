import { NextResponse } from "next/server";
import { getDeploymentManifest, protocolCapabilities } from "@/lib/manifest";
import {
  readMarketplaceReadiness,
  unavailableMarketplaceReadiness,
  type MarketplaceReadiness,
} from "@/lib/marketplace-readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const responseHeaders = {
  "cache-control": "no-store",
  "retry-after": "2",
};

function response(readiness: MarketplaceReadiness) {
  return NextResponse.json(readiness, {
    status: readiness.ready ? 200 : 503,
    headers: readiness.ready
      ? { "cache-control": responseHeaders["cache-control"] }
      : responseHeaders,
  });
}

export async function GET() {
  try {
    const manifest = getDeploymentManifest();
    if (!protocolCapabilities.marketplace) {
      return response(
        unavailableMarketplaceReadiness(manifest, "EXECUTION_SURFACE_DISABLED"),
      );
    }
    return response(await readMarketplaceReadiness(manifest));
  } catch {
    return response(
      unavailableMarketplaceReadiness(null, "READINESS_DEPENDENCY_UNAVAILABLE"),
    );
  }
}
