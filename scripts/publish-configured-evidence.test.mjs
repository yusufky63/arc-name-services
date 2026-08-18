import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildConfiguredEvidencePublication,
  configuredEvidenceConstants,
  publishConfiguredEvidence,
  sha256,
} from "./lib/configured-evidence-publisher.mjs";

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFile = promisify(execFileCallback);
const BASE_URL = "https://candidate.example/evidence/contour-v1";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const CANONICAL_NFT_METADATA_BASE_URI =
  "https://contour-arc.vercel.app/api/metadata/";
const INPUT_PATHS = Object.freeze({
  manifest: resolve(REPOSITORY, "deployments/5042002.json"),
  deploymentEvidence: resolve(REPOSITORY, "deployments/evidence/5042002/contour-single-owner-v1/deployment-evidence.json"),
  chainState: resolve(REPOSITORY, "deployments/evidence/5042002/contour-single-owner-v1/configured-chain-state.json"),
  broadcast: resolve(REPOSITORY, "deployments/evidence/5042002/contour-single-owner-v1/foundry-run-hydrated.json"),
  arcscanIndex: resolve(REPOSITORY, "deployments/evidence/5042002/contour-v1/arcscan-source-verification.json"),
});

async function readInputs() {
  const [manifestBytes, deploymentEvidenceBytes, chainStateBytes, broadcastBytes, arcscanIndexBytes] = await Promise.all([
    readFile(INPUT_PATHS.manifest),
    readFile(INPUT_PATHS.deploymentEvidence),
    readFile(INPUT_PATHS.chainState),
    readFile(INPUT_PATHS.broadcast),
    readFile(INPUT_PATHS.arcscanIndex),
  ]);
  return {
    manifestBytes: configuredManifestFixture(manifestBytes),
    deploymentEvidenceBytes,
    chainStateBytes,
    broadcastBytes,
    arcscanIndexBytes,
  };
}

