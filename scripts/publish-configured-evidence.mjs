#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  parseConfiguredEvidenceArguments,
  publishConfiguredEvidence,
} from "./lib/configured-evidence-publisher.mjs";

export async function main(argv = process.argv.slice(2)) {
  const options = parseConfiguredEvidenceArguments(argv);
  const result = await publishConfiguredEvidence(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Configured evidence publication failed: ${message}\n`);
    process.exitCode = 1;
  });
}
