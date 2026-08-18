import { afterEach, describe, expect, it, vi } from "vitest";
import { maxUint256 } from "viem";
import {
  buildNameNftMetadata,
  canonicalSiteUrl,
  escapeNftXml,
  InvalidNftLabelHintError,
  nftImagePath,
  nftLabelHintFromRequestUrl,
  nftMetadataPath,
  nftReleaseIdFromRequestUrl,
  parseNftTokenId,
  renderNameNftSvg,
  type NameNftSnapshot,
} from "./nft-metadata";

const snapshot: NameNftSnapshot = {
  releaseId: `0x${"ab".repeat(32)}`,
  releaseKey: "canonical",
  registrarVersion: "v2",
  chainId: 5_042_002,
  chainName: "Arc Testnet",
  explorerUrl: "https://testnet.arcscan.app",
  registrarAddress: "0x1111111111111111111111111111111111111111",
  suffix: "contour",
  tokenId: "123",
  label: "alice",
  name: "alice.contour",
  owner: "0x2222222222222222222222222222222222222222",
  expiry: "1800000000",
  lifecycle: "active",
  asOfBlock: "53272967",
  asOfTimestamp: "1700000000",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("NFT token ID validation", () => {
  it("accepts only canonical uint256 decimal strings", () => {
    expect(parseNftTokenId("0")).toBe(0n);
    expect(parseNftTokenId("1")).toBe(1n);
    expect(parseNftTokenId(maxUint256.toString())).toBe(maxUint256);

    for (const invalid of [
      "",
      "00",
      "01",
      "-1",
      "+1",
      " 1",
      "1 ",
      "1.0",
      "0x01",
      `${maxUint256 + 1n}`,
      "9".repeat(79),
    ]) {
      expect(parseNftTokenId(invalid), invalid).toBeNull();
    }
  });
});

describe("NFT metadata URLs and attributes", () => {
  it("adds an encoded label hint to companion paths only when provided", () => {
    expect(nftMetadataPath("123")).toBe("/api/metadata/123");
    expect(nftImagePath("123")).toBe("/api/image/123");
    expect(nftMetadataPath("123", "ali/ç")).toBe(
      "/api/metadata/123?label=ali%2F%C3%A7",
    );
    expect(nftImagePath("123", "alice")).toBe(
      "/api/image/123?label=alice",
    );
    expect(nftImagePath("123", "alice", snapshot.releaseId)).toBe(
      `/api/image/123?label=alice&release=${snapshot.releaseId}`,
    );
  });

  it("accepts one exact retained release ID", () => {
    expect(
      nftReleaseIdFromRequestUrl(
        `https://names.example/api/image/123?release=${snapshot.releaseId}`,
      ),
    ).toBe(snapshot.releaseId);
    expect(() =>
      nftReleaseIdFromRequestUrl(
        "https://names.example/api/image/123?release=legacy",
      )
    ).toThrow();
  });

  it("accepts one bounded label query and rejects ambiguous or empty hints", () => {
    expect(
      nftLabelHintFromRequestUrl("https://names.example/api/image/123"),
    ).toBeUndefined();
    expect(
      nftLabelHintFromRequestUrl(
        "https://names.example/api/image/123?label=ali%2F%C3%A7",
      ),
    ).toBe("ali/ç");

    for (const url of [
      "https://names.example/api/image/123?label=",
      "https://names.example/api/image/123?label=alice&label=bob",
      `https://names.example/api/image/123?label=${"a".repeat(257)}`,
    ]) {
      expect(() => nftLabelHintFromRequestUrl(url)).toThrow(
        InvalidNftLabelHintError,
      );
    }
  });

  it("uses the configured HTTP(S) origin and discards path, query, and hash", () => {
    vi.stubEnv(
      "NEXT_PUBLIC_SITE_URL",
      "https://names.example:8443/ignored/path?query=1#fragment",
    );
    expect(canonicalSiteUrl("http://localhost:3002/api/metadata/123")).toBe(
      "https://names.example:8443",
    );
  });

  it("falls back to the request origin and rejects non-web protocols", () => {
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
    expect(
      canonicalSiteUrl("http://127.0.0.1:3002/api/metadata/123?source=test"),
    ).toBe("http://127.0.0.1:3002");

    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "javascript:alert(1)");
    expect(() => canonicalSiteUrl("https://names.example/api/metadata/123")).toThrow(
      "HTTP or HTTPS",
    );
  });

  it("builds absolute image and external URLs with collectible data", () => {
    const metadata = buildNameNftMetadata(snapshot, "https://names.example");

    expect(metadata).toMatchObject({
      name: "alice.contour",
      image:
        `https://names.example/api/image/123?label=alice&release=${snapshot.releaseId}`,
      external_url:
        `https://names.example/name/alice?release=${snapshot.releaseId}`,
      background_color: "F5ECDA",
      properties: {
        releaseId: snapshot.releaseId,
        registrarVersion: "v2",
        chainId: 5_042_002,
        contract: snapshot.registrarAddress,
        tokenId: "123",
        owner: snapshot.owner,
        lifecycle: "active",
        asOfBlock: "53272967",
      },
    });
    expect(metadata.attributes).toContainEqual({
      trait_type: "Expires",
      display_type: "date",
      value: 1_800_000_000,
    });
  });

  it("does not lose precision for an out-of-range expiry", () => {
    const metadata = buildNameNftMetadata(
      { ...snapshot, expiry: maxUint256.toString() },
      "https://names.example",
    );

    expect(metadata.attributes).toContainEqual({
      trait_type: "Expires",
      value: maxUint256.toString(),
    });
  });

  it("encodes the label as one external URL path segment", () => {
    const metadata = buildNameNftMetadata(
      { ...snapshot, label: "ali ce/<", name: "ali ce/<.contour" },
      "https://names.example",
    );
    expect(metadata.external_url).toBe(
      `https://names.example/name/ali%20ce%2F%3C?release=${snapshot.releaseId}`,
    );
  });
});

describe("deterministic SVG safety", () => {
  it("escapes XML metacharacters and replaces XML 1.0 control/surrogate characters", () => {
    const unsafe = `a<&"'${String.fromCharCode(0, 11, 0xd800)}z`;
    expect(escapeNftXml(unsafe)).toBe(
      "a&lt;&amp;&quot;&apos;\uFFFD\uFFFD\uFFFDz",
    );
  });

  it("renders deterministic XML without raw injected markup or invalid controls", () => {
    const unsafeLabel = `alice</text><script>alert(1)</script>${String.fromCharCode(
      0,
      0xd800,
    )}`;
    const unsafeSnapshot: NameNftSnapshot = {
      ...snapshot,
      label: unsafeLabel,
      name: `${unsafeLabel}.contour`,
      chainName: "Arc & <Testnet>",
    };

    const first = renderNameNftSvg(unsafeSnapshot);
    const second = renderNameNftSvg(unsafeSnapshot);

    expect(first).toBe(second);
    expect(first).toContain(
      "alice&lt;/text&gt;&lt;script&gt;alert(1)&lt;/script&gt;\uFFFD\uFFFD",
    );
    expect(first).toContain("ARC &amp; &lt;TESTNET&gt;");
    expect(first).toContain("Contour name identity visual for");
    expect(first).toContain("font-family=\"Space Grotesk, Arial, sans-serif\"");
    expect(first).toContain("font-family=\"IBM Plex Mono, monospace\"");
    expect(first).not.toContain("<script>");
    expect(first).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uD800-\uDFFF]/u);
    expect(first).toContain("OWNER / 0x222222...222222");
  });
});
