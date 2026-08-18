import { NextResponse } from "next/server";
import { getDeploymentManifest } from "@/lib/manifest";
import { readLocalIssuerHealth } from "@/lib/permit-issuer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await readLocalIssuerHealth(getDeploymentManifest());
    return NextResponse.json(result.body, {
      status: result.status,
      headers: { "cache-control": "no-store" },
    });
  } catch {
    return NextResponse.json(
      {
        ok: false,
        signerReady: false,
        signerKind: "local-private-key",
        storage: "stateless",
        coordinationScope: "onchain-finality",
        durable: false,
        code: "ISSUER_DEPENDENCY_UNAVAILABLE",
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
