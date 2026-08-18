import { createHash, randomUUID } from "node:crypto";
import { getAddress, type Address, type Hex } from "viem";
import { ARC_TESTNET_CAIP2, ARC_TESTNET_CHAIN_ID, ARC_USDC, type DeploymentManifest } from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";
import type { ArcGateway, GatewayRequirements } from "./gateway.js";
import type { KeeperOrder } from "./state.js";
import type { OrderStore } from "./store.js";

const sha = (value: unknown): Hex => `0x${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

export interface KeeperDependencies {
  quote(normalizedLabel: string, durationYears: bigint): Promise<bigint>;
  issueAgentPermit(input: {
    normalizedLabel: string; labelHash: Hex; namehash: Hex; recipient: Address; payer: Address;
    authorizedExecutor: Address; durationYears: number; exactAmount: bigint; orderId: string;
    requestFingerprint: Hex; controller: Address; releaseId: Hex; normalizationProfileHash: Hex;
    settlementAsset: Address;
  }): Promise<{ permitId: Hex; permit: AgentPermitPayload; signature: Hex }>;
  submitRegistration(input: { orderId: string; requestFingerprint: Hex; normalizedLabel: string; permit: Record<string, unknown>; signature: Hex }): Promise<Hex>;
  receipt(txHash: Hex): Promise<RegistrationReceiptProof>;
  refund(order: KeeperOrder): Promise<{ refunded: boolean; transaction?: Hex }>;
}

export interface AgentPermitPayload extends Record<string, unknown> {
  chainId: string;
  controller: Address;
  releaseId: Hex;
  normalizationProfileHash: Hex;
  normalizedLabelHash: Hex;
  namehash: Hex;
  recipient: Address;
  payer: Address;
  authorizedExecutor: Address;
  durationYears: string;
  settlementAsset: Address;
  expectedAmount: string;
  permitId: Hex;
  validAfter: string;
  validUntil: string;
}

export type RegistrationReceiptProof =
  | { state: "pending" }
  | { state: "reverted" }
  | {
      state: "success";
      chainId: number;
      receiptStatus: "success";
      transactionTo: Address;
      decodedFunction: "register";
      decodedLabel: string;
      decodedPermitId: Hex;
      decodedReleaseId: Hex;
      decodedNamehash: Hex;
      decodedRecipient: Address;
      decodedAuthorizedExecutor: Address;
      decodedExpectedAmount: string;
      controllerEventEmitter: Address;
      registeredLabelHash: Hex;
      registeredOwner: Address;
      registrarTokenId: string;
      permitConsumedId: Hex;
      registrationEventCount: 1;
      permitConsumedEventCount: 1;
    };

function sameHex(a: string, b: string): boolean { return a.toLowerCase() === b.toLowerCase(); }

export function assertReceiptProof(order: KeeperOrder, proof: Extract<RegistrationReceiptProof, { state: "success" }>, keeperAddress: Address): bigint {
  if (
    proof.chainId !== ARC_TESTNET_CHAIN_ID || proof.receiptStatus !== "success" ||
    getAddress(proof.transactionTo) !== getAddress(order.controller) ||
    getAddress(proof.controllerEventEmitter) !== getAddress(order.controller) ||
    proof.decodedFunction !== "register" || proof.decodedLabel !== order.normalizedLabel ||
    !sameHex(proof.decodedPermitId, order.permitId ?? "") || !sameHex(proof.permitConsumedId, order.permitId ?? "") ||
    !sameHex(proof.decodedReleaseId, order.releaseId) || !sameHex(proof.decodedNamehash, order.namehash) ||
    getAddress(proof.decodedRecipient) !== getAddress(order.recipient) || getAddress(proof.registeredOwner) !== getAddress(order.recipient) ||
    getAddress(proof.decodedAuthorizedExecutor) !== getAddress(keeperAddress) ||
    BigInt(proof.decodedExpectedAmount) !== order.exactAmount || !sameHex(proof.registeredLabelHash, order.labelHash) ||
    proof.registrationEventCount !== 1 || proof.permitConsumedEventCount !== 1
  ) throw new Error("registration receipt proof does not match durable order");
  const tokenId = BigInt(proof.registrarTokenId);
  if (tokenId !== BigInt(order.labelHash)) throw new Error("registration tokenId proof mismatch");
  return tokenId;
}

export class KeeperWorkflow {
  constructor(
    readonly manifest: DeploymentManifest,
    readonly store: OrderStore,
    readonly gateway: ArcGateway,
    readonly dependencies: KeeperDependencies,
    readonly payTo: Address,
    readonly keeperAddress: Address,
    readonly maxOrderBaseUnits: bigint,
    readonly paused: () => boolean,
    readonly now: () => Date = () => new Date(),
  ) {}

  async create(input: { rawLabel: string; normalizationAccepted: boolean; recipient: Address; durationYears: number; idempotencyKey: string }) {
    if (this.paused()) throw new Error("keeper is paused");
    const suffix = this.manifest.namespace.suffix;
    const controller = this.manifest.contracts.controller.address;
    const releaseId = this.manifest.releaseId;
    if (!suffix || !controller || !releaseId || !this.manifest.x402.active) throw new Error("x402 is not active");
    const identity = deriveNameIdentity(input.rawLabel, suffix);
    if (identity.changed && !input.normalizationAccepted) throw new Error(`normalization changed the label to ${identity.normalized}`);
    if (!Number.isInteger(input.durationYears) || input.durationYears < 1 || input.durationYears > 10) throw new Error("invalid duration");
    const recipient = getAddress(input.recipient);
    const exactAmount = await this.dependencies.quote(identity.normalized, BigInt(input.durationYears));
    if (exactAmount <= 0n || exactAmount > this.maxOrderBaseUnits) throw new Error("quote exceeds keeper spend policy");
    const requestFingerprint = sha({
      labelHash: identity.labelhash, namehash: identity.namehash, recipient,
      payer: this.keeperAddress, authorizedExecutor: this.keeperAddress,
      durationYears: input.durationYears, controller, releaseId,
      normalizationProfileHash: this.manifest.normalization.profileHash,
      settlementAsset: this.manifest.settlement.erc20Address,
      exactAmount: exactAmount.toString(),
    });
    const date = this.now();
    const candidate: KeeperOrder = {
      id: randomUUID(), idempotencyKey: input.idempotencyKey, requestFingerprint, state: "quoted",
      normalizedLabel: identity.normalized, labelHash: identity.labelhash, namehash: identity.namehash, recipient, controller, releaseId, exactAmount,
      permitId: null, permitPayload: null, permitSignature: null, paymentIdentifier: null, paymentPayload: null,
      registrationTxHash: null, registrationTokenId: null, settlementTxHash: null, refundTxHash: null, failureCode: null,
      createdAt: date, updatedAt: date,
    };
    const created = await this.store.create(candidate);
    if (created.order.state !== "quoted") return this.response(created.order, input.durationYears);
    const signed = await this.dependencies.issueAgentPermit({
      normalizedLabel: identity.normalized, labelHash: identity.labelhash, namehash: identity.namehash,
      recipient, payer: this.keeperAddress, authorizedExecutor: this.keeperAddress,
      durationYears: input.durationYears, exactAmount, orderId: created.order.id, requestFingerprint,
      controller, releaseId, normalizationProfileHash: this.manifest.normalization.profileHash,
      settlementAsset: this.manifest.settlement.erc20Address,
    });
    this.assertPermit(signed.permitId, signed.permit, identity.namehash, created.order, input.durationYears);
    const permitted = await this.store.transition(created.order.id, "quoted", "permit_issued", {
      permitId: signed.permitId, permitPayload: signed.permit, permitSignature: signed.signature,
    });
    return this.response(permitted, input.durationYears);
  }

  private response(order: KeeperOrder, durationYears: number) {
    const requirements = this.gateway.requirements(order.exactAmount, ARC_USDC.erc20Address, this.payTo);
    return {
      orderId: order.id, state: order.state, normalizedLabel: order.normalizedLabel,
      exactAmount: order.exactAmount.toString(), network: ARC_TESTNET_CAIP2, asset: ARC_USDC.erc20Address,
      durationYears, paymentRequired: { x402Version: 2, resource: { url: `/v1/orders/${order.id}/authorize`, description: "Arc Testnet name registration", mimeType: "application/json" }, accepts: [requirements] },
    };
  }

  async authorize(orderId: string, payment: Record<string, unknown>) {
    if (this.paused()) throw new Error("keeper is paused");
    const order = await this.required(orderId);
    const identifier = sha(payment);
    if (order.state === "payment_authorized") {
      if (order.paymentIdentifier !== identifier) throw new Error("order is already bound to a different payment authorization");
      return this.submitAuthorized(order);
    }
    if (["registration_submitted", "registration_confirmed", "payment_settled"].includes(order.state)) {
      if (order.paymentIdentifier !== identifier) throw new Error("order is already bound to a different payment authorization");
      return order;
    }
    if (order.state !== "permit_issued") throw new Error("order is not awaiting payment authorization");
    const requirements = this.gateway.requirements(order.exactAmount, ARC_USDC.erc20Address, this.payTo);
    const verified = await this.gateway.verify(payment, requirements);
    if (!verified.isValid) throw new Error("payment authorization rejected");
    const authorized = await this.store.transition(order.id, "permit_issued", "payment_authorized", { paymentIdentifier: identifier, paymentPayload: payment });
    return this.submitAuthorized(authorized);
  }

  async reconcile(orderId: string) {
    const order = await this.required(orderId);
    if (order.state === "payment_authorized") return this.submitAuthorized(order);
    if (order.state === "registration_submitted") {
      const receipt = await this.dependencies.receipt(order.registrationTxHash!);
      if (receipt.state === "pending") return order;
      if (receipt.state === "reverted") return this.store.transition(order.id, "registration_submitted", "refund_pending", { failureCode: "REGISTRATION_REVERTED" });
      let tokenId: bigint;
      try { tokenId = assertReceiptProof(order, receipt, this.keeperAddress); }
      catch {
        return this.store.transition(order.id, "registration_submitted", "manual_review", { failureCode: "TOKEN_ID_NOT_PROVEN" });
      }
      return this.store.transition(order.id, "registration_submitted", "registration_confirmed", { registrationTokenId: tokenId });
    }
    if (order.state === "registration_confirmed") {
      const requirements = this.gateway.requirements(order.exactAmount, ARC_USDC.erc20Address, this.payTo);
      const settled = await this.gateway.settle(order.paymentPayload!, requirements);
      if (!settled.success) return this.store.transition(order.id, "registration_confirmed", "manual_review", { failureCode: "SETTLEMENT_FAILED_AFTER_REGISTRATION" });
      return this.store.transition(order.id, "registration_confirmed", "payment_settled", { settlementTxHash: settled.transaction as Hex });
    }
    if (order.state === "refund_pending") {
      const result = await this.dependencies.refund(order);
      if (!result.refunded) return order;
      return this.store.transition(order.id, "refund_pending", "refunded", result.transaction ? { refundTxHash: result.transaction } : {});
    }
    return order;
  }

  private async required(id: string) {
    const order = await this.store.get(id);
    if (!order) throw new Error("order not found");
    return order;
  }

  private async submitAuthorized(order: KeeperOrder) {
    if (!order.permitPayload || !order.permitSignature) throw new Error("durable permit payload is missing");
    const txHash = await this.dependencies.submitRegistration({
      orderId: order.id,
      requestFingerprint: order.requestFingerprint,
      normalizedLabel: order.normalizedLabel,
      permit: order.permitPayload,
      signature: order.permitSignature,
    });
    return this.store.transition(order.id, "payment_authorized", "registration_submitted", { registrationTxHash: txHash });
  }

  private assertPermit(permitId: Hex, permit: AgentPermitPayload, expectedNamehash: Hex, order: KeeperOrder, durationYears: number) {
    if (
      BigInt(permit.chainId) !== BigInt(ARC_TESTNET_CHAIN_ID) || !sameHex(permit.permitId, permitId) ||
      getAddress(permit.controller) !== getAddress(order.controller) || !sameHex(permit.releaseId, order.releaseId) ||
      !sameHex(permit.normalizationProfileHash, this.manifest.normalization.profileHash) ||
      !sameHex(permit.normalizedLabelHash, order.labelHash) || !sameHex(permit.namehash, expectedNamehash) ||
      getAddress(permit.recipient) !== getAddress(order.recipient) || getAddress(permit.payer) !== getAddress(this.keeperAddress) ||
      getAddress(permit.authorizedExecutor) !== getAddress(this.keeperAddress) || BigInt(permit.durationYears) !== BigInt(durationYears) ||
      getAddress(permit.settlementAsset) !== getAddress(this.manifest.settlement.erc20Address) ||
      BigInt(permit.expectedAmount) !== order.exactAmount || BigInt(permit.validAfter) > BigInt(permit.validUntil)
    ) throw new Error("agent permit does not match durable x402 order");
  }
}
