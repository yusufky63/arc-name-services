#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  defaultAttestationPath,
  parsePromotionCliArguments,
  verifyAndWritePromotion,
} from "./promotion-cli.mjs";

const cli = parsePromotionCliArguments(process.argv.slice(2));
const manifestPath = resolve(cli.manifestArgument ?? "deployments/5042002.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const attestationPath = resolve(cli.attestationArgument ?? defaultAttestationPath(manifestPath));

try {
  const { report } = await verifyAndWritePromotion(manifest, attestationPath, {
    candidateOrigin: cli.candidateOrigin,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown promotion verification failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
