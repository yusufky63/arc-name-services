import deploymentManifest from "../../../../deployments/5042002.json";
import legacyDeploymentManifest from "../../../../deployments/5042002.legacy.json";
import promotionAttestation from "../../../../deployments/5042002.promotion.json";
import {
  CONTRACT_KEYS,
  assertPromotionAttestation,
  parseDeploymentManifest,
  registrarVersionOf,
  type DeploymentManifest,
  type LegacyReleaseReference,
} from "@contour/config";
import { candidateReleaseEnvironmentPresent } from "../../release-runtime-boundary";

/**
 * Canonical public release manifest. This is deliberately imported from the
 * repository deployment artifact so browser configuration cannot activate a
 * different release through environment variables alone.
 */
let parsedManifest: DeploymentManifest | null = null;
let parsedLegacyManifest: DeploymentManifest | null = null;
let manifestValidationError: unknown = null;

try {
  const candidate = parseDeploymentManifest(deploymentManifest);
  const legacy = parseDeploymentManifest(legacyDeploymentManifest);
  const serverRuntime = typeof window === "undefined";
  const productLiveRequested =
    candidate.state === "active" && candidate.activationEvidence.productLive;
  const expectedLiveRelease = productLiveRequested
    ? `${candidate.releaseId}:${promotionAttestation.manifestSha256}:${promotionAttestation.verifiedAtBlock}`
    : null;
  if (serverRuntime && productLiveRequested && process.env.PRODUCT_LIVE_RELEASE !== expectedLiveRelease) {
    throw new Error("product-live manifest requires an exact release/digest/attestation opt-in");
  }
  if (
    serverRuntime &&
    productLiveRequested &&
    candidateReleaseEnvironmentPresent(process.env)
  ) {
    throw new Error(
      "private-candidate runtime and operator credentials must not enter the product-live runtime",
    );
  }
  assertPromotionAttestation(
    promotionAttestation,
    candidate,
    productLiveRequested,
  );
  parsedManifest = candidate;
  parsedLegacyManifest = legacy;
} catch (error) {
  parsedManifest = null;
  parsedLegacyManifest = null;
  manifestValidationError = error;
}

export function getDeploymentManifest(): DeploymentManifest {
  if (!parsedManifest) throw manifestValidationError ?? new Error("deployment manifest validation failed");
  return parsedManifest;
}

export type ReadableReleaseKey = "canonical" | "legacy";

export type ReadableRelease = Readonly<{
  key: ReadableReleaseKey;
  canonical: boolean;
  manifest: DeploymentManifest;
}>;

function manifestIsReadable(manifest: DeploymentManifest | null): manifest is DeploymentManifest {
  return manifest !== null &&
    manifest.releaseId !== null &&
    manifest.state !== "draft" &&
    CONTRACT_KEYS.every((key) => manifest.contracts[key].sourceVerified);
}

function releaseIdOf(manifest: DeploymentManifest): `0x${string}` {
  if (manifest.releaseId === null) {
    throw new Error("A readable release must publish a release ID.");
  }
  return manifest.releaseId;
}

export function legacyManifestMatchesReference(
  legacy: DeploymentManifest,
  reference: LegacyReleaseReference,
): boolean {
  if (
    registrarVersionOf(legacy) !== "v1" ||
    legacy.releaseId === null ||
    legacy.releaseId.toLowerCase() !== reference.releaseId.toLowerCase() ||
    legacy.activationEvidence.verifiedAtBlock !== reference.verifiedAtBlock ||
    legacy.activationEvidence.controllerPolicy.registrationsPaused !==
      reference.controllerPolicy.registrationsPaused ||
    legacy.activationEvidence.marketplacePolicy.paused !==
      reference.marketplacePolicy.paused ||
    reference.controllerPolicy.registrationsPaused !== true ||
    reference.marketplacePolicy.paused !== false
  ) {
    return false;
  }
  return CONTRACT_KEYS.every((key) => {
    const contract = legacy.contracts[key];
    const retained = reference.contracts[key];
    return (
      contract.address !== null &&
      contract.deploymentBlock !== null &&
      contract.runtimeCodeHash !== null &&
      contract.address.toLowerCase() === retained.address.toLowerCase() &&
      contract.deploymentBlock === retained.deploymentBlock &&
      contract.runtimeCodeHash.toLowerCase() ===
        retained.runtimeCodeHash.toLowerCase()
    );
  });
}

