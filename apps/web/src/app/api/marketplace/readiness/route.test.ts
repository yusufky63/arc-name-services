import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  marketplaceEnabled: { value: true },
  getDeploymentManifest: vi.fn(),
  readMarketplaceReadiness: vi.fn(),
  unavailableMarketplaceReadiness: vi.fn(),
}));

vi.mock("@/lib/manifest", () => ({
  getDeploymentManifest: mocks.getDeploymentManifest,
  protocolCapabilities: {
    get marketplace() {
      return mocks.marketplaceEnabled.value;
    },
  },
}));

vi.mock("@/lib/marketplace-readiness", () => ({
  readMarketplaceReadiness: mocks.readMarketplaceReadiness,
  unavailableMarketplaceReadiness: mocks.unavailableMarketplaceReadiness,
}));

const manifest = { releaseId: "0xrelease" };
const ready = {
  ready: true,
  reasons: [],
  releaseId: "0xrelease",
  chainId: 5_042_002,
  marketplace: "0x1111111111111111111111111111111111111111",
  asOfBlock: "100",
  paused: false,
  feeBps: 250,
};
const closed = {
  ...ready,
  ready: false,
  reasons: ["MARKETPLACE_PAUSED"],
  paused: true,
};

beforeEach(() => {
  mocks.marketplaceEnabled.value = true;
  mocks.getDeploymentManifest.mockReset();
  mocks.getDeploymentManifest.mockReturnValue(manifest);
  mocks.readMarketplaceReadiness.mockReset();
  mocks.unavailableMarketplaceReadiness.mockReset();
  mocks.unavailableMarketplaceReadiness.mockImplementation(
    (_manifest, reason) => ({ ...closed, reasons: [reason] }),
  );
});

describe("GET /api/marketplace/readiness", () => {
  it("returns HTTP 200 only for a truth-based ready observation", async () => {
    mocks.readMarketplaceReadiness.mockResolvedValue(ready);
    const { GET } = await import("./route");

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBeNull();
    await expect(response.json()).resolves.toEqual(ready);
  });

  it("returns HTTP 503 and retry guidance when Arc reports the market paused", async () => {
    mocks.readMarketplaceReadiness.mockResolvedValue(closed);
    const { GET } = await import("./route");

    const response = await GET();
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("retry-after")).toBe("2");
    await expect(response.json()).resolves.toEqual(closed);
  });

  it("does not query Arc when the staged execution surface is disabled", async () => {
    mocks.marketplaceEnabled.value = false;
    const { GET } = await import("./route");

    const response = await GET();
    expect(response.status).toBe(503);
    expect(mocks.readMarketplaceReadiness).not.toHaveBeenCalled();
    expect(mocks.unavailableMarketplaceReadiness).toHaveBeenCalledWith(
      manifest,
      "EXECUTION_SURFACE_DISABLED",
    );
  });

  it("sanitizes unexpected configuration failures", async () => {
    mocks.getDeploymentManifest.mockImplementation(() => {
      throw new Error("PRIVATE_KEY=0xsecret");
    });
    const { GET } = await import("./route");

    const response = await GET();
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.reasons).toEqual(["READINESS_DEPENDENCY_UNAVAILABLE"]);
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_KEY|0xsecret/);
  });
});
