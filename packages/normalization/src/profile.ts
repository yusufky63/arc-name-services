import type { Hex } from "viem";

export const NORMALIZATION_PROFILE = Object.freeze({
  id: "arc-ensip15-single-label-v1",
  implementation: "@adraffy/ens-normalize@1.11.1",
  unicodeVersion: "17.0.0",
  upstreamSpecSha256: "0x4febc8f5d285cbf80d2320fb0c1777ac25e378eb72910c34ec963d0a4e319c84" as Hex,
  descriptor:
    "ensip15|implementation=@adraffy/ens-normalize@1.11.1|unicode=17.0.0|spec-sha256=4febc8f5d285cbf80d2320fb0c1777ac25e378eb72910c34ec963d0a4e319c84|corpus-sha256=d25e274d718f468f1edbded13a5319a404d9e2dff39ded6ecf78ef88ea37cf60|preprocess=trim|input=single-label|utf8-bytes=1..63|codepoints=1..63|dot=reject|empty=reject",
  /** SHA-256 of descriptor UTF-8 bytes. */
  profileHash: "0x0889fdb1d0500090d2c605094dd2bd30510a137778f641aca67d8d2fb491f89c" as Hex,
  /** SHA-256 of canonical JSON text, excluding an optional trailing LF. */
  corpusHash: "0xd25e274d718f468f1edbded13a5319a404d9e2dff39ded6ecf78ef88ea37cf60" as Hex,
  maxUtf8Bytes: 63,
  maxCodePoints: 63,
} as const);
