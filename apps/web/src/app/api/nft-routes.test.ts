import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InvalidNftLabelHintError,
  type NameNftSnapshot,
} from "@/lib/nft-metadata";

const mocks = vi.hoisted(() => ({
  readNftSnapshot: vi.fn(),
}));

vi.mock("@/lib/protocol-read-model", () => ({
  readNftSnapshot: mocks.readNftSnapshot,
}));

import { GET as getImage } from "./image/[tokenId]/route";
import { GET as getMetadata } from "./metadata/[tokenId]/route";

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

function context(tokenId: string) {
  return { params: Promise.resolve({ tokenId }) };
}

beforeEach(() => {
  mocks.readNftSnapshot.mockReset();
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/metadata/[tokenId]", () => {
  it("rejects a non-canonical token ID without reading Arc", async () => {
    const response = await getMetadata(
      new Request("https://names.example/api/metadata/01"),
      context("01"),
    );

    expect(response.status).toBe(400);
    expect(mocks.readNftSnapshot).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_TOKEN_ID" },
    });
  });

  it("returns 404 for a canonical token not discovered in verified registration events", async () => {
    mocks.readNftSnapshot.mockResolvedValue(null);
    const response = await getMetadata(
      new Request("https://names.example/api/metadata/123"),
      context("123"),
    );

    expect(response.status).toBe(404);
    expect(mocks.readNftSnapshot).toHaveBeenCalledWith(
      123n,
      undefined,
      undefined,
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "TOKEN_NOT_FOUND" },
    });
  });

  it("returns absolute metadata with public cache, CORS, and nosniff headers", async () => {
    mocks.readNftSnapshot.mockResolvedValue(snapshot);
    vi.stubEnv(
      "NEXT_PUBLIC_SITE_URL",
      "https://contour.example/ignored?query=1#fragment",
    );
    const response = await getMetadata(
      new Request("http://localhost:3002/api/metadata/123"),
      context("123"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=120",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toMatchObject({
      image:
        `https://contour.example/api/image/123?label=alice&release=${snapshot.releaseId}`,
      external_url:
        `https://contour.example/name/alice?release=${snapshot.releaseId}`,
      properties: {
        tokenId: "123",
        asOfBlock: "53272967",
      },
    });
  });

  it("forwards one label hint to the verified snapshot reader", async () => {
    mocks.readNftSnapshot.mockResolvedValue(snapshot);
    const response = await getMetadata(
      new Request("https://names.example/api/metadata/123?label=alice"),
      context("123"),
    );

    expect(response.status).toBe(200);
    expect(mocks.readNftSnapshot).toHaveBeenCalledWith(
      123n,
      "alice",
      undefined,
    );
  });

  it("returns 400 for an ambiguous or cryptographically invalid label hint", async () => {
    const duplicate = await getMetadata(
      new Request(
        "https://names.example/api/metadata/123?label=alice&label=bob",
      ),
      context("123"),
    );
    expect(duplicate.status).toBe(400);
    expect(mocks.readNftSnapshot).not.toHaveBeenCalled();
    await expect(duplicate.json()).resolves.toMatchObject({
      error: { code: "INVALID_LABEL_HINT" },
    });

    mocks.readNftSnapshot.mockRejectedValue(new InvalidNftLabelHintError());
    const mismatch = await getMetadata(
      new Request("https://names.example/api/metadata/123?label=bob"),
      context("123"),
    );
    expect(mismatch.status).toBe(400);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: { code: "INVALID_LABEL_HINT" },
    });
  });

  it("returns a sanitized 503 when the verified read fails", async () => {
    mocks.readNftSnapshot.mockRejectedValue(
      new Error("ARC_RPC_URL=https://private.example/secret"),
    );
    const response = await getMetadata(
      new Request("https://names.example/api/metadata/123"),
      context("123"),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("NFT_METADATA_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toMatch(/private\.example|secret|ARC_RPC_URL/);
  });
});

describe("GET /api/image/[tokenId]", () => {
  it("rejects a non-canonical token ID without reading Arc", async () => {
    const response = await getImage(
      new Request("https://names.example/api/image/+1"),
      context("+1"),
    );

    expect(response.status).toBe(400);
    expect(mocks.readNftSnapshot).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_TOKEN_ID" },
    });
  });

  it("returns 404 for a missing token", async () => {
    mocks.readNftSnapshot.mockResolvedValue(null);
    const response = await getImage(
      new Request("https://names.example/api/image/123"),
      context("123"),
    );

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "TOKEN_NOT_FOUND" },
    });
  });

  it("returns a sandboxed, cross-origin SVG with public cache and nosniff headers", async () => {
    mocks.readNftSnapshot.mockResolvedValue(snapshot);
    const response = await getImage(
      new Request("https://names.example/api/image/123"),
      context("123"),
    );
    const svg = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "image/svg+xml; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe(
      "public, s-maxage=30, stale-while-revalidate=120",
    );
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cross-origin-resource-policy")).toBe(
      "cross-origin",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(svg).toMatch(/^<svg /);
    expect(svg).toContain("alice.contour");
  });

  it("forwards one label hint to the verified image snapshot reader", async () => {
    mocks.readNftSnapshot.mockResolvedValue(snapshot);
    const response = await getImage(
      new Request("https://names.example/api/image/123?label=alice"),
      context("123"),
    );

    expect(response.status).toBe(200);
    expect(mocks.readNftSnapshot).toHaveBeenCalledWith(
      123n,
      "alice",
      undefined,
    );
  });

  it("returns a sanitized 503 when the verified read fails", async () => {
    mocks.readNftSnapshot.mockRejectedValue(
      new Error("PRIVATE_KEY=0xdo-not-expose"),
    );
    const response = await getImage(
      new Request("https://names.example/api/image/123"),
      context("123"),
    );
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("NFT_IMAGE_UNAVAILABLE");
    expect(JSON.stringify(body)).not.toMatch(/PRIVATE_KEY|do-not-expose/);
  });

  it("verifies the complete NFT discovery chain: tokenURI -> metadata -> image -> SVG", async () => {
    mocks.readNftSnapshot.mockResolvedValue(snapshot);
    vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://contour-arc.vercel.app");

    // 1. tokenURI resolution
    const baseUri = "https://contour-arc.vercel.app/api/metadata/";
    const tokenId = "123";
    const resolvedTokenUri = `${baseUri}${tokenId}`;
    expect(resolvedTokenUri).toBe("https://contour-arc.vercel.app/api/metadata/123");

    // 2. Fetch metadata from resolved tokenURI
    const metadataResponse = await getMetadata(
      new Request(resolvedTokenUri),
      context(tokenId),
    );
    expect(metadataResponse.status).toBe(200);
    const metadataJson = await metadataResponse.json() as {
      name: string;
      image: string;
      attributes: Array<{ trait_type: string; value: string }>;
      properties: { tokenId: string };
    };
    expect(metadataJson.name).toBe("alice.contour");
    expect(metadataJson.image).toContain("/api/image/123");
    expect(metadataJson.properties.tokenId).toBe("123");

    // 3. Fetch SVG image from metadata.image
    const imageResponse = await getImage(
      new Request(metadataJson.image),
      context(tokenId),
    );
    expect(imageResponse.status).toBe(200);
    expect(imageResponse.headers.get("content-type")).toContain("image/svg+xml");
    const svgText = await imageResponse.text();
    expect(svgText).toContain("<svg");
    expect(svgText).toContain("alice.contour");
    expect(svgText).toContain("</svg>");
  });
});
