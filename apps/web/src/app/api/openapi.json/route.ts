import type { NextRequest } from "next/server";
import { arcTestnet } from "viem/chains";
import {
  registrarVersionOf,
  type DeploymentManifest,
} from "@contour/config";
import { getDeploymentManifest } from "../../../lib/manifest";
import {
  apiError,
  ARTIFACT_CACHE_HEADERS,
  jsonResponse,
  OPTIONS,
} from "../_shared/http";
import { protocolContext } from "../_shared/protocol";

export { OPTIONS };
export const dynamic = "force-dynamic";

const jsonContent = (schema: object) => ({
  "application/json": { schema },
});

export function nftMetadataDisclosure(manifest: DeploymentManifest) {
  const registrarVersion = registrarVersionOf(manifest);
  const canonicalSupportsMetadata =
    registrarVersion === "v2" && manifest.nftMetadata !== null &&
    manifest.nftMetadata !== undefined;
  const retainedV1 = manifest.legacyReleases?.length === 1;
  return {
    registrarVersion,
    canonicalSupportsMetadata,
    retainedV1,
    canonicalStatement: canonicalSupportsMetadata
      ? "The canonical V2 registrar implements ERC-721 Metadata and its tokenURI resolves to the production metadata route."
      : "The canonical V1 registrar does not implement ERC-721 Metadata or tokenURI; metadata and image routes are application companion endpoints.",
    retainedStatement: retainedV1
      ? " The retained V1 registrar does not implement ERC-721 Metadata or tokenURI; its existing names use the same routes as release-bound companion metadata."
      : "",
  } as const;
}

