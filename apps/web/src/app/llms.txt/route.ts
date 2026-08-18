import {
  CONTRACT_KEYS,
  deploymentManifestDigest,
  registrarVersionOf,
} from "@contour/config";
import { getDeploymentManifest } from "../../lib/manifest";
import { BRAND } from "../../lib/brand";
import { apiError, OPTIONS, textResponse } from "../api/_shared/http";

export { OPTIONS };
export const dynamic = "force-dynamic";

export function GET() {
  try {
    const manifest = getDeploymentManifest();
    const suffix = manifest.namespace.suffix ?? "contour";
    const registrarVersion = registrarVersionOf(manifest);
    const canonicalSupportsMetadata =
      registrarVersion === "v2" && manifest.nftMetadata !== null &&
      manifest.nftMetadata !== undefined;
    const retainedMetadataStatement = manifest.legacyReleases?.length === 1
      ? " The retained V1 registrar does not implement ERC-721 Metadata or tokenURI; its existing names use these routes as release-bound companion metadata."
      : "";
    const metadataStatement = canonicalSupportsMetadata
      ? "NFT metadata compatibility: the canonical V2 registrar implements ERC-721 Metadata and tokenURI resolves to the production /api/metadata/{tokenId} route."
      : "NFT metadata compatibility: the canonical V1 registrar does not implement ERC-721 Metadata or tokenURI. /api/metadata/{tokenId} and /api/image/{tokenId} are application companion endpoints for Contour display and sharing.";
    const contracts = CONTRACT_KEYS.map(
      (key) => `- ${key}: ${manifest.contracts[key].address} (ABI: /abi/${key}.json)`,
    ).join("\n");
    const text = `# ${BRAND.protocolName}

> Independent name infrastructure built for Arc Testnet. Read configuration from the manifest before making RPC calls.

## Machine-readable integration

- [Deployment manifest](/deployment-manifest.json): canonical chain, settlement, normalization, release, and contract metadata.
- [Well-known manifest](/.well-known/chain-name-service.json): stable manifest discovery alias.
- [Runtime discovery](/runtime-manifest.json): WSS-free HTTPS endpoints, manifest-declared capabilities, release evidence status, and live readiness URLs. Require readiness before execution.
- [OpenAPI](/api/openapi.json): recommended public HTTP routes and schemas.
- [Service status](/status): live registration, marketplace, permit issuer, and hosted MCP readiness checks.
- [Contour MCP](/api/mcp): hosted Streamable HTTP MCP endpoint.
- [ABI index](/abi): curated SDK ABI surfaces for supported protocol and settlement workflows.
- [Developer documentation](/developers): public SDK, workspace React, MCP, API, App Kit, and x402 integration.

## Read API

- GET /api/name/{label}: direct Arc registry, registrar, and resolver read.
- GET /api/reverse/{address}: forward-confirmed reverse read.
- GET /api/metadata/{tokenId}: application companion metadata for a registered name NFT.
- GET /api/image/{tokenId}: deterministic 1200x630 SVG for the same verified name snapshot.
- GET /api/account?owner={address}: owned names, credits, proceeds, and listings.
- GET /api/market: live fixed-price listings.
- GET /api/registration/readiness: registration contract, signer, controller, and pause readiness.
- GET /api/marketplace/readiness: marketplace contract, settlement, fee, and pause readiness.
- POST /api/registration/preflight: approval and wallet transaction plan.
- POST /api/registration/prepare: wallet-bound permit and registration calldata.

OpenAPI intentionally excludes internal verification, issuer-v1, compatibility, manifest, and MCP transport routes. Public response envelopes are route-specific: successful read routes generally include deployment context, while readiness and registration responses have their own shapes. CORS and cache headers are also route-specific. Integer token IDs and timestamps are decimal strings. Errors include an error value and may include a stable code and deployment context.

${metadataStatement}${retainedMetadataStatement}

## Current deployment

- Chain: Arc Testnet (${manifest.chain.caip2})
- Namespace: .${suffix}
- Manifest schema: ${manifest.schemaVersion}
- Manifest SHA-256: ${deploymentManifestDigest(manifest)}
- Release ID: ${manifest.releaseId}
- Deployment state: ${manifest.state}
- RPC: ${manifest.chain.rpcUrl}
- Explorer: ${manifest.chain.explorerUrl}
- Settlement: ${manifest.settlement.symbol} at ${manifest.settlement.erc20Address}

${contracts}

## Public SDK and workspace packages

- Public npm package: contour-sdk (ESM; Node.js >=20.9 <25).
- Install: npm install contour-sdk viem
- Public exports include ARC_TESTNET, ArcNameClient, and fetchDeploymentManifest.
- Repository-only workspaces: @contour/config, @contour/normalization, @contour/react, and @contour/mcp.
- @contour/react provides TanStack Query hooks; @contour/mcp is the smaller stdio MCP server. Neither is part of the public SDK package.

## Hosted Contour MCP

Endpoint: /api/mcp

Resource: contour://runtime

Tools: normalize_label, get_name, reverse_lookup, get_account_names, get_market, prepare_registration_request, prepare_permit_request, prepare_approval, prepare_renewal, prepare_market_token_approval, prepare_market_token_approval_revoke, prepare_market_usdc_approval, prepare_market_listing, prepare_market_buy, prepare_market_cancel, prepare_claim_proceeds, prepare_claim_referral, prepare_transfer, prepare_market_invalidate.

prepare_registration_request and prepare_permit_request have identical schemas. They accept rawLabel, normalizationAccepted, account, durationYears, and an optional requestId, then return an unexecuted POST template for /api/registration/prepare. The permit-named tool is only a hosted compatibility alias. prepare_approval remains the backwards-compatible registration-controller allowance; use prepare_market_usdc_approval for purchases and prepare_market_token_approval for listing authorization. Cancel, approval revoke, liability claims, and stale-listing invalidation remain plannable while the marketplace is paused. get_account_names and get_market return structured snapshots without a formal outputSchema; the other seventeen hosted tools advertise output schemas.

The MCP has no private-key, signing, or broadcast tool. Reads and unsigned plans use the canonical Arc HTTPS RPC.

## Repository stdio MCP

Resource: contour://manifest

Tools: normalize_label, get_name, reverse_lookup, prepare_issuer_request, prepare_approval, prepare_renewal, prepare_market_token_approval, prepare_market_token_approval_revoke, prepare_market_usdc_approval, prepare_market_listing, prepare_market_buy, prepare_market_cancel, prepare_claim_proceeds, prepare_claim_referral, prepare_transfer, prepare_market_invalidate.

The stdio-only prepare_issuer_request accepts the complete issuer intent and returns separate issuer-v1 challenge and permit POST templates. It does not make either request or sign the wallet challenge. The hosted and stdio registration-helper schemas are intentionally different.

## Upstream Arc and Circle tooling

- Arc Docs MCP: https://docs.arc.io/mcp
- Arc Docs MCP setup: https://docs.arc.io/ai/mcp
- Circle App Kit: https://docs.arc.io/app-kit
- Circle App Kit installation: https://docs.arc.io/app-kit/tutorials/installation
- Circle x402 SDK reference: https://developers.circle.com/gateway/nanopayments/references/sdk
- Circle x402 concept: https://developers.circle.com/gateway/nanopayments/concepts/x402

## Attribution

${BRAND.disclaimer}
`;
    return textResponse(text, "text/plain; charset=utf-8");
  } catch {
    return apiError(
      503,
      "LLMS_DOCUMENT_UNAVAILABLE",
      "The llms.txt document could not be generated from the deployment manifest.",
    );
  }
}
