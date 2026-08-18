import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deriveNameIdentity, normalizeLabel, NormalizationError, NORMALIZATION_PROFILE } from "./index.js";

describe("pinned ENSIP-15 normalization", () => {
  it("normalizes case and exposes that the input changed", () => {
    const result = normalizeLabel("Alice");
    expect(result.normalized).toBe("alice");
    expect(result.changed).toBe(true);
  });

  it("performs only the specified edge trim before ENSIP-15", () => {
    const result = normalizeLabel("  Alice  ");
    expect(result.normalized).toBe("alice");
    expect(result.changed).toBe(true);
  });

  it("keeps labelhash/tokenId parity", () => {
    const result = deriveNameIdentity("alice", "arcname");
    expect(result.tokenId).toBe(BigInt(result.labelhash));
    expect(result.name).toBe("alice.arcname");
  });

  it("rejects full names", () => {
    expect(() => normalizeLabel("alice.arcname")).toThrowError(NormalizationError);
    expect(() => normalizeLabel("alice。arcname")).toThrowError(NormalizationError);
    expect(() => normalizeLabel("alice．arcname")).toThrowError(NormalizationError);
    expect(() => normalizeLabel("alice｡arcname")).toThrowError(NormalizationError);
  });

  it("rejects labels over the pinned byte bound", () => {
    expect(() => normalizeLabel("a".repeat(64))).toThrow(/exceeds/);
  });

  it("locks the descriptor and complete corpus hashes", () => {
    const profileHash = `0x${createHash("sha256").update(NORMALIZATION_PROFILE.descriptor).digest("hex")}`;
    const file = readFileSync(new URL("../fixtures/corpus.canonical.json", import.meta.url));
    const canonical = file.at(-1) === 10 ? file.subarray(0, -1) : file;
    const corpusHash = `0x${createHash("sha256").update(canonical).digest("hex")}`;
    expect(profileHash).toBe(NORMALIZATION_PROFILE.profileHash);
    expect(corpusHash).toBe(NORMALIZATION_PROFILE.corpusHash);

    const corpus = JSON.parse(canonical.toString("utf8")) as { valid: [string, string][]; invalid: string[] };
    for (const [raw, expected] of corpus.valid) expect(normalizeLabel(raw).normalized).toBe(expected);
    for (const raw of corpus.invalid) expect(() => normalizeLabel(raw)).toThrow();
  });
});
