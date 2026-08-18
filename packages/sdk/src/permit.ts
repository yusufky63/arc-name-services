import type { Address, Hex, TypedDataDomain } from "viem";
import { ARC_TESTNET_CHAIN_ID } from "@contour/config";

export interface RegistrationPermit {
  chainId: bigint;
  controller: Address;
  releaseId: Hex;
  normalizationProfileHash: Hex;
  normalizedLabelHash: Hex;
  namehash: Hex;
  requester: Address;
  recipient: Address;
  payer: Address;
  authorizedExecutor: Address;
  durationYears: bigint;
  resolverDataHash: Hex;
  referrer: Address;
  settlementAsset: Address;
  expectedAmount: bigint;
  expectedReferralBps: bigint;
  permitId: Hex;
  nonce: bigint;
  issuedAt: bigint;
  validAfter: bigint;
  validUntil: bigint;
}

export const registrationPermitTypes = {
  RegistrationPermit: [
    { name: "chainId", type: "uint256" },
    { name: "controller", type: "address" },
    { name: "releaseId", type: "bytes32" },
    { name: "normalizationProfileHash", type: "bytes32" },
    { name: "normalizedLabelHash", type: "bytes32" },
    { name: "namehash", type: "bytes32" },
    { name: "requester", type: "address" },
    { name: "recipient", type: "address" },
    { name: "payer", type: "address" },
    { name: "authorizedExecutor", type: "address" },
    { name: "durationYears", type: "uint256" },
    { name: "resolverDataHash", type: "bytes32" },
    { name: "referrer", type: "address" },
    { name: "settlementAsset", type: "address" },
    { name: "expectedAmount", type: "uint256" },
    { name: "expectedReferralBps", type: "uint256" },
    { name: "permitId", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "issuedAt", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validUntil", type: "uint256" },
  ],
} as const;

export function registrationPermitDomain(controller: Address): TypedDataDomain {
  return {
    name: "Arc Registrar Controller",
    version: "1",
    chainId: ARC_TESTNET_CHAIN_ID,
    verifyingContract: controller,
  };
}

export function assertPermitWindow(permit: RegistrationPermit, nowSeconds: bigint): void {
  if (permit.chainId !== BigInt(ARC_TESTNET_CHAIN_ID)) throw new Error("permit chain mismatch");
  if (nowSeconds < permit.validAfter) throw new Error("permit is not valid yet");
  if (nowSeconds > permit.validUntil) throw new Error("permit expired");
  if (permit.validAfter > permit.issuedAt || permit.issuedAt > permit.validUntil) {
    throw new Error("invalid permit time ordering");
  }
  if (permit.issuedAt - permit.validAfter > 5n) {
    throw new Error("permit validAfter clock skew exceeds five seconds");
  }
  if (permit.validUntil - permit.validAfter > 300n) {
    throw new Error("permit validity exceeds 300 seconds");
  }
}