export function GET(request: NextRequest) {
  try {
    const manifest = getDeploymentManifest();
    const context = protocolContext(manifest);
    const suffix = manifest.namespace.suffix ?? "contour";
    const metadata = nftMetadataDisclosure(manifest);
    const document = {
      openapi: "3.1.0",
      info: {
        title: "Contour Name Protocol API",
        version: manifest.schemaVersion,
        description:
          `Live read and wallet-plan APIs for .${suffix} names on Arc Testnet. ` +
          "The server never submits a user wallet transaction. " +
          `${metadata.canonicalStatement}${metadata.retainedStatement}`,
      },
      externalDocs: {
        description: "Contour developer documentation",
        url: new URL("/developers", request.nextUrl.origin).toString(),
      },
      servers: [{ url: request.nextUrl.origin }],
      security: [],
      tags: [
        { name: "Names", description: "Source-verified Arc contract reads." },
        { name: "Accounts", description: "Owned-name and balance snapshots." },
        { name: "Market", description: "Live marketplace reads." },
        {
          name: "NFT",
          description:
            "Verified metadata and deterministic SVG images for registered names. " +
            `${metadata.canonicalStatement}${metadata.retainedStatement}`,
        },
        { name: "Registration", description: "Wallet-bound registration plans." },
        { name: "Operations", description: "Runtime readiness." },
      ],
      paths: {
        "/api/name/{label}": {
          get: {
            operationId: "getContourName",
            tags: ["Names"],
            summary: "Read a complete name record",
            parameters: [{ $ref: "#/components/parameters/Label" }],
            responses: {
              "200": {
                description: "Registry, registrar, resolver, and availability data.",
                content: jsonContent({ $ref: "#/components/schemas/NameEnvelope" }),
              },
              "400": { $ref: "#/components/responses/BadRequest" },
              "503": { $ref: "#/components/responses/ReadUnavailable" },
            },
          },
        },
        "/api/reverse/{address}": {
          get: {
            operationId: "getContourReverse",
            tags: ["Names"],
            summary: "Read a forward-confirmed reverse record",
            parameters: [{ $ref: "#/components/parameters/Address" }],
            responses: {
              "200": {
                description: "Reverse name and forward-confirmation result.",
                content: jsonContent({ $ref: "#/components/schemas/ReverseEnvelope" }),
              },
              "400": { $ref: "#/components/responses/BadRequest" },
              "503": { $ref: "#/components/responses/ReadUnavailable" },
            },
          },
        },
        "/api/metadata/{tokenId}": {
          get: {
            operationId: "getContourNftMetadata",
            tags: ["NFT"],
            summary: "Read companion metadata for a registered name NFT",
            description:
              "Returns application-hosted metadata derived from verified registration discovery " +
              "and a same-block registrar state read. A canonical label hint can bypass temporary " +
              "explorer indexing delay only when its normalized hash equals the token ID. " +
              `${metadata.canonicalStatement}${metadata.retainedStatement}`,
            parameters: [
              { $ref: "#/components/parameters/TokenId" },
              { $ref: "#/components/parameters/NftLabelHint" },
            ],
            responses: {
              "200": {
                description: "Metadata for the registered Contour name.",
                content: jsonContent({ $ref: "#/components/schemas/NameNftMetadata" }),
              },
              "400": { $ref: "#/components/responses/BadRequest" },
              "404": { $ref: "#/components/responses/NotFound" },
              "503": { $ref: "#/components/responses/ReadUnavailable" },
            },
          },
        },
        "/api/image/{tokenId}": {
          get: {
            operationId: "getContourNftImage",
            tags: ["NFT"],
            summary: "Render a deterministic name identity visual",
            description:
              "Returns a 1200 by 630 application-hosted SVG derived from the same verified " +
              "name snapshot as the companion metadata endpoint.",
            parameters: [
              { $ref: "#/components/parameters/TokenId" },
              { $ref: "#/components/parameters/NftLabelHint" },
            ],
            responses: {
              "200": {
                description: "Deterministic Contour name identity SVG.",
                content: {
                  "image/svg+xml": {
                    schema: {
                      type: "string",
                      contentMediaType: "image/svg+xml",
                    },
                  },
                },
              },
              "400": { $ref: "#/components/responses/BadRequest" },
              "404": { $ref: "#/components/responses/NotFound" },
              "503": { $ref: "#/components/responses/ReadUnavailable" },
            },
          },
        },
        "/api/account": {
          get: {
            operationId: "getContourAccount",
            tags: ["Accounts"],
            summary: "List names owned by an account",
            parameters: [
              { $ref: "#/components/parameters/Owner" },
              { $ref: "#/components/parameters/Fresh" },
            ],
            responses: {
              "200": {
                description: "Owned names, referral credits, proceeds, and listing state.",
                content: jsonContent({ $ref: "#/components/schemas/AccountSnapshot" }),
              },
              "400": { $ref: "#/components/responses/BadRequest" },
              "503": { $ref: "#/components/responses/ReadUnavailable" },
            },
          },
        },
        "/api/market": {
          get: {
            operationId: "getContourMarket",
            tags: ["Market"],
            summary: "Read live fixed-price listings",
            parameters: [{ $ref: "#/components/parameters/Fresh" }],
            responses: {
              "200": {
                description: "Verified marketplace policy and listing snapshot.",
                content: jsonContent({ $ref: "#/components/schemas/MarketSnapshot" }),
              },
              "503": { $ref: "#/components/responses/ReadUnavailable" },
            },
          },
        },
        "/api/registration/preflight": {
          post: {
            operationId: "prepareRegistrationPreflight",
            tags: ["Registration"],
            summary: "Read the quote and prepare an optional USDC approval",
            requestBody: {
              required: true,
              content: jsonContent({ $ref: "#/components/schemas/RegistrationPreflightRequest" }),
            },
            responses: {
              "200": {
                description: "Current amount plus an unsigned approval transaction when required.",
                content: jsonContent({ $ref: "#/components/schemas/RegistrationPreflightResponse" }),
              },
              "400": { $ref: "#/components/responses/BadRequest" },
              "409": { $ref: "#/components/responses/Conflict" },
              "413": { $ref: "#/components/responses/PayloadTooLarge" },
              "503": { $ref: "#/components/responses/ReadUnavailable" },
            },
          },
        },
        "/api/registration/prepare": {
          post: {
            operationId: "prepareRegistration",
            tags: ["Registration"],
            summary: "Issue a wallet-bound permit and unsigned registration transaction",
            requestBody: {
              required: true,
              content: jsonContent({ $ref: "#/components/schemas/RegistrationPrepareRequest" }),
            },
            responses: {
              "200": {
                description: "Short-lived permit, quote, and unsigned registration calldata.",
                content: jsonContent({ $ref: "#/components/schemas/RegistrationPrepareResponse" }),
              },
              "400": { $ref: "#/components/responses/BadRequest" },
              "402": {
                description: "Circle x402 payment required.",
                content: jsonContent({ $ref: "#/components/schemas/X402PaymentRequired" }),
                headers: {
                  "PAYMENT-REQUIRED": {
                    description: "Circle x402 payment requirements JSON payload.",
                    schema: { type: "string" },
                  },
                },
              },
              "409": { $ref: "#/components/responses/Conflict" },
              "413": { $ref: "#/components/responses/PayloadTooLarge" },
              "503": { $ref: "#/components/responses/ReadUnavailable" },
            },
          },
        },
        "/api/registration/readiness": {
          get: {
            operationId: "getRegistrationReadiness",
            tags: ["Operations"],
            summary: "Check registration dependencies",
            responses: {
              "200": {
                description: "Registration dependencies are ready.",
                content: jsonContent({ $ref: "#/components/schemas/RegistrationReadiness" }),
              },
              "503": {
                description: "Registration dependencies are unavailable.",
                content: jsonContent({ $ref: "#/components/schemas/RegistrationReadiness" }),
              },
            },
          },
        },
        "/api/marketplace/readiness": {
          get: {
            operationId: "getMarketplaceReadiness",
            tags: ["Operations"],
            summary: "Check marketplace dependencies",
            responses: {
              "200": {
                description: "Marketplace dependencies are ready.",
                content: jsonContent({ $ref: "#/components/schemas/MarketplaceReadiness" }),
              },
              "503": {
                description: "Marketplace dependencies are unavailable.",
                content: jsonContent({ $ref: "#/components/schemas/MarketplaceReadiness" }),
              },
            },
          },
        },
      },
      components: {
        parameters: {
          Label: {
            name: "label",
            in: "path",
            required: true,
            description: "One label. The API applies the manifest-pinned ENSIP-15 profile.",
            schema: { type: "string", minLength: 1, maxLength: 256 },
          },
          Address: {
            name: "address",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
          },
          Owner: {
            name: "owner",
            in: "query",
            required: true,
            schema: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
          },
          Fresh: {
            name: "fresh",
            in: "query",
            required: false,
            description: "Set to 1 to invalidate the short-lived server snapshot cache before reading.",
            schema: { type: "string", enum: ["1"] },
          },
          TokenId: {
            name: "tokenId",
            in: "path",
            required: true,
            description:
              "Canonical base-10 uint256 token ID: zero, or a non-zero value without leading zeroes.",
            schema: { $ref: "#/components/schemas/TokenIdString" },
          },
          NftLabelHint: {
            name: "label",
            in: "query",
            required: false,
            description:
              "Optional canonical label preimage. It is accepted only when ENSIP-15 normalization " +
              "does not change it and its labelhash equals tokenId; this avoids post-mint explorer indexing delay.",
            schema: { type: "string", minLength: 1, maxLength: 256 },
          },
        },
        schemas: {
          Address: {
            type: "string",
            pattern: "^0x[0-9a-fA-F]{40}$",
            examples: ["0x78de409a6306550882328E2a67160471368387FF"],
          },
          Bytes32: {
            type: "string",
            pattern: "^0x[0-9a-fA-F]{64}$",
          },
          HexData: {
            type: "string",
            pattern: "^0x(?:[0-9a-fA-F]{2})*$",
          },
          DecimalString: {
            type: "string",
            pattern: "^(0|[1-9][0-9]*)$",
          },
          TokenIdString: {
            type: "string",
            format: "uint256-decimal",
            pattern: "^(0|[1-9][0-9]{0,77})$",
            maxLength: 78,
            description:
              "Canonical decimal integer from 0 through 2^256 - 1. Values above the uint256 maximum are rejected.",
            examples: [
              "0",
              "32540854028373530199979267381508191878139842538060205354946260187502743967163",
            ],
            "x-contour-maximum":
              "115792089237316195423570985008687907853269984665640564039457584007913129639935",
          },
          NameNftMetadata: {
            type: "object",
            additionalProperties: false,
            required: [
              "name",
              "description",
              "image",
              "external_url",
              "background_color",
              "attributes",
              "properties",
            ],
            properties: {
              name: { type: "string", examples: [`atlas.${suffix}`] },
              description: { type: "string" },
              image: { type: "string", format: "uri" },
              external_url: { type: "string", format: "uri" },
              background_color: { type: "string", const: "000B24" },
              attributes: {
                type: "array",
                minItems: 5,
                maxItems: 5,
                prefixItems: [
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["trait_type", "value"],
                    properties: {
                      trait_type: { type: "string", const: "Namespace" },
                      value: { type: "string", const: `.${suffix}` },
                    },
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["trait_type", "value"],
                    properties: {
                      trait_type: { type: "string", const: "Network" },
                      value: { type: "string", const: arcTestnet.name },
                    },
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["trait_type", "value"],
                    properties: {
                      trait_type: { type: "string", const: "Length" },
                      value: { type: "integer", minimum: 1 },
                    },
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["trait_type", "value"],
                    properties: {
                      trait_type: { type: "string", const: "Status" },
                      value: {
                        type: "string",
                        enum: ["ACTIVE", "GRACE", "EXPIRED"],
                      },
                    },
                  },
                  {
                    type: "object",
                    additionalProperties: false,
                    required: ["trait_type", "display_type", "value"],
                    properties: {
                      trait_type: { type: "string", const: "Expires" },
                      display_type: { type: "string", const: "date" },
                      value: { type: "integer", minimum: 0 },
                    },
                  },
                ],
                items: false,
              },
              properties: {
                type: "object",
                additionalProperties: false,
                required: [
                  "chainId",
                  "contract",
                  "tokenId",
                  "owner",
                  "lifecycle",
                  "asOfBlock",
                ],
                properties: {
                  chainId: { type: "integer", const: manifest.chain.id },
                  contract: {
                    $ref: "#/components/schemas/Address",
                    const: manifest.contracts.baseRegistrar.address,
                  },
                  tokenId: { $ref: "#/components/schemas/TokenIdString" },
                  owner: { $ref: "#/components/schemas/Address" },
                  lifecycle: {
                    type: "string",
                    enum: ["active", "grace", "expired"],
                  },
                  asOfBlock: { $ref: "#/components/schemas/DecimalString" },
                },
              },
            },
          },
          ProtocolChain: {
            type: "object",
            additionalProperties: false,
            required: ["id", "caip2", "explorerUrl", "confirmations"],
            properties: {
              id: { type: "integer", const: manifest.chain.id },
              caip2: { type: "string", const: manifest.chain.caip2 },
              explorerUrl: { type: "string", format: "uri", const: manifest.chain.explorerUrl },
              confirmations: { type: "integer", minimum: 1 },
            },
          },
          ProtocolNamespace: {
            type: "object",
            additionalProperties: false,
            required: ["brand", "suffix", "baseNode"],
            properties: {
              brand: { type: "string" },
              suffix: { type: "string", const: suffix },
              baseNode: { $ref: "#/components/schemas/Bytes32" },
            },
          },
          Settlement: {
            type: "object",
            additionalProperties: false,
            required: [
              "symbol", "erc20Address", "applicationDecimals",
              "nativeInterfaceDecimals", "sharedUnderlyingBalance",
            ],
            properties: {
              symbol: { type: "string" },
              erc20Address: { $ref: "#/components/schemas/Address" },
              applicationDecimals: { type: "integer", minimum: 0 },
              nativeInterfaceDecimals: { type: "integer", minimum: 0 },
              sharedUnderlyingBalance: { type: "boolean" },
            },
          },
          ContractAddresses: {
            type: "object",
            additionalProperties: false,
            required: [
              "registry", "baseRegistrar", "controller", "publicResolver",
              "reverseRegistrar", "universalResolver", "marketplace",
            ],
            properties: {
              registry: { $ref: "#/components/schemas/Address" },
              baseRegistrar: { $ref: "#/components/schemas/Address" },
              controller: { $ref: "#/components/schemas/Address" },
              publicResolver: { $ref: "#/components/schemas/Address" },
              reverseRegistrar: { $ref: "#/components/schemas/Address" },
              universalResolver: { $ref: "#/components/schemas/Address" },
              marketplace: { $ref: "#/components/schemas/Address" },
            },
          },
          ProtocolContext: {
            type: "object",
            additionalProperties: false,
            required: [
              "schemaVersion", "manifestSha256", "state", "releaseId", "chain",
              "namespace", "settlement", "contracts",
            ],
            properties: {
              schemaVersion: { type: "string", const: manifest.schemaVersion },
              manifestSha256: { $ref: "#/components/schemas/Bytes32", const: context.manifestSha256 },
              state: { type: "string", const: manifest.state },
              releaseId: {
                oneOf: [{ $ref: "#/components/schemas/Bytes32" }, { type: "null" }],
              },
              chain: { $ref: "#/components/schemas/ProtocolChain" },
              namespace: { $ref: "#/components/schemas/ProtocolNamespace" },
              settlement: { $ref: "#/components/schemas/Settlement" },
              contracts: { $ref: "#/components/schemas/ContractAddresses" },
            },
          },
          NameRecord: {
            type: "object",
            required: [
              "name", "node", "tokenId", "registryOwner", "registrant", "resolver",
              "resolvedAddress", "contentHash", "expiry", "available", "input",
            ],
            properties: {
              name: { type: "string", examples: [`atlas.${suffix}`] },
              node: { type: "string", pattern: "^0x[0-9a-fA-F]{64}$" },
              tokenId: { type: "string", pattern: "^[0-9]+$" },
              registryOwner: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
              registrant: { type: ["string", "null"] },
              resolver: { type: ["string", "null"] },
              resolvedAddress: { type: ["string", "null"] },
              contentHash: { type: ["string", "null"] },
              expiry: { type: ["string", "null"], pattern: "^[0-9]+$" },
              available: { type: "boolean" },
              input: {
                type: "object",
                required: ["rawLabel", "normalizedLabel", "normalizationChanged"],
                properties: {
                  rawLabel: { type: "string" },
                  normalizedLabel: { type: "string" },
                  normalizationChanged: { type: "boolean" },
                },
              },
            },
          },
          NameEnvelope: {
            type: "object",
            required: ["data", "context"],
            properties: {
              data: { $ref: "#/components/schemas/NameRecord" },
              context: { $ref: "#/components/schemas/ProtocolContext" },
            },
          },
          ReverseResult: {
            type: "object",
            required: ["address", "name", "forwardConfirmed"],
            properties: {
              address: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
              name: { type: ["string", "null"] },
              forwardConfirmed: { type: "boolean" },
            },
          },
          ReverseEnvelope: {
            type: "object",
            required: ["data", "context"],
            properties: {
              data: { $ref: "#/components/schemas/ReverseResult" },
              context: { $ref: "#/components/schemas/ProtocolContext" },
            },
          },
          LiveMarketListing: {
            type: "object",
            additionalProperties: false,
            required: [
              "tokenId", "label", "name", "seller", "price", "validUntil",
              "expiry", "feeBps", "marketPaused",
            ],
            properties: {
              tokenId: { $ref: "#/components/schemas/DecimalString" },
              label: { type: "string" },
              name: { type: "string", examples: [`atlas.${suffix}`] },
              seller: { $ref: "#/components/schemas/Address" },
              price: { $ref: "#/components/schemas/DecimalString" },
              validUntil: { $ref: "#/components/schemas/DecimalString" },
              expiry: { $ref: "#/components/schemas/DecimalString" },
              feeBps: { type: "integer", minimum: 0, maximum: 1_000 },
              marketPaused: { type: "boolean" },
            },
          },
          OwnedName: {
            type: "object",
            additionalProperties: false,
            required: ["tokenId", "label", "name", "expiry", "lifecycle", "listing"],
            properties: {
              tokenId: { $ref: "#/components/schemas/DecimalString" },
              label: { type: "string" },
              name: { type: "string" },
              expiry: { $ref: "#/components/schemas/DecimalString" },
              lifecycle: { type: "string", enum: ["active", "grace", "expired"] },
              listing: {
                oneOf: [
                  { $ref: "#/components/schemas/LiveMarketListing" },
                  { type: "null" },
                ],
              },
            },
          },
          MarketSnapshot: {
            type: "object",
            additionalProperties: false,
            required: ["chainId", "asOfBlock", "asOfTimestamp", "listings"],
            properties: {
              chainId: { type: "integer", const: manifest.chain.id },
              asOfBlock: { $ref: "#/components/schemas/DecimalString" },
              asOfTimestamp: { $ref: "#/components/schemas/DecimalString" },
              listings: {
                type: "array",
                items: { $ref: "#/components/schemas/LiveMarketListing" },
              },
            },
          },
          AccountSnapshot: {
            type: "object",
            additionalProperties: false,
            required: [
              "chainId", "asOfBlock", "asOfTimestamp", "owner", "referralCredits",
              "sellerProceeds", "marketPaused", "names",
            ],
            properties: {
              chainId: { type: "integer", const: manifest.chain.id },
              asOfBlock: { $ref: "#/components/schemas/DecimalString" },
              asOfTimestamp: { $ref: "#/components/schemas/DecimalString" },
              owner: { $ref: "#/components/schemas/Address" },
              referralCredits: { $ref: "#/components/schemas/DecimalString" },
              sellerProceeds: { $ref: "#/components/schemas/DecimalString" },
              marketPaused: { type: "boolean" },
              names: {
                type: "array",
                items: { $ref: "#/components/schemas/OwnedName" },
              },
            },
          },
          RegistrationPreflightRequest: {
            type: "object",
            required: ["rawLabel", "normalizationAccepted", "durationYears", "payer"],
            properties: {
              rawLabel: { type: "string", minLength: 1, maxLength: 256 },
              normalizationAccepted: { type: "boolean" },
              durationYears: { type: "integer", minimum: 1, maximum: 10 },
              payer: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
            },
          },
          RegistrationPrepareRequest: {
            type: "object",
            required: [
              "rawLabel", "normalizationAccepted", "durationYears", "requestId",
            ],
            properties: {
              rawLabel: { type: "string", minLength: 1, maxLength: 256 },
              normalizationAccepted: { type: "boolean" },
              durationYears: { type: "integer", minimum: 1, maximum: 10 },
              account: {
                type: "string",
                pattern: "^0x[0-9a-fA-F]{40}$",
                description: "Convenience alias setting requester, payer, and recipient to the same address.",
              },
              requester: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
              payer: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
              recipient: { type: "string", pattern: "^0x[0-9a-fA-F]{40}$" },
              requestId: { type: "string", minLength: 8, maxLength: 128 },
            },
          },
          UnsignedTransaction: {
            type: "object",
            additionalProperties: false,
            required: ["to", "data", "value"],
            properties: {
              to: { $ref: "#/components/schemas/Address" },
              data: { $ref: "#/components/schemas/HexData" },
              value: { type: "string", const: "0x0" },
            },
          },
          RegistrationPreflightResponse: {
            type: "object",
            additionalProperties: false,
            required: ["normalizedLabel", "expectedAmount", "approvalTransaction"],
            properties: {
              normalizedLabel: { type: "string" },
              expectedAmount: { $ref: "#/components/schemas/DecimalString" },
              approvalTransaction: {
                oneOf: [
                  { $ref: "#/components/schemas/UnsignedTransaction" },
                  { type: "null" },
                ],
              },
            },
          },
          RegistrationPermit: {
            type: "object",
            additionalProperties: false,
            required: [
              "chainId", "controller", "releaseId", "normalizationProfileHash",
              "normalizedLabelHash", "namehash", "requester", "recipient", "payer",
              "authorizedExecutor", "durationYears", "resolverDataHash", "referrer",
              "settlementAsset", "expectedAmount", "expectedReferralBps", "permitId",
              "nonce", "issuedAt", "validAfter", "validUntil",
            ],
            properties: {
              chainId: { $ref: "#/components/schemas/DecimalString" },
              controller: { $ref: "#/components/schemas/Address" },
              releaseId: { $ref: "#/components/schemas/Bytes32" },
              normalizationProfileHash: { $ref: "#/components/schemas/Bytes32" },
              normalizedLabelHash: { $ref: "#/components/schemas/Bytes32" },
              namehash: { $ref: "#/components/schemas/Bytes32" },
              requester: { $ref: "#/components/schemas/Address" },
              recipient: { $ref: "#/components/schemas/Address" },
              payer: { $ref: "#/components/schemas/Address" },
              authorizedExecutor: { $ref: "#/components/schemas/Address" },
              durationYears: { $ref: "#/components/schemas/DecimalString" },
              resolverDataHash: { $ref: "#/components/schemas/Bytes32" },
              referrer: { $ref: "#/components/schemas/Address" },
              settlementAsset: { $ref: "#/components/schemas/Address" },
              expectedAmount: { $ref: "#/components/schemas/DecimalString" },
              expectedReferralBps: { $ref: "#/components/schemas/DecimalString" },
              permitId: { $ref: "#/components/schemas/Bytes32" },
              nonce: { $ref: "#/components/schemas/DecimalString" },
              issuedAt: { $ref: "#/components/schemas/DecimalString" },
              validAfter: { $ref: "#/components/schemas/DecimalString" },
              validUntil: { $ref: "#/components/schemas/DecimalString" },
            },
          },
          RegistrationPrepareResponse: {
            type: "object",
            additionalProperties: false,
            required: [
              "registrationTransaction", "permitId", "validUntil", "permit", "signature",
            ],
            properties: {
              registrationTransaction: { $ref: "#/components/schemas/UnsignedTransaction" },
              permitId: { $ref: "#/components/schemas/Bytes32" },
              validUntil: { $ref: "#/components/schemas/DecimalString" },
              permit: { $ref: "#/components/schemas/RegistrationPermit" },
              signature: { $ref: "#/components/schemas/HexData" },
              paymentVerified: { type: "boolean" },
              paymentIdentifier: { $ref: "#/components/schemas/Bytes32" },
            },
          },
          X402PaymentRequired: {
            type: "object",
            additionalProperties: false,
            required: ["code", "error", "paymentRequired"],
            properties: {
              code: { type: "string", const: "PAYMENT_REQUIRED" },
              error: { type: "string" },
              paymentRequired: {
                type: "object",
                additionalProperties: false,
                required: ["x402Version", "resource", "accepts"],
                properties: {
                  x402Version: { type: "integer", const: 2 },
                  resource: {
                    type: "object",
                    additionalProperties: false,
                    required: ["url", "description", "mimeType"],
                    properties: {
                      url: { type: "string" },
                      description: { type: "string" },
                      mimeType: { type: "string" },
                    },
                  },
                  accepts: {
                    type: "array",
                    items: {
                      type: "object",
                      additionalProperties: false,
                      required: [
                        "scheme",
                        "network",
                        "asset",
                        "amount",
                        "payTo",
                        "maxTimeoutSeconds",
                        "extra",
                      ],
                      properties: {
                        scheme: { type: "string", const: "exact" },
                        network: { type: "string", const: "eip155:5042002" },
                        asset: {
                          type: "string",
                          const: "0x3600000000000000000000000000000000000000",
                        },
                        amount: { $ref: "#/components/schemas/DecimalString" },
                        payTo: { $ref: "#/components/schemas/Address" },
                        maxTimeoutSeconds: { type: "integer", const: 120 },
                        extra: {
                          type: "object",
                          additionalProperties: false,
                          required: ["domain", "verifyingContract"],
                          properties: {
                            domain: { type: "integer", const: 26 },
                            verifyingContract: { $ref: "#/components/schemas/Address" },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          RegistrationReadiness: {
            type: "object",
            additionalProperties: false,
            required: [
              "ready", "releaseId", "chainId", "controller", "signerAddress", "registrationsPaused",
            ],
            properties: {
              ready: { type: "boolean" },
              code: { type: "string" },
              reasons: {
                type: "array",
                items: { type: "string" },
              },
              error: { type: "string" },
              releaseId: {
                oneOf: [{ $ref: "#/components/schemas/Bytes32" }, { type: "null" }],
              },
              chainId: {
                oneOf: [{ type: "integer" }, { type: "null" }],
              },
              controller: {
                oneOf: [{ $ref: "#/components/schemas/Address" }, { type: "null" }],
              },
              signerAddress: {
                oneOf: [{ $ref: "#/components/schemas/Address" }, { type: "null" }],
              },
              registrationsPaused: { type: ["boolean", "null"] },
            },
          },
          MarketplaceReadiness: {
            type: "object",
            additionalProperties: false,
            required: [
              "ready", "reasons", "releaseId", "chainId", "marketplace",
              "asOfBlock", "paused", "feeBps",
            ],
            properties: {
              ready: { type: "boolean" },
              reasons: {
                type: "array",
                items: {
                  type: "string",
                  enum: [
                    "EXECUTION_SURFACE_DISABLED",
                    "MANIFEST_NOT_ACTIVE",
                    "MANIFEST_POLICY_INCOMPLETE",
                    "MANIFEST_POLICY_NOT_OPEN",
                    "ARC_CHAIN_MISMATCH",
                    "MARKETPLACE_RUNTIME_MISMATCH",
                    "MARKETPLACE_REGISTRAR_MISMATCH",
                    "MARKETPLACE_SETTLEMENT_MISMATCH",
                    "MARKETPLACE_OWNER_MISMATCH",
                    "MARKETPLACE_PENDING_OWNER",
                    "MARKETPLACE_TREASURY_MISMATCH",
                    "MARKETPLACE_FEE_POLICY_MISMATCH",
                    "MARKETPLACE_PAUSED",
                    "ARC_RPC_UNAVAILABLE",
                    "READINESS_DEPENDENCY_UNAVAILABLE",
                  ],
                },
              },
              releaseId: {
                oneOf: [{ $ref: "#/components/schemas/Bytes32" }, { type: "null" }],
              },
              chainId: {
                oneOf: [{ type: "integer" }, { type: "null" }],
              },
              marketplace: {
                oneOf: [{ $ref: "#/components/schemas/Address" }, { type: "null" }],
              },
              asOfBlock: {
                oneOf: [{ $ref: "#/components/schemas/DecimalString" }, { type: "null" }],
              },
              paused: { type: ["boolean", "null"] },
              feeBps: {
                oneOf: [
                  { type: "integer", minimum: 0, maximum: 1_000 },
                  { type: "null" },
                ],
              },
            },
          },
          NestedErrorEnvelope: {
            type: "object",
            additionalProperties: false,
            required: ["error", "context"],
            properties: {
              error: {
                type: "object",
                additionalProperties: false,
                required: ["code", "message"],
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                  details: { type: "object" },
                },
              },
              context: {
                oneOf: [
                  { $ref: "#/components/schemas/ProtocolContext" },
                  { type: "null" },
                ],
              },
            },
          },
          FlatErrorEnvelope: {
            type: "object",
            required: ["error"],
            properties: {
              error: { type: "string" },
              code: { type: "string" },
              normalizedLabel: { type: "string" },
              retryAfter: { type: "string" },
            },
          },
          ErrorEnvelope: {
            oneOf: [
              { $ref: "#/components/schemas/NestedErrorEnvelope" },
              { $ref: "#/components/schemas/FlatErrorEnvelope" },
            ],
          },
        },
        responses: {
          BadRequest: {
            description: "The request input is invalid.",
            content: jsonContent({ $ref: "#/components/schemas/ErrorEnvelope" }),
          },
          Conflict: {
            description: "Current normalization, availability, authorization, or permit state conflicts with the request.",
            content: jsonContent({ $ref: "#/components/schemas/ErrorEnvelope" }),
          },
          PayloadTooLarge: {
            description: "The JSON request body exceeds the endpoint limit.",
            content: jsonContent({ $ref: "#/components/schemas/ErrorEnvelope" }),
          },
          NotFound: {
            description: "No registered Contour name exists for the requested token ID.",
            content: jsonContent({ $ref: "#/components/schemas/ErrorEnvelope" }),
          },
          TooManyRequests: {
            description: "The verification service is busy; retry after the indicated delay.",
            content: jsonContent({ $ref: "#/components/schemas/ErrorEnvelope" }),
            headers: {
              "Retry-After": {
                description: "Recommended retry delay in seconds.",
                schema: { type: "string" },
              },
            },
          },
          ReadUnavailable: {
            description: "A required manifest, Arc RPC, issuer, or bounded service dependency is unavailable.",
            content: jsonContent({ $ref: "#/components/schemas/ErrorEnvelope" }),
            headers: {
              "Retry-After": {
                description: "Present when a short retry is recommended.",
                schema: { type: "string" },
              },
            },
          },
        },
      },
      "x-contour-deployment": context,
      "x-contour-discovery": {
        manifest: "/deployment-manifest.json",
        wellKnown: "/.well-known/chain-name-service.json",
        runtime: "/runtime-manifest.json",
        mcp: "/api/mcp",
        abiIndex: "/abi",
        llms: "/llms.txt",
      },
      "x-contour-nft-metadata": {
        classification: metadata.canonicalSupportsMetadata
          ? "canonical-token-uri"
          : "application-companion",
        liveRegistrarVersion: metadata.registrarVersion.toUpperCase(),
        liveRegistrarSupportsErc721Metadata:
          metadata.canonicalSupportsMetadata,
        liveRegistrarSupportsTokenUri: metadata.canonicalSupportsMetadata,
        metadataBaseURI: manifest.nftMetadata?.metadataBaseURI ?? null,
        metadataPath: "/api/metadata/{tokenId}",
        imagePath: "/api/image/{tokenId}",
        note: `${metadata.canonicalStatement}${metadata.retainedStatement}`,
        retainedLegacyRegistrar: metadata.retainedV1
          ? {
              registrarVersion: "V1",
              supportsErc721Metadata: false,
              supportsTokenUri: false,
              classification: "release-bound-companion",
            }
          : null,
      },
      "x-contour-route-scope": {
        description:
          "Only stable public read, registration-plan, and readiness operations are included in paths. " +
          "The following application-internal, compatibility, self-description, or protocol-specific routes remain reachable but are not part of the generated HTTP client contract.",
        additionalRoutes: [
          {
            path: "/api/account/verify",
            methods: ["POST"],
            classification: "application-internal",
            knownStatusCodes: [200, 202, 400, 409, 413, 429],
          },
          {
            path: "/api/market/verify",
            methods: ["POST"],
            classification: "application-internal",
            knownStatusCodes: [200, 202, 400, 409, 413, 429],
          },
          {
            path: "/api/registration/verify",
            methods: ["POST"],
            classification: "application-internal",
            knownStatusCodes: [200, 400, 409, 413, 503],
          },
          {
            path: "/api/registration/challenge",
            methods: ["POST"],
            classification: "compatibility",
            knownStatusCodes: [200, 400, 409, 413, 503],
          },
          {
            path: "/api/registration/issuer/healthz",
            methods: ["GET"],
            classification: "issuer-internal",
            knownStatusCodes: [200, 503],
          },
          {
            path: "/api/registration/issuer/v1/challenges",
            methods: ["POST"],
            classification: "issuer-adapter",
            knownStatusCodes: [200, 400, 413, 503],
          },
          {
            path: "/api/registration/issuer/v1/permits",
            methods: ["POST"],
            classification: "issuer-adapter",
            knownStatusCodes: [200, 400, 409, 413, 422, 503],
          },
          {
            path: "/api/manifest",
            methods: ["GET"],
            classification: "compatibility",
            knownStatusCodes: [200, 503],
          },
          {
            path: "/api/mcp",
            methods: ["GET", "POST", "OPTIONS"],
            classification: "protocol-specific",
            knownStatusCodes: [200, 204, 400, 500],
          },
          {
            path: "/api/openapi.json",
            methods: ["GET", "OPTIONS"],
            classification: "self-description",
            knownStatusCodes: [200, 204, 503],
          },
        ],
      },
    };

    return jsonResponse(document, { headers: ARTIFACT_CACHE_HEADERS });
  } catch {
    return apiError(
      503,
      "OPENAPI_UNAVAILABLE",
      "The OpenAPI document could not be generated from the deployment manifest.",
    );
  }
}
