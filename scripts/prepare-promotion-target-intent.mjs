#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPromotionTargetIntent } from "./lib/promotion-target.mjs";

function fail(message) {
  throw new Error(`promotion target intent refused: ${message}`);
}

export function parsePromotionTargetIntentArgs(argv) {
  const values = new Map();
  const allowed = new Set(["--manifest", "--verified-at-block", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!allowed.has(flag) || values.has(flag)) fail(`unknown or duplicate argument ${String(flag)}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires one explicit value`);
    values.set(flag, value);
    index += 1;
  }
  for (const flag of allowed) if (!values.has(flag)) fail(`${flag} is required`);
  const verifiedAtBlock = Number(values.get("--verified-at-block"));
  if (!Number.isSafeInteger(verifiedAtBlock) || verifiedAtBlock <= 0) {
    fail("--verified-at-block must be a positive safe integer");
  }
  return {
    manifestPath: resolve(values.get("--manifest")),
    verifiedAtBlock,
    outputPath: resolve(values.get("--output")),
  };
}

export async function preparePromotionTargetIntent(argv) {
  const options = parsePromotionTargetIntentArgs(argv);
  let candidate;
  try { candidate = JSON.parse(await readFile(options.manifestPath, "utf8")); }
  catch { fail("candidate manifest could not be read as JSON"); }
  const intent = createPromotionTargetIntent(candidate, options.verifiedAtBlock);
  await writeFile(options.outputPath, `${JSON.stringify(intent, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  return { output: options.outputPath, intent };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  try {
    const result = await preparePromotionTargetIntent(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify({
      output: result.output,
      artifact: result.intent.artifact,
      chainId: result.intent.chainId,
      releaseId: result.intent.releaseId,
      verifiedAtBlock: result.intent.verifiedAtBlock,
      promotionSubjectSha256: result.intent.promotionSubjectSha256,
    }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "promotion target intent failed"}\n`);
    process.exitCode = 1;
  }
}