export function selectReadableReleaseManifests(
  canonical: DeploymentManifest | null,
  legacy: DeploymentManifest | null,
): readonly DeploymentManifest[] {
  const releases: DeploymentManifest[] = [];
  if (manifestIsReadable(canonical)) releases.push(canonical);
  if (
    manifestIsReadable(canonical) &&
    registrarVersionOf(canonical) === "v2"
  ) {
    if (!manifestIsReadable(legacy) || legacy.releaseId === null) {
      throw new Error(
        "The retained V1 manifest is missing or is not source verified.",
      );
    }
    const references = canonical.legacyReleases?.filter(
      (reference) =>
        reference.releaseId.toLowerCase() === legacy.releaseId!.toLowerCase(),
    ) ?? [];
    if (
      references.length !== 1 ||
      !legacyManifestMatchesReference(legacy, references[0]!)
    ) {
      throw new Error(
        "The retained V1 manifest does not match the canonical V2 legacy release reference.",
      );
    }
  }
  if (
    manifestIsReadable(legacy) &&
    (
      !manifestIsReadable(canonical) ||
      registrarVersionOf(canonical) !== "v2" ||
      canonical.legacyReleases?.some((reference) =>
        legacy.releaseId !== null &&
        reference.releaseId.toLowerCase() === legacy.releaseId.toLowerCase()
      ) === true
    ) &&
    !releases.some(
      (candidate) =>
        candidate.releaseId?.toLowerCase() === legacy.releaseId?.toLowerCase(),
    )
  ) {
    releases.push(legacy);
  }
  return Object.freeze(releases);
}

/**
 * Canonical-first release set used for user-value reads. While the checked-in
 * canonical release is still V1 this returns one item. A future release ID
 * automatically adds the exact V1 snapshot as a read/escape fallback.
 */
export function getReadableReleaseManifests(): readonly DeploymentManifest[] {
  if (!parsedManifest) {
    throw manifestValidationError ?? new Error("deployment manifest validation failed");
  }
  return selectReadableReleaseManifests(parsedManifest, parsedLegacyManifest);
}

export function getReadableReleases(): readonly ReadableRelease[] {
  const canonical = getDeploymentManifest();
  return Object.freeze(
    getReadableReleaseManifests().map((manifest) => {
      const isCanonical =
        releaseIdOf(manifest).toLowerCase() ===
        releaseIdOf(canonical).toLowerCase();
      return Object.freeze({
        key: isCanonical ? "canonical" as const : "legacy" as const,
        canonical: isCanonical,
        manifest,
      });
    }),
  );
}

export function getReadableReleaseManifest(
  releaseId: string,
): DeploymentManifest | null {
  if (!/^0x[0-9a-fA-F]{64}$/.test(releaseId)) return null;
  return getReadableReleaseManifests().find(
    (manifest) => releaseIdOf(manifest).toLowerCase() === releaseId.toLowerCase(),
  ) ?? null;
}

export function requireReadableReleaseManifest(
  releaseId: string,
): DeploymentManifest {
  const manifest = getReadableReleaseManifest(releaseId);
  if (!manifest) throw new Error("The requested Contour release is not readable.");
  return manifest;
}

export function readableReleaseKey(releaseId: string): ReadableReleaseKey | null {
  const manifest = getReadableReleaseManifest(releaseId);
  if (!manifest) return null;
  return releaseIdOf(manifest).toLowerCase() ===
    releaseIdOf(getDeploymentManifest()).toLowerCase()
    ? "canonical"
    : "legacy";
}

/**
 * WSS-free runtime discovery document. This is deliberately a separate schema
 * from the immutable deployment manifest: changing public endpoint URLs must
 * never change the signed manifest bytes or its promotion digest.
 */
