import { describe, expect, it, vi } from "vitest";
import { zeroAddress, type Address, type PublicClient } from "viem";
import deployment from "../../../deployments/5042002.json" with { type: "json" };
import { EXPECTED_RESOLVER_CAPABILITIES, parseDeploymentManifest } from "@contour/config";
import { ArcNameClient } from "./client.js";

function activeManifest() {
  const value = structuredClone(deployment) as any;
  value.state = "active";
  value.releaseId = `0x${"99".repeat(32)}`;
  value.resolverCapabilities = { ...EXPECTED_RESOLVER_CAPABILITIES };
  let index = 1;
  for (const contract of Object.values(value.contracts) as any[]) {
    contract.address = `0x${index.toString(16).padStart(40, "0")}`;
    contract.deploymentBlock = 100 + index;
    contract.transactionHash = `0x${index.toString(16).padStart(64, "0")}`;
    contract.runtimeCodeHash = `0x${(index + 10).toString(16).padStart(64, "0")}`;
    contract.abiUrl = `https://example.com/contract-${index}.json`;
    contract.abiSha256 = `0x${(index + 20).toString(16).padStart(64, "0")}`;
    contract.sourceVerified = true;
    contract.sourceVerificationUrl = `https://testnet.arcscan.app/api/v2/smart-contracts/${contract.address}`;
    contract.sourceVerificationSha256 = `0x${(index + 30).toString(16).padStart(64, "0")}`;
    index += 1;
  }
  value.activationEvidence.productLive = true;
  value.activationEvidence.verifiedAtBlock = 200;
  let artifactIndex = 40;
  for (const [key, artifact] of Object.entries(value.activationEvidence.artifacts) as Array<[string, any]>) {
    artifact.url = `https://example.com/evidence/${key}.json`;
    artifact.sha256 = `0x${artifactIndex.toString(16).padStart(64, "0")}`;
    artifactIndex += 1;
  }
  value.activationEvidence.governance = {
    account: "0xd100000000000000000000000000000000000001",
  };
  value.activationEvidence.controllerPolicy = {
    permitSigner: "0xd100000000000000000000000000000000000001",
    signerPolicyVersion: "1",
    referralBps: 500,
    registrationsPaused: false,
  };
  value.activationEvidence.marketplacePolicy = { feeBps: 250, paused: false };
  value.permitIssuer = {
    url: "https://issuer.example.com",
    signerAddress: "0xd100000000000000000000000000000000000001",
    publicKey: null,
    policyVersion: "1",
    active: true,
  };
  return parseDeploymentManifest(value);
}

function configuredManifest() {
  const value = structuredClone(activeManifest()) as any;
  value.state = "configured";
  value.activationEvidence.productLive = false;
  value.permitIssuer.active = false;
  value.x402.active = false;
  return parseDeploymentManifest(value);
}

function multicallFrom(
  read: (request: { address: Address; functionName: string }) => Promise<unknown>,
) {
  return vi.fn(async ({ contracts }: { contracts: Array<{ address: Address; functionName: string }> }) =>
    Promise.all(contracts.map(async (contract) => {
      try {
        return { status: "success" as const, result: await read(contract) };
      } catch (error) {
        return { status: "failure" as const, error, result: undefined };
      }
    })),
  );
}

