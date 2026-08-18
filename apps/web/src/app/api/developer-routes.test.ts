import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  CANONICAL_NFT_METADATA_BASE_URI,
  deploymentManifestDigest,
  parseDeploymentManifest,
  registrarVersionOf,
  type DeploymentManifest,
} from "@contour/config";
import { resolverDataHash } from "@contour/sdk";
import { GET as getManifestAlias } from "../deployment-manifest.json/route";
import { GET as getWellKnown } from "../.well-known/chain-name-service.json/route";
import { GET as getRuntimeDiscovery } from "../runtime-manifest.json/route";
import { GET as getAbi } from "../abi/[contract]/route";
import { GET as getLlms } from "../llms.txt/route";
import { GET as getName } from "./name/[label]/route";
import { GET as getReverse } from "./reverse/[address]/route";
import { GET as getAccount } from "./account/route";
import { POST as postRegistrationPreflight } from "./registration/preflight/route";
import { POST as postRegistrationPrepare } from "./registration/prepare/route";
import { POST as postRegistrationChallenge } from "./registration/challenge/route";
import {
  GET as getOpenApi,
  nftMetadataDisclosure,
} from "./openapi.json/route";
import {
  DELETE as deleteMcp,
  GET as getMcpInfo,
  OPTIONS as optionsMcp,
  POST as postMcp,
} from "./mcp/route";

vi.mock("server-only", () => ({}));

