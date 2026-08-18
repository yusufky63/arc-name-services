import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import { ARC_TESTNET_CHAIN_ID } from "@contour/config";
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
import { preparePermitHttpRequest, REQUEST_ID_PATTERN } from "./permit-request.js";
import {
  ContourReleaseDirectory,
  type ContourReleaseSet,
} from "./release-directory.js";

export const stdioToolNames = [
  "normalize_label",
  "get_name",
  "reverse_lookup",
  "prepare_issuer_request",
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
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

const addressInputSchema = z.string()
  .regex(ADDRESS_PATTERN, "Invalid EVM address")
  .refine(isAddress, "Invalid EVM address");
const addressOutputSchema = z.string().regex(ADDRESS_PATTERN);
const bytes32OutputSchema = z.string().regex(BYTES32_PATTERN);
const releaseIdInputSchema = z.string().regex(BYTES32_PATTERN, "Invalid releaseId");

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
  name: z.string().nullable(),
  forwardConfirmed: z.boolean(),
};

const issuerIntentOutputSchema = {
  requestId: z.string().regex(REQUEST_ID_PATTERN),
  rawLabel: z.string(),
  normalizationAccepted: z.boolean(),
  requester: addressOutputSchema,
  recipient: addressOutputSchema,
  payer: addressOutputSchema,
  authorizedExecutor: addressOutputSchema,
  durationYears: z.number().int().min(1).max(10),
  resolverDataHash: bytes32OutputSchema,
  referrer: addressOutputSchema,
};

const issuerRequestOutputSchema = {
  releaseId: bytes32OutputSchema,
  challenge: z.object({
    method: z.literal("POST"),
    url: z.string().url(),
    body: z.object(issuerIntentOutputSchema),
    responseFields: z.object({
      challengeId: z.literal("id"),
      challengeMessage: z.literal("message"),
      challengeProof: z.literal("proof"),
    }),
  }),
  permit: z.object({
    method: z.literal("POST"),
    url: z.string().url(),
    bodyAfterChallengeSignature: z.object({
      ...issuerIntentOutputSchema,
      challengeId: z.null(),
      challengeMessage: z.null(),
      challengeProof: z.null(),
      challengeSignature: z.null(),
    }),
  }),
  warning: z.string(),
};

function transactionPlanOutputSchema(kind: "approval" | "renew" | "market" | "transfer") {
  return {
    kind: z.literal(kind),
    chainId: z.literal(ARC_TESTNET_CHAIN_ID),
    releaseId: bytes32OutputSchema,
    to: addressOutputSchema,
    data: z.string().regex(HEX_PATTERN),
    value: z.literal("0"),
    description: z.string(),
  };
}

function json(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item, 2);
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
      text: error instanceof Error ? error.message : "request failed",
    }],
  };
}

