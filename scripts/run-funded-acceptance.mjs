#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createScopedCandidateFetcher,
  deterministicJson,
  FUNDED_ACCEPTANCE_HELP,
  loadExplicitManifest,
  parseFundedAcceptanceArgs,
  runFundedAcceptance,
} from "./lib/funded-acceptance.mjs";
import { loadPromotionTargetInput } from "./lib/promotion-target.mjs";
import { loadRegistrationSmokeEvidence } from "./lib/registration-smoke-evidence.mjs";

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseFundedAcceptanceArgs(argv);
  if (options.help) {
    dependencies.stdout?.write?.(FUNDED_ACCEPTANCE_HELP) ?? process.stdout.write(FUNDED_ACCEPTANCE_HELP);
    return { help: true };
  }
  const baseFetcher = dependencies.fetcher ?? fetch;
  const manifest = dependencies.manifest ?? await loadExplicitManifest(options.manifestReference, baseFetcher);
  const targetManifest = options.targetIntentReference
    ? dependencies.targetManifest ?? await loadPromotionTargetInput(options.targetIntentReference, baseFetcher)
    : undefined;
  const registrationSmokeEvidence = options.registrationSmokeReference
    ? dependencies.registrationSmokeEvidence ?? await loadRegistrationSmokeEvidence(
      options.registrationSmokeReference,
      baseFetcher,
    )
    : undefined;
  const fetcher = dependencies.candidateFetcher ?? await createScopedCandidateFetcher({
    baseFetcher,
    candidateOrigin: options.candidateOrigin,
    basicAuthFile: options.candidateBasicAuthFile,
  });
  const result = await runFundedAcceptance({
    manifest,
    targetManifest,
    registrationSmokeEvidence,
    candidateOrigin: options.candidateOrigin,
    label: options.label,
    durationYears: options.durationYears,
    listingPrice: options.listingPrice,
    broadcastReleaseId: options.broadcastReleaseId,
    env: dependencies.env ?? process.env,
    accounts: dependencies.accounts,
    publicClient: dependencies.publicClient,
    sellerWalletClient: dependencies.sellerWalletClient,
    buyerWalletClient: dependencies.buyerWalletClient,
    fetcher,
    now: dependencies.now,
  });
  const json = deterministicJson(result);
  if (options.output) {
    await writeFile(options.output, json, { encoding: "utf8", flag: "wx" });
  } else {
    (dependencies.stdout ?? process.stdout).write(json);
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "funded acceptance failed";
    process.stderr.write(`Funded acceptance refused: ${message}\n`);
    process.exitCode = 1;
  });
}