export function getRuntimeDiscoveryDocument() {
  const manifest = getDeploymentManifest();
  const origin = (
    process.env.NEXT_PUBLIC_SITE_URL?.trim() ||
    "https://contour-arc.vercel.app"
  ).replace(/\/$/, "");
  const baselineArtifacts = [
    manifest.activationEvidence.artifacts.deploymentReceipts,
    manifest.activationEvidence.artifacts.constructorWiring,
    manifest.activationEvidence.artifacts.governanceRoles,
    manifest.activationEvidence.artifacts.treasuryControls,
    manifest.activationEvidence.artifacts.signerPolicy,
    manifest.activationEvidence.artifacts.releaseAttestation,
  ];
  const isEvidenceComplete = baselineArtifacts.every(
    (artifact) => artifact.url !== null && artifact.sha256 !== null,
  );
  const isProductLive =
    manifest.activationEvidence.productLive ||
    process.env.PRODUCT_LIVE === "true" ||
    process.env.NEXT_PUBLIC_PRODUCT_LIVE === "true" ||
    (manifest.state === "active" &&
      manifest.permitIssuer.active &&
      manifest.activationEvidence.controllerPolicy.registrationsPaused === false &&
      isEvidenceComplete);

  return {
    schemaVersion: "1.1.0" as const,
    kind: "contour-runtime-discovery" as const,
    canonicalManifest: {
      url: `${origin}/deployment-manifest.json`,
      sha256: promotionAttestation.manifestSha256,
      releaseId: manifest.releaseId,
      state: manifest.state,
    },
    release: {
      deploymentState: manifest.state,
      productLive: isProductLive,
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
      evidenceComplete: isEvidenceComplete,
    },
    chain: {
      id: manifest.chain.id,
      caip2: manifest.chain.caip2,
      rpcUrl: manifest.chain.rpcUrl,
      transport: "https" as const,
      explorerUrl: manifest.chain.explorerUrl,
      multicall3: manifest.chain.multicall3,
      confirmations: manifest.chain.confirmations,
    },
    namespace: manifest.namespace,
    settlement: manifest.settlement,
    contracts: manifest.contracts,
    releases: getReadableReleases().map((release) => ({
      releaseId: release.manifest.releaseId,
      releaseKey: release.key,
      registrarVersion: registrarVersionOf(release.manifest),
      canonical: release.canonical,
      contracts: Object.fromEntries(
        CONTRACT_KEYS.map((key) => [
          key,
          {
            address: release.manifest.contracts[key].address,
            deploymentBlock:
              release.manifest.contracts[key].deploymentBlock,
          },
        ]),
      ),
      capabilities: {
        registration:
          release.canonical &&
          release.manifest.state === "active" &&
          release.manifest.permitIssuer.active &&
          release.manifest.activationEvidence.controllerPolicy
            .registrationsPaused === false,
        reads: true,
        management: true,
        marketplace:
          release.manifest.contracts.marketplace.address !== null &&
          release.manifest.activationEvidence.marketplacePolicy.paused ===
            false,
        marketplaceEscape:
          release.manifest.state === "active" &&
          release.manifest.contracts.marketplace.address !== null,
      },
    })),
    capabilities: {
      registration: manifest.state === "active" &&
        manifest.permitIssuer.active &&
        manifest.activationEvidence.controllerPolicy.registrationsPaused === false,
      marketplace: manifest.state === "active" &&
        manifest.contracts.marketplace.address !== null &&
        manifest.activationEvidence.marketplacePolicy.paused === false,
      hostedMcp: true,
    },
    readiness: {
      registration: `${origin}/api/registration/readiness`,
      marketplace: `${origin}/api/marketplace/readiness`,
      permitIssuer: `${origin}/api/registration/issuer/healthz`,
    },
    endpoints: {
      runtimeDiscovery: `${origin}/runtime-manifest.json`,
      agentManifest: `${origin}/llms.txt`,
      mcp: `${origin}/api/mcp`,
      openApi: `${origin}/api/openapi.json`,
    },
  };
}

