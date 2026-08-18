import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify from "fastify";
import { isAddress, type Address } from "viem";
import { parseDeploymentManifest } from "@contour/config";
import { ArcGateway } from "./gateway.js";
import { KeeperWorkflow } from "./workflow.js";
import { MemoryOrderStore } from "./store.js";

const enabled = process.env.X402_ENABLED === "true";

if (!enabled) {
  throw new Error(
    "x402 keeper is fail-closed (X402_ENABLED is not true); no payment or registration was attempted",
  );
}

const keeperAddressRaw = process.env.KEEPER_ADDRESS;
const payToRaw = process.env.PAY_TO ?? process.env.TREASURY_ADDRESS;
const gatewayUrl = process.env.GATEWAY_FACILITATOR_URL ?? "https://gateway.circle.com";

if (!keeperAddressRaw || !isAddress(keeperAddressRaw) || !payToRaw || !isAddress(payToRaw)) {
  throw new Error(
    "startup must fail: missing required environment variables (KEEPER_ADDRESS, PAY_TO) for x402 keeper",
  );
}

const keeperAddress = keeperAddressRaw as Address;
const payTo = payToRaw as Address;

let manifestRaw: unknown;
try {
  manifestRaw = JSON.parse(
    readFileSync(resolve(process.cwd(), "../../deployments/5042002.json"), "utf8"),
  );
} catch {
  try {
    manifestRaw = JSON.parse(
      readFileSync(resolve(process.cwd(), "deployments/5042002.json"), "utf8"),
    );
  } catch {
    manifestRaw = {};
  }
}
const manifest = parseDeploymentManifest(manifestRaw);
const store = new MemoryOrderStore();
const gateway = new ArcGateway(gatewayUrl);

export function buildServer() {
  const app = Fastify({ logger: false });

  let isPaused = false;
  const workflow = new KeeperWorkflow(
    manifest,
    store,
    gateway,
    {
      async quote() {
        return 2_500_000n; // Default 1-year quote
      },
      async issueAgentPermit(input) {
        return {
          permitId: `0x${"11".repeat(32)}`,
          permit: {
            chainId: String(manifest.chain.id),
            controller: input.controller,
            releaseId: input.releaseId,
            normalizationProfileHash: input.normalizationProfileHash,
            normalizedLabelHash: input.labelHash,
            namehash: input.namehash,
            recipient: input.recipient,
            payer: input.payer,
            authorizedExecutor: input.authorizedExecutor,
            durationYears: String(input.durationYears),
            settlementAsset: input.settlementAsset,
            expectedAmount: input.exactAmount.toString(),
            permitId: `0x${"11".repeat(32)}`,
            validAfter: String(Math.floor(Date.now() / 1000) - 10),
            validUntil: String(Math.floor(Date.now() / 1000) + 180),
          },
          signature: `0x${"22".repeat(65)}`,
        };
      },
      async submitRegistration() {
        return `0x${"33".repeat(32)}`;
      },
      async receipt() {
        return { state: "pending" };
      },
      async refund() {
        return { refunded: false };
      },
    },
    payTo,
    keeperAddress,
    1_000_000_000n, // Max spend
    () => isPaused,
  );

  app.get("/healthz", async () => ({ ok: true, keeper: keeperAddress, x402: true }));

  app.post<{
    Body: {
      rawLabel: string;
      normalizationAccepted: boolean;
      recipient: Address;
      durationYears: number;
      idempotencyKey?: string;
    };
  }>("/v1/orders", async (request, reply) => {
    try {
      const order = await workflow.create({
        rawLabel: request.body.rawLabel,
        normalizationAccepted: request.body.normalizationAccepted,
        recipient: request.body.recipient,
        durationYears: request.body.durationYears,
        idempotencyKey: request.body.idempotencyKey ?? crypto.randomUUID(),
      });
      return reply.code(201).send(order);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Order creation failed",
      });
    }
  });

  app.post<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>("/v1/orders/:id/authorize", async (request, reply) => {
    try {
      const result = await workflow.authorize(request.params.id, request.body);
      return reply.send(result);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Authorization failed",
      });
    }
  });

  return app;
}

if (process.env.NODE_ENV !== "test" && process.env.START_SERVER === "true") {
  const port = Number(process.env.PORT ?? 3004);
  const server = buildServer();

  server.listen({ port, host: "0.0.0.0" }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
