import { describe, expect, it } from "vitest";
import {
  CONTRACT_KEYS,
  registrarVersionOf,
  type DeploymentManifest,
  type LegacyReleaseReference,
} from "@contour/config";
import deploymentManifest from "../../../../deployments/5042002.json";
import legacyDeploymentManifest from "../../../../deployments/5042002.legacy.json";
import {
  deriveExecutionCapabilities,
  deriveMarketplaceEscapeCapability,
  deriveReadCapabilities,
  legacyManifestMatchesReference,
  protocolCapabilities,
  selectReadableReleaseManifests,
} from "./manifest";

function retainedReference(
  legacy: DeploymentManifest,
): LegacyReleaseReference {
  if (legacy.releaseId === null) throw new Error("fixture release ID missing");
  if (legacy.activationEvidence.verifiedAtBlock === null) {
    throw new Error("fixture verification block missing");
  }
  return {
    registrarVersion: "v1",
    releaseId: legacy.releaseId,
    verifiedAtBlock: legacy.activationEvidence.verifiedAtBlock,
    contracts: Object.fromEntries(
      CONTRACT_KEYS.map((key) => {
        const contract = legacy.contracts[key];
        if (
          contract.address === null ||
          contract.deploymentBlock === null ||
          contract.runtimeCodeHash === null
        ) {
          throw new Error(`fixture ${key} identity missing`);
        }
        return [
          key,
          {
            address: contract.address,
            deploymentBlock: contract.deploymentBlock,
            runtimeCodeHash: contract.runtimeCodeHash,
          },
        ];
      }),
    ) as LegacyReleaseReference["contracts"],
    controllerPolicy: { registrationsPaused: true },
    marketplacePolicy: { paused: false },
  };
}

describe("read capabilities", () => {
  it("keeps the retained V1 artifact semantically bound across the cutover", () => {
    const canonical =
      deploymentManifest as unknown as DeploymentManifest;
    const legacy =
      legacyDeploymentManifest as unknown as DeploymentManifest;
    expect(registrarVersionOf(legacy)).toBe("v1");
    if (registrarVersionOf(canonical) === "v2") {
      expect(canonical.legacyReleases).toHaveLength(1);
      expect(
        legacyManifestMatchesReference(
          legacy,
          canonical.legacyReleases![0]!,
        ),
      ).toBe(true);
      return;
    }
    expect(canonical.releaseId).toBe(legacy.releaseId);
    for (const key of CONTRACT_KEYS) {
      expect(canonical.contracts[key].address).toBe(
        legacy.contracts[key].address,
      );
      expect(canonical.contracts[key].deploymentBlock).toBe(
        legacy.contracts[key].deploymentBlock,
      );
      expect(canonical.contracts[key].runtimeCodeHash).toBe(
        legacy.contracts[key].runtimeCodeHash,
      );
    }
  });

  it("adds retained V1 only when canonical V2 binds its exact immutable identity", () => {
    const legacy = structuredClone(
      legacyDeploymentManifest,
    ) as unknown as DeploymentManifest;
    expect(selectReadableReleaseManifests(legacy, legacy)).toEqual([legacy]);

    const canonical = structuredClone(legacy) as DeploymentManifest;
    legacy.activationEvidence.controllerPolicy.registrationsPaused = true;
    canonical.registrarVersion = "v2";
    canonical.releaseId = `0x${"cd".repeat(32)}`;
    canonical.nftMetadata = {
      metadataBaseURI: "https://contour-arc.vercel.app/api/metadata/",
    };
    canonical.legacyReleases = [retainedReference(legacy)];

    expect(legacyManifestMatchesReference(
      legacy,
      canonical.legacyReleases[0]!,
    )).toBe(true);
    expect(selectReadableReleaseManifests(canonical, legacy)).toEqual([
      canonical,
      legacy,
    ]);
  });

  it("fails closed when a retained artifact is absent or differs from the V2 trust root", () => {
    const legacy = structuredClone(
      legacyDeploymentManifest,
    ) as unknown as DeploymentManifest;
    legacy.activationEvidence.controllerPolicy.registrationsPaused = true;
    const canonical = structuredClone(legacy) as DeploymentManifest;
    canonical.registrarVersion = "v2";
    canonical.releaseId = `0x${"cd".repeat(32)}`;
    canonical.nftMetadata = {
      metadataBaseURI: "https://contour-arc.vercel.app/api/metadata/",
    };
    canonical.legacyReleases = [retainedReference(legacy)];

    expect(() => selectReadableReleaseManifests(canonical, null)).toThrow(
      /retained V1 manifest/i,
    );
    const tampered = structuredClone(legacy);
    tampered.contracts.marketplace.runtimeCodeHash = `0x${"ef".repeat(32)}`;
    expect(() =>
      selectReadableReleaseManifests(canonical, tampered)
    ).toThrow(/does not match/i);
    const reopened = structuredClone(legacy);
    reopened.activationEvidence.controllerPolicy.registrationsPaused = false;
    expect(() =>
      selectReadableReleaseManifests(canonical, reopened)
    ).toThrow(/does not match/i);
  });

  it("publishes the configured source-verified repository deployment as readable", () => {
    expect(protocolCapabilities).toMatchObject({
      configured: true,
      sourceVerified: true,
      reads: true,
      marketReads: true,
      productLive: false,
      registration: true,
      marketplace: true,
      marketplaceEscape: true,
    });
  });

  it("opens configured reads only when every deployed contract is source verified", () => {
    const configured = structuredClone(deploymentManifest) as unknown as DeploymentManifest;
    expect(deriveReadCapabilities(configured)).toEqual({
      configured: true,
      sourceVerified: true,
      reads: true,
      marketReads: true,
    });

    configured.contracts.controller.sourceVerified = false;
    expect(deriveReadCapabilities(configured)).toEqual({
      configured: true,
      sourceVerified: false,
      reads: false,
      marketReads: false,
    });
  });

  it("keeps reads closed without a parsed non-draft manifest", () => {
    expect(deriveReadCapabilities(null)).toEqual({
      configured: false,
      sourceVerified: false,
      reads: false,
      marketReads: false,
    });
  });
});

describe("staged execution capabilities", () => {
  const marketplaceAddress = "0x1111111111111111111111111111111111111111";

  it("keeps both actions closed during the initial paused candidate bootstrap", () => {
    expect(deriveExecutionCapabilities({
      active: true,
      issuerActive: true,
      registrationsPaused: true,
      marketplaceAddress,
      marketplacePaused: true,
    })).toEqual({ registration: false, marketplace: false });
  });

  it("opens registration on an active release before the separately controlled marketplace", () => {
    expect(deriveExecutionCapabilities({
      active: true,
      issuerActive: true,
      registrationsPaused: false,
      marketplaceAddress,
      marketplacePaused: true,
    })).toEqual({ registration: true, marketplace: false });
  });

  it("keeps execution closed for a non-active manifest even when both policies are unpaused", () => {
    expect(deriveExecutionCapabilities({
      active: false,
      issuerActive: true,
      registrationsPaused: false,
      marketplaceAddress,
      marketplacePaused: false,
    })).toEqual({ registration: false, marketplace: false });
  });

  it("keeps marketplace escape actions independent of the pause policy", () => {
    expect(deriveMarketplaceEscapeCapability({
      active: true,
      marketplaceAddress,
    })).toBe(true);
    expect(deriveMarketplaceEscapeCapability({
      active: false,
      marketplaceAddress,
    })).toBe(false);
    expect(deriveMarketplaceEscapeCapability({
      active: true,
      marketplaceAddress: null,
    })).toBe(false);
  });
});
