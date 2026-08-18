import { describe, expect, it } from "vitest";
import {
  CANONICAL_NFT_METADATA_BASE_URI,
  CONTRACT_KEYS,
  type DeploymentManifest,
  type LegacyReleaseReference,
} from "@contour/config";
import legacyDeploymentManifest from "../../../../../deployments/5042002.legacy.json";
import type { ReadableRelease } from "@/lib/manifest";
import {
  buildPublicReleaseStatus,
  unavailablePublicReleaseStatus,
} from "./release-status";

function retainedReference(
  legacy: DeploymentManifest,
): LegacyReleaseReference {
  if (
    legacy.releaseId === null ||
    legacy.activationEvidence.verifiedAtBlock === null
  ) {
    throw new Error("The retained fixture is incomplete.");
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
          throw new Error(`The retained ${key} fixture is incomplete.`);
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

function releaseFixtures(): {
  canonical: ReadableRelease;
  retained: ReadableRelease;
} {
  const legacy = structuredClone(
    legacyDeploymentManifest,
  ) as unknown as DeploymentManifest;
  const canonical = structuredClone(legacy);
  canonical.registrarVersion = "v2";
  canonical.releaseId = `0x${"cd".repeat(32)}`;
  canonical.nftMetadata = {
    metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI,
  };
  canonical.legacyReleases = [retainedReference(legacy)];
  canonical.activationEvidence.productLive = true;
  canonical.activationEvidence.controllerPolicy.registrationsPaused = false;
  canonical.activationEvidence.marketplacePolicy.paused = false;
  canonical.permitIssuer.active = true;

  return {
    canonical: {
      key: "canonical",
      canonical: true,
      manifest: canonical,
    },
    retained: {
      key: "legacy",
      canonical: false,
      manifest: legacy,
    },
  };
}

function statusValue(
  status: ReturnType<typeof buildPublicReleaseStatus>,
  id: string,
): string {
  const result = status.rows.find((row) => row.id === id);
  if (!result) throw new Error(`Missing status row ${id}.`);
  return result.value;
}

describe("dual-release public status", () => {
  it("reports canonical V2 and the exact retained V1 cutover as ready", () => {
    const { canonical, retained } = releaseFixtures();
    const status = buildPublicReleaseStatus([canonical, retained]);

    expect(status.ready).toBe(true);
    expect(statusValue(status, "canonical-identity")).toBe("PUBLIC LIVE");
    expect(statusValue(status, "canonical-registration")).toBe("OPEN");
    expect(statusValue(status, "canonical-marketplace")).toBe("OPEN");
    expect(statusValue(status, "canonical-metadata")).toBe("NATIVE");
    expect(statusValue(status, "retained-identity")).toBe("RETAINED");
    expect(statusValue(status, "retained-names")).toBe("AVAILABLE");
    expect(statusValue(status, "retained-marketplace")).toBe("AVAILABLE");
    expect(statusValue(status, "retained-registration")).toBe("PAUSED");
  });

  it("uses the V2-bound cutover policy instead of mutable legacy policy fields", () => {
    const { canonical, retained } = releaseFixtures();
    retained.manifest.activationEvidence.controllerPolicy.registrationsPaused =
      false;

    const status = buildPublicReleaseStatus([canonical, retained]);

    expect(status.ready).toBe(true);
    expect(statusValue(status, "retained-registration")).toBe("PAUSED");
  });

  it("fails closed until the canonical V2 release is product-live", () => {
    const { canonical, retained } = releaseFixtures();
    canonical.manifest.activationEvidence.productLive = false;

    const status = buildPublicReleaseStatus([canonical, retained]);

    expect(status.ready).toBe(false);
    expect(statusValue(status, "canonical-identity")).toBe("UNAVAILABLE");
    expect(statusValue(status, "canonical-registration")).toBe("UNAVAILABLE");
    expect(statusValue(status, "retained-names")).toBe("UNAVAILABLE");
  });

  it("fails closed when the retained V1 reference does not enforce the cutover", () => {
    const { canonical, retained } = releaseFixtures();
    const unsafeReference = canonical.manifest.legacyReleases![0]! as unknown as {
      controllerPolicy: { registrationsPaused: boolean };
    };
    unsafeReference.controllerPolicy.registrationsPaused = false;

    const status = buildPublicReleaseStatus([canonical, retained]);

    expect(status.ready).toBe(false);
    expect(statusValue(status, "retained-registration")).toBe("UNSAFE");
  });

  it("provides a minimal fail-closed fallback when manifest loading fails", () => {
    const status = unavailablePublicReleaseStatus();

    expect(status.ready).toBe(false);
    expect(status.rows.map((row) => row.id)).toEqual([
      "release-topology",
      "canonical-identity",
      "retained-identity",
    ]);
    expect(status.rows.every((row) => row.tone === "unavailable")).toBe(true);
  });
});
