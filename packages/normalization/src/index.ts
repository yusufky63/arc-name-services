import { ens_normalize } from "@adraffy/ens-normalize";
import {
  bytesToHex,
  keccak256,
  namehash as viemNamehash,
  stringToBytes,
  type Hex,
} from "viem";
import { NORMALIZATION_PROFILE } from "./profile.js";

export { NORMALIZATION_PROFILE } from "./profile.js";

export class NormalizationError extends Error {
  readonly code:
    | "EMPTY_LABEL"
    | "FULL_NAME_NOT_ALLOWED"
    | "ENSIP15_REJECTED"
    | "LABEL_TOO_LONG";

  constructor(code: NormalizationError["code"], message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NormalizationError";
    this.code = code;
  }
}

export interface NormalizedLabel {
  readonly raw: string;
  readonly normalized: string;
  readonly changed: boolean;
  readonly utf8: Hex;
  readonly utf8ByteLength: number;
  readonly codePointLength: number;
  readonly labelhash: Hex;
  readonly profileId: typeof NORMALIZATION_PROFILE.id;
  readonly profileHash: Hex;
  readonly corpusHash: Hex;
}

/**
 * Canonical ENSIP-15 pipeline for one label. Full names are rejected so callers
 * cannot accidentally normalize a user-selected suffix as part of the label.
 */
export function normalizeLabel(raw: string): NormalizedLabel {
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new NormalizationError("EMPTY_LABEL", "label is empty");
  if (trimmed.includes(".")) {
    throw new NormalizationError("FULL_NAME_NOT_ALLOWED", "expected one label, not a full name");
  }

  let normalized: string;
  try {
    normalized = ens_normalize(trimmed);
  } catch (cause) {
    throw new NormalizationError("ENSIP15_REJECTED", "label is not valid under the pinned ENSIP-15 profile", { cause });
  }
  if (normalized.length === 0) throw new NormalizationError("EMPTY_LABEL", "normalized label is empty");
  if (normalized.includes(".")) {
    throw new NormalizationError(
      "FULL_NAME_NOT_ALLOWED",
      "normalization produced a full name; expected one label",
    );
  }

  const bytes = stringToBytes(normalized);
  const codePointLength = Array.from(normalized).length;
  if (
    bytes.length > NORMALIZATION_PROFILE.maxUtf8Bytes ||
    codePointLength > NORMALIZATION_PROFILE.maxCodePoints
  ) {
    throw new NormalizationError(
      "LABEL_TOO_LONG",
      `label exceeds ${NORMALIZATION_PROFILE.maxUtf8Bytes} UTF-8 bytes or ${NORMALIZATION_PROFILE.maxCodePoints} code points`,
    );
  }

  return Object.freeze({
    raw,
    normalized,
    changed: raw !== normalized,
    utf8: bytesToHex(bytes),
    utf8ByteLength: bytes.length,
    codePointLength,
    labelhash: keccak256(bytes),
    profileId: NORMALIZATION_PROFILE.id,
    profileHash: NORMALIZATION_PROFILE.profileHash,
    corpusHash: NORMALIZATION_PROFILE.corpusHash,
  });
}

export function fullName(normalizedLabel: string, suffix: string): string {
  if (!suffix || suffix.includes(".") || suffix !== suffix.toLowerCase()) {
    throw new NormalizationError("ENSIP15_REJECTED", "suffix must be a configured lowercase label");
  }
  const checked = normalizeLabel(normalizedLabel);
  if (checked.changed) {
    throw new NormalizationError("ENSIP15_REJECTED", "label must already be normalized");
  }
  return `${checked.normalized}.${suffix}`;
}

export function deriveNameIdentity(raw: string, suffix: string) {
  const label = normalizeLabel(raw);
  const name = fullName(label.normalized, suffix);
  const namehash = viemNamehash(name);
  return Object.freeze({
    ...label,
    name,
    namehash,
    tokenId: BigInt(label.labelhash),
  });
}