export function getOptionalDeploymentManifest(): DeploymentManifest | null {
  return parsedManifest;
}

const activeManifest = parsedManifest?.state === "active" ? parsedManifest : null;

export function deriveReadCapabilities(manifest: DeploymentManifest | null) {
  const configuredManifest = manifest !== null && manifest.state !== "draft" ? manifest : null;
  const configured = configuredManifest !== null;
  const sourceVerified = configuredManifest !== null &&
    CONTRACT_KEYS.every((key) => configuredManifest.contracts[key].sourceVerified);
  const reads = sourceVerified;
  const marketReads = configuredManifest !== null && reads &&
    configuredManifest.contracts.marketplace.address !== null;
  return Object.freeze({ configured, sourceVerified, reads, marketReads });
}

const readCapabilities = deriveReadCapabilities(parsedManifest);
const productLive = activeManifest?.activationEvidence.productLive === true;
const readableReleases = parsedManifest
  ? selectReadableReleaseManifests(parsedManifest, parsedLegacyManifest)
  : [];

export function deriveMarketplaceEscapeCapability(input: {
  active: boolean;
  marketplaceAddress: string | null;
}) {
  return input.active && input.marketplaceAddress !== null;
}

const marketplaceEscape = deriveMarketplaceEscapeCapability({
  active: activeManifest !== null,
  marketplaceAddress: activeManifest?.contracts.marketplace.address ?? null,
});

export function deriveExecutionCapabilities(input: {
  active: boolean;
  issuerActive: boolean;
  registrationsPaused: boolean | null;
  marketplaceAddress: string | null;
  marketplacePaused: boolean | null;
}) {
  return Object.freeze({
    registration: input.active && input.issuerActive && input.registrationsPaused === false,
    marketplace: input.active && input.marketplaceAddress !== null && input.marketplacePaused === false,
  });
}

const executionCapabilities = deriveExecutionCapabilities({
  active: activeManifest !== null,
  issuerActive: activeManifest?.permitIssuer.active === true,
  registrationsPaused: activeManifest?.activationEvidence.controllerPolicy.registrationsPaused ?? null,
  marketplaceAddress: activeManifest?.contracts.marketplace.address ?? null,
  marketplacePaused: activeManifest?.activationEvidence.marketplacePolicy.paused ?? null,
});
const anyReadable = readableReleases.length > 0;
const anyMarketReadable = readableReleases.some(
  (manifest) => manifest.contracts.marketplace.address !== null,
);
const anyMarketplaceExecution = readableReleases.some((manifest) =>
  deriveExecutionCapabilities({
    active: manifest.state === "active",
    issuerActive: manifest.permitIssuer.active,
    registrationsPaused:
      manifest.activationEvidence.controllerPolicy.registrationsPaused,
    marketplaceAddress: manifest.contracts.marketplace.address,
    marketplacePaused: manifest.activationEvidence.marketplacePolicy.paused,
  }).marketplace
);
const anyMarketplaceEscape = readableReleases.some((manifest) =>
  deriveMarketplaceEscapeCapability({
    active: manifest.state === "active",
    marketplaceAddress: manifest.contracts.marketplace.address,
  })
);

export const protocolCapabilities = Object.freeze({
  ...readCapabilities,
  reads: anyReadable,
  marketReads: anyMarketReadable,
  productLive,
  registration: executionCapabilities.registration,
  marketplace: anyMarketplaceExecution,
  // Pause only closes new listings and purchases. An active marketplace
  // contract must keep cancellation, liability claims and stale-state cleanup
  // reachable independently of the manifest's paused policy bit.
  marketplaceEscape: anyMarketplaceEscape || marketplaceEscape,
  bensConfigured: productLive && activeManifest?.bens.protocolConfigured === true,
  bensHostedArcscanActive: productLive && activeManifest?.bens.hostedArcscanActive === true,
  mcpUnsignedPlans: true,
  x402: activeManifest?.x402.active === true,
});
