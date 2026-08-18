import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeploymentManifest } from "@contour/config";
import deploymentManifest from "../../../../deployments/5042002.json";

const mocks = vi.hoisted(() => ({
  releases: [] as DeploymentManifest[],
}));

vi.mock("server-only", () => ({}));
vi.mock("./manifest", () => ({
  getReadableReleaseManifests: () => mocks.releases,
}));

import { readRegistrationReleaseGate } from "./registration-release-gate";

function releasesFixture() {
  const canonical = structuredClone(
    deploymentManifest,
  ) as unknown as DeploymentManifest;
  canonical.releaseId = `0x${"aa".repeat(32)}`;
  const legacy = structuredClone(canonical);
  legacy.releaseId = `0x${"bb".repeat(32)}`;
  legacy.contracts.controller.address =
    "0x1111111111111111111111111111111111111111";
  legacy.contracts.baseRegistrar.address =
    "0x2222222222222222222222222222222222222222";
  return { canonical, legacy };
}

beforeEach(() => {
  mocks.releases = [];
});

describe("cross-release registration gate", () => {
  it("pins every release read and denies a name retained by V1", async () => {
    const { canonical, legacy } = releasesFixture();
    mocks.releases = [canonical, legacy];
    const readContract = vi.fn(async (input: {
      address: string;
      functionName: string;
      blockNumber?: bigint;
    }) => {
      if (input.functionName === "registrationsPaused") {
        return input.address.toLowerCase() ===
            legacy.contracts.controller.address?.toLowerCase();
      }
      if (input.functionName === "available") {
        return input.address.toLowerCase() !==
          legacy.contracts.baseRegistrar.address?.toLowerCase();
      }
      throw new Error("unexpected read");
    });
    const gate = await readRegistrationReleaseGate({
      canonical,
      tokenId: 123n,
      client: {
        getChainId: vi.fn(async () => canonical.chain.id),
        getBlockNumber: vi.fn(async () => 999n),
        readContract,
      } as never,
    });

    expect(gate.blockNumber).toBe(999n);
    expect(gate.availableEverywhere).toBe(false);
    expect(gate.retainedReleasesClosed).toBe(true);
    expect(readContract).toHaveBeenCalledTimes(4);
    expect(readContract.mock.calls.every(
      ([input]) => input.blockNumber === 999n,
    )).toBe(true);
  });

  it("keeps issuance closed while a retained controller is open", async () => {
    const { canonical, legacy } = releasesFixture();
    mocks.releases = [canonical, legacy];
    const gate = await readRegistrationReleaseGate({
      canonical,
      tokenId: 123n,
      client: {
        getChainId: vi.fn(async () => canonical.chain.id),
        getBlockNumber: vi.fn(async () => 999n),
        readContract: vi.fn(async ({ functionName }: {
          functionName: string;
        }) => functionName === "available"),
      } as never,
    });

    expect(gate.availableEverywhere).toBe(true);
    expect(gate.retainedReleasesClosed).toBe(false);
  });

  it("fails closed when any retained release read fails", async () => {
    const { canonical, legacy } = releasesFixture();
    mocks.releases = [canonical, legacy];
    await expect(readRegistrationReleaseGate({
      canonical,
      tokenId: 123n,
      client: {
        getChainId: vi.fn(async () => canonical.chain.id),
        getBlockNumber: vi.fn(async () => 999n),
        readContract: vi.fn(async () => {
          throw new Error("RPC unavailable");
        }),
      } as never,
    })).rejects.toThrow("RPC unavailable");
  });
});
