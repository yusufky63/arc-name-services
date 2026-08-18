import {
  CONTRACT_KEYS,
  assertDeploymentManifest,
  registrarVersionOf,
  type DeploymentManifest,
} from "@contour/config";
import type { ArcNameClient } from "@contour/sdk";
import { getAddress, type Hex } from "viem";

export type ContourNameReader = Pick<ArcNameClient, "name" | "reverse">;

export interface ContourReleaseBinding {
  manifest: DeploymentManifest;
  client: ContourNameReader;
}

export interface ContourReleaseSet {
  canonical: ContourReleaseBinding;
  legacy?: readonly ContourReleaseBinding[];
}

function releaseIdOf(manifest: DeploymentManifest): Hex {
  if (!manifest.releaseId) throw new Error("MCP release manifest has no releaseId");
  return manifest.releaseId;
}

function sameHex(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function assertLegacyBinding(
  canonical: DeploymentManifest,
  legacy: DeploymentManifest,
): void {
  if (registrarVersionOf(legacy) !== "v1") {
    throw new Error("MCP legacy release must use registrarVersion v1");
  }
  const releaseId = releaseIdOf(legacy);
  const reference = canonical.legacyReleases?.find((candidate) =>
    sameHex(candidate.releaseId, releaseId)
  );
  if (!reference) {
    throw new Error(`MCP legacy release ${releaseId} is not referenced by the canonical manifest`);
  }
  if (legacy.activationEvidence.verifiedAtBlock !== reference.verifiedAtBlock) {
    throw new Error(`MCP legacy release ${releaseId} verification block mismatch`);
  }
  if (
    legacy.activationEvidence.controllerPolicy.registrationsPaused !==
      reference.controllerPolicy.registrationsPaused ||
    legacy.activationEvidence.marketplacePolicy.paused !==
      reference.marketplacePolicy.paused
  ) {
    throw new Error(`MCP legacy release ${releaseId} policy mismatch`);
  }
  for (const key of CONTRACT_KEYS) {
    const actual = legacy.contracts[key];
    const expected = reference.contracts[key];
    if (
      !actual.address ||
      !actual.runtimeCodeHash ||
      getAddress(actual.address) !== getAddress(expected.address) ||
      actual.deploymentBlock !== expected.deploymentBlock ||
      !sameHex(actual.runtimeCodeHash, expected.runtimeCodeHash)
    ) {
      throw new Error(`MCP legacy release ${releaseId} ${key} binding mismatch`);
    }
  }
}

/**
 * Immutable, fail-closed release selector for the stdio MCP.
 *
 * Every read and unsigned mutation plan resolves through an explicit releaseId.
 * A canonical V2 manifest must provide one full, validated manifest/client
 * binding for every immutable legacy reference it publishes.
 */
export class ContourReleaseDirectory {
  readonly canonicalReleaseId: Hex;
  readonly bindings: readonly ContourReleaseBinding[];
  private readonly byReleaseId: ReadonlyMap<string, ContourReleaseBinding>;

  constructor(input: ContourReleaseSet) {
    assertDeploymentManifest(input.canonical.manifest);
    const canonicalReleaseId = releaseIdOf(input.canonical.manifest);
    const legacy = [...(input.legacy ?? [])];
    const bindings = [input.canonical, ...legacy];
    const byReleaseId = new Map<string, ContourReleaseBinding>();

    for (const binding of bindings) {
      assertDeploymentManifest(binding.manifest);
      const releaseId = releaseIdOf(binding.manifest);
      const key = releaseId.toLowerCase();
      if (byReleaseId.has(key)) {
        throw new Error(`MCP releaseId is duplicated: ${releaseId}`);
      }
      byReleaseId.set(key, binding);
    }

    if (registrarVersionOf(input.canonical.manifest) === "v2") {
      const referenced = input.canonical.manifest.legacyReleases ?? [];
      if (legacy.length !== referenced.length) {
        throw new Error("MCP must load every canonical legacy release manifest");
      }
      for (const binding of legacy) {
        assertLegacyBinding(input.canonical.manifest, binding.manifest);
      }
    } else if (legacy.length > 0) {
      throw new Error("MCP cannot attach legacy releases to a V1 canonical manifest");
    }

    this.canonicalReleaseId = canonicalReleaseId;
    this.bindings = Object.freeze(bindings);
    this.byReleaseId = byReleaseId;
  }

  resolve(releaseId: string): ContourReleaseBinding {
    const binding = this.byReleaseId.get(releaseId.toLowerCase());
    if (!binding) throw new Error(`unknown releaseId: ${releaseId}`);
    return binding;
  }

  resolveCanonicalV2(releaseId: string): ContourReleaseBinding {
    if (!sameHex(releaseId, this.canonicalReleaseId)) {
      throw new Error("new registration is available only on the canonical releaseId");
    }
    const binding = this.resolve(releaseId);
    if (registrarVersionOf(binding.manifest) !== "v2") {
      throw new Error("new registration is unavailable until the canonical V2 release is active");
    }
    return binding;
  }

  resourceDocument(): {
    canonicalReleaseId: Hex;
    releases: Array<{ role: "canonical" | "legacy"; manifest: DeploymentManifest }>;
  } {
    return {
      canonicalReleaseId: this.canonicalReleaseId,
      releases: this.bindings.map((binding, index) => ({
        role: index === 0 ? "canonical" : "legacy",
        manifest: binding.manifest,
      })),
    };
  }
}
