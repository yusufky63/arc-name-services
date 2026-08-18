import { Pool } from "pg";
import type { Hex } from "viem";
import { assertTransition, type KeeperOrder, type OrderState } from "./state.js";

export interface OrderPatch {
  permitId?: Hex;
  permitPayload?: Record<string, unknown>;
  permitSignature?: Hex;
  paymentIdentifier?: Hex;
  paymentPayload?: Record<string, unknown>;
  registrationTxHash?: Hex;
  registrationTokenId?: bigint;
  settlementTxHash?: Hex;
  refundTxHash?: Hex;
  failureCode?: string;
}

export interface OrderStore {
  create(order: KeeperOrder): Promise<{ order: KeeperOrder; idempotent: boolean }>;
  get(id: string): Promise<KeeperOrder | null>;
  transition(id: string, from: OrderState, to: OrderState, patch?: OrderPatch): Promise<KeeperOrder>;
  listReconcilable(limit: number): Promise<KeeperOrder[]>;
}

export class MemoryOrderStore implements OrderStore {
  readonly orders = new Map<string, KeeperOrder>();
  readonly byIdempotency = new Map<string, string>();

  async create(order: KeeperOrder) {
    const existingId = this.byIdempotency.get(order.idempotencyKey);
    if (existingId) {
      const existing = this.orders.get(existingId)!;
      if (existing.requestFingerprint !== order.requestFingerprint) throw new Error("idempotency key reused with different request");
      return { order: structuredClone(existing), idempotent: true };
    }
    this.orders.set(order.id, structuredClone(order));
    this.byIdempotency.set(order.idempotencyKey, order.id);
    return { order: structuredClone(order), idempotent: false };
  }
  async get(id: string) { const item = this.orders.get(id); return item ? structuredClone(item) : null; }
  async transition(id: string, from: OrderState, to: OrderState, patch: OrderPatch = {}) {
    assertTransition(from, to);
    const order = this.orders.get(id);
    if (!order || order.state !== from) throw new Error("order CAS conflict");
    Object.assign(order, patch, { state: to, updatedAt: new Date(order.updatedAt.getTime() + 1) });
    return structuredClone(order);
  }
  async listReconcilable(limit: number) {
    return [...this.orders.values()].filter((o) => ["payment_authorized", "registration_submitted", "registration_confirmed", "refund_pending"].includes(o.state)).slice(0, limit).map((o) => structuredClone(o));
  }
}

