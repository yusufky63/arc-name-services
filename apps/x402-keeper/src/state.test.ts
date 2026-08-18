import { describe, expect, it } from "vitest";
import { assertTransition } from "./state.js";
import { MemoryOrderStore } from "./store.js";
import type { KeeperOrder } from "./state.js";
import { assertReceiptProof, type RegistrationReceiptProof } from "./workflow.js";

const order = (): KeeperOrder => ({
  id: "00000000-0000-4000-8000-000000000001",
  idempotencyKey: "request-0001",
  requestFingerprint: `0x${"11".repeat(32)}`,
  state: "quoted",
  normalizedLabel: "alice",
  labelHash: `0x${"22".repeat(32)}`,
  namehash: `0x${"55".repeat(32)}`,
  recipient: "0x1111111111111111111111111111111111111111",
  controller: "0x2222222222222222222222222222222222222222",
  releaseId: `0x${"33".repeat(32)}`,
  exactAmount: 500_000n,
  permitId: null,
  permitPayload: null,
  permitSignature: null,
  paymentIdentifier: null,
  paymentPayload: null,
  registrationTxHash: null,
  registrationTokenId: null,
  settlementTxHash: null,
  refundTxHash: null,
  failureCode: null,
  createdAt: new Date("2030-01-01T00:00:00Z"),
  updatedAt: new Date("2030-01-01T00:00:00Z"),
});

describe("keeper workflow transitions", () => {
  it("allows receipt before settlement", () => {
    expect(() => assertTransition("registration_submitted", "registration_confirmed")).not.toThrow();
    expect(() => assertTransition("registration_confirmed", "payment_settled")).not.toThrow();
  });
  it("forbids payment settlement before registration confirmation", () => {
    expect(() => assertTransition("payment_authorized", "payment_settled")).toThrow(/invalid keeper transition/);
  });
  it("keeps terminal states terminal", () => {
    expect(() => assertTransition("refunded", "quoted")).toThrow();
  });

  it("returns an order idempotently and rejects key reuse", async () => {
    const store = new MemoryOrderStore();
    expect((await store.create(order())).idempotent).toBe(false);
    expect((await store.create(order())).idempotent).toBe(true);
    const changed = order();
    changed.requestFingerprint = `0x${"44".repeat(32)}`;
    await expect(store.create(changed)).rejects.toThrow(/idempotency key reused/);
  });

  it("keeps payment_authorized orders in the reconciliation queue", async () => {
    const store = new MemoryOrderStore();
    await store.create(order());
    await store.transition(order().id, "quoted", "permit_issued");
    await store.transition(order().id, "permit_issued", "payment_authorized");
    expect((await store.listReconcilable(10))[0]?.state).toBe("payment_authorized");
  });

  it("requires complete controller, permit, name and recipient receipt proof", () => {
    const expected = order();
    expected.permitId = `0x${"66".repeat(32)}`;
    const proof: Extract<RegistrationReceiptProof, { state: "success" }> = {
      state: "success", chainId: 5042002, receiptStatus: "success",
      transactionTo: expected.controller, decodedFunction: "register", decodedLabel: expected.normalizedLabel,
      decodedPermitId: expected.permitId, decodedReleaseId: expected.releaseId, decodedNamehash: expected.namehash,
      decodedRecipient: expected.recipient, decodedAuthorizedExecutor: "0x3333333333333333333333333333333333333333",
      decodedExpectedAmount: expected.exactAmount.toString(), controllerEventEmitter: expected.controller,
      registeredLabelHash: expected.labelHash, registeredOwner: expected.recipient,
      registrarTokenId: BigInt(expected.labelHash).toString(), permitConsumedId: expected.permitId,
      registrationEventCount: 1, permitConsumedEventCount: 1,
    };
    expect(assertReceiptProof(expected, proof, "0x3333333333333333333333333333333333333333")).toBe(BigInt(expected.labelHash));
    expect(() => assertReceiptProof(expected, { ...proof, registeredOwner: "0x4444444444444444444444444444444444444444" }, "0x3333333333333333333333333333333333333333")).toThrow(/receipt proof/);
  });
});
