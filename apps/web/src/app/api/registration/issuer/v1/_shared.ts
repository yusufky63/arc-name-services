import { getAddress, isAddress, zeroAddress, type Hex } from "viem";
import {
  isSupportedWalletSignature,
  type RegistrationIntent,
} from "../../../../../lib/permit-issuer";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const INTENT_KEYS = [
  "requestId",
  "rawLabel",
  "normalizationAccepted",
  "requester",
  "recipient",
  "payer",
  "authorizedExecutor",
  "durationYears",
  "resolverDataHash",
  "referrer",
] as const;

const PERMIT_KEYS = [
  ...INTENT_KEYS,
  "challengeId",
  "challengeMessage",
  "challengeProof",
  "challengeSignature",
] as const;

export class IssuerAdapterInputError extends Error {
  constructor(message = "Invalid issuer request.") {
    super(message);
    this.name = "IssuerAdapterInputError";
  }
}

function assertExactKeys(body: Record<string, unknown>, allowed: readonly string[]) {
  const expected = new Set(allowed);
  if (
    Object.keys(body).length !== expected.size ||
    Object.keys(body).some((key) => !expected.has(key))
  ) {
    throw new IssuerAdapterInputError("Issuer request fields do not match the canonical schema.");
  }
}

export function parseIssuerIntent(
  body: Record<string, unknown>,
  exactKeys: readonly string[] = INTENT_KEYS,
): RegistrationIntent {
  assertExactKeys(body, exactKeys);
  if (
    typeof body.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(body.requestId) ||
    typeof body.rawLabel !== "string" ||
    body.rawLabel.length === 0 ||
    body.rawLabel.length > 256 ||
    typeof body.normalizationAccepted !== "boolean" ||
    typeof body.durationYears !== "number" ||
    !Number.isInteger(body.durationYears) ||
    body.durationYears < 1 ||
    body.durationYears > 10 ||
    typeof body.resolverDataHash !== "string" ||
    !BYTES32_PATTERN.test(body.resolverDataHash)
  ) {
    throw new IssuerAdapterInputError("Registration intent is outside policy.");
  }

  const partyValues = [body.requester, body.recipient, body.payer, body.authorizedExecutor];
  if (partyValues.some((value) => typeof value !== "string" || !isAddress(value))) {
    throw new IssuerAdapterInputError("Registration intent contains an invalid address.");
  }
  if (typeof body.referrer !== "string" || !isAddress(body.referrer)) {
    throw new IssuerAdapterInputError("Registration intent contains an invalid referrer.");
  }

  const requester = getAddress(body.requester as string);
  const recipient = getAddress(body.recipient as string);
  const payer = getAddress(body.payer as string);
  const authorizedExecutor = getAddress(body.authorizedExecutor as string);
  const referrer = getAddress(body.referrer);
  if (
    [requester, recipient, payer, authorizedExecutor].some((address) => address === zeroAddress) ||
    requester !== recipient ||
    requester !== payer ||
    requester !== authorizedExecutor ||
    referrer !== zeroAddress
  ) {
    throw new IssuerAdapterInputError("Wallet-bound registration parties are unsafe.");
  }

  return {
    requestId: body.requestId,
    rawLabel: body.rawLabel,
    normalizationAccepted: body.normalizationAccepted,
    requester,
    recipient,
    payer,
    authorizedExecutor,
    durationYears: body.durationYears,
    resolverDataHash: body.resolverDataHash as Hex,
    referrer,
  };
}

export function parseIssuerPermitRequest(body: Record<string, unknown>) {
  const intent = parseIssuerIntent(body, PERMIT_KEYS);
  if (
    typeof body.challengeId !== "string" ||
    !UUID_PATTERN.test(body.challengeId) ||
    typeof body.challengeMessage !== "string" ||
    body.challengeMessage.length === 0 ||
    body.challengeMessage.length > 4_096 ||
    typeof body.challengeProof !== "string" ||
    !BYTES32_PATTERN.test(body.challengeProof) ||
    typeof body.challengeSignature !== "string" ||
    !isSupportedWalletSignature(body.challengeSignature)
  ) {
    throw new IssuerAdapterInputError("Wallet challenge fields are invalid.");
  }
  return {
    intent,
    challengeId: body.challengeId,
    challengeMessage: body.challengeMessage,
    challengeProof: body.challengeProof as Hex,
    challengeSignature: body.challengeSignature as Hex,
  };
}

export function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_, item) => (typeof item === "bigint" ? item.toString() : item)),
  ) as unknown;
}