describe("ArcNameClient live chain identity", () => {
  it("fails closed before a contract read when RPC is not Arc Testnet", async () => {
    const readContract = vi.fn();
    const client = new ArcNameClient({
      getChainId: vi.fn(async () => 1),
      readContract,
    } as unknown as PublicClient, activeManifest());

    await expect(client.quote("alice", 1n)).rejects.toThrow(/expected 5042002, received 1/);
    expect(readContract).not.toHaveBeenCalled();
  });

  it("caches a successful assertion for the immutable client transport", async () => {
    const getChainId = vi.fn(async () => 5_042_002);
    const readContract = vi.fn(async () => 1n);
    const client = new ArcNameClient({ getChainId, readContract } as unknown as PublicClient, activeManifest());

    await client.quote("alice", 1n);
    await client.allowance("0x1111111111111111111111111111111111111111");
    expect(getChainId).toHaveBeenCalledTimes(1);
    expect(readContract).toHaveBeenCalledTimes(2);
  });

  it("reads source-verified contracts from a configured deployment", async () => {
    const readContract = vi.fn(async () => 1n);
    const manifest = configuredManifest();
    const client = new ArcNameClient({
      getChainId: vi.fn(async () => 5_042_002),
      readContract,
    } as unknown as PublicClient, manifest);

    await expect(client.quote("alice", 1n)).resolves.toBe(1n);
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({
      address: manifest.contracts.controller.address,
      functionName: "quote",
    }));
  });

  it("rejects reads from a configured deployment without source verification", async () => {
    const value = structuredClone(configuredManifest()) as any;
    value.contracts.controller.sourceVerified = false;
    const manifest = parseDeploymentManifest(value);
    const readContract = vi.fn();
    const client = new ArcNameClient({
      getChainId: vi.fn(async () => 5_042_002),
      readContract,
    } as unknown as PublicClient, manifest);

    await expect(client.quote("alice", 1n)).rejects.toThrow(/source-verified deployment/);
    expect(readContract).not.toHaveBeenCalled();
  });

  it("reads the canonical name record in one atomic multicall", async () => {
    const manifest = activeManifest();
    const owner = "0x1111111111111111111111111111111111111111" as Address;
    const registrant = "0x2222222222222222222222222222222222222222" as Address;
    const read = vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "owner": return owner;
        case "resolver": return manifest.contracts.publicResolver.address;
        case "available": return false;
        case "nameExpires": return 1_800_000_000n;
        case "ownerOf": return registrant;
        case "addr": return registrant;
        case "contenthash": return "0x1234";
        default: throw new Error(`unexpected function ${functionName}`);
      }
    });
    const multicall = multicallFrom(read);
    const readContract = vi.fn();
    const client = new ArcNameClient({
      getChainId: vi.fn(async () => 5_042_002),
      multicall,
      readContract,
    } as unknown as PublicClient, manifest);

    await expect(client.name("alice")).resolves.toMatchObject({
      releaseId: manifest.releaseId,
      registryOwner: owner,
      registrant,
      resolvedAddress: registrant,
      contentHash: "0x1234",
      available: false,
    });
    expect(multicall).toHaveBeenCalledTimes(1);
    expect(readContract).not.toHaveBeenCalled();
  });

  it("pins canonical name and reverse reads to an explicit Arc block", async () => {
    const manifest = activeManifest();
    const blockNumber = 123_456n;
    const read = vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "owner": return "0x1111111111111111111111111111111111111111";
        case "resolver": return zeroAddress;
        case "available": return true;
        case "nameExpires": return 0n;
        case "ownerOf": throw new Error("token is available");
        case "addr": return zeroAddress;
        case "contenthash": return "0x";
        case "quote": return 500_000n;
        case "getCurrentBlockTimestamp": return 1_800_000_001n;
        default: throw new Error(`unexpected function ${functionName}`);
      }
    });
    const multicall = multicallFrom(read);
    const readContract = vi.fn(async () => "alice.contour");
    const client = new ArcNameClient({
      getChainId: vi.fn(async () => 5_042_002),
      multicall,
      readContract,
    } as unknown as PublicClient, manifest);

    await expect(client.name("alice", { blockNumber })).resolves.toMatchObject({
      releaseId: manifest.releaseId,
      name: "alice.contour",
    });
    await expect(client.nameWithQuote("alice", 1n, { blockNumber })).resolves.toMatchObject({
      releaseId: manifest.releaseId,
      record: { releaseId: manifest.releaseId, name: "alice.contour" },
      quote: 500_000n,
      blockTimestamp: 1_800_000_001n,
    });
    await expect(client.reverse(
      "0x1111111111111111111111111111111111111111",
      { blockNumber },
    )).resolves.toEqual({
      releaseId: manifest.releaseId,
      name: "alice.contour",
      forwardConfirmed: true,
    });
    expect(multicall).toHaveBeenCalledTimes(2);
    expect(multicall).toHaveBeenNthCalledWith(1, expect.objectContaining({ blockNumber }));
    expect(multicall).toHaveBeenNthCalledWith(2, expect.objectContaining({ blockNumber }));
    expect(readContract).toHaveBeenCalledWith(expect.objectContaining({ blockNumber }));
  });

  it("reads the name, quote, and Arc timestamp in one atomic multicall", async () => {
    const manifest = activeManifest();
    const owner = "0x1111111111111111111111111111111111111111" as Address;
    const read = vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "owner": return owner;
        case "resolver": return zeroAddress;
        case "available": return true;
        case "nameExpires": return 0n;
        case "ownerOf": throw new Error("token is available");
        case "addr": return zeroAddress;
        case "contenthash": return "0x";
        case "quote": return 500_000n;
        case "getCurrentBlockTimestamp": return 1_800_000_001n;
        default: throw new Error(`unexpected function ${functionName}`);
      }
    });
    const multicall = multicallFrom(read);
    const client = new ArcNameClient({
      getChainId: vi.fn(async () => 5_042_002),
      multicall,
      readContract: vi.fn(),
    } as unknown as PublicClient, manifest);

    await expect(client.nameWithQuote("alice", 1n)).resolves.toMatchObject({
      record: { registryOwner: owner, available: true },
      quote: 500_000n,
      blockTimestamp: 1_800_000_001n,
    });
    expect(multicall).toHaveBeenCalledTimes(1);
  });

  it("keeps the name readable when an auxiliary quote call fails", async () => {
    const read = vi.fn(async ({ functionName }: { functionName: string }) => {
      switch (functionName) {
        case "owner": return "0x1111111111111111111111111111111111111111";
        case "resolver": return zeroAddress;
        case "available": return true;
        case "nameExpires": return 0n;
        case "ownerOf": throw new Error("token is available");
        case "addr": return zeroAddress;
        case "contenthash": return "0x";
        case "quote": throw new Error("temporary quote failure");
        case "getCurrentBlockTimestamp": return 1_800_000_001n;
        default: throw new Error(`unexpected function ${functionName}`);
      }
    });
    const client = new ArcNameClient({
      getChainId: vi.fn(async () => 5_042_002),
      multicall: multicallFrom(read),
      readContract: vi.fn(),
    } as unknown as PublicClient, activeManifest());

    await expect(client.nameWithQuote("alice", 1n)).resolves.toMatchObject({
      record: { available: true },
      quote: null,
      blockTimestamp: 1_800_000_001n,
    });
  });

  it("keeps partial records readable when a custom resolver lacks one interface", async () => {
    const customResolver = "0x9999999999999999999999999999999999999999" as Address;
    const read = vi.fn(async (request: { functionName: string }) => {
      switch (request.functionName) {
        case "owner": return "0x1111111111111111111111111111111111111111";
        case "resolver": return customResolver;
        case "available": return true;
        case "nameExpires": return 0n;
        case "addr": return zeroAddress;
        case "contenthash": throw new Error("unsupported selector");
        default: throw new Error(`unexpected function ${request.functionName}`);
      }
    });
    const readContract = vi.fn(read);
    const client = new ArcNameClient({
      getChainId: vi.fn(async () => 5_042_002),
      multicall: multicallFrom(read),
      readContract,
    } as unknown as PublicClient, activeManifest());

    const record = await client.name("alice");
    expect(record.resolver).toBe(customResolver);
    expect(record.resolvedAddress).toBeNull();
    expect(record.contentHash).toBeNull();
  });
});
