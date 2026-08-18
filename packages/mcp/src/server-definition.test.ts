import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeFunctionData, getAddress, zeroAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import legacyDeployment from "../../../deployments/5042002.legacy.json" with { type: "json" };
import {
  CANONICAL_NFT_METADATA_BASE_URI,
  parseDeploymentManifest,
  type DeploymentManifest,
} from "@contour/config";
import { baseRegistrarAbi, controllerAbi, erc20Abi, marketplaceAbi } from "@contour/sdk";
import { createContourStdioServer, stdioToolNames } from "./server-definition.js";

function unusedReader() {
  return {
    async name() {
      throw new Error("not used by this test");
    },
    async reverse() {
      throw new Error("not used by this test");
    },
  };
}

function v2ReleaseManifests(marketPaused = false): {
  canonical: DeploymentManifest;
  legacy: DeploymentManifest;
} {
  const legacyInput = structuredClone(legacyDeployment) as any;
  legacyInput.releaseId = `0x${"11".repeat(32)}`;
  legacyInput.registrarVersion = "v1";
  delete legacyInput.nftMetadata;
  delete legacyInput.legacyReleases;
  legacyInput.activationEvidence.productLive = false;
  legacyInput.activationEvidence.controllerPolicy.registrationsPaused = true;
  legacyInput.activationEvidence.marketplacePolicy.paused = false;
  const legacy = parseDeploymentManifest(legacyInput);

  const canonicalInput = structuredClone(legacyDeployment) as any;
  canonicalInput.releaseId = `0x${"22".repeat(32)}`;
  canonicalInput.registrarVersion = "v2";
  canonicalInput.nftMetadata = { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI };
  canonicalInput.activationEvidence.productLive = false;
  canonicalInput.activationEvidence.controllerPolicy.registrationsPaused = false;
  canonicalInput.activationEvidence.marketplacePolicy.paused = marketPaused;
  canonicalInput.permitIssuer.url = "https://names.example.com/api/registration/issuer/";
  let addressIndex = 0xa1;
  for (const contract of Object.values(canonicalInput.contracts) as any[]) {
    contract.address = `0x${addressIndex.toString(16).padStart(40, "0")}`;
    contract.sourceVerificationUrl =
      `https://testnet.arcscan.app/api/v2/smart-contracts/${contract.address}`;
    addressIndex += 1;
  }
  canonicalInput.legacyReleases = [{
    registrarVersion: "v1",
    releaseId: legacy.releaseId,
    verifiedAtBlock: legacy.activationEvidence.verifiedAtBlock,
    contracts: Object.fromEntries(
      Object.entries(legacy.contracts).map(([key, contract]) => [
        key,
        {
          address: contract.address,
          deploymentBlock: contract.deploymentBlock,
          runtimeCodeHash: contract.runtimeCodeHash,
        },
      ]),
    ),
    controllerPolicy: { registrationsPaused: true },
    marketplacePolicy: { paused: false },
  }];
  return { canonical: parseDeploymentManifest(canonicalInput), legacy };
}

function dualReleaseManifests(): {
  canonical: DeploymentManifest;
  legacy: DeploymentManifest;
} {
  return v2ReleaseManifests();
}

