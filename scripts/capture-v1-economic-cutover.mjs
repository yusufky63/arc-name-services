#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicClient, http } from "viem";
import { arcTestnet } from "viem/chains";
import {
  parseDeploymentManifest,
  registrarVersionOf,
} from "../packages/config/dist/index.js";
import {
  captureV1EconomicCutoverEvidence,
  deterministicEconomicCutoverJson,
} from "./lib/v1-economic-cutover-evidence.mjs";

export const V1_ECONOMIC_CUTOVER_HELP = `Usage:
  node scripts/capture-v1-economic-cutover.mjs \\
    --manifest <exact-v1-manifest.json> \\
    --cutover-block <confirmed-block> \\
    --output <new-evidence.json> \\
    [--require-live-listing <label.suffix>]...

The output path is mandatory and must not already exist. All historical calls
use the manifest's canonical Arc RPC and the exact cutover block hash.
`;

function parsePositiveBlock(value) {
  if (!/^[1-9][0-9]*$/.test(value ?? "")) {
    throw new Error("--cutover-block must be a positive decimal integer");
  }
  const parsed = BigInt(value);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("--cutover-block exceeds the safe integer range");
  }
  return parsed;
}

export function parseV1EconomicCutoverArgs(argv) {
  const options = {
    help: false,
    manifestPath: null,
    cutoverBlock: null,
    outputPath: null,
    requiredLiveListings: [],
  };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      options.help = true;
      continue;
    }
    if (
      argument !== "--manifest" &&
      argument !== "--cutover-block" &&
      argument !== "--output" &&
      argument !== "--require-live-listing"
    ) {
      throw new Error(`unsupported argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    if (argument === "--require-live-listing") {
      options.requiredLiveListings.push(value);
      continue;
    }
    if (seen.has(argument)) throw new Error(`${argument} may be provided only once`);
    seen.add(argument);
    if (argument === "--manifest") options.manifestPath = resolve(value);
    if (argument === "--output") options.outputPath = resolve(value);
    if (argument === "--cutover-block") {
      options.cutoverBlock = parsePositiveBlock(value);
    }
  }
  if (options.help) return options;
  if (!options.manifestPath || options.cutoverBlock === null || !options.outputPath) {
    throw new Error("--manifest, --cutover-block and --output are required");
  }
  if (options.manifestPath === options.outputPath) {
    throw new Error("output path must differ from the manifest path");
  }
  return options;
}

async function loadExactV1Manifest(path) {
  let value;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error("exact V1 manifest is unreadable or invalid JSON");
  }
  const manifest = parseDeploymentManifest(value);
  if (registrarVersionOf(manifest) !== "v1") {
    throw new Error("exact cutover manifest must be registrarVersion v1");
  }
  return manifest;
}

function canonicalRpcUrl(manifest, environment) {
  const manifestRpc = manifest.chain.rpcUrl;
  const configured = environment.ARC_RPC_URL?.trim();
  if (configured && configured !== manifestRpc) {
    throw new Error("ARC_RPC_URL must exactly equal the V1 manifest RPC");
  }
  const url = new URL(manifestRpc);
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("V1 manifest RPC must be credential-free HTTPS");
  }
  return manifestRpc;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseV1EconomicCutoverArgs(argv);
  const stdout = dependencies.stdout ?? process.stdout;
  if (options.help) {
    stdout.write(V1_ECONOMIC_CUTOVER_HELP);
    return { help: true };
  }
  const manifest = dependencies.manifest
    ?? await loadExactV1Manifest(options.manifestPath);
  const rpcUrl = canonicalRpcUrl(manifest, dependencies.environment ?? process.env);
  const client = dependencies.client ?? createPublicClient({
    chain: arcTestnet,
    transport: http(rpcUrl, {
      retryCount: 1,
      timeout: 15_000,
    }),
  });
  const report = await captureV1EconomicCutoverEvidence({
    manifest,
    cutoverBlock: options.cutoverBlock,
    client,
    requiredLiveListings: options.requiredLiveListings,
  });
  const bytes = deterministicEconomicCutoverJson(report);
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, bytes, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  const sha256 = `0x${createHash("sha256").update(bytes).digest("hex")}`;
  stdout.write(deterministicEconomicCutoverJson({
    blockHash: report.cutover.blockHash,
    blockNumber: report.cutover.blockNumber,
    output: options.outputPath,
    releaseId: report.releaseId,
    sha256,
    verdict: report.verdict,
  }));
  return { report, outputPath: options.outputPath, sha256 };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    const message = error instanceof Error
      ? error.message
      : "economic cutover capture failed";
    process.stderr.write(`Economic cutover capture refused: ${message}\n`);
    process.exitCode = 1;
  });
}
