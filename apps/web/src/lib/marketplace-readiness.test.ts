import { beforeEach, describe, expect, it, vi } from "vitest";
import { getAddress, keccak256, zeroAddress } from "viem";
import type { DeploymentManifest } from "@contour/config";
import deploymentManifest from "../../../../deployments/5042002.json";

const mocks = vi.hoisted(() => ({
  createPublicClient: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/network", () => ({
  arcTestnet: { id: 5_042_002 },
}));
vi.mock("viem", async () => {
  const actual = await vi.importActual<typeof import("viem")>("viem");
  return { ...actual, createPublicClient: mocks.createPublicClient };
});

const runtimeCode = "0x60006000" as const;

function activeManifest(): DeploymentManifest {
  const manifest = structuredClone(deploymentManifest) as unknown as DeploymentManifest;
  manifest.state = "active";
  manifest.activationEvidence.productLive = false;
  manifest.activationEvidence.verifiedAtBlock = 52_190_647;
  manifest.activationEvidence.marketplacePolicy.paused = false;
  manifest.contracts.marketplace.runtimeCodeHash = keccak256(runtimeCode);
  return manifest;
}

function installClient(
  manifest: DeploymentManifest,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const observations: Record<string, unknown> = {
    registrar: manifest.contracts.baseRegistrar.address,
    settlementAsset: manifest.settlement.erc20Address,
    owner: manifest.activationEvidence.governance.account,
    pendingOwner: zeroAddress,
    treasury: manifest.activationEvidence.governance.account,
    feeBps: BigInt(manifest.activationEvidence.marketplacePolicy.feeBps ?? 0),
    paused: false,
    ...overrides,
  };
  const client = {
    getChainId: vi.fn(async (): Promise<number> => manifest.chain.id),
    getBlockNumber: vi.fn(async () => 52_200_000n),
    getCode: vi.fn(async () => runtimeCode),
    readContract: vi.fn(async ({
      functionName,
    }: {
      functionName: string;
      blockNumber: bigint;
    }) => {
      if (!(functionName in observations)) throw new Error("unexpected contract read");
      return observations[functionName];
    }),
  };
  mocks.createPublicClient.mockReturnValue(client);
  return client;
}

beforeEach(() => {
  mocks.createPublicClient.mockReset();
});

describe("marketplace readiness", () => {
  it("opens only when the confirmed Arc marketplace matches every pinned policy", async () => {
    const manifest = activeManifest();
    const client = installClient(manifest);
    const { readMarketplaceReadiness } = await import("./marketplace-readiness");

    await expect(readMarketplaceReadiness(manifest)).resolves.toEqual({
      ready: true,
      reasons: [],
      releaseId: manifest.releaseId,
      chainId: manifest.chain.id,
      marketplace: getAddress(manifest.contracts.marketplace.address!),
      asOfBlock: "52200000",
      paused: false,
      feeBps: 250,
    });
    expect(client.readContract).toHaveBeenCalledTimes(7);
    expect(
      client.readContract.mock.calls.every(
        ([request]) => request.blockNumber === 52_200_000n,
      ),
    ).toBe(true);
  });

  it("reports a live pause and other policy mismatches without claiming readiness", async () => {
    const manifest = activeManifest();
    installClient(manifest, {
      paused: true,
      feeBps: 300n,
      pendingOwner: "0x1111111111111111111111111111111111111111",
    });
    const { readMarketplaceReadiness } = await import("./marketplace-readiness");

    await expect(readMarketplaceReadiness(manifest)).resolves.toMatchObject({
      ready: false,
      paused: true,
      feeBps: 300,
      reasons: [
        "MARKETPLACE_PENDING_OWNER",
        "MARKETPLACE_FEE_POLICY_MISMATCH",
        "MARKETPLACE_PAUSED",
      ],
    });
  });

  it("fails before contract reads when the RPC is not Arc Testnet", async () => {
    const manifest = activeManifest();
    const client = installClient(manifest);
    client.getChainId.mockResolvedValue(1);
    const { readMarketplaceReadiness } = await import("./marketplace-readiness");

    await expect(readMarketplaceReadiness(manifest)).resolves.toMatchObject({
      ready: false,
      chainId: 1,
      reasons: ["ARC_CHAIN_MISMATCH"],
    });
    expect(client.getBlockNumber).not.toHaveBeenCalled();
    expect(client.readContract).not.toHaveBeenCalled();
  });

  it("sanitizes RPC failures and never returns provider error text", async () => {
    const manifest = activeManifest();
    const client = installClient(manifest);
    client.getCode.mockRejectedValue(
      new Error("PRIVATE_KEY=0xsecret candidate password=secret"),
    );
    const { readMarketplaceReadiness } = await import("./marketplace-readiness");

    const result = await readMarketplaceReadiness(manifest);
    expect(result).toMatchObject({
      ready: false,
      reasons: ["ARC_RPC_UNAVAILABLE"],
      asOfBlock: null,
    });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_KEY|password|0xsecret/);
  });

  it("does not contact Arc for an inactive or statically paused manifest", async () => {
    const manifest = activeManifest();
    const { readMarketplaceReadiness } = await import("./marketplace-readiness");

    manifest.state = "configured";
    await expect(readMarketplaceReadiness(manifest)).resolves.toMatchObject({
      ready: false,
      reasons: ["MANIFEST_NOT_ACTIVE"],
    });
    manifest.state = "active";
    manifest.activationEvidence.marketplacePolicy.paused = true;
    await expect(readMarketplaceReadiness(manifest)).resolves.toMatchObject({
      ready: false,
      reasons: ["MANIFEST_POLICY_NOT_OPEN"],
    });
    expect(mocks.createPublicClient).not.toHaveBeenCalled();
  });
});
