import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeAbiParameters,
  encodeEventTopics,
  parseAbiItem,
  zeroAddress,
  type Address,
} from "viem";
import type { DeploymentManifest } from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";
import deploymentManifest from "../../../../deployments/5042002.json";

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
);
const NAME_REGISTERED_EVENT = parseAbiItem(
  "event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)",
);

const mocks = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
  getDeploymentManifest: vi.fn(),
}));

vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, createPublicClient: mocks.createPublicClient };
});

vi.mock("./manifest", () => ({
  getDeploymentManifest: mocks.getDeploymentManifest,
  getReadableReleaseManifests: () => [mocks.getDeploymentManifest()],
  getReadableReleaseManifest: (releaseId: string) => {
    const manifest = mocks.getDeploymentManifest();
    return manifest.releaseId?.toLowerCase() === releaseId.toLowerCase()
      ? manifest
      : null;
  },
  readableReleaseKey: () => "canonical",
  protocolCapabilities: { reads: true, marketReads: true, marketplace: false },
}));

vi.mock("./network", () => ({
  arcTestnet: { id: 5_042_002, name: "Arc Testnet" },
}));

function configuredFixture(): DeploymentManifest {
  const fixture = structuredClone(deploymentManifest) as unknown as DeploymentManifest;
  fixture.state = "configured";
  fixture.contracts.controller.deploymentBlock = 1;
  fixture.contracts.marketplace.deploymentBlock = 1;
  fixture.contracts.baseRegistrar.deploymentBlock = 1;
  return fixture;
}

function installClient(head: bigint) {
  const getLogs = vi.fn(async () => {
    throw new Error("market discovery must not use eth_getLogs");
  });
  const client = {
    getChainId: vi.fn(async () => deploymentManifest.chain.id),
    getBlockNumber: vi.fn(async () => head),
    getBlock: vi.fn(async () => ({ timestamp: 1_700_000_000n })),
    getLogs,
    readContract: vi.fn(async ({ functionName }: { functionName: string }): Promise<unknown> => {
      if (functionName === "feeBps") return 250n;
      if (functionName === "paused") return false;
      if (functionName === "referralCredits" || functionName === "proceeds") return 0n;
      throw new Error(`unexpected readContract call: ${functionName}`);
    }),
  };
  mocks.createPublicClient.mockReturnValue(client);
  return { client, getLogs };
}

