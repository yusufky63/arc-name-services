import {
  CANONICAL_NFT_METADATA_BASE_URI,
  CONTRACT_KEYS,
  registrarVersionOf,
  type LegacyReleaseReference,
} from "@contour/config";
import type { ReadableRelease } from "@/lib/manifest";

export type PublicStatusTone = "ready" | "unavailable";

export type PublicStatusRow = Readonly<{
  id: string;
  label: string;
  value: string;
  tone: PublicStatusTone;
  detail: string;
}>;

export type PublicReleaseStatus = Readonly<{
  ready: boolean;
  rows: readonly PublicStatusRow[];
}>;

function row(
  id: string,
  label: string,
  value: string,
  ready: boolean,
  detail: string,
): PublicStatusRow {
  return Object.freeze({
    id,
    label,
    value,
    tone: ready ? "ready" : "unavailable",
    detail,
  });
}

function hasCompleteContractSet(release: ReadableRelease): boolean {
  return CONTRACT_KEYS.every(
    (key) =>
      release.manifest.contracts[key].address !== null &&
      release.manifest.contracts[key].sourceVerified,
  );
}

function retainedReferenceFor(
  canonical: ReadableRelease | null,
  retained: ReadableRelease | null,
): LegacyReleaseReference | null {
  const retainedId = retained?.manifest.releaseId;
  if (canonical === null || retainedId === null || retainedId === undefined) {
    return null;
  }
  const matches = canonical.manifest.legacyReleases?.filter(
    (reference) =>
      reference.releaseId.toLowerCase() === retainedId.toLowerCase(),
  ) ?? [];
  return matches.length === 1 ? matches[0]! : null;
}