describe("stdio MCP tool contract", () => {
  it("fails closed when a canonical V2 legacy reference is not loaded", () => {
    const { canonical } = dualReleaseManifests();
    expect(() => createContourStdioServer({
      canonical: { manifest: canonical, client: unusedReader() },
    })).toThrow(/load every canonical legacy release/);
  });

  it("publishes the complete, versioned stdio contract", async () => {
    const { canonical: manifest, legacy } = v2ReleaseManifests();
    const releaseId = manifest.releaseId!;
    const server = createContourStdioServer({
      canonical: { manifest, client: unusedReader() },
      legacy: [{ manifest: legacy, client: unusedReader() }],
    });
    const client = new Client({ name: "contract-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      expect(client.getServerVersion()).toEqual({
        name: "contour-name-protocol-stdio",
        version: "2.0.0",
      });

      const { resources } = await client.listResources();
      expect(resources).toEqual([
        expect.objectContaining({
          name: "deployment-manifest",
          uri: "contour://manifest",
          mimeType: "application/json",
        }),
      ]);
      const manifestResource = await client.readResource({ uri: "contour://manifest" });
      const manifestContent = manifestResource.contents[0];
      expect(manifestContent).toMatchObject({
        uri: "contour://manifest",
        mimeType: "application/json",
      });
      if (!manifestContent || !("text" in manifestContent)) {
        throw new Error("manifest resource must contain JSON text");
      }
      expect(JSON.parse(manifestContent.text)).toMatchObject({
        canonicalReleaseId: releaseId,
        releases: [
          { role: "canonical", manifest },
          { role: "legacy", manifest: legacy },
        ],
      });

      const { tools } = await client.listTools();
      expect(tools.map(({ name }) => name)).toEqual([...stdioToolNames]);
      expect(tools.map(({ name }) => name)).not.toContain("prepare_permit_request");

      const tool = (name: (typeof stdioToolNames)[number]) => {
        const found = tools.find((candidate) => candidate.name === name);
        expect(found, `${name} must be registered`).toBeDefined();
        return found!;
      };

      expect(tool("reverse_lookup").inputSchema).toMatchObject({
        required: expect.arrayContaining(["releaseId", "account"]),
        properties: {
          releaseId: { pattern: "^0x[0-9a-fA-F]{64}$" },
          account: { pattern: "^0x[0-9a-fA-F]{40}$" },
        },
      });
      expect(tool("prepare_issuer_request").inputSchema).toMatchObject({
        required: expect.arrayContaining([
          "releaseId",
          "rawLabel",
          "normalizationAccepted",
          "requester",
          "recipient",
          "durationYears",
          "resolverDataHash",
          "requestId",
        ]),
        properties: {
          releaseId: { pattern: "^0x[0-9a-fA-F]{64}$" },
          requester: { pattern: "^0x[0-9a-fA-F]{40}$" },
          recipient: { pattern: "^0x[0-9a-fA-F]{40}$" },
          referrer: { pattern: "^0x[0-9a-fA-F]{40}$" },
          requestId: { pattern: "^[A-Za-z0-9._:-]{8,128}$" },
        },
      });
      for (const name of [
        "prepare_market_token_approval",
        "prepare_market_token_approval_revoke",
        "prepare_market_listing",
        "prepare_market_buy",
        "prepare_market_cancel",
        "prepare_market_invalidate",
      ] as const) {
        expect(tool(name).inputSchema).toMatchObject({
          required: expect.arrayContaining(["releaseId", "tokenId"]),
          properties: {
            releaseId: { pattern: "^0x[0-9a-fA-F]{64}$" },
            tokenId: { pattern: "^(0|[1-9][0-9]*)$" },
          },
        });
      }
      expect(tool("prepare_transfer").inputSchema).toMatchObject({
        required: expect.arrayContaining(["releaseId", "from", "to", "tokenId"]),
        properties: {
          from: { pattern: "^0x[0-9a-fA-F]{40}$" },
          to: { pattern: "^0x[0-9a-fA-F]{40}$" },
          tokenId: { pattern: "^(0|[1-9][0-9]*)$" },
        },
      });

      expect(tools.filter(({ outputSchema }) => outputSchema).map(({ name }) => name)).toEqual([
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
      ]);
      expect(tool("prepare_issuer_request").outputSchema).toMatchObject({
        type: "object",
        required: ["releaseId", "challenge", "permit", "warning"],
        properties: {
          releaseId: { type: "string" },
          challenge: { type: "object" },
          permit: { type: "object" },
          warning: { type: "string" },
        },
      });

      const normalized = await client.callTool({
        name: "normalize_label",
        arguments: { rawLabel: "Alice" },
      });
      expect(normalized.isError).not.toBe(true);
      expect(normalized.structuredContent).toMatchObject({
        normalized: "alice",
        changed: true,
      });

      const issuerRequest = await client.callTool({
        name: "prepare_issuer_request",
        arguments: {
          releaseId,
          rawLabel: "alice",
          normalizationAccepted: true,
          requester: "0x1111111111111111111111111111111111111111",
          recipient: "0x2222222222222222222222222222222222222222",
          durationYears: 2,
          resolverDataHash: `0x${"00".repeat(32)}`,
          requestId: "request-0001",
        },
      });
      expect(issuerRequest.isError).not.toBe(true);
      expect(issuerRequest.structuredContent).toMatchObject({
        releaseId,
        challenge: {
          method: "POST",
          url: "https://names.example.com/api/registration/issuer/v1/challenges",
          body: { requestId: "request-0001" },
        },
        permit: {
          method: "POST",
          url: "https://names.example.com/api/registration/issuer/v1/permits",
          bodyAfterChallengeSignature: { challengeSignature: null },
        },
        warning: expect.any(String),
      });

      const unknownRelease = await client.callTool({
        name: "prepare_market_cancel",
        arguments: {
          releaseId: `0x${"55".repeat(32)}`,
          tokenId: "7",
        },
      });
      expect(unknownRelease.isError).toBe(true);
      expect(unknownRelease.content).toEqual([
        expect.objectContaining({ text: expect.stringContaining("unknown releaseId") }),
      ]);

      const implicitRelease = await client.callTool({
        name: "prepare_market_cancel",
        arguments: { tokenId: "7" },
      });
      expect(implicitRelease.isError).toBe(true);

      const planCalls = [
        ["prepare_approval", { releaseId, amountBaseUnits: "1000000" }, "approval"],
        ["prepare_market_token_approval", { releaseId, tokenId: "7" }, "approval"],
        ["prepare_market_token_approval_revoke", { releaseId, tokenId: "7" }, "approval"],
        ["prepare_market_usdc_approval", { releaseId, amountBaseUnits: "1000000" }, "approval"],
        ["prepare_market_cancel", { releaseId, tokenId: "7" }, "market"],
        ["prepare_claim_proceeds", { releaseId }, "market"],
        ["prepare_claim_referral", { releaseId }, "market"],
        [
          "prepare_transfer",
          {
            releaseId,
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            tokenId: "7",
          },
          "transfer",
        ],
        ["prepare_market_invalidate", { releaseId, tokenId: "7" }, "market"],
      ] as const;
      const returnedPlans = new Map<string, {
        kind: string;
        chainId: number;
        releaseId: Hex;
        to: Address;
        data: Hex;
        value: string;
        description: string;
      }>();
      for (const [name, arguments_, kind] of planCalls) {
        const result = await client.callTool({ name, arguments: arguments_ });
        expect(
          result.isError,
          `${name} must return an unsigned plan: ${JSON.stringify(result)}`,
        ).not.toBe(true);
        expect(result.structuredContent).toMatchObject({
          kind,
          chainId: 5_042_002,
          releaseId,
          to: expect.stringMatching(/^0x[0-9a-fA-F]{40}$/),
          data: expect.stringMatching(/^0x[0-9a-fA-F]+$/),
          value: "0",
          description: expect.any(String),
        });
        returnedPlans.set(name, result.structuredContent as {
          kind: string;
          chainId: number;
          releaseId: Hex;
          to: Address;
          data: Hex;
          value: string;
          description: string;
        });
      }

      const decodePlan = <TAbi extends readonly unknown[]>(name: string, abi: TAbi) => {
        const plan = returnedPlans.get(name);
        expect(plan, `${name} plan must be captured`).toBeDefined();
        return {
          plan: plan!,
          decoded: decodeFunctionData({ abi, data: plan!.data }),
        };
      };
      const controller = getAddress(manifest.contracts.controller.address!);
      const registrar = getAddress(manifest.contracts.baseRegistrar.address!);
      const market = getAddress(manifest.contracts.marketplace.address!);

      const registrationApproval = decodePlan("prepare_approval", erc20Abi);
      expect(getAddress(registrationApproval.plan.to)).toBe(
        getAddress(manifest.settlement.erc20Address),
      );
      expect(registrationApproval.decoded).toMatchObject({
        functionName: "approve",
        args: [controller, 1_000_000n],
      });

      const tokenApproval = decodePlan("prepare_market_token_approval", baseRegistrarAbi);
      expect(getAddress(tokenApproval.plan.to)).toBe(registrar);
      expect(tokenApproval.decoded).toMatchObject({
        functionName: "approve",
        args: [market, 7n],
      });

      const tokenRevoke = decodePlan(
        "prepare_market_token_approval_revoke",
        baseRegistrarAbi,
      );
      expect(getAddress(tokenRevoke.plan.to)).toBe(registrar);
      expect(tokenRevoke.decoded).toMatchObject({
        functionName: "approve",
        args: [zeroAddress, 7n],
      });

      const marketApproval = decodePlan("prepare_market_usdc_approval", erc20Abi);
      expect(getAddress(marketApproval.plan.to)).toBe(
        getAddress(manifest.settlement.erc20Address),
      );
      expect(marketApproval.decoded).toMatchObject({
        functionName: "approve",
        args: [market, 1_000_000n],
      });

      expect(decodePlan("prepare_market_cancel", marketplaceAbi).decoded).toMatchObject({
        functionName: "cancel",
        args: [7n],
      });
      expect(decodePlan("prepare_claim_proceeds", marketplaceAbi).decoded).toMatchObject({
        functionName: "claimProceeds",
      });
      expect(decodePlan("prepare_claim_referral", controllerAbi).decoded).toMatchObject({
        functionName: "claimReferral",
      });
      expect(decodePlan("prepare_transfer", baseRegistrarAbi).decoded).toMatchObject({
        functionName: "safeTransferFrom",
        args: [
          "0x1111111111111111111111111111111111111111",
          "0x2222222222222222222222222222222222222222",
          7n,
        ],
      });
      expect(decodePlan("prepare_market_invalidate", marketplaceAbi).decoded).toMatchObject({
        functionName: "invalidateListing",
        args: [7n],
      });

      const oversizedToken = await client.callTool({
        name: "prepare_market_cancel",
        arguments: { releaseId, tokenId: (1n << 256n).toString() },
      });
      expect(oversizedToken.isError).toBe(true);

      const malformedToken = await client.callTool({
        name: "prepare_market_cancel",
        arguments: { releaseId, tokenId: "not-a-number" },
      });
      expect(malformedToken.isError).toBe(true);

      const zeroMarketApproval = await client.callTool({
        name: "prepare_market_usdc_approval",
        arguments: { releaseId, amountBaseUnits: "0" },
      });
      expect(zeroMarketApproval.isError).toBe(true);

      const zeroTransferRecipient = await client.callTool({
        name: "prepare_transfer",
        arguments: {
          releaseId,
          from: "0x1111111111111111111111111111111111111111",
          to: "0x0000000000000000000000000000000000000000",
          tokenId: "7",
        },
      });
      expect(zeroTransferRecipient.isError).toBe(true);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("keeps escape plans available and blocks new market exposure while paused", async () => {
    const { canonical: manifest, legacy } = v2ReleaseManifests(true);
    const releaseId = manifest.releaseId!;
    const server = createContourStdioServer({
      canonical: { manifest, client: unusedReader() },
      legacy: [{ manifest: legacy, client: unusedReader() }],
    });
    const client = new Client({ name: "paused-market-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const escapeCalls = [
        ["prepare_market_token_approval_revoke", { releaseId, tokenId: "7" }],
        ["prepare_market_cancel", { releaseId, tokenId: "7" }],
        ["prepare_claim_proceeds", { releaseId }],
        ["prepare_claim_referral", { releaseId }],
        [
          "prepare_transfer",
          {
            releaseId,
            from: "0x1111111111111111111111111111111111111111",
            to: "0x2222222222222222222222222222222222222222",
            tokenId: "7",
          },
        ],
        ["prepare_market_invalidate", { releaseId, tokenId: "7" }],
      ] as const;
      for (const [name, arguments_] of escapeCalls) {
        const result = await client.callTool({ name, arguments: arguments_ });
        expect(
          result.isError,
          `${name} must remain plannable while paused: ${JSON.stringify(result)}`,
        ).not.toBe(true);
      }

      const blockedCalls = [
        ["prepare_market_token_approval", { releaseId, tokenId: "7" }],
        ["prepare_market_usdc_approval", { releaseId, amountBaseUnits: "1000000" }],
        [
          "prepare_market_listing",
          { releaseId, tokenId: "7", priceBaseUnits: "1000000", validUntil: "9999999999" },
        ],
        [
          "prepare_market_buy",
          { releaseId, tokenId: "7", expectedPriceBaseUnits: "1000000", expectedFeeBps: 250 },
        ],
      ] as const;
      for (const [name, arguments_] of blockedCalls) {
        const result = await client.callTool({ name, arguments: arguments_ });
        expect(result.isError, `${name} must fail closed while paused`).toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("routes legacy reads and plans only by explicit releaseId", async () => {
    const { canonical, legacy } = dualReleaseManifests();
    const canonicalReverse = {
      releaseId: canonical.releaseId!,
      name: "canonical.contour",
      forwardConfirmed: true,
    };
    const legacyReverse = {
      releaseId: legacy.releaseId!,
      name: "legacy.contour",
      forwardConfirmed: true,
    };
    const server = createContourStdioServer({
      canonical: {
        manifest: canonical,
        client: {
          async name() { throw new Error("not used"); },
          async reverse() { return canonicalReverse; },
        },
      },
      legacy: [{
        manifest: legacy,
        client: {
          async name() { throw new Error("not used"); },
          async reverse() { return legacyReverse; },
        },
      }],
    });
    const client = new Client({ name: "dual-release-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    try {
      const reverse = await client.callTool({
        name: "reverse_lookup",
        arguments: {
          releaseId: legacy.releaseId,
          account: "0x1111111111111111111111111111111111111111",
        },
      });
      expect(reverse.isError).not.toBe(true);
      expect(reverse.structuredContent).toEqual(legacyReverse);

      const cancel = await client.callTool({
        name: "prepare_market_cancel",
        arguments: { releaseId: legacy.releaseId, tokenId: "7" },
      });
      expect(cancel.isError).not.toBe(true);
      expect(cancel.structuredContent).toMatchObject({
        releaseId: legacy.releaseId,
        to: legacy.contracts.marketplace.address,
      });

      const legacyRegistration = await client.callTool({
        name: "prepare_issuer_request",
        arguments: {
          releaseId: legacy.releaseId,
          rawLabel: "alice",
          normalizationAccepted: true,
          requester: "0x1111111111111111111111111111111111111111",
          recipient: "0x2222222222222222222222222222222222222222",
          durationYears: 1,
          resolverDataHash: `0x${"00".repeat(32)}`,
          requestId: "request-legacy",
        },
      });
      expect(legacyRegistration.isError).toBe(true);
      expect(legacyRegistration.content).toEqual([
        expect.objectContaining({
          text: expect.stringContaining("canonical releaseId"),
        }),
      ]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