function explorerResponse(result: unknown[]) {
  return new Response(JSON.stringify({
    status: result.length > 0 ? "1" : "0",
    message: result.length > 0 ? "OK" : "No logs found",
    result,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
  mocks.createPublicClient.mockReset();
  mocks.getDeploymentManifest.mockReset();
  mocks.getDeploymentManifest.mockReturnValue(configuredFixture());
  vi.stubGlobal("fetch", vi.fn(async () => explorerResponse([])));
});

describe("ArcScan event discovery with current RPC verification", () => {
  it(
    "uses a matching normalized label hint without waiting for ArcScan indexing",
    async () => {
      const owner = "0x1111111111111111111111111111111111111111" as Address;
      const identity = deriveNameIdentity("alice", deploymentManifest.namespace.suffix);
      const expiry = 1_800_000_000n;
      const { client, getLogs } = installClient(40_005n);
      vi.mocked(client.readContract).mockImplementation(
        async ({ functionName }: { functionName: string }) => {
          if (functionName === "ownerOf") return owner;
          if (functionName === "nameExpires") return expiry;
          if (functionName === "isActive") return true;
          if (functionName === "inGracePeriod") return false;
          throw new Error(`unexpected readContract call: ${functionName}`);
        },
      );
      const { readNftSnapshot } = await import("./protocol-read-model");

      await expect(readNftSnapshot(identity.tokenId, "alice")).resolves.toMatchObject({
        label: "alice",
        name: "alice.contour",
        owner,
        expiry: expiry.toString(),
        lifecycle: "active",
        asOfBlock: "40005",
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(getLogs).not.toHaveBeenCalled();
      expect(client.getBlock).toHaveBeenCalledWith({ blockNumber: 40_005n });
      for (const functionName of [
        "ownerOf",
        "nameExpires",
        "isActive",
        "inGracePeriod",
      ]) {
        expect(client.readContract).toHaveBeenCalledWith(
          expect.objectContaining({
            functionName,
            args: [identity.tokenId],
            blockNumber: 40_005n,
          }),
        );
      }
    },
    15_000,
  );

  it("rejects changed or token-mismatched label hints before any network read", async () => {
    const alice = deriveNameIdentity("alice", deploymentManifest.namespace.suffix);
    installClient(40_005n);
    const { readNftSnapshot } = await import("./protocol-read-model");

    await expect(readNftSnapshot(alice.tokenId, "bob")).rejects.toThrow(
      "hash matches the token ID",
    );
    await expect(readNftSnapshot(alice.tokenId, " Alice ")).rejects.toThrow(
      "hash matches the token ID",
    );

    expect(mocks.createPublicClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not retain a null hinted snapshot in the 30-second cache", async () => {
    const identity = deriveNameIdentity("alice", deploymentManifest.namespace.suffix);
    const { client } = installClient(40_005n);
    vi.mocked(client.readContract).mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === "ownerOf") throw new Error("TokenDoesNotExist");
        if (functionName === "nameExpires") return 0n;
        if (functionName === "isActive" || functionName === "inGracePeriod") {
          return false;
        }
        throw new Error(`unexpected readContract call: ${functionName}`);
      },
    );
    const { readNftSnapshot } = await import("./protocol-read-model");

    await expect(readNftSnapshot(identity.tokenId, "alice")).resolves.toBeNull();
    await expect(readNftSnapshot(identity.tokenId, "alice")).resolves.toBeNull();

    expect(fetch).not.toHaveBeenCalled();
    expect(client.getBlock).toHaveBeenCalledTimes(2);
    for (const functionName of [
      "ownerOf",
      "nameExpires",
      "isActive",
      "inGracePeriod",
    ]) {
      expect(
        vi.mocked(client.readContract).mock.calls.filter(
          ([request]) =>
            (request as { functionName?: string }).functionName === functionName,
        ),
      ).toHaveLength(2);
    }
  });

  it("pins NFT discovery, block metadata, and all registrar reads to one confirmed block", async () => {
    const owner = "0x1111111111111111111111111111111111111111" as Address;
    const identity = deriveNameIdentity("alice", deploymentManifest.namespace.suffix);
    const expiry = 1_800_000_000n;
    const { client, getLogs } = installClient(40_005n);
    vi.mocked(client.readContract).mockImplementation(
      async ({ functionName }: { functionName: string }) => {
        if (functionName === "ownerOf") return owner;
        if (functionName === "nameExpires") return expiry;
        if (functionName === "isActive") return true;
        if (functionName === "inGracePeriod") return false;
        throw new Error(`unexpected readContract call: ${functionName}`);
      },
    );
    vi.stubGlobal("fetch", vi.fn(async () =>
      explorerResponse([{
        blockNumber: "40005",
        topics: encodeEventTopics({
          abi: [NAME_REGISTERED_EVENT],
          eventName: "NameRegistered",
          args: { label: identity.labelhash, owner },
        }),
        data: encodeAbiParameters(
          [
            { type: "string" },
            { type: "uint256" },
            { type: "uint256" },
            { type: "uint256" },
          ],
          ["alice", 0n, 0n, expiry],
        ),
      }]),
    ));
    const { readNftSnapshot } = await import("./protocol-read-model");

    await expect(readNftSnapshot(identity.tokenId)).resolves.toMatchObject({
      label: "alice",
      name: "alice.contour",
      owner,
      expiry: expiry.toString(),
      lifecycle: "active",
      asOfBlock: "40005",
      asOfTimestamp: "1700000000",
    });

    expect(getLogs).not.toHaveBeenCalled();
    expect(client.getBlock).toHaveBeenCalledWith({ blockNumber: 40_005n });
    expect(fetch).toHaveBeenCalledTimes(1);
    const endpoint = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
    expect(endpoint.searchParams.get("toBlock")).toBe("40005");
    expect(endpoint.searchParams.get("topic1")).toBe(
      `0x${identity.tokenId.toString(16).padStart(64, "0")}`,
    );
    expect(endpoint.searchParams.get("topic0_1_opr")).toBe("and");
    for (const functionName of [
      "ownerOf",
      "nameExpires",
      "isActive",
      "inGracePeriod",
    ]) {
      expect(client.readContract).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName,
          args: [identity.tokenId],
          blockNumber: 40_005n,
        }),
      );
    }
  });

  it(
    "discovers the complete marketplace range without eth_getLogs",
    async () => {
      const { getLogs } = installClient(250_001n);
      const { readMarketSnapshot } = await import("./protocol-read-model");

      await expect(readMarketSnapshot()).resolves.toMatchObject({
        asOfBlock: "250001",
        listings: [],
      });

      expect(getLogs).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledTimes(1);
      const endpoint = new URL(String(vi.mocked(fetch).mock.calls[0]?.[0]));
      expect(endpoint.origin).toBe(deploymentManifest.chain.explorerUrl);
      expect(endpoint.searchParams.get("module")).toBe("logs");
      expect(endpoint.searchParams.get("action")).toBe("getLogs");
      expect(endpoint.searchParams.get("fromBlock")).toBe("1");
      expect(endpoint.searchParams.get("toBlock")).toBe("250001");
      expect(endpoint.searchParams.get("address")).toBe(
        deploymentManifest.contracts.marketplace.address,
      );
    },
    // This test intentionally reloads the full viem/config/SDK graph. Under the
    // monorepo's parallel verification load, that cold import can exceed
    // Vitest's 5 s default; a timeout leaves its async work running and pollutes
    // the following global-fetch assertion.
    15_000,
  );

  it("shares one in-flight explorer snapshot across concurrent callers", async () => {
    installClient(35_000n);
    vi.stubGlobal("fetch", vi.fn(async () => {
      await Promise.resolve();
      return explorerResponse([]);
    }));
    const { readMarketSnapshot } = await import("./protocol-read-model");

    const [left, right] = await Promise.all([
      readMarketSnapshot(),
      readMarketSnapshot(),
    ]);

    expect(left).toEqual(right);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fails closed at the explorer public result bound", async () => {
    installClient(40_000n);
    vi.stubGlobal("fetch", vi.fn(async () =>
      explorerResponse(Array.from({ length: 1_000 }, () => ({}))),
    ));
    const { readMarketSnapshot } = await import("./protocol-read-model");

    await expect(readMarketSnapshot()).rejects.toThrow(
      "ArcScan event discovery reached its public result bound",
    );
  });

  it("discovers two account histories with indexed ArcScan reads and one cached RPC head", async () => {
    const { client, getLogs } = installClient(40_000n);
    const first = "0x1111111111111111111111111111111111111111" as Address;
    const second = "0x2222222222222222222222222222222222222222" as Address;
    const { readAccountSnapshot } = await import("./protocol-read-model");

    const [left, right] = await Promise.all([
      readAccountSnapshot(first),
      readAccountSnapshot(second),
    ]);

    expect(left.names).toEqual([]);
    expect(right.names).toEqual([]);
    expect(getLogs).not.toHaveBeenCalled();
    expect(client.getChainId).toHaveBeenCalledTimes(1);
    expect(client.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(3);
    const transferQueries = vi.mocked(fetch).mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.searchParams.get("address") === deploymentManifest.contracts.baseRegistrar.address);
    expect(transferQueries).toHaveLength(2);
    expect(transferQueries.map((url) => url.searchParams.get("topic2"))).toEqual([
      `0x${first.slice(2).padStart(64, "0")}`,
      `0x${second.slice(2).padStart(64, "0")}`,
    ]);
    expect(transferQueries.every((url) => url.searchParams.get("topic0_2_opr") === "and")).toBe(true);
  });

  it("verifies one discovered account token in one state-read wave without duplicate listing reads", async () => {
    const owner = "0x1111111111111111111111111111111111111111" as Address;
    const identity = deriveNameIdentity("alice", deploymentManifest.namespace.suffix);
    const expiry = 1_800_000_000n;
    const { client, getLogs } = installClient(40_000n);
    vi.mocked(client.readContract).mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === "feeBps") return 250n;
      if (functionName === "paused") return false;
      if (functionName === "referralCredits" || functionName === "proceeds") return 0n;
      if (functionName === "ownerOf") return owner;
      if (functionName === "nameExpires") return expiry;
      if (functionName === "isActive") return true;
      if (functionName === "inGracePeriod") return false;
      if (functionName === "listingOf") return [zeroAddress, 0n, 0n] as const;
      throw new Error(`unexpected readContract call: ${functionName}`);
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.searchParams.get("address") === deploymentManifest.contracts.controller.address) {
        return explorerResponse([{
          blockNumber: "100",
          topics: encodeEventTopics({
            abi: [NAME_REGISTERED_EVENT],
            eventName: "NameRegistered",
            args: { label: identity.labelhash, owner },
          }),
          data: encodeAbiParameters(
            [
              { type: "string" },
              { type: "uint256" },
              { type: "uint256" },
              { type: "uint256" },
            ],
            ["alice", 0n, 0n, expiry],
          ),
        }]);
      }
      return explorerResponse([{
        blockNumber: "100",
        topics: encodeEventTopics({
          abi: [TRANSFER_EVENT],
          eventName: "Transfer",
          args: { from: zeroAddress, to: owner, tokenId: identity.tokenId },
        }),
        data: "0x",
      }]);
    }));
    const { readAccountSnapshot } = await import("./protocol-read-model");

    await expect(readAccountSnapshot(owner)).resolves.toMatchObject({
      names: [{ label: "alice", lifecycle: "active", listing: null }],
    });
    expect(getLogs).not.toHaveBeenCalled();
    for (const functionName of ["ownerOf", "nameExpires", "isActive", "inGracePeriod", "listingOf"]) {
      expect(client.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName }));
      expect(vi.mocked(client.readContract).mock.calls.filter(([request]) =>
        (request as { functionName?: string }).functionName === functionName,
      )).toHaveLength(1);
    }
  });
});