function parseOrder(row: Record<string, unknown>): KeeperOrder {
  return {
    id: row.id as string,
    idempotencyKey: row.idempotency_key as string,
    requestFingerprint: row.request_fingerprint as Hex,
    state: row.state as OrderState,
    normalizedLabel: row.normalized_label as string,
    labelHash: row.label_hash as Hex,
    namehash: row.namehash as Hex,
    recipient: row.recipient as KeeperOrder["recipient"],
    controller: row.controller as KeeperOrder["controller"],
    releaseId: row.release_id as Hex,
    exactAmount: BigInt(row.exact_amount as string),
    permitId: row.permit_id as Hex | null,
    permitPayload: row.permit_payload as Record<string, unknown> | null,
    permitSignature: row.permit_signature as Hex | null,
    paymentIdentifier: row.payment_identifier as Hex | null,
    paymentPayload: row.payment_payload as Record<string, unknown> | null,
    registrationTxHash: row.registration_tx_hash as Hex | null,
    registrationTokenId: row.registration_token_id === null ? null : BigInt(row.registration_token_id as string),
    settlementTxHash: row.settlement_tx_hash as Hex | null,
    refundTxHash: row.refund_tx_hash as Hex | null,
    failureCode: row.failure_code as string | null,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

export class PostgresOrderStore implements OrderStore {
  constructor(readonly pool: Pool) {}
  async create(order: KeeperOrder) {
    const inserted = await this.pool.query(
      `INSERT INTO x402_orders
       (id,idempotency_key,request_fingerprint,state,normalized_label,label_hash,namehash,recipient,controller,release_id,exact_amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING *`,
      [order.id, order.idempotencyKey, order.requestFingerprint, order.state, order.normalizedLabel, order.labelHash, order.namehash, order.recipient, order.controller, order.releaseId, order.exactAmount.toString()],
    );
    if (inserted.rows[0]) return { order: parseOrder(inserted.rows[0]), idempotent: false };
    const existing = await this.pool.query("SELECT * FROM x402_orders WHERE idempotency_key=$1", [order.idempotencyKey]);
    const parsed = parseOrder(existing.rows[0]);
    if (parsed.requestFingerprint !== order.requestFingerprint) throw new Error("idempotency key reused with different request");
    return { order: parsed, idempotent: true };
  }
  async get(id: string) {
    const result = await this.pool.query("SELECT * FROM x402_orders WHERE id=$1", [id]);
    return result.rows[0] ? parseOrder(result.rows[0]) : null;
  }
  async transition(id: string, from: OrderState, to: OrderState, patch: OrderPatch = {}) {
    assertTransition(from, to);
    const result = await this.pool.query(
      `UPDATE x402_orders SET state=$3,
       permit_id=COALESCE($4,permit_id), permit_payload=COALESCE($5::jsonb,permit_payload),
       permit_signature=COALESCE($6,permit_signature), payment_identifier=COALESCE($7,payment_identifier),
       payment_payload=COALESCE($8::jsonb,payment_payload), registration_tx_hash=COALESCE($9,registration_tx_hash),
       registration_token_id=COALESCE($10,registration_token_id), settlement_tx_hash=COALESCE($11,settlement_tx_hash),
       refund_tx_hash=COALESCE($12,refund_tx_hash), failure_code=COALESCE($13,failure_code), updated_at=now()
       WHERE id=$1 AND state=$2 RETURNING *`,
      [id, from, to, patch.permitId ?? null, patch.permitPayload ? JSON.stringify(patch.permitPayload) : null,
       patch.permitSignature ?? null, patch.paymentIdentifier ?? null, patch.paymentPayload ? JSON.stringify(patch.paymentPayload) : null,
       patch.registrationTxHash ?? null, patch.registrationTokenId?.toString() ?? null, patch.settlementTxHash ?? null, patch.refundTxHash ?? null, patch.failureCode ?? null],
    );
    if (!result.rows[0]) throw new Error("order CAS conflict");
    return parseOrder(result.rows[0]);
  }
  async listReconcilable(limit: number) {
    const result = await this.pool.query(
      "SELECT * FROM x402_orders WHERE state IN ('payment_authorized','registration_submitted','registration_confirmed','refund_pending') ORDER BY updated_at ASC LIMIT $1",
      [limit],
    );
    return result.rows.map(parseOrder);
  }
}

export async function migrateKeeper(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS x402_orders (
      id uuid PRIMARY KEY,
      idempotency_key varchar(128) NOT NULL UNIQUE,
      request_fingerprint char(66) NOT NULL,
      state text NOT NULL CHECK (state IN ('quoted','permit_issued','payment_authorized','registration_submitted','registration_confirmed','payment_settled','refund_pending','refunded','manual_review')),
      normalized_label text NOT NULL,
      label_hash char(66) NOT NULL,
      namehash char(66) NOT NULL,
      recipient char(42) NOT NULL,
      controller char(42) NOT NULL,
      release_id char(66) NOT NULL,
      exact_amount numeric(78,0) NOT NULL,
      permit_id char(66),
      permit_payload jsonb,
      permit_signature text,
      payment_identifier char(66),
      payment_payload jsonb,
      registration_tx_hash char(66),
      registration_token_id numeric(78,0),
      settlement_tx_hash char(66),
      refund_tx_hash char(66),
      failure_code text,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS x402_orders_reconcile_idx ON x402_orders(state,updated_at);
    CREATE UNIQUE INDEX IF NOT EXISTS x402_orders_payment_identifier_idx ON x402_orders(payment_identifier) WHERE payment_identifier IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS x402_orders_permit_id_idx ON x402_orders(permit_id) WHERE permit_id IS NOT NULL;
  `);
}
