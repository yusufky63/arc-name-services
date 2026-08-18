import { keccak256 } from "viem";

export const TEST_CONTROLLER_RUNTIME_CODE = "0x6001600155";
export const TEST_MARKETPLACE_RUNTIME_CODE = "0x6002600255";

const CONTROLLER_HASH = "0x19c00a6464ca88927b248a7a48b90e0b7f2be1ed053132a3abb7227739509341";
const MARKETPLACE_HASH = "0x41675e8c1155c91c315436d3fac034414170cd9b425f9ffd44e61964b0255507";

/** Deterministic fake-client dependency; production runners always default to viem keccak256. */
export function testRuntimeCodeHasher(code) {
  if (code === TEST_CONTROLLER_RUNTIME_CODE) return CONTROLLER_HASH;
  if (code === TEST_MARKETPLACE_RUNTIME_CODE) return MARKETPLACE_HASH;
  return keccak256(code);
}
