import { maxUint256 } from "viem";

export const NFT_METADATA_PATH = "/api/metadata/";
export const NFT_IMAGE_PATH = "/api/image/";
export const MAX_NFT_LABEL_HINT_CODE_UNITS = 256;

export class InvalidNftLabelHintError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "Label hint must be one canonical normalized label whose hash matches the token ID.",
      options,
    );
    this.name = "InvalidNftLabelHintError";
  }
}

export class InvalidNftReleaseIdError extends Error {
  constructor(options?: ErrorOptions) {
    super("Release must identify one retained Contour deployment.", options);
    this.name = "InvalidNftReleaseIdError";
  }
}

export type NameNftSnapshot = {
  releaseId: `0x${string}`;
  releaseKey: "canonical" | "legacy";
  registrarVersion: "v1" | "v2";
  chainId: number;
  chainName: string;
  explorerUrl: string;
  registrarAddress: `0x${string}`;
  suffix: string;
  tokenId: string;
  label: string;
  name: string;
  owner: `0x${string}`;
  expiry: string;
  lifecycle: "active" | "grace" | "expired";
  asOfBlock: string;
  asOfTimestamp: string;
};

export type NameNftMetadata = {
  name: string;
  description: string;
  image: string;
  external_url: string;
  background_color: string;
  attributes: Array<{
    trait_type: string;
    value: string | number;
    display_type?: "date";
  }>;
  properties: {
    releaseId: `0x${string}`;
    registrarVersion: NameNftSnapshot["registrarVersion"];
    chainId: number;
    contract: `0x${string}`;
    tokenId: string;
    owner: `0x${string}`;
    lifecycle: NameNftSnapshot["lifecycle"];
    asOfBlock: string;
  };
};

export function parseNftTokenId(rawTokenId: string): bigint | null {
  if (!/^(0|[1-9][0-9]{0,77})$/.test(rawTokenId)) return null;
  const tokenId = BigInt(rawTokenId);
  return tokenId <= maxUint256 ? tokenId : null;
}

export function canonicalSiteUrl(requestUrl: string): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const value = configured || new URL(requestUrl).origin;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("The public site URL must use HTTP or HTTPS.");
  }
  return url.origin;
}

function nftPath(
  basePath: string,
  tokenId: string,
  labelHint?: string,
  releaseId?: string,
): string {
  const path = `${basePath}${tokenId}`;
  const search = new URLSearchParams();
  if (labelHint !== undefined) search.set("label", labelHint);
  if (releaseId !== undefined) search.set("release", releaseId);
  const query = search.toString();
  return query.length === 0 ? path : `${path}?${query}`;
}

export function nftMetadataPath(
  tokenId: string,
  labelHint?: string,
  releaseId?: string,
): string {
  return nftPath(NFT_METADATA_PATH, tokenId, labelHint, releaseId);
}

export function nftImagePath(
  tokenId: string,
  labelHint?: string,
  releaseId?: string,
): string {
  return nftPath(NFT_IMAGE_PATH, tokenId, labelHint, releaseId);
}

export function nftLabelHintFromRequestUrl(requestUrl: string): string | undefined {
  const values = new URL(requestUrl).searchParams.getAll("label");
  if (
    values.length > 1 ||
    (values.length === 1 &&
      (values[0] === undefined ||
        values[0].length === 0 ||
        values[0].length > MAX_NFT_LABEL_HINT_CODE_UNITS))
  ) {
    throw new InvalidNftLabelHintError();
  }
  return values[0];
}

export function nftReleaseIdFromRequestUrl(requestUrl: string): string | undefined {
  const values = new URL(requestUrl).searchParams.getAll("release");
  if (
    values.length > 1 ||
    (values.length === 1 && !/^0x[0-9a-fA-F]{64}$/.test(values[0] ?? ""))
  ) {
    throw new InvalidNftReleaseIdError();
  }
  return values[0];
}

