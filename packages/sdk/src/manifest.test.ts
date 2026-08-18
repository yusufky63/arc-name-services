import { afterEach, describe, expect, it, vi } from "vitest";
import deployment from "../../../deployments/5042002.json" with { type: "json" };
import { deploymentManifestDigest, parseDeploymentManifest } from "@contour/config";
import { fetchDeploymentManifest } from "./manifest.js";

const canonical = parseDeploymentManifest(deployment);
const body = JSON.stringify(deployment);

afterEach(() => vi.unstubAllGlobals());

describe("pinned manifest discovery", () => {
  it("returns a bounded manifest only when its trusted digest matches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      headers: { "content-type": "application/json" },
    })));
    const result = await fetchDeploymentManifest("http://localhost/manifest.json", {
      expectedManifestSha256: deploymentManifestDigest(canonical),
      expectedReleaseId: canonical.releaseId,
    });
    expect(result.chain.id).toBe(5_042_002);
    expect(result).toEqual(canonical);
  });

  it("rejects a structurally valid response whose digest is not the trusted pin", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, {
      headers: { "content-type": "application/json" },
    })));
    await expect(fetchDeploymentManifest("https://names.example/manifest.json", {
      expectedManifestSha256: `0x${"11".repeat(32)}`,
    })).rejects.toThrow("trusted pin");
  });

  it("stream-caps manifest responses before parsing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(256 * 1024 + 1), {
      headers: { "content-type": "application/json" },
    })));
    await expect(fetchDeploymentManifest("https://names.example/manifest.json", {
      expectedManifestSha256: deploymentManifestDigest(canonical),
    })).rejects.toThrow("too large");
  });
});
