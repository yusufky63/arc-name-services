import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { formatUnits, getAddress, zeroAddress, type Address, type Hex } from "viem";
import { requireActivatedContract } from "@contour/config";
import { baseRegistrarAbi, marketplaceAbi, type NameRecord } from "@contour/sdk";
import {
  NameManagementPanel,
  type NameListingView,
  type StaleNameListingView,
} from "@/components/name-management-panel";
import { NameIdentityPanel } from "@/components/name-identity-panel";
import { NameReadRecovery } from "@/components/name-read-recovery";
import { NameRegistrationCta } from "@/components/name-registration-cta";
import { RegisterPanel } from "@/components/register-panel";
import { BRAND } from "@/lib/brand";
import { cleanLabel, isPlausibleLabel } from "@/lib/names";
import {
  getOptionalDeploymentManifest,
  getReadableReleases,
  protocolCapabilities,
} from "@/lib/manifest";
import { getSharedProtocolClient } from "@/lib/protocol-client";

type PageProps = {
  params: Promise<{ label: string }>;
  searchParams?: Promise<{ release?: string | string[] }>;
};

export const dynamic = "force-dynamic";

function compactAddress(value: string | null) {
  return value ? `${value.slice(0, 8)}…${value.slice(-6)}` : "—";
}

function formatExpiry(value: bigint | null) {
  if (value === null) return "—";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Number(value) * 1_000));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { label: raw } = await params;
  let label = "name";
  try {
    label = cleanLabel(decodeURIComponent(raw));
  } catch {
    // The route body owns the not-found decision.
  }
  const fullName = `${label}${BRAND.suffix}`;
  const description =
    `View availability, ownership, records, and the shareable identity for ${fullName}.`;
  const canonical = `/name/${encodeURIComponent(label)}`;
  return {
    title: fullName,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      title: fullName,
      description,
      url: canonical,
    },
    twitter: {
      card: "summary_large_image",
      title: fullName,
      description,
    },
  };
}