function mutateJson(bytes, mutate) {
  const value = JSON.parse(bytes.toString("utf8"));
  mutate(value);
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function configuredManifestFixture(bytes) {
  return mutateJson(bytes, (manifest) => {
    manifest.state = "configured";
    manifest.activationEvidence.productLive = false;
    manifest.activationEvidence.verifiedAtBlock = null;
    for (const artifact of Object.values(manifest.activationEvidence.artifacts)) {
      artifact.url = null;
      artifact.sha256 = null;
    }
    manifest.activationEvidence.controllerPolicy.registrationsPaused = true;
    manifest.activationEvidence.marketplacePolicy.paused = true;
    manifest.permitIssuer.url = null;
    manifest.permitIssuer.active = false;
    manifest.x402.active = false;
    manifest.x402.facilitatorUrl = null;
    for (const capability of Object.keys(manifest.resolverCapabilities)) {
      manifest.resolverCapabilities[capability] = false;
    }
  });
}

function retainedV1ReferenceFixture(manifest) {
  return {
    registrarVersion: "v1",
    releaseId: `0x${"88".repeat(32)}`,
    verifiedAtBlock: 52_300_000,
    contracts: Object.fromEntries(
      Object.keys(manifest.contracts).map((key, index) => [
        key,
        {
          address: `0x${(index + 80).toString(16).padStart(40, "0")}`,
          deploymentBlock: 52_200_000 + index,
          runtimeCodeHash: `0x${(index + 90).toString(16).padStart(64, "0")}`,
        },
      ]),
    ),
    controllerPolicy: { registrationsPaused: true },
    marketplacePolicy: { paused: false },
  };
}

test("reproduces the six configured, paused and source-verified evidence artifacts", async () => {
  const inputs = await readInputs();
  const publication = buildConfiguredEvidencePublication({ ...inputs, baseUrl: BASE_URL, commit: COMMIT });

  assert.equal(publication.chainId, 5_042_002);
  assert.equal(publication.releaseId, "0x66aeb7b208fdfb6eb9f728a3d0b12d6d3b7132eb0e363b38f7c388c358edefdc");
  assert.deepEqual(Object.keys(publication.artifacts), configuredEvidenceConstants.artifactNames);
  assert.equal(publication.artifacts["deployment-receipts.json"].value.transactionCount, 15);
  assert.deepEqual(
    Object.keys(publication.artifacts["deployment-receipts.json"].value.contracts),
    configuredEvidenceConstants.contractRoles,
  );

  for (const name of configuredEvidenceConstants.artifactNames) {
    const checkedIn = JSON.parse(await readFile(resolve(REPOSITORY, "apps/web/public/evidence/contour-v1", name), "utf8"));
    assert.deepEqual(publication.artifacts[name].value, checkedIn, `${name} must remain reproducible`);
    assert.equal(publication.artifacts[name].value.status, "CONFIGURED_PAUSED_SOURCE_VERIFIED");
  }

  const attestation = publication.artifacts["release-attestation.json"].value;
  assert.equal(attestation.sourceVerifiedContracts, 7);
  assert.equal(attestation.compilerVersion, "v0.8.24+commit.e11b9ed9");
  assert.equal(attestation.optimizerRuns, 10_000);
  assert.equal(attestation.evmVersion, "cancun");
  assert.equal(attestation.arcscanEvidenceIndexSha256, sha256(inputs.arcscanIndexBytes));
});

test("binds V2 registrar identity into configured evidence without changing V1 output", async () => {
  const inputs = await readInputs();
  const manifestBytes = mutateJson(inputs.manifestBytes, (manifest) => {
    manifest.registrarVersion = "v2";
    manifest.nftMetadata = { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI };
    manifest.legacyReleases = [retainedV1ReferenceFixture(manifest)];
  });
  const deploymentEvidenceBytes = mutateJson(
    inputs.deploymentEvidenceBytes,
    (evidence) => {
      evidence.config.registrarVersion = "v2";
      evidence.config.metadataBaseURI = CANONICAL_NFT_METADATA_BASE_URI;
      evidence.contracts.baseRegistrar.contractName = "ArcBaseRegistrarV2";
    },
  );
  const publication = buildConfiguredEvidencePublication({
    ...inputs,
    manifestBytes,
    deploymentEvidenceBytes,
    baseUrl: "https://candidate.example/evidence/contour-v2",
    commit: COMMIT,
  });

  for (const artifact of Object.values(publication.artifacts)) {
    assert.equal(artifact.value.registrarVersion, "v2");
    assert.deepEqual(artifact.value.nftMetadata, {
      metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI,
    });
    assert.deepEqual(artifact.value.legacyReleaseIds, [`0x${"88".repeat(32)}`]);
  }

  const emptyLegacyDirectory = mutateJson(manifestBytes, (manifest) => {
    manifest.legacyReleases = [];
  });
  assert.throws(() => buildConfiguredEvidencePublication({
    ...inputs,
    manifestBytes: emptyLegacyDirectory,
    deploymentEvidenceBytes,
    baseUrl: "https://candidate.example/evidence/contour-v2",
    commit: COMMIT,
  }), /exactly one retained V1/);

  const wrongIdentity = mutateJson(deploymentEvidenceBytes, (evidence) => {
    evidence.contracts.baseRegistrar.contractName = "ArcBaseRegistrar";
  });
  assert.throws(() => buildConfiguredEvidencePublication({
    ...inputs,
    manifestBytes,
    deploymentEvidenceBytes: wrongIdentity,
    baseUrl: "https://candidate.example/evidence/contour-v2",
    commit: COMMIT,
  }), /ArcBaseRegistrarV2/);
});

test("creates an explicit fresh V2 template with the canonical metadata endpoint", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "contour-v2-template-"));
  try {
    const sourcePath = join(temporary, "retained-v1-cutover.json");
    const output = join(temporary, "manifest.v2.draft.json");
    const source = JSON.parse(await readFile(
      resolve(REPOSITORY, "deployments/5042002.candidate-market-open.json"),
      "utf8",
    ));
    source.activationEvidence.controllerPolicy.registrationsPaused = true;
    source.activationEvidence.verifiedAtBlock += 1;
    await writeFile(sourcePath, `${JSON.stringify(source, null, 2)}\n`, "utf8");
    await execFile(process.execPath, [
      resolve(REPOSITORY, "scripts/create-fresh-deployment-template.mjs"),
      sourcePath,
      output,
      "--registrar-version",
      "v2",
    ]);
    const template = JSON.parse(await readFile(output, "utf8"));
    assert.equal(template.state, "draft");
    assert.equal(template.registrarVersion, "v2");
    assert.deepEqual(template.nftMetadata, {
      metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI,
    });
    assert.deepEqual(template.legacyReleases, [{
      registrarVersion: "v1",
      releaseId: source.releaseId,
      verifiedAtBlock: source.activationEvidence.verifiedAtBlock,
      contracts: Object.fromEntries(
        Object.entries(source.contracts).map(([key, contract]) => [
          key,
          {
            address: contract.address,
            deploymentBlock: contract.deploymentBlock,
            runtimeCodeHash: contract.runtimeCodeHash,
          },
        ]),
      ),
      controllerPolicy: { registrationsPaused: true },
      marketplacePolicy: { paused: false },
    }]);
    assert.ok(Object.values(template.contracts).every((contract) => contract.address === null));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("refuses to fabricate a paused V1 cutover reference from an open source", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "contour-v2-template-open-v1-"));
  try {
    await assert.rejects(
      execFile(process.execPath, [
        resolve(REPOSITORY, "scripts/create-fresh-deployment-template.mjs"),
        resolve(REPOSITORY, "deployments/5042002.candidate-market-open.json"),
        join(temporary, "manifest.v2.draft.json"),
        "--registrar-version",
        "v2",
      ]),
      /retained V1 registrations must already be paused/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("fails closed on release, role, source hash, or compiler inconsistency", async (context) => {
  const inputs = await readInputs();
  const build = (overrides = {}) => buildConfiguredEvidencePublication({
    ...inputs,
    ...overrides,
    baseUrl: BASE_URL,
    commit: COMMIT,
  });

  await context.test("release", () => {
    const arcscanIndexBytes = mutateJson(inputs.arcscanIndexBytes, (value) => {
      value.releaseId = `0x${"11".repeat(32)}`;
    });
    assert.throws(() => build({ arcscanIndexBytes }), /releaseId hash mismatch/);
  });

  await context.test("exact seven roles", () => {
    const arcscanIndexBytes = mutateJson(inputs.arcscanIndexBytes, (value) => {
      value.contracts.extraRole = value.contracts.registry;
    });
    assert.throws(() => build({ arcscanIndexBytes }), /must contain exactly/);
  });

  await context.test("source response hash", () => {
    const arcscanIndexBytes = mutateJson(inputs.arcscanIndexBytes, (value) => {
      value.contracts.controller.sha256 = `0x${"22".repeat(32)}`;
    });
    assert.throws(() => build({ arcscanIndexBytes }), /hash mismatch/);
  });

  await context.test("compiler", () => {
    const arcscanIndexBytes = mutateJson(inputs.arcscanIndexBytes, (value) => {
      value.verification.optimizerRuns = 200;
    });
    assert.throws(() => build({ arcscanIndexBytes }), /optimizerRuns must equal 10000/);
  });
});

test("publishes a deterministic content-addressed index and never overwrites", async () => {
  const firstTemp = await mkdtemp(join(tmpdir(), "contour-evidence-first-"));
  const secondTemp = await mkdtemp(join(tmpdir(), "contour-evidence-second-"));
  try {
    const configuredManifestPath = join(firstTemp, "configured-manifest.json");
    const inputs = await readInputs();
    await writeFile(configuredManifestPath, inputs.manifestBytes);
    const options = {
      ...INPUT_PATHS,
      manifest: configuredManifestPath,
      baseUrl: BASE_URL,
      commit: COMMIT,
    };
    const first = await publishConfiguredEvidence({ ...options, outputDir: firstTemp });
    const second = await publishConfiguredEvidence({ ...options, outputDir: secondTemp });

    assert.equal(first.publicationDigest, second.publicationDigest);
    assert.equal(basename(first.publicationDirectory), first.publicationDigest.slice(2));
    assert.deepEqual(await readFile(first.index.file), await readFile(second.index.file));
    assert.equal(sha256(await readFile(first.index.file)), first.index.sha256);

    const index = JSON.parse(await readFile(first.index.file, "utf8"));
    assert.equal(index.publicationDigest, first.publicationDigest);
    assert.equal(index.manifestSha256, sha256(await readFile(configuredManifestPath)));
    assert.equal(index.artifacts.length, 6);
    assert.ok(index.artifacts.every((artifact) => artifact.url.includes(`/${first.publicationDigest.slice(2)}/`)));

    await assert.rejects(
      publishConfiguredEvidence({ ...options, outputDir: firstTemp }),
      /already exists; refusing to overwrite/,
    );
  } finally {
    await Promise.all([
      rm(firstTemp, { recursive: true, force: true }),
      rm(secondTemp, { recursive: true, force: true }),
    ]);
  }
});
