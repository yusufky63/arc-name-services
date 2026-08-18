#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createPublicClient } from "viem";
import { ARC_TESTNET, parseDeploymentManifest } from "@contour/config";
import { ArcNameClient } from "@contour/sdk";
import { canonicalArcRpcUrl, rateLimitedArcHttp } from "./arc-rpc.js";
import { createContourStdioServer } from "./server-definition.js";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function readManifest(path: string) {
  return parseDeploymentManifest(JSON.parse(await readFile(path, "utf8")));
}

function legacyManifestPaths(): string[] {
  const raw = process.env.MCP_LEGACY_MANIFEST_PATHS?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("MCP_LEGACY_MANIFEST_PATHS must be a JSON array of file paths");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== "string" || item.trim().length === 0)
  ) {
    throw new Error("MCP_LEGACY_MANIFEST_PATHS must be a JSON array of file paths");
  }
  return parsed.map((item) => item.trim());
}

const manifest = await readManifest(required("MCP_MANIFEST_PATH"));
const legacyManifests = await Promise.all(legacyManifestPaths().map(readManifest));
const rpcUrl = canonicalArcRpcUrl(process.env.ARC_RPC_URL ?? manifest.chain.rpcUrl);
const publicClient = createPublicClient({
  chain: ARC_TESTNET,
  transport: rateLimitedArcHttp(rpcUrl),
  batch: { multicall: { wait: 25 } },
});
const client = new ArcNameClient(publicClient, manifest);
const legacyClients = legacyManifests.map((legacy) => new ArcNameClient(publicClient, legacy));
await Promise.all([client.assertChain(), ...legacyClients.map((legacy) => legacy.assertChain())]);

const server = createContourStdioServer({
  canonical: { manifest, client },
  legacy: legacyManifests.map((legacy, index) => ({
    manifest: legacy,
    client: legacyClients[index]!,
  })),
});
await server.connect(new StdioServerTransport());
