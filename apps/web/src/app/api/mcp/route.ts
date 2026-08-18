import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { ARC_TESTNET_CHAIN_ID, registrarVersionOf } from "@contour/config";
import { normalizeLabel } from "@contour/normalization";
import {
  prepareApprovalPlan,
  prepareBuyPlan,
  prepareCancelListingPlan,
  prepareClaimProceedsPlan,
  prepareClaimReferralPlan,
  prepareInvalidateListingPlan,
  prepareListingPlan,
  prepareMarketplaceApprovalPlan,
  prepareMarketplaceTokenApprovalPlan,
  prepareMarketplaceTokenApprovalRevokePlan,
  prepareRenewalPlan,
  prepareTransferPlan,
} from "@contour/sdk";
import {
  getDeploymentManifest,
  getReadableReleaseManifests,
  getRuntimeDiscoveryDocument,
  requireReadableReleaseManifest,
} from "../../../lib/manifest";
import {
  readAccountSnapshot,
  readMarketSnapshot,
  readNameAcrossReleases,
  readReverseAcrossReleases,
} from "../../../lib/protocol-read-model";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id",
  "access-control-expose-headers": "mcp-session-id",
  "cache-control": "no-store",
};

const toolNames = [
  "normalize_label",
  "get_name",
  "reverse_lookup",
  "get_account_names",
  "get_market",
  "prepare_registration_request",
  "prepare_permit_request",
  "prepare_approval",
  "prepare_renewal",
  "prepare_market_token_approval",
  "prepare_market_token_approval_revoke",
  "prepare_market_usdc_approval",
  "prepare_market_listing",
  "prepare_market_buy",
  "prepare_market_cancel",
  "prepare_claim_proceeds",
  "prepare_claim_referral",
  "prepare_transfer",
  "prepare_market_invalidate",
] as const;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const HEX_PATTERN = /^0x[0-9a-fA-F]*$/;
const UINT_PATTERN = /^(0|[1-9][0-9]*)$/;
const POSITIVE_UINT_PATTERN = /^[1-9][0-9]*$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_MCP_BODY_BYTES = 256 * 1024;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

class McpBodyTooLargeError extends Error {}

async function boundedMcpRequest(request: Request): Promise<Request> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (
      !Number.isSafeInteger(parsedLength) ||
      parsedLength < 0 ||
      parsedLength > MAX_MCP_BODY_BYTES
    ) {
      throw new McpBodyTooLargeError();
    }
  }

  if (!request.body) return request;

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalLength += value.byteLength;
    if (totalLength > MAX_MCP_BODY_BYTES) {
      await reader.cancel();
      throw new McpBodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: body.buffer,
  });
}

const addressInputSchema = z.string()
  .regex(ADDRESS_PATTERN, "Invalid EVM address")
  .refine(isAddress, "Invalid EVM address");
const addressOutputSchema = z.string().regex(ADDRESS_PATTERN);
const bytes32OutputSchema = z.string().regex(BYTES32_PATTERN);

function decimalAtMost(value: string, maximum: bigint): boolean {
  try {
    return BigInt(value) <= maximum;
  } catch {
    return false;
  }
}

const uint256InputSchema = z.string()
  .regex(UINT_PATTERN, "Invalid uint256 decimal")
  .refine((value) => decimalAtMost(value, UINT256_MAX), "Value exceeds uint256");
const positiveUint256InputSchema = z.string()
  .regex(POSITIVE_UINT_PATTERN, "Expected a positive uint256 decimal")
  .refine((value) => decimalAtMost(value, UINT256_MAX), "Value exceeds uint256");
const positiveUint64InputSchema = z.string()
  .regex(POSITIVE_UINT_PATTERN, "Expected a positive uint64 decimal")
  .refine((value) => decimalAtMost(value, UINT64_MAX), "Value exceeds uint64");

const normalizeLabelOutputSchema = {
  normalized: z.string(),
  changed: z.boolean(),
  labelhash: bytes32OutputSchema,
  profileId: z.string(),
  profileHash: bytes32OutputSchema,
  corpusHash: bytes32OutputSchema,
};

const nameOutputSchema = {
  releaseId: bytes32OutputSchema,
  releaseKey: z.enum(["canonical", "legacy"]),
  name: z.string(),
  node: bytes32OutputSchema,
  tokenId: z.string().regex(UINT_PATTERN),
  registryOwner: addressOutputSchema,
  registrant: addressOutputSchema.nullable(),
  resolver: addressOutputSchema.nullable(),
  resolvedAddress: addressOutputSchema.nullable(),
  contentHash: z.string().regex(HEX_PATTERN).nullable(),
  expiry: z.string().regex(UINT_PATTERN).nullable(),
  available: z.boolean(),
};