export default async function NamePage({ params, searchParams }: PageProps) {
  const { label: raw } = await params;
  let label: string;
  let rawLabel: string;
  try {
    const decoded = decodeURIComponent(raw);
    rawLabel = decoded;
    label = cleanLabel(decoded);
  } catch {
    notFound();
  }
  if (!isPlausibleLabel(label)) notFound();

  const fullName = `${label}${BRAND.suffix}`;
  const canonicalDeployment = getOptionalDeploymentManifest();
  let deployment = canonicalDeployment;
  const releaseValue = (await searchParams)?.release;
  const requestedReleaseId =
    typeof releaseValue === "string" ? releaseValue : null;
  if (
    releaseValue !== undefined &&
    (
      requestedReleaseId === null ||
      !/^0x[0-9a-fA-F]{64}$/.test(requestedReleaseId)
    )
  ) {
    notFound();
  }
  const normalizationRequired = rawLabel !== label;
  let record: NameRecord | null = null;
  let annualQuote: bigint | null = null;
  let primaryName: string | null = null;
  let chainTimestamp: bigint | null = null;
  let listing: NameListingView | null = null;
  let staleListing: StaleNameListingView | null = null;
  let marketplaceTokenApproved = false;
  // New listing/purchase UI fails closed until the current marketplace pause
  // state is read. Escape actions receive their own independent capability.
  let marketPaused = true;
  let readFailed = false;

  if (protocolCapabilities.reads && canonicalDeployment) {
    try {
      const releases = getReadableReleases();
      if (
        requestedReleaseId &&
        !releases.some(
          (release) =>
            release.manifest.releaseId!.toLowerCase() ===
          requestedReleaseId.toLowerCase(),
        )
      ) throw new Error("The requested Contour release is not readable.");
      const blockNumber = await getSharedProtocolClient(
        releases[0]!.manifest,
      ).publicClient.getBlockNumber();
      const releaseReads = await Promise.allSettled(
        releases.map(async (release) => {
          const shared = getSharedProtocolClient(release.manifest);
          const snapshot = await shared.names.nameWithQuote(label, 1n, {
            blockNumber,
          });
          return { release, shared, snapshot };
        }),
      );
      const successfulReads = releaseReads.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const registeredReads = successfulReads.filter(
        ({ snapshot }) => !snapshot.record.available,
      );
      const explicitlySelected = requestedReleaseId
        ? successfulReads.find(
            ({ release }) =>
              release.manifest.releaseId!.toLowerCase() ===
              requestedReleaseId.toLowerCase(),
          )
        : undefined;
      const selected = requestedReleaseId
        ? explicitlySelected
        : registeredReads[0] ??
          successfulReads.find(({ release }) => release.canonical);

      // A registration availability result is safe only when every readable
      // release answered. One failed legacy read must never allow a duplicate
      // label to be minted into the canonical V2 registrar.
      if (
        !selected ||
        (
          registeredReads.length === 0 &&
          successfulReads.length !== releases.length
        )
      ) {
        throw new Error("The complete Contour release set could not be read.");
      }
      if (
        requestedReleaseId &&
        selected.snapshot.record.available &&
        registeredReads.length > 0
      ) {
        throw new Error(
          "The requested release does not own this name; refusing to retarget it.",
        );
      }

      deployment = selected.release.manifest;
      const { names: client, publicClient } = selected.shared;
      record = selected.snapshot.record;
      annualQuote = selected.snapshot.quote;
      chainTimestamp = selected.snapshot.blockTimestamp;

      if (record.registrant) {
        try {
          primaryName = (
            await client.reverse(record.registrant, { blockNumber })
          ).name;
        } catch {
          // Reverse resolution is optional; forward ownership remains authoritative.
        }
      }

      if (!record.available && deployment.contracts.marketplace.address) {
        const marketplace = requireActivatedContract(deployment, "marketplace");
        const registrar = requireActivatedContract(deployment, "baseRegistrar");
        const [
          listingResult,
          rawListingResult,
          feeResult,
          pausedResult,
          tokenApprovalResult,
        ] = await Promise.allSettled([
          publicClient.readContract({
            address: marketplace,
            abi: marketplaceAbi,
            functionName: "listingOf",
            args: [record.tokenId],
            blockNumber,
          }),
          publicClient.readContract({
            address: marketplace,
            abi: marketplaceAbi,
            functionName: "rawListingOf",
            args: [record.tokenId],
            blockNumber,
          }),
          publicClient.readContract({
            address: marketplace,
            abi: marketplaceAbi,
            functionName: "feeBps",
            blockNumber,
          }),
          publicClient.readContract({
            address: marketplace,
            abi: marketplaceAbi,
            functionName: "paused",
            blockNumber,
          }),
          publicClient.readContract({
            address: registrar,
            abi: baseRegistrarAbi,
            functionName: "getApproved",
            args: [record.tokenId],
            blockNumber,
          }),
        ]);
        if (pausedResult.status === "fulfilled") marketPaused = pausedResult.value;
        if (tokenApprovalResult.status === "fulfilled") {
          marketplaceTokenApproved =
            getAddress(tokenApprovalResult.value) === getAddress(marketplace);
        }
        if (listingResult.status === "fulfilled" && feeResult.status === "fulfilled") {
          const current = listingResult.value;
          if (current[0] !== zeroAddress && current[1] > 0n) {
            listing = {
              seller: current[0] as Address,
              price: current[1].toString(),
              validUntil: BigInt(current[2]).toString(),
              feeBps: feeResult.value,
            };
          }
        }
        if (
          listingResult.status === "fulfilled" &&
          listingResult.value[0] === zeroAddress &&
          rawListingResult.status === "fulfilled" &&
          rawListingResult.value[0] !== zeroAddress
        ) {
          staleListing = {
            seller: rawListingResult.value[0] as Address,
            price: rawListingResult.value[1].toString(),
            validUntil: BigInt(rawListingResult.value[2]).toString(),
          };
        }
      }
    } catch {
      readFailed = true;
    }
  }

  const isAvailable = record?.available === true;
  const isRegistered = record?.available === false;
  const inGrace = Boolean(
    isRegistered &&
    record?.expiry !== null &&
    chainTimestamp !== null &&
    record?.expiry !== undefined &&
    record.expiry < chainTimestamp,
  );
  const nameStatus = isAvailable
    ? "AVAILABLE"
    : isRegistered
      ? inGrace ? "GRACE" : "REGISTERED"
      : readFailed ? "RPC ERROR" : "CHECKING";
  const quotedPrice = annualQuote === null ? "—" : `${formatUnits(annualQuote, 6)} USDC`;
  const owner = record?.registrant ?? null;
  const heroFacts = isAvailable
    ? [
        ["Status", nameStatus],
        ["Term", "1 YEAR"],
        ["Price", quotedPrice],
        ["Payment", "USDC"],
      ]
    : isRegistered
      ? [
          ["Status", nameStatus],
          ["Owner", compactAddress(owner)],
          ["Expiry", formatExpiry(record?.expiry ?? null)],
          listing
            ? ["Market", `${formatUnits(BigInt(listing.price), 6)} USDC`]
            : ["Primary", primaryName === fullName ? "YES" : "NO"],
        ]
      : [
          ["Status", nameStatus],
          ["Registration", "HIDDEN"],
          ["Owner", "—"],
          ["Price", "—"],
        ];
  const recordRows = isRegistered ? [
    ["Owner", compactAddress(owner)],
    ["Resolved address", compactAddress(record?.resolvedAddress ?? null)],
    ["Primary name", primaryName ?? "—"],
    ["Resolver", compactAddress(record?.resolver ?? null)],
    ["Content hash", record?.contentHash ?? "—"],
    ["Expiry", formatExpiry(record?.expiry ?? null)],
  ] as const : [];
  const liveRegistrationHref =
    canonicalDeployment?.state === "active" &&
    canonicalDeployment.permitIssuer.active &&
    canonicalDeployment.permitIssuer.url &&
    canonicalDeployment.activationEvidence.controllerPolicy.registrationsPaused === false
      ? `${new URL(canonicalDeployment.permitIssuer.url).origin}/name/${encodeURIComponent(label)}#registration`
      : undefined;
  const selectedMarketplaceEnabled =
    deployment?.state === "active" &&
    deployment.contracts.marketplace.address !== null &&
    deployment.activationEvidence.marketplacePolicy.paused === false;
  const selectedMarketplaceEscapeEnabled =
    deployment?.state === "active" &&
    deployment.contracts.marketplace.address !== null;

  return (
    <main id="main-content" className="name-page">
      <NameReadRecovery active={readFailed} label={label} />
      <section className="name-route-hero">
        <div className="name-route-hero__content content-shell">
          <div className="name-route-hero__meta"><span>CONTOUR NAME</span></div>
          <div className="name-route-hero__name" title={fullName}>
            <span>{label}</span><strong>{BRAND.suffix}</strong>
          </div>
          <NameRegistrationCta
            label={label}
            registrationEnabled={protocolCapabilities.registration}
            nameAvailable={record?.available}
            liveRegistrationHref={liveRegistrationHref}
          />
          <div className="name-route-hero__facts">
            {heroFacts.map(([field, value]) => (
              <div key={field}><span>{field}</span><strong>{value}</strong></div>
            ))}
          </div>
        </div>
      </section>

      {isAvailable ? (
        <section id="registration" className="registration-surface" aria-labelledby="registration-heading">
          <div className="registration-layout content-shell">
            {protocolCapabilities.registration ? (
              <>
                <div className="registration-layout__intro">
                  <span>01 / REGISTER YOUR NAME</span>
                  <h1 id="registration-heading">Make {fullName} yours.</h1>
                  <p>Choose the term, review the USDC price, and confirm with your wallet.</p>
                  <dl>
                    <div><dt>1. Choose</dt><dd>Term and owner</dd></div>
                    <div><dt>2. Approve</dt><dd>USDC if needed</dd></div>
                    <div><dt>3. Confirm</dt><dd>Register in wallet</dd></div>
                  </dl>
                </div>
                <RegisterPanel
                  label={label}
                  rawLabel={rawLabel}
                  normalizationRequired={normalizationRequired}
                  deploymentReady
                  nameAvailable
                />
              </>
            ) : (
              <div className="name-state-card">
                <span>REGISTRATION</span>
                <h2>Continue in the live app.</h2>
                {liveRegistrationHref ? <a href={liveRegistrationHref}>Register {fullName}</a> : null}
              </div>
            )}
          </div>
        </section>
      ) : null}

      {isRegistered &&
      record &&
      owner &&
      record.expiry !== null &&
      record.expiry !== undefined &&
      deployment?.state === "active" ? (
        <NameIdentityPanel
          fullName={fullName}
          releaseId={deployment.releaseId!}
          label={label}
          tokenId={record.tokenId.toString()}
          owner={owner}
          expiry={record.expiry.toString()}
          lifecycle={inGrace ? "grace" : "active"}
          explorerUrl={deployment.chain.explorerUrl}
          registrarAddress={requireActivatedContract(deployment, "baseRegistrar")}
        />
      ) : null}

      {isRegistered && record && deployment?.state === "active" ? (
        <NameManagementPanel
          releaseId={deployment.releaseId!}
          label={label}
          fullName={fullName}
          tokenId={record.tokenId.toString()}
          node={record.node as Hex}
          owner={owner}
          resolvedAddress={record.resolvedAddress}
          primaryName={primaryName}
          lifecycle={inGrace ? "grace" : "active"}
          expiry={record.expiry?.toString() ?? "0"}
          annualQuote={annualQuote?.toString() ?? null}
          listing={listing}
          staleListing={staleListing}
          marketplaceTokenApproved={marketplaceTokenApproved}
          marketPaused={marketPaused}
          managementEnabled={deployment?.state === "active"}
          marketplaceEnabled={selectedMarketplaceEnabled}
          marketplaceEscapeEnabled={selectedMarketplaceEscapeEnabled}
        />
      ) : null}

      {!isAvailable && !isRegistered ? (
        <section className="name-state-surface">
          <div className="name-state-card content-shell">
            <span>NAME READ</span>
            <h2>We could not confirm this name yet.</h2>
            <p>
              We retry temporary Arc RPC failures automatically. Registration stays hidden until
              ownership and availability are confirmed.
            </p>
            <a href={`/name/${encodeURIComponent(label)}`}>Try again</a>
          </div>
        </section>
      ) : null}

      {recordRows.length ? (
        <section className="name-records-surface">
          <div className="name-records content-shell">
            <div className="name-records__heading">
              <span>03 / NAME DETAILS</span>
              <h2>Records</h2>
              <p>Ownership, resolution, primary-name, and expiry information.</p>
            </div>
            {recordRows.map(([field, value]) => (
              <div className="record-row" key={field}>
                <span>{field}</span><strong title={value}>{value}</strong>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
