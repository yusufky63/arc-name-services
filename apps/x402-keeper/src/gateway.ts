import { BatchFacilitatorClient } from "@circle-fin/x402-batching/server";

export interface GatewayRequirements {
  scheme: "exact";
  network: "eip155:5042002";
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: Record<string, unknown>;
}

export class ArcGateway {
  readonly client: BatchFacilitatorClient;
  private supportedExtra: Record<string, unknown> | null = null;
  constructor(readonly url: string) { this.client = new BatchFacilitatorClient({ url }); }

  async discover() {
    const supported = await this.client.getSupported();
    const profile = supported.kinds.find((kind) => kind.scheme === "exact" && kind.network === "eip155:5042002");
    if (!profile?.extra?.verifyingContract) throw new Error("Circle facilitator does not advertise the required Arc exact profile");
    this.supportedExtra = profile.extra;
  }

  requirements(amount: bigint, asset: string, payTo: string): GatewayRequirements {
    if (!this.supportedExtra) throw new Error("facilitator profile has not been discovered");
    return {
      scheme: "exact", network: "eip155:5042002", asset, amount: amount.toString(), payTo,
      maxTimeoutSeconds: 120, extra: this.supportedExtra,
    };
  }

  verify(payment: Record<string, unknown>, requirements: GatewayRequirements) {
    return this.client.verify(payment as never, requirements as never);
  }
  settle(payment: Record<string, unknown>, requirements: GatewayRequirements) {
    return this.client.settle(payment as never, requirements as never);
  }
}