const reverseLookupOutputSchema = {
  releaseId: bytes32OutputSchema,
  releaseKey: z.enum(["canonical", "legacy"]),
  name: z.string().nullable(),
  forwardConfirmed: z.boolean(),
};

const registrationRequestBodyOutputSchema = {
  rawLabel: z.string(),
  normalizationAccepted: z.boolean(),
  durationYears: z.number().int().min(1).max(10),
  requester: addressOutputSchema,
  payer: addressOutputSchema,
  recipient: addressOutputSchema,
  requestId: z.string().regex(REQUEST_ID_PATTERN),
};

const registrationRequestOutputSchema = {
  method: z.literal("POST"),
  url: z.string().url(),
  headers: z.object({ "content-type": z.literal("application/json") }),
  body: z.object(registrationRequestBodyOutputSchema),
  normalizedLabel: z.string(),
  next: z.string(),
};

function transactionPlanOutputSchema(kind: "approval" | "renew" | "market" | "transfer") {
  return {
    kind: z.literal(kind),
    chainId: z.literal(ARC_TESTNET_CHAIN_ID),
    releaseId: bytes32OutputSchema,
    registrarVersion: z.enum(["v1", "v2"]),
    to: addressOutputSchema,
    data: z.string().regex(HEX_PATTERN),
    value: z.literal("0"),
    description: z.string(),
  };
}

function json(value: unknown): string {
  return JSON.stringify(
    value,
    (_, item) => typeof item === "bigint" ? item.toString() : item,
    2,
  );
}

function output(value: unknown) {
  const serialized = json(value);
  return {
    content: [{ type: "text" as const, text: serialized }],
    structuredContent: JSON.parse(serialized) as Record<string, unknown>,
  };
}

function executionError(error: unknown) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: error instanceof Error ? error.message : "Request failed.",
    }],
  };
}

