#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createScopedCandidateFetcher,
  deterministicJson,
  loadExplicitManifest,
} from "./lib/funded-acceptance.mjs";
import {
  parseRegistrationSmokeArgs,
  REGISTRATION_SMOKE_HELP,
  runRegistrationSmoke,
} from "./lib/registration-smoke.mjs";

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseRegistrationSmokeArgs(argv);
  if (options.help) {
    dependencies.stdout?.write?.(REGISTRATION_SMOKE_HELP) ?? process.stdout.write(REGISTRATION_SMOKE_HELP);
    return { help: true };
  }
  const baseFetcher = dependencies.fetcher ?? fetch;
  const manifest = dependencies.manifest ?? await loadExplicitManifest(
    options.manifestReference,
    baseFetcher,
  );
  const fetcher = dependencies.candidateFetcher ?? await createScopedCandidateFetcher({
    baseFetcher,
    candidateOrigin: options.candidateOrigin,
    basicAuthFile: options.candidateBasicAuthFile,
  });
  const result = await runRegistrationSmoke({
    manifest,
    candidateOrigin: options.candidateOrigin,
    label: options.label,
    durationYears: options.durationYears,
    broadcastReleaseId: options.broadcastReleaseId,
    confirmRegistrant: options.confirmRegistrant,
    env: dependencies.env ?? process.env,
    account: dependencies.account,
    publicClient: dependencies.publicClient,
    walletClient: dependencies.walletClient,
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
    const message = error instanceof Error ? error.message : "registration smoke failed";
    process.stderr.write(`Registration smoke refused: ${message}\n`);
    process.exitCode = 1;
  });
}