export function buildNameNftMetadata(
  snapshot: NameNftSnapshot,
  siteUrl: string,
): NameNftMetadata {
  const base = siteUrl.replace(/\/$/, "");
  const expiry = BigInt(snapshot.expiry);
  const expiryAttribute =
    expiry <= BigInt(Number.MAX_SAFE_INTEGER)
      ? {
          trait_type: "Expires",
          display_type: "date" as const,
          value: Number(expiry),
        }
      : {
          trait_type: "Expires",
          value: snapshot.expiry,
        };
  return {
    name: snapshot.name,
    description:
      `${snapshot.name} is a Contour name registered on ${snapshot.chainName}.`,
    image: `${base}${nftImagePath(
      snapshot.tokenId,
      snapshot.label,
      snapshot.releaseId,
    )}`,
    external_url:
      `${base}/name/${encodeURIComponent(snapshot.label)}?release=${encodeURIComponent(snapshot.releaseId)}`,
    background_color: "F5ECDA",
    attributes: [
      { trait_type: "Namespace", value: `.${snapshot.suffix}` },
      { trait_type: "Network", value: snapshot.chainName },
      { trait_type: "Length", value: Array.from(snapshot.label).length },
      { trait_type: "Status", value: snapshot.lifecycle.toUpperCase() },
      expiryAttribute,
    ],
    properties: {
      releaseId: snapshot.releaseId,
      registrarVersion: snapshot.registrarVersion,
      chainId: snapshot.chainId,
      contract: snapshot.registrarAddress,
      tokenId: snapshot.tokenId,
      owner: snapshot.owner,
      lifecycle: snapshot.lifecycle,
      asOfBlock: snapshot.asOfBlock,
    },
  };
}

export function escapeNftXml(value: string): string {
  const xmlSafeValue = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (codePoint !== undefined &&
        ((codePoint >= 0x20 && codePoint <= 0xd7ff) ||
          (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
          (codePoint >= 0x10000 && codePoint <= 0x10ffff)))
    ) {
      return character;
    }
    return "\uFFFD";
  }).join("");
  return xmlSafeValue
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function svgFontSize(label: string): number {
  const length = Array.from(label).length;
  if (length > 40) return 54;
  if (length > 28) return 66;
  if (length > 18) return 82;
  if (length > 11) return 104;
  return 132;
}

function shortOwner(owner: string): string {
  return `${owner.slice(0, 8)}...${owner.slice(-6)}`;
}

export function renderNameNftSvg(snapshot: NameNftSnapshot): string {
  const label = escapeNftXml(snapshot.label);
  const name = escapeNftXml(snapshot.name);
  const network = escapeNftXml(snapshot.chainName.toUpperCase());
  const owner = escapeNftXml(shortOwner(snapshot.owner));
  const token = escapeNftXml(snapshot.tokenId.slice(0, 18));
  const status = escapeNftXml(snapshot.lifecycle.toUpperCase());
  const fontSize = svgFontSize(snapshot.label);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" role="img" aria-labelledby="title description">
  <title id="title">${name}</title>
  <desc id="description">Contour name identity visual for ${name}</desc>
  <rect width="1200" height="630" fill="#f5ecda"/>
  <rect width="34" height="630" fill="#255277"/>
  <rect x="34" width="1166" height="86" fill="#000b24"/>
  <path d="M76 126H1156M76 502H1156" stroke="#000b24" stroke-width="2"/>
  <path d="M318 126V502M930 126V502" stroke="#acc6e9" stroke-width="1"/>
  <text x="78" y="55" fill="#ffffff" font-family="Space Grotesk, Arial, sans-serif" font-size="25" font-weight="700" letter-spacing="2">CONTOUR</text>
  <text x="1156" y="55" text-anchor="end" fill="#acc6e9" font-family="IBM Plex Mono, monospace" font-size="20">${network} / ${snapshot.chainId}</text>
  <text x="76" y="322" fill="#000b24" font-family="Space Grotesk, Arial, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="-3">${label}</text>
  <text x="76" y="414" fill="#255277" font-family="Space Grotesk, Arial, sans-serif" font-size="68" font-weight="700">.${escapeNftXml(snapshot.suffix)}</text>
  <text x="76" y="548" fill="#000b24" font-family="IBM Plex Mono, monospace" font-size="20">IDENTITY / ${status}</text>
  <text x="1156" y="548" text-anchor="end" fill="#000b24" font-family="IBM Plex Mono, monospace" font-size="20">OWNER / ${owner}</text>
  <text x="76" y="590" fill="#326796" font-family="IBM Plex Mono, monospace" font-size="17">TOKEN / ${token}</text>
  <rect x="1118" y="566" width="38" height="38" fill="#255277"/>
</svg>`;
}