function createContourMcpServer() {
  const manifest = getDeploymentManifest();
  const releaseInputSchema = bytes32OutputSchema.optional();
  const planManifest = (releaseId?: string) => {
    if (releaseId !== undefined) {
      return requireReadableReleaseManifest(releaseId);
    }
    if (getReadableReleaseManifests().length > 1) {
      throw new Error(
        "releaseId is required when more than one Contour release is readable.",
      );
    }
    return manifest;
  };
  const releasePlan = <T extends object>(
    release: typeof manifest,
    plan: T,
  ) => ({
    ...plan,
    releaseId: release.releaseId,
    registrarVersion: registrarVersionOf(release),
  });
  const server = new McpServer({
    name: "contour-name-protocol",
    version: "1.0.0",
  });

  server.registerResource(
    "runtime-discovery",
    "contour://runtime",
    {
      title: "Contour Arc Testnet runtime discovery",
      mimeType: "application/json",
    },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: json(getRuntimeDiscoveryDocument()),
      }],
    }),
  );

  server.registerTool(
    "normalize_label",
    {
      title: "Normalize a Contour label",
      description: "Runs the pinned ENSIP-15 single-label profile without signing or reserving a name.",
      inputSchema: { rawLabel: z.string().min(1).max(256) },
      outputSchema: normalizeLabelOutputSchema,
    },
    async ({ rawLabel }) => {
      try {
        const label = normalizeLabel(rawLabel);
        return output({
          normalized: label.normalized,
          changed: label.changed,
          labelhash: label.labelhash,
          profileId: label.profileId,
          profileHash: label.profileHash,
          corpusHash: label.corpusHash,
        });
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "get_name",
    {
      title: "Read a Contour name",
      description: "Reads ownership, resolution and lifecycle from the deployed Arc contracts.",
      inputSchema: { label: z.string().min(1).max(256) },
      outputSchema: nameOutputSchema,
    },
    async ({ label }) => {
      try {
        return output(await readNameAcrossReleases(label));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "reverse_lookup",
    {
      title: "Resolve an Arc account",
      description: "Returns the primary Contour name and its forward-confirmation state.",
      inputSchema: { account: addressInputSchema },
      outputSchema: reverseLookupOutputSchema,
    },
    async ({ account }) => {
      try {
        return output(await readReverseAcrossReleases(getAddress(account)));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "get_account_names",
    {
      title: "List names owned by an account",
      description: "Returns the same verified snapshot used by the live My Names page.",
      inputSchema: { account: addressInputSchema },
    },
    async ({ account }) => {
      try {
        return output(await readAccountSnapshot(getAddress(account)));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "get_market",
    {
      title: "Read the Contour marketplace",
      description: "Returns verified live listings and marketplace policy from Arc.",
      inputSchema: {},
    },
    async () => {
      try {
        return output(await readMarketSnapshot());
      } catch (error) {
        return executionError(error);
      }
    },
  );

  const registrationRequestSchema = {
    rawLabel: z.string().min(1).max(256),
    normalizationAccepted: z.boolean().default(false),
    account: addressInputSchema,
    durationYears: z.number().int().min(1).max(10),
    requestId: z.string().regex(REQUEST_ID_PATTERN).optional(),
  };
  const prepareRegistrationRequest = ({
    rawLabel,
    normalizationAccepted,
    account,
    durationYears,
    requestId,
  }: {
    rawLabel: string;
    normalizationAccepted: boolean;
    account: string;
    durationYears: number;
    requestId?: string | undefined;
  }) => {
    const normalized = normalizeLabel(rawLabel);
    if (normalized.changed && !normalizationAccepted) {
      throw new Error(
        `Normalization changed the label to ${normalized.normalized}; explicit acceptance is required.`,
      );
    }
    const wallet = getAddress(account);
    const discovery = getRuntimeDiscoveryDocument();
    const origin = new URL(discovery.endpoints.runtimeDiscovery).origin;
    return {
      method: "POST",
      url: `${origin}/api/registration/prepare`,
      headers: { "content-type": "application/json" },
      body: {
        rawLabel,
        normalizationAccepted,
        durationYears,
        requester: wallet,
        payer: wallet,
        recipient: wallet,
        requestId: requestId ?? `mcp-${crypto.randomUUID()}`,
      },
      normalizedLabel: normalized.normalized,
      next: "Submit the returned registrationTransaction with this same wallet.",
    };
  };

  server.registerTool(
    "prepare_registration_request",
    {
      title: "Prepare a direct registration request",
      description:
        "Builds the hosted registration API request for one wallet. It does not sign or broadcast the wallet transaction.",
      inputSchema: registrationRequestSchema,
      outputSchema: registrationRequestOutputSchema,
    },
    async (input) => {
      try {
        return output(prepareRegistrationRequest(input));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_permit_request",
    {
      title: "Prepare a wallet-bound permit request",
      description:
        "Compatibility name for the direct hosted registration request. No private key or wallet signature enters MCP.",
      inputSchema: registrationRequestSchema,
      outputSchema: registrationRequestOutputSchema,
    },
    async (input) => {
      try {
        return output(prepareRegistrationRequest(input));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_approval",
    {
      title: "Prepare an unsigned registration-controller USDC approval",
      description:
        "Backwards-compatible registration allowance tool. Returns transaction calldata only and never broadcasts or handles a private key.",
      inputSchema: { amountBaseUnits: positiveUint256InputSchema },
      outputSchema: transactionPlanOutputSchema("approval"),
    },
    async ({ amountBaseUnits }) => {
      try {
        return output(releasePlan(
          manifest,
          prepareApprovalPlan(manifest, BigInt(amountBaseUnits)),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_renewal",
    {
      title: "Prepare an unsigned renewal",
      inputSchema: {
        normalizedLabel: z.string().min(1).max(256),
        durationYears: z.number().int().min(1).max(10),
        expectedAmountBaseUnits: positiveUint256InputSchema,
        releaseId: releaseInputSchema,
      },
      outputSchema: transactionPlanOutputSchema("renew"),
    },
    async ({ normalizedLabel, durationYears, expectedAmountBaseUnits, releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(release, prepareRenewalPlan(
          release,
          normalizedLabel,
          BigInt(durationYears),
          BigInt(expectedAmountBaseUnits),
        )));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_token_approval",
    {
      title: "Prepare an unsigned marketplace NFT approval",
      description:
        "Authorizes only the selected registrar token for the pinned marketplace. Returns calldata only and never broadcasts.",
      inputSchema: { tokenId: uint256InputSchema, releaseId: releaseInputSchema },
      outputSchema: transactionPlanOutputSchema("approval"),
    },
    async ({ tokenId, releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(
          release,
          prepareMarketplaceTokenApprovalPlan(release, BigInt(tokenId)),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_token_approval_revoke",
    {
      title: "Prepare an unsigned marketplace NFT approval revocation",
      description:
        "Clears the selected token's ERC-721 approval. This escape plan remains available while the marketplace is paused.",
      inputSchema: { tokenId: uint256InputSchema, releaseId: releaseInputSchema },
      outputSchema: transactionPlanOutputSchema("approval"),
    },
    async ({ tokenId, releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(
          release,
          prepareMarketplaceTokenApprovalRevokePlan(release, BigInt(tokenId)),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_usdc_approval",
    {
      title: "Prepare an unsigned marketplace USDC approval",
      description:
        "Authorizes the pinned marketplace for the exact positive USDC amount. Returns calldata only and never broadcasts.",
      inputSchema: {
        amountBaseUnits: positiveUint256InputSchema,
        releaseId: releaseInputSchema,
      },
      outputSchema: transactionPlanOutputSchema("approval"),
    },
    async ({ amountBaseUnits, releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(
          release,
          prepareMarketplaceApprovalPlan(release, BigInt(amountBaseUnits)),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_listing",
    {
      title: "Prepare an unsigned fixed-price listing",
      inputSchema: {
        tokenId: uint256InputSchema,
        priceBaseUnits: positiveUint256InputSchema,
        validUntil: positiveUint64InputSchema,
        releaseId: releaseInputSchema,
      },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ tokenId, priceBaseUnits, validUntil, releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(release, prepareListingPlan(
          release,
          BigInt(tokenId),
          BigInt(priceBaseUnits),
          BigInt(validUntil),
        )));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_buy",
    {
      title: "Prepare an unsigned fixed-price purchase",
      inputSchema: {
        tokenId: uint256InputSchema,
        expectedPriceBaseUnits: positiveUint256InputSchema,
        expectedFeeBps: z.number().int().min(0).max(1_000),
        releaseId: releaseInputSchema,
      },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ tokenId, expectedPriceBaseUnits, expectedFeeBps, releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(release, prepareBuyPlan(
          release,
          BigInt(tokenId),
          BigInt(expectedPriceBaseUnits),
          expectedFeeBps,
        )));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_cancel",
    {
      title: "Prepare an unsigned listing cancellation",
      description:
        "Cancels the selected marketplace listing. This escape plan remains available while the marketplace is paused.",
      inputSchema: { tokenId: uint256InputSchema, releaseId: releaseInputSchema },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ tokenId, releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(
          release,
          prepareCancelListingPlan(release, BigInt(tokenId)),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_claim_proceeds",
    {
      title: "Prepare an unsigned seller-proceeds claim",
      description:
        "Claims marketplace proceeds owed to the connected seller. This liability claim remains available while the marketplace is paused.",
      inputSchema: { releaseId: releaseInputSchema },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(release, prepareClaimProceedsPlan(release)));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_claim_referral",
    {
      title: "Prepare an unsigned referral-credit claim",
      description:
        "Claims registration referral credits owed to the connected account. It does not depend on marketplace pause state.",
      inputSchema: { releaseId: releaseInputSchema },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(release, prepareClaimReferralPlan(release)));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_transfer",
    {
      title: "Prepare an unsigned registrar-token transfer",
      description:
        "Builds a safeTransferFrom plan for one active name token. The connected owner remains the signer.",
      inputSchema: {
        from: addressInputSchema,
        to: addressInputSchema,
        tokenId: uint256InputSchema,
        releaseId: releaseInputSchema,
      },
      outputSchema: transactionPlanOutputSchema("transfer"),
    },
    async ({ from, to, tokenId, releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(release, prepareTransferPlan(
          release,
          getAddress(from),
          getAddress(to),
          BigInt(tokenId),
        )));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_invalidate",
    {
      title: "Prepare an unsigned stale-listing invalidation",
      description:
        "Permissionlessly clears a stale raw listing. Live listings are a safe no-op and the plan remains available while paused.",
      inputSchema: { tokenId: uint256InputSchema, releaseId: releaseInputSchema },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ tokenId, releaseId }) => {
      try {
        const release = planManifest(releaseId);
        return output(releasePlan(
          release,
          prepareInvalidateListingPlan(release, BigInt(tokenId)),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  return server;
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(corsHeaders)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handlePost(request: Request): Promise<Response> {
  try {
    const boundedRequest = await boundedMcpRequest(request);
    const server = createContourMcpServer();
    const transport = new WebStandardStreamableHTTPServerTransport({
      enableJsonResponse: true,
    });
    await server.connect(transport);
    return withCors(await transport.handleRequest(boundedRequest));
  } catch (error) {
    if (error instanceof McpBodyTooLargeError) {
      return Response.json(
        {
          jsonrpc: "2.0",
          error: { code: -32_001, message: "MCP request body is too large." },
          id: null,
        },
        { status: 413, headers: corsHeaders },
      );
    }
    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : "MCP request failed.",
        },
        id: null,
      },
      { status: 500, headers: corsHeaders },
    );
  }
}

export function GET(request: Request) {
  return Response.json(
    {
      name: "contour-name-protocol",
      version: "1.0.0",
      transport: "streamable-http",
      mode: "stateless",
      endpoint: new URL("/api/mcp", request.url).toString(),
      resource: "contour://runtime",
      tools: toolNames,
      usage: "Send MCP JSON-RPC requests with POST.",
    },
    { headers: corsHeaders },
  );
}

export const POST = handlePost;

export function DELETE() {
  return Response.json(
    {
      jsonrpc: "2.0",
      error: { code: -32_000, message: "Stateless MCP has no session to delete." },
      id: null,
    },
    {
      status: 405,
      headers: { ...corsHeaders, allow: "GET, POST, OPTIONS" },
    },
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}
