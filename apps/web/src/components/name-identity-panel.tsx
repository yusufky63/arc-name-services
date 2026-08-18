import Image from "next/image";
import { nftImagePath, nftMetadataPath } from "@/lib/nft-metadata";
import { NameShareActions } from "./name-share-actions";

function formatExpiry(expiry: string): string {
  const timestamp = BigInt(expiry);
  if (timestamp > BigInt(Number.MAX_SAFE_INTEGER)) return "Unavailable";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Number(timestamp) * 1_000));
}

function compactAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function compactTokenId(tokenId: string): string {
  if (tokenId.length <= 24) return tokenId;
  return `${tokenId.slice(0, 14)}…${tokenId.slice(-8)}`;
}

export function NameIdentityPanel({
  fullName,
  releaseId,
  label,
  tokenId,
  owner,
  expiry,
  lifecycle,
  explorerUrl,
  registrarAddress,
}: {
  fullName: string;
  releaseId: `0x${string}`;
  label: string;
  tokenId: string;
  owner: string;
  expiry: string;
  lifecycle: "active" | "grace" | "expired";
  explorerUrl: string;
  registrarAddress: string;
}) {
  const imagePath = nftImagePath(tokenId, label, releaseId);
  const metadataPath = nftMetadataPath(tokenId, label, releaseId);
  const namePath =
    `/name/${encodeURIComponent(label)}?release=${encodeURIComponent(releaseId)}`;
  const registrarUrl =
    `${explorerUrl.replace(/\/$/, "")}/address/${registrarAddress}`;

  return (
    <section className="name-identity-surface" aria-labelledby="name-identity-heading">
      <div className="name-identity content-shell">
        <header className="name-identity__heading">
          <span>02 / NAME IDENTITY</span>
          <div>
            <h2 id="name-identity-heading">{fullName}</h2>
            <p>
              Your shareable image and companion metadata are derived from the
              verified Arc registration state.
            </p>
          </div>
        </header>

        <div className="name-identity__visual">
          <a href={imagePath} aria-label={`Open the full-size visual for ${fullName}`}>
            <Image
              src={imagePath}
              alt={`Contour name visual for ${fullName}`}
              width={1200}
              height={630}
              sizes="(max-width: 760px) 100vw, 66vw"
              unoptimized
            />
          </a>
        </div>

        <div className="name-identity__details">
          <div className="name-identity__name">
            <span>REGISTERED NAME</span>
            <strong title={fullName}>
              <span>{label}</span>
              <span>{fullName.slice(label.length)}</span>
            </strong>
          </div>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>{lifecycle.toUpperCase()}</dd>
            </div>
            <div>
              <dt>Owner</dt>
              <dd title={owner}>{compactAddress(owner)}</dd>
            </div>
            <div>
              <dt>Expiry</dt>
              <dd>{formatExpiry(expiry)}</dd>
            </div>
            <div>
              <dt>Token ID</dt>
              <dd title={tokenId}>{compactTokenId(tokenId)}</dd>
            </div>
          </dl>
          <NameShareActions fullName={fullName} namePath={namePath} />
          <nav className="name-identity__links" aria-label={`${fullName} asset links`}>
            <a href={metadataPath}>Metadata JSON</a>
            <a href={imagePath}>Open image</a>
            <a href={registrarUrl} target="_blank" rel="noreferrer">
              Registrar on ArcScan
            </a>
          </nav>
        </div>
      </div>
    </section>
  );
}
