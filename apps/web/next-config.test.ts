import { describe, expect, it } from "vitest";
import nextConfig from "./next.config";
import {
  CANDIDATE_RELEASE_ENVIRONMENT_KEYS,
  candidateReleaseEnvironmentPresent,
} from "./release-runtime-boundary";

describe("Next response headers", () => {
  it("keeps the public SVG route sandboxed after the global application CSP", async () => {
    const rules = await nextConfig.headers?.();
    expect(rules).toBeDefined();
    const imageRule = rules?.find((rule) => rule.source === "/api/image/:tokenId");
    const csp = imageRule?.headers.find(
      (header) => header.key === "Content-Security-Policy",
    )?.value;

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("sandbox");
    expect(imageRule?.headers).toContainEqual({
      key: "Cross-Origin-Resource-Policy",
      value: "cross-origin",
    });
  });

  it("treats every private-candidate runtime or operator value as forbidden live residue", () => {
    for (const key of CANDIDATE_RELEASE_ENVIRONMENT_KEYS) {
      expect(candidateReleaseEnvironmentPresent({ [key]: "false" })).toBe(true);
    }
    expect(candidateReleaseEnvironmentPresent({})).toBe(false);
    expect(candidateReleaseEnvironmentPresent({
      PRIVATE_CANDIDATE_MODE: "",
      PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE: "",
    })).toBe(false);
  });
});
