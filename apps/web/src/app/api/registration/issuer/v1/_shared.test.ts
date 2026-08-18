import { describe, expect, it, vi } from "vitest";
import { zeroAddress } from "viem";

vi.mock("server-only", () => ({}));

import {
  IssuerAdapterInputError,
  jsonSafe,
  parseIssuerIntent,
  parseIssuerPermitRequest,
} from "./_shared";

const intent = {
  requestId: "request-0001",
  rawLabel: "alice",
  normalizationAccepted: true,
  requester: "0x1111111111111111111111111111111111111111",
  recipient: "0x1111111111111111111111111111111111111111",
  payer: "0x1111111111111111111111111111111111111111",
  authorizedExecutor: "0x1111111111111111111111111111111111111111",
  durationYears: 1,
  resolverDataHash: `0x${"00".repeat(32)}`,
  referrer: zeroAddress,
};

describe("same-origin issuer v1 adapter validation", () => {
  it("accepts the exact wallet-bound canonical intent", () => {
    expect(parseIssuerIntent(intent)).toMatchObject({
      requestId: intent.requestId,
      requester: intent.requester,
      payer: intent.requester,
      authorizedExecutor: intent.requester,
      referrer: zeroAddress,
    });
  });

  it("requires the complete challenge proof and signature envelope", () => {
    const parsed = parseIssuerPermitRequest({
      ...intent,
      challengeId: "9dfbc20d-4cc0-48d7-84f6-144154cc31d4",
      challengeMessage: "canonical challenge",
      challengeProof: `0x${"ab".repeat(32)}`,
      challengeSignature: `0x${"cd".repeat(65)}`,
    });
    expect(parsed.challengeId).toBe("9dfbc20d-4cc0-48d7-84f6-144154cc31d4");
    expect(parsed.challengeProof).toBe(`0x${"ab".repeat(32)}`);
  });

  it("accepts bounded smart-account signatures", () => {
    const parsed = parseIssuerPermitRequest({
      ...intent,
      challengeId: "9dfbc20d-4cc0-48d7-84f6-144154cc31d4",
      challengeMessage: "canonical challenge",
      challengeProof: `0x${"ab".repeat(32)}`,
      challengeSignature: `0x${"cd".repeat(96)}`,
    });
    expect(parsed.challengeSignature).toHaveLength(194);
  });

  it("rejects schema ambiguity and unsafe wallet parties", () => {
    expect(() => parseIssuerIntent({ ...intent, ignored: true })).toThrow(
      IssuerAdapterInputError,
    );
    expect(() => parseIssuerIntent({
      ...intent,
      payer: "0x3333333333333333333333333333333333333333",
    })).toThrow(/unsafe/);
    expect(() => parseIssuerIntent({
      ...intent,
      recipient: "0x2222222222222222222222222222222222222222",
    })).toThrow(/unsafe/);
    expect(() => parseIssuerPermitRequest({
      ...intent,
      challengeId: "not-a-uuid",
      challengeMessage: "canonical challenge",
      challengeProof: `0x${"ab".repeat(32)}`,
      challengeSignature: `0x${"cd".repeat(65)}`,
    })).toThrow(/challenge fields/);
  });

  it("serializes permit bigint fields without exposing runtime objects", () => {
    expect(jsonSafe({ nonce: 7n, nested: { validUntil: 180n } })).toEqual({
      nonce: "7",
      nested: { validUntil: "180" },
    });
  });
});