describe("public developer routes", () => {
  it("keeps the signed manifest exact and publishes separate HTTPS runtime discovery", async () => {
    const [alias, wellKnown] = [getManifestAlias(), getWellKnown()];
    expect(alias.status).toBe(200);
    expect(alias.headers.get("access-control-allow-origin")).toBe("*");
    const body = await alias.clone().json();
    expect(body).toEqual(await wellKnown.json());
    const manifest = parseDeploymentManifest(body);
    expect(manifest.chain.websocketUrl).toBe("wss://rpc.testnet.arc.network");
    expect(deploymentManifestDigest(manifest)).toMatch(/^0x[0-9a-f]{64}$/);

    const runtime = getRuntimeDiscovery();
    expect(runtime.status).toBe(200);
    const runtimeBody = await runtime.json() as {
      schemaVersion: string;
      kind: string;
      chain: Record<string, unknown>;
      canonicalManifest: { sha256: string };
      release: { productLive: boolean; evidenceComplete: boolean };
      readiness: { registration: string; marketplace: string; permitIssuer: string };
      endpoints: { mcp: string };
    };
    expect(runtimeBody.schemaVersion).toBe("1.1.0");
    expect(runtimeBody.kind).toBe("contour-runtime-discovery");
    expect(runtimeBody.chain).not.toHaveProperty("websocketUrl");
    expect(runtimeBody.chain).toMatchObject({
      rpcUrl: "https://rpc.testnet.arc.network",
      transport: "https",
    });
    expect(runtimeBody.canonicalManifest.sha256).toBe(deploymentManifestDigest(manifest));
    expect(runtimeBody.release).toMatchObject({
      deploymentState: manifest.state,
      productLive: true,
      registrationReady:
        manifest.state === "active" &&
        manifest.permitIssuer.active &&
        manifest.activationEvidence.controllerPolicy.registrationsPaused === false,
      marketplaceReady:
        manifest.state === "active" &&
        manifest.contracts.marketplace.address !== null &&
        manifest.activationEvidence.marketplacePolicy.paused === false,
      mcpReady: true,
      permitIssuerReady: manifest.permitIssuer.active,
      x402Ready: manifest.x402.active,
      evidenceComplete: true,
    });
    expect(runtimeBody.readiness).toMatchObject({
      registration: expect.stringMatching(/\/api\/registration\/readiness$/),
      marketplace: expect.stringMatching(/\/api\/marketplace\/readiness$/),
      permitIssuer: expect.stringMatching(/\/api\/registration\/issuer\/healthz$/),
    });
    expect(runtimeBody.endpoints.mcp).toMatch(/\/api\/mcp$/);
  });

  it("publishes ABI artifacts and a stable not-found envelope", async () => {
    const artifact = await getAbi(new Request("http://localhost/abi/registry.json"), {
      params: Promise.resolve({ contract: "registry.json" }),
    });
    expect(artifact.status).toBe(200);
    await expect(artifact.json()).resolves.toMatchObject({
      abiScope: "sdk-surface",
      contractName: "registry",
      chainId: 5_042_002,
      sourceVerified: true,
    });

    const missing = await getAbi(new Request("http://localhost/abi/nope.json"), {
      params: Promise.resolve({ contract: "nope.json" }),
    });
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({ error: { code: "ABI_NOT_FOUND" } });
  });

  it("keeps the generated OpenAPI contract synchronized with public HTTP behavior", async () => {
    const openApi = getOpenApi(new NextRequest("http://localhost:3002/api/openapi.json"));
    const document = await openApi.json() as {
      security: unknown[];
      paths: Record<string, {
        get?: { parameters?: Array<{ $ref: string }>; responses: Record<string, unknown> };
        post?: { responses: Record<string, unknown> };
      }>;
      components: { schemas: Record<string, Record<string, unknown>> };
      "x-contour-route-scope": {
        additionalRoutes: Array<{
          path: string;
          classification: string;
          knownStatusCodes: number[];
        }>;
      };
      "x-contour-nft-metadata": {
        classification: string;
        liveRegistrarVersion: string;
        liveRegistrarSupportsErc721Metadata: boolean;
        liveRegistrarSupportsTokenUri: boolean;
        metadataBaseURI: string | null;
        metadataPath: string;
        imagePath: string;
        retainedLegacyRegistrar: {
          registrarVersion: string;
          supportsErc721Metadata: boolean;
          supportsTokenUri: boolean;
        } | null;
      };
    };
    expect(openApi.status).toBe(200);
    expect(document.security).toEqual([]);
    expect(Object.keys(document.paths).sort()).toEqual([
      "/api/account",
      "/api/image/{tokenId}",
      "/api/market",
      "/api/marketplace/readiness",
      "/api/metadata/{tokenId}",
      "/api/name/{label}",
      "/api/registration/preflight",
      "/api/registration/prepare",
      "/api/registration/readiness",
      "/api/reverse/{address}",
    ]);

    for (const path of ["/api/metadata/{tokenId}", "/api/image/{tokenId}"]) {
      expect(document.paths[path]?.get?.parameters).toEqual([
        { $ref: "#/components/parameters/TokenId" },
        { $ref: "#/components/parameters/NftLabelHint" },
      ]);
      expect(Object.keys(document.paths[path]?.get?.responses ?? {}).sort())
        .toEqual(["200", "400", "404", "503"]);
    }
    expect(document.paths["/api/account"]?.get?.parameters).toEqual([
      { $ref: "#/components/parameters/Owner" },
      { $ref: "#/components/parameters/Fresh" },
    ]);
    expect(document.paths["/api/market"]?.get?.parameters).toEqual([
      { $ref: "#/components/parameters/Fresh" },
    ]);
    expect(Object.keys(document.paths["/api/registration/preflight"]?.post?.responses ?? {}).sort())
      .toEqual(["200", "400", "409", "413", "503"]);
    expect(Object.keys(document.paths["/api/registration/prepare"]?.post?.responses ?? {}).sort())
      .toEqual(["200", "400", "402", "409", "413", "503"]);
    expect(document.paths["/api/account"]?.get?.responses).toMatchObject({
      "200": {
        content: {
          "application/json": { schema: { $ref: "#/components/schemas/AccountSnapshot" } },
        },
      },
    });
    expect(document.paths["/api/registration/prepare"]?.post?.responses).toMatchObject({
      "200": {
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/RegistrationPrepareResponse" },
          },
        },
      },
    });
    expect(document.components.schemas.ErrorEnvelope).toEqual({
      oneOf: [
        { $ref: "#/components/schemas/NestedErrorEnvelope" },
        { $ref: "#/components/schemas/FlatErrorEnvelope" },
      ],
    });
    expect(document.components.schemas.AccountSnapshot?.required).toEqual(expect.arrayContaining([
      "owner", "referralCredits", "sellerProceeds", "marketPaused", "names",
    ]));
    expect(document.components.schemas.RegistrationPrepareResponse?.required).toEqual([
      "registrationTransaction", "permitId", "validUntil", "permit", "signature",
    ]);
    expect(document.components.schemas.TokenIdString).toMatchObject({
      type: "string",
      format: "uint256-decimal",
      pattern: "^(0|[1-9][0-9]{0,77})$",
      maxLength: 78,
    });
    expect(document.components).toMatchObject({
      parameters: {
        NftLabelHint: {
          name: "label",
          in: "query",
          required: false,
          schema: { type: "string", minLength: 1, maxLength: 256 },
        },
      },
    });
    expect(document.components.schemas.NameNftMetadata).toMatchObject({
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
        background_color: { type: "string", const: "000B24" },
        attributes: { type: "array", minItems: 5, maxItems: 5, items: false },
        properties: {
          additionalProperties: false,
          required: [
            "chainId", "contract", "tokenId", "owner", "lifecycle", "asOfBlock",
          ],
        },
      },
    });
    const manifest = parseDeploymentManifest(await getManifestAlias().json());
    const supportsMetadata =
      registrarVersionOf(manifest) === "v2" && manifest.nftMetadata !== null &&
      manifest.nftMetadata !== undefined;
    expect(document["x-contour-nft-metadata"]).toMatchObject({
      classification: supportsMetadata ? "canonical-token-uri" : "application-companion",
      liveRegistrarVersion: registrarVersionOf(manifest).toUpperCase(),
      liveRegistrarSupportsErc721Metadata: supportsMetadata,
      liveRegistrarSupportsTokenUri: supportsMetadata,
      metadataBaseURI: manifest.nftMetadata?.metadataBaseURI ?? null,
      metadataPath: "/api/metadata/{tokenId}",
      imagePath: "/api/image/{tokenId}",
      retainedLegacyRegistrar: manifest.legacyReleases?.length === 1
        ? {
            registrarVersion: "V1",
            supportsErc721Metadata: false,
            supportsTokenUri: false,
          }
        : null,
    });

    const additionalRoute = (path: string) =>
      document["x-contour-route-scope"].additionalRoutes.find((route) => route.path === path);
    expect(additionalRoute("/api/account/verify")).toMatchObject({
      classification: "application-internal",
      knownStatusCodes: [200, 202, 400, 409, 413, 429],
    });
    expect(additionalRoute("/api/registration/verify")?.knownStatusCodes).toContain(503);
    expect(additionalRoute("/api/registration/challenge")?.classification).toBe("compatibility");

    const llms = getLlms();
    expect(llms.headers.get("content-type")).toContain("text/plain");
    const llmsText = await llms.text();
    expect(llmsText).toContain("https://docs.arc.io/mcp");
    expect(llmsText).toContain("GET /api/metadata/{tokenId}");
    expect(llmsText).toContain("GET /api/image/{tokenId}");
    expect(llmsText).toContain(
      supportsMetadata
        ? "canonical V2 registrar implements ERC-721 Metadata and tokenURI"
        : "canonical V1 registrar does not implement ERC-721 Metadata or tokenURI",
    );
    for (const toolName of [
      "prepare_market_token_approval",
      "prepare_market_token_approval_revoke",
      "prepare_market_usdc_approval",
      "prepare_market_cancel",
      "prepare_claim_proceeds",
      "prepare_claim_referral",
      "prepare_transfer",
      "prepare_market_invalidate",
    ]) {
      expect(llmsText).toContain(toolName);
    }
  });

  it("reports canonical V2 tokenURI support while isolating retained V1 limitations", async () => {
    const current = parseDeploymentManifest(
      await getManifestAlias().json(),
    );
    const v2 = {
      ...current,
      registrarVersion: "v2",
      nftMetadata: { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI },
      legacyReleases: [{}],
    } as unknown as DeploymentManifest;
    expect(nftMetadataDisclosure(v2)).toMatchObject({
      registrarVersion: "v2",
      canonicalSupportsMetadata: true,
      retainedV1: true,
      canonicalStatement: expect.stringContaining("implements ERC-721 Metadata"),
      retainedStatement: expect.stringContaining(
        "retained V1 registrar does not implement ERC-721 Metadata",
      ),
    });
  });

  it("keeps flat HTTP errors and strict registration inputs aligned with OpenAPI", async () => {
    const wallet = "0x78de409a6306550882328E2a67160471368387FF";
    const jsonRequest = (path: string, body: Record<string, unknown>) => new NextRequest(
      `http://localhost:3002${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const account = await getAccount(new NextRequest("http://localhost:3002/api/account?owner=nope"));
    expect(account.status).toBe(400);
    await expect(account.json()).resolves.toEqual({ error: "A valid owner address is required." });

    const normalizationConflict = await postRegistrationPreflight(jsonRequest(
      "/api/registration/preflight",
      {
        rawLabel: "Atlas",
        normalizationAccepted: false,
        durationYears: 1,
        payer: wallet,
      },
    ));
    expect(normalizationConflict.status).toBe(409);
    await expect(normalizationConflict.json()).resolves.toMatchObject({
      code: "NORMALIZATION_ACCEPTANCE_REQUIRED",
      normalizedLabel: "atlas",
    });

    const stringDuration = {
      rawLabel: "atlas",
      normalizationAccepted: true,
      durationYears: "1",
      requester: wallet,
      payer: wallet,
      recipient: wallet,
      requestId: "openapi-contract-test",
    };
    const preflightStringDuration = await postRegistrationPreflight(jsonRequest(
      "/api/registration/preflight",
      {
        rawLabel: stringDuration.rawLabel,
        normalizationAccepted: stringDuration.normalizationAccepted,
        durationYears: stringDuration.durationYears,
        payer: wallet,
      },
    ));
    expect(preflightStringDuration.status).toBe(400);

    const prepareStringDuration = await postRegistrationPrepare(jsonRequest(
      "/api/registration/prepare",
      stringDuration,
    ));
    expect(prepareStringDuration.status).toBe(400);

    const challengeStringDuration = await postRegistrationChallenge(jsonRequest(
      "/api/registration/challenge",
      {
        ...stringDuration,
        authorizedExecutor: wallet,
        resolverDataHash: resolverDataHash([]),
        referrer: "0x0000000000000000000000000000000000000000",
      },
    ));
    expect(challengeStringDuration.status).toBe(400);

    const oversizedBody = { padding: "x".repeat(17_000) };
    const oversizedPreflight = await postRegistrationPreflight(jsonRequest(
      "/api/registration/preflight",
      oversizedBody,
    ));
    expect(oversizedPreflight.status).toBe(413);
    const oversizedPrepare = await postRegistrationPrepare(jsonRequest(
      "/api/registration/prepare",
      oversizedBody,
    ));
    expect(oversizedPrepare.status).toBe(413);
  });

  it("serves a stateless hosted MCP over Streamable HTTP", async () => {
    const headers = {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-06-18",
    };
    const initialize = await postMcp(new Request("http://localhost:3002/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0.0" },
        },
      }),
    }));
    expect(initialize.status).toBe(200);
    await expect(initialize.json()).resolves.toMatchObject({
      result: { serverInfo: { name: "contour-name-protocol", version: "1.0.0" } },
    });

    const tools = await postMcp(new Request("http://localhost:3002/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }));
    const toolsBody = await tools.json() as {
      result: {
        tools: Array<{
          name: string;
          inputSchema: Record<string, unknown>;
          outputSchema?: Record<string, unknown>;
        }>;
      };
    };
    expect(tools.status).toBe(200);
    const expectedToolNames = [
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
    ];
    expect(toolsBody.result.tools.map(({ name }) => name)).toEqual(expectedToolNames);

    const tool = (name: string) => {
      const found = toolsBody.result.tools.find((candidate) => candidate.name === name);
      expect(found, `${name} must be registered`).toBeDefined();
      return found!;
    };
    expect(tool("reverse_lookup").inputSchema).toMatchObject({
      properties: { account: { pattern: "^0x[0-9a-fA-F]{40}$" } },
    });
    expect(tool("get_account_names").inputSchema).toMatchObject({
      properties: { account: { pattern: "^0x[0-9a-fA-F]{40}$" } },
    });
    expect(tool("prepare_registration_request").inputSchema).toMatchObject({
      properties: {
        account: { pattern: "^0x[0-9a-fA-F]{40}$" },
        requestId: { pattern: "^[A-Za-z0-9._:-]{8,128}$" },
      },
    });
    expect(tool("prepare_permit_request").inputSchema).toEqual(
      tool("prepare_registration_request").inputSchema,
    );
    expect(tool("prepare_permit_request").outputSchema).toEqual(
      tool("prepare_registration_request").outputSchema,
    );
    for (const name of [
      "prepare_market_token_approval",
      "prepare_market_token_approval_revoke",
      "prepare_market_listing",
      "prepare_market_buy",
      "prepare_market_cancel",
      "prepare_market_invalidate",
    ]) {
      expect(tool(name).inputSchema).toMatchObject({
        properties: { tokenId: { pattern: "^(0|[1-9][0-9]*)$" } },
      });
    }
    expect(tool("prepare_transfer").inputSchema).toMatchObject({
      required: expect.arrayContaining(["from", "to", "tokenId"]),
      properties: {
        from: { pattern: "^0x[0-9a-fA-F]{40}$" },
        to: { pattern: "^0x[0-9a-fA-F]{40}$" },
        tokenId: { pattern: "^(0|[1-9][0-9]*)$" },
      },
    });
    expect(toolsBody.result.tools
      .filter(({ outputSchema }) => outputSchema)
      .map(({ name }) => name)).toEqual([
      "normalize_label",
      "get_name",
      "reverse_lookup",
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
    ]);

    const planCalls = [
      ["prepare_market_token_approval", { tokenId: "7" }, "approval"],
      ["prepare_market_token_approval_revoke", { tokenId: "7" }, "approval"],
      ["prepare_market_usdc_approval", { amountBaseUnits: "1000000" }, "approval"],
      ["prepare_market_cancel", { tokenId: "7" }, "market"],
      ["prepare_claim_proceeds", {}, "market"],
      ["prepare_claim_referral", {}, "market"],
      [
        "prepare_transfer",
        {
          from: "0x1111111111111111111111111111111111111111",
          to: "0x2222222222222222222222222222222222222222",
          tokenId: "7",
        },
        "transfer",
      ],
      ["prepare_market_invalidate", { tokenId: "7" }, "market"],
    ] as const;
    for (const [name, arguments_, kind] of planCalls) {
      const call = await postMcp(new Request("http://localhost:3002/api/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: `plan-${name}`,
          method: "tools/call",
          params: { name, arguments: arguments_ },
        }),
      }));
      expect(call.status).toBe(200);
      await expect(call.json()).resolves.toMatchObject({
        result: {
          structuredContent: {
            kind,
            chainId: 5_042_002,
            to: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
            data: expect.stringMatching(/^0x[0-9a-fA-F]+$/),
            value: "0",
            description: expect.any(String),
          },
        },
      });
    }

    const invalidUint = await postMcp(new Request("http://localhost:3002/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "invalid-uint",
        method: "tools/call",
        params: {
          name: "prepare_market_invalidate",
          arguments: { tokenId: (1n << 256n).toString() },
        },
      }),
    }));
    expect(invalidUint.status).toBe(200);
    await expect(invalidUint.json()).resolves.toMatchObject({
      result: { isError: true },
    });

    const info = getMcpInfo(new Request("http://localhost:3002/api/mcp"));
    await expect(info.json()).resolves.toMatchObject({
      transport: "streamable-http",
      resource: "contour://runtime",
      tools: expectedToolNames,
    });
    expect(deleteMcp().status).toBe(405);

    const preflight = optionsMcp();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("*");

    const oversized = await postMcp(new Request("http://localhost:3002/api/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ padding: "x".repeat(256 * 1024) }),
    }));
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({
      error: { code: -32_001, message: "MCP request body is too large." },
    });
  });

  it("rejects invalid path inputs before any Arc RPC call", async () => {
    const name = await getName(new Request("http://localhost/api/name/bad.name"), {
      params: Promise.resolve({ label: "bad.name" }),
    });
    expect(name.status).toBe(400);
    await expect(name.json()).resolves.toMatchObject({ error: { code: "FULL_NAME_NOT_ALLOWED" } });

    const reverse = await getReverse(new Request("http://localhost/api/reverse/nope"), {
      params: Promise.resolve({ address: "nope" }),
    });
    expect(reverse.status).toBe(400);
    await expect(reverse.json()).resolves.toMatchObject({ error: { code: "INVALID_ADDRESS" } });
  });
});