export function buildPublicReleaseStatus(
  releases: readonly ReadableRelease[],
): PublicReleaseStatus {
  const canonicalCandidates = releases.filter((release) => release.canonical);
  const retainedCandidates = releases.filter((release) => !release.canonical);
  const canonical = canonicalCandidates.length === 1
    ? canonicalCandidates[0]!
    : null;
  const retained = retainedCandidates.length === 1
    ? retainedCandidates[0]!
    : null;

  const canonicalId = canonical?.manifest.releaseId ?? null;
  const retainedId = retained?.manifest.releaseId ?? null;
  const retainedReference = retainedReferenceFor(canonical, retained);
  const canonicalV2 =
    canonical !== null &&
    canonical.key === "canonical" &&
    registrarVersionOf(canonical.manifest) === "v2" &&
    canonicalId !== null &&
    canonical.manifest.state === "active" &&
    hasCompleteContractSet(canonical);
  const canonicalPublicLive =
    canonicalV2 && canonical.manifest.activationEvidence.productLive;
  const canonicalRegistration =
    canonicalPublicLive &&
    canonical.manifest.permitIssuer.active &&
    canonical.manifest.activationEvidence.controllerPolicy
      .registrationsPaused === false;
  const canonicalMarketplace =
    canonicalPublicLive &&
    canonical.manifest.contracts.marketplace.address !== null &&
    canonical.manifest.activationEvidence.marketplacePolicy.paused === false;
  const canonicalMetadata =
    canonicalPublicLive &&
    canonical.manifest.nftMetadata?.metadataBaseURI ===
      CANONICAL_NFT_METADATA_BASE_URI;

  const retainedV1 =
    retained !== null &&
    retained.key === "legacy" &&
    registrarVersionOf(retained.manifest) === "v1" &&
    retainedId !== null &&
    retained.manifest.state === "active" &&
    hasCompleteContractSet(retained) &&
    retainedReference !== null;
  const retainedNames = canonicalPublicLive && retainedV1;
  const retainedRegistrationClosed =
    retainedV1 &&
    retainedReference?.controllerPolicy.registrationsPaused === true;
  const retainedMarketplace =
    canonicalPublicLive &&
    retainedV1 &&
    retained.manifest.contracts.marketplace.address !== null &&
    retainedReference?.marketplacePolicy.paused === false;
  const retainedMarketEscape =
    canonicalPublicLive &&
    retainedV1 &&
    retained.manifest.contracts.marketplace.address !== null;

  const topologyReady =
    releases.length === 2 &&
    canonicalV2 &&
    canonicalPublicLive &&
    canonicalRegistration &&
    canonicalMarketplace &&
    canonicalMetadata &&
    retainedNames &&
    retainedRegistrationClosed &&
    retainedMarketplace &&
    retainedMarketEscape;

  const rows: PublicStatusRow[] = [
    row(
      "release-topology",
      "Protocol topology",
      topologyReady ? "READY" : "UNAVAILABLE",
      topologyReady,
      topologyReady
        ? "Network contracts, state manifests, and cryptographic attestations are verified."
        : "The required contract trust set is incomplete. User actions remain fail-closed.",
    ),
    row(
      "canonical-identity",
      "Protocol architecture",
      canonicalPublicLive ? "PUBLIC LIVE" : "UNAVAILABLE",
      canonicalPublicLive,
      canonicalId
        ? canonicalPublicLive
          ? `Release ID ${canonicalId}. New names are issued only by this release.`
          : `Release ID ${canonicalId} is configured, but its product-live gate is not complete.`
        : "No validated canonical release ID is available.",
    ),
    row(
      "canonical-registration",
      "Registration controller",
      canonicalRegistration ? "OPEN" : "UNAVAILABLE",
      canonicalRegistration,
      canonicalRegistration
        ? "New .contour registrations use the canonical registrar controller."
        : "Registration is not reported as open unless the active issuer and controller policy both match.",
    ),
    row(
      "canonical-marketplace",
      "On-chain marketplace",
      canonicalMarketplace ? "OPEN" : "UNAVAILABLE",
      canonicalMarketplace,
      canonicalMarketplace
        ? "Listing, purchase, cancellation, and proceeds claims in USDC are enabled."
        : "Market execution is not reported as open without an active, unpaused verified marketplace.",
    ),
    row(
      "canonical-metadata",
      "ERC-721 metadata engine",
      canonicalMetadata ? "NATIVE" : "UNAVAILABLE",
      canonicalMetadata,
      canonicalMetadata
        ? `Registrar tokenURI resolves through ${CANONICAL_NFT_METADATA_BASE_URI}`
        : "Native ERC-721 metadata is not reported unless the exact metadata base URI is manifest-bound.",
    ),
    row(
      "retained-identity",
      "Namespace integrity",
      retainedV1 ? "RETAINED" : "UNAVAILABLE",
      retainedV1,
      retainedId
        ? `Release ID ${retainedId}. Existing tokens remain on their original contracts.`
        : "No exact retained release ID is available.",
    ),
    row(
      "retained-names",
      "Name records & resolution",
      retainedNames ? "AVAILABLE" : "UNAVAILABLE",
      retainedNames,
      retainedNames
        ? "Read, renew, transfer, resolver, and ownership management remain available."
        : "Name reads and management are not reported as available without the verified contract set.",
    ),
    row(
      "retained-marketplace",
      "Marketplace settlement & exits",
      retainedMarketplace && retainedMarketEscape ? "AVAILABLE" : "UNAVAILABLE",
      retainedMarketplace && retainedMarketEscape,
      retainedMarketplace && retainedMarketEscape
        ? "Existing listings and purchases remain available; cancellation, claims, and stale-listing cleanup stay reachable."
        : "Marketplace and escape actions are not reported as available unless the marketplace is active and open.",
    ),
    row(
      "retained-registration",
      "Registration policy gate",
      retainedRegistrationClosed ? "PAUSED" : "UNSAFE",
      retainedRegistrationClosed,
      retainedRegistrationClosed
        ? "Registration policy gates and front-running protections are enforced."
        : "The release policy is unsafe until the trust root binds registration policies.",
    ),
    row(
      "migration-policy",
      "Namespace protection",
      "NO AUTO-MIGRATION",
      topologyReady,
      "Names are cryptographically protected on-chain; collision prevention is active.",
    ),
  ];

  return Object.freeze({
    ready: topologyReady,
    rows: Object.freeze(rows),
  });
}

export function unavailablePublicReleaseStatus(): PublicReleaseStatus {
  return Object.freeze({
    ready: false,
    rows: Object.freeze([
      row(
        "release-topology",
        "Protocol topology",
        "UNAVAILABLE",
        false,
        "Release manifests could not be validated. Reads and user actions remain fail-closed.",
      ),
      row(
        "canonical-identity",
        "Protocol architecture",
        "UNAVAILABLE",
        false,
        "No validated protocol release is available.",
      ),
      row(
        "retained-identity",
        "Namespace integrity",
        "UNAVAILABLE",
        false,
        "No validated namespace release is available.",
      ),
    ]),
  });
}
