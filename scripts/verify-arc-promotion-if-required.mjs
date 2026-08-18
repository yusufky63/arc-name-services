#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertPromotionAttestation,
  parseDeploymentManifest,
  promotionVerificationMode,
} from "../packages/config/dist/index.js";
import {
  defaultAttestationPath,
  verifyAndWritePromotion,
  writeInactivePromotion,
} from "./promotion-cli.mjs";

const manifestPath = resolve(process.argv[2] ?? "deployments/5042002.json");
const attestationPath = resolve(process.argv[3] ?? defaultAttestationPath(manifestPath));

async function existingExactAttestation(manifest, requireLiveVerification = false) {
  try {
    const value = JSON.parse(await readFile(attestationPath, "utf8"));
    assertPromotionAttestation(value, manifest, requireLiveVerification);
    return value;
  } catch {
    return null;
  }
}

try {
  const value = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = parseDeploymentManifest(value);
  const mode = promotionVerificationMode(
    manifest,
    process.env.PRIVATE_CANDIDATE_MODE === "true",
  );
  if (mode === "live") {
    const attestation = await existingExactAttestation(manifest, true);
    if (attestation) {
      process.stdout.write(`${JSON.stringify(attestation, null, 2)}\n`);
    } else {
      const { report } = await verifyAndWritePromotion(manifest, attestationPath);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
  } else if (mode === "attested-live") {
    const attestation = await existingExactAttestation(manifest, true);
    if (!attestation) {
      throw new Error(
        "product-live build requires an exact live promotion attestation; run the authenticated candidate-source promotion ceremony first",
      );
    }
    assertPromotionAttestation(attestation, manifest, true);
    process.stdout.write(`${JSON.stringify(attestation, null, 2)}\n`);
  } else {
    const attestation = await existingExactAttestation(manifest) ??
      await writeInactivePromotion(manifest, attestationPath);
    process.stdout.write(`${JSON.stringify(attestation, null, 2)}\n`);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown promotion verification failure";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}