export function createContourStdioServer(
  releases: ContourReleaseSet,
): McpServer {
  const directory = new ContourReleaseDirectory(releases);
  const server = new McpServer({
    name: "contour-name-protocol-stdio",
    version: "2.0.0",
  });

  server.registerResource(
    "deployment-manifest",
    "contour://manifest",
    { title: "Arc Testnet canonical and legacy release manifests", mimeType: "application/json" },
    async (uri) => ({
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: json(directory.resourceDocument()),
      }],
    }),
  );

  server.registerTool(
    "normalize_label",
    {
      title: "Normalize an Arc name label",
      description: "Runs the exact pinned ENSIP-15 single-label profile. It never signs or reserves the name.",
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
      title: "Read a name from Arc RPC",
      description:
        "Reads owner, registrant, resolver, address and lifecycle from the explicitly selected Arc release.",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        label: z.string().min(1).max(256),
      },
      outputSchema: nameOutputSchema,
    },
    async ({ releaseId, label }) => {
      try {
        return output(await directory.resolve(releaseId).client.name(label));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "reverse_lookup",
    {
      title: "Forward-confirmed Arc reverse lookup",
      description:
        "Returns a primary name from the explicitly selected release and whether its forward record confirms the account.",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        account: addressInputSchema,
      },
      outputSchema: reverseLookupOutputSchema,
    },
    async ({ releaseId, account }) => {
      try {
        return output(await directory.resolve(releaseId).client.reverse(getAddress(account)));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_issuer_request",
    {
      title: "Prepare a wallet-bound issuer request payload",
      description: "Builds issuer challenge and permit request fields only. It does not sign, hold keys, reserve labels or submit transactions.",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        rawLabel: z.string().min(1).max(256),
        normalizationAccepted: z.boolean(),
        requester: addressInputSchema,
        recipient: addressInputSchema,
        durationYears: z.number().int().min(1).max(10),
        resolverDataHash: z.string().regex(BYTES32_PATTERN),
        requestId: z.string().regex(REQUEST_ID_PATTERN),
        referrer: addressInputSchema.optional(),
      },
      outputSchema: issuerRequestOutputSchema,
    },
    async (input) => {
      try {
        const binding = directory.resolveCanonicalV2(input.releaseId);
        return output(preparePermitHttpRequest(binding.manifest, input));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_approval",
    {
      title: "Prepare unsigned registration-controller USDC approval",
      description:
        "Backwards-compatible registration allowance tool. Returns calldata only; value is always zero and no transaction is broadcast.",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        amountBaseUnits: positiveUint256InputSchema,
      },
      outputSchema: transactionPlanOutputSchema("approval"),
    },
    async ({ releaseId, amountBaseUnits }) => {
      try {
        return output(prepareApprovalPlan(
          directory.resolve(releaseId).manifest,
          BigInt(amountBaseUnits),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_renewal",
    {
      title: "Prepare unsigned renewal",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        normalizedLabel: z.string().min(1).max(256),
        durationYears: z.number().int().min(1).max(10),
        expectedAmountBaseUnits: positiveUint256InputSchema,
      },
      outputSchema: transactionPlanOutputSchema("renew"),
    },
    async ({ releaseId, normalizedLabel, durationYears, expectedAmountBaseUnits }) => {
      try {
        return output(prepareRenewalPlan(
          directory.resolve(releaseId).manifest,
          normalizedLabel,
          BigInt(durationYears),
          BigInt(expectedAmountBaseUnits),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_token_approval",
    {
      title: "Prepare unsigned marketplace NFT approval",
      description:
        "Authorizes only the selected registrar token for the pinned marketplace. Returns calldata only and never broadcasts.",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        tokenId: uint256InputSchema,
      },
      outputSchema: transactionPlanOutputSchema("approval"),
    },
    async ({ releaseId, tokenId }) => {
      try {
        return output(prepareMarketplaceTokenApprovalPlan(
          directory.resolve(releaseId).manifest,
          BigInt(tokenId),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_token_approval_revoke",
    {
      title: "Prepare unsigned marketplace NFT approval revocation",
      description:
        "Clears the selected token's ERC-721 approval. This escape plan remains available while the marketplace is paused.",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        tokenId: uint256InputSchema,
      },
      outputSchema: transactionPlanOutputSchema("approval"),
    },
    async ({ releaseId, tokenId }) => {
      try {
        return output(prepareMarketplaceTokenApprovalRevokePlan(
          directory.resolve(releaseId).manifest,
          BigInt(tokenId),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_usdc_approval",
    {
      title: "Prepare unsigned marketplace USDC approval",
      description:
        "Authorizes the pinned marketplace for the exact positive USDC amount. Returns calldata only and never broadcasts.",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        amountBaseUnits: positiveUint256InputSchema,
      },
      outputSchema: transactionPlanOutputSchema("approval"),
    },
    async ({ releaseId, amountBaseUnits }) => {
      try {
        return output(prepareMarketplaceApprovalPlan(
          directory.resolve(releaseId).manifest,
          BigInt(amountBaseUnits),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_listing",
    {
      title: "Prepare unsigned fixed-price listing",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        tokenId: uint256InputSchema,
        priceBaseUnits: positiveUint256InputSchema,
        validUntil: positiveUint64InputSchema,
      },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ releaseId, tokenId, priceBaseUnits, validUntil }) => {
      try {
        return output(prepareListingPlan(
          directory.resolve(releaseId).manifest,
          BigInt(tokenId),
          BigInt(priceBaseUnits),
          BigInt(validUntil),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_buy",
    {
      title: "Prepare unsigned fixed-price purchase",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        tokenId: uint256InputSchema,
        expectedPriceBaseUnits: positiveUint256InputSchema,
        expectedFeeBps: z.number().int().min(0).max(1_000),
      },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ releaseId, tokenId, expectedPriceBaseUnits, expectedFeeBps }) => {
      try {
        return output(prepareBuyPlan(
          directory.resolve(releaseId).manifest,
          BigInt(tokenId),
          BigInt(expectedPriceBaseUnits),
          expectedFeeBps,
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_cancel",
    {
      title: "Prepare unsigned listing cancellation",
      description:
        "Cancels the selected marketplace listing. This escape plan remains available while the marketplace is paused.",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        tokenId: uint256InputSchema,
      },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ releaseId, tokenId }) => {
      try {
        return output(prepareCancelListingPlan(
          directory.resolve(releaseId).manifest,
          BigInt(tokenId),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_claim_proceeds",
    {
      title: "Prepare unsigned seller-proceeds claim",
      description:
        "Claims marketplace proceeds owed to the connected seller. This liability claim remains available while the marketplace is paused.",
      inputSchema: { releaseId: releaseIdInputSchema },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ releaseId }) => {
      try {
        return output(prepareClaimProceedsPlan(directory.resolve(releaseId).manifest));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_claim_referral",
    {
      title: "Prepare unsigned referral-credit claim",
      description:
        "Claims registration referral credits owed to the connected account. It does not depend on marketplace pause state.",
      inputSchema: { releaseId: releaseIdInputSchema },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ releaseId }) => {
      try {
        return output(prepareClaimReferralPlan(directory.resolve(releaseId).manifest));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_transfer",
    {
      title: "Prepare unsigned registrar-token transfer",
      description:
        "Builds a safeTransferFrom plan for one active name token. The connected owner remains the signer.",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        from: addressInputSchema,
        to: addressInputSchema,
        tokenId: uint256InputSchema,
      },
      outputSchema: transactionPlanOutputSchema("transfer"),
    },
    async ({ releaseId, from, to, tokenId }) => {
      try {
        return output(prepareTransferPlan(
          directory.resolve(releaseId).manifest,
          getAddress(from),
          getAddress(to),
          BigInt(tokenId),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  server.registerTool(
    "prepare_market_invalidate",
    {
      title: "Prepare unsigned stale-listing invalidation",
      description:
        "Permissionlessly clears a stale raw listing. Live listings are a safe no-op and the plan remains available while paused.",
      inputSchema: {
        releaseId: releaseIdInputSchema,
        tokenId: uint256InputSchema,
      },
      outputSchema: transactionPlanOutputSchema("market"),
    },
    async ({ releaseId, tokenId }) => {
      try {
        return output(prepareInvalidateListingPlan(
          directory.resolve(releaseId).manifest,
          BigInt(tokenId),
        ));
      } catch (error) {
        return executionError(error);
      }
    },
  );

  return server;
}
