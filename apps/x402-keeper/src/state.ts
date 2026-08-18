import type { Address, Hex } from "viem";

export const ORDER_STATES = [
  "quoted",
  "permit_issued",
  "payment_authorized",
  "registration_submitted",
  "registration_confirmed",
  "payment_settled",
  "refund_pending",
  "refunded",
  "manual_review",
] as const;
export type OrderState = (typeof ORDER_STATES)[number];

export const ALLOWED_TRANSITIONS: Readonly<Record<OrderState, readonly OrderState[]>> = {
  quoted: ["permit_issued", "manual_review"],
  permit_issued: ["payment_authorized", "manual_review"],
  payment_authorized: ["registration_submitted", "refund_pending", "manual_review"],
  registration_submitted: ["registration_confirmed", "refund_pending", "manual_review"],
  registration_confirmed: ["payment_settled", "refund_pending", "manual_review"],
  payment_settled: ["refund_pending", "manual_review"],
  refund_pending: ["refunded", "manual_review"],
  refunded: [],
  manual_review: [],
};

export interface KeeperOrder {
  id: string;
  idempotencyKey: string;
  requestFingerprint: Hex;
  state: OrderState;
  normalizedLabel: string;
  labelHash: Hex;
  namehash: Hex;
  recipient: Address;
  controller: Address;
  releaseId: Hex;
  exactAmount: bigint;
  permitId: Hex | null;
  permitPayload: Record<string, unknown> | null;
  permitSignature: Hex | null;
  paymentIdentifier: Hex | null;
  paymentPayload: Record<string, unknown> | null;
  registrationTxHash: Hex | null;
  registrationTokenId: bigint | null;
  settlementTxHash: Hex | null;
  refundTxHash: Hex | null;
  failureCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function assertTransition(from: OrderState, to: OrderState): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) throw new Error(`invalid keeper transition ${from} -> ${to}`);
}
