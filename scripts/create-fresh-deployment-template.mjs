#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const CANONICAL_NFT_METADATA_BASE_URI =
  "https://contour-arc.vercel.app/api/metadata/";

const CONTRACT_KEYS = [
  "registry",
  "baseRegistrar",
  "controller",
  "publicResolver",
  "reverseRegistrar",
  "universalResolver",
  "marketplace",
];

const ARTIFACT_KEYS = [
  "deploymentReceipts",
  "constructorWiring",
  "governanceRoles",
  "treasuryControls",
  "signerPolicy",
  "releaseAttestation",
  "fundedEndToEnd",
  "operationsDrill",
];

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function validateLegacyReference(reference) {
  if (
    !hasExactKeys(reference, [
      "registrarVersion",
      "releaseId",
      "verifiedAtBlock",
      "contracts",
      "controllerPolicy",
      "marketplacePolicy",
    ]) ||
    reference.registrarVersion !== "v1" ||
    !/^0x[0-9a-fA-F]{64}$/.test(reference.releaseId ?? "") ||
    /^0x0{64}$/i.test(reference.releaseId) ||
    !Number.isSafeInteger(reference.verifiedAtBlock) ||
    reference.verifiedAtBlock <= 0 ||
    !hasExactKeys(reference.controllerPolicy, ["registrationsPaused"]) ||
    reference.controllerPolicy.registrationsPaused !== true ||
    !hasExactKeys(reference.marketplacePolicy, ["paused"]) ||
    reference.marketplacePolicy.paused !== false ||
    !hasExactKeys(reference.contracts, CONTRACT_KEYS)
  ) {
    throw new Error("retained V1 release reference is invalid");
  }
  for (const key of CONTRACT_KEYS) {
    const contract = reference.contracts[key];
    if (
      !hasExactKeys(contract, ["address", "deploymentBlock", "runtimeCodeHash"]) ||
      !/^0x[0-9a-fA-F]{40}$/.test(contract.address ?? "") ||
      /^0x0{40}$/i.test(contract.address) ||
      !Number.isSafeInteger(contract.deploymentBlock) ||
      contract.deploymentBlock <= 0 ||
      contract.deploymentBlock > reference.verifiedAtBlock ||
      !/^0x[0-9a-fA-F]{64}$/.test(contract.runtimeCodeHash ?? "") ||
      /^0x0{64}$/i.test(contract.runtimeCodeHash)
    ) {
      throw new Error(`retained V1 ${key} reference is invalid`);
    }
  }
  return structuredClone(reference);
}

function legacyReferenceFrom(source) {
  const existingVersion = source?.registrarVersion ?? "v1";
  if (existingVersion === "v2") {
    if (!Array.isArray(source.legacyReleases) || source.legacyReleases.length !== 1) {
      throw new Error(
        "V2 template source must contain exactly one retained V1 release reference",
      );
    }
    return validateLegacyReference(source.legacyReleases[0]);
  }
  if (existingVersion !== "v1") {
    throw new Error("template source registrarVersion must be v1 or v2");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(source?.releaseId ?? "")) {
    throw new Error("V2 template source must be a complete retained V1 release");
  }
  const verifiedAtBlock = source?.activationEvidence?.verifiedAtBlock;
  if (!Number.isSafeInteger(verifiedAtBlock) || verifiedAtBlock <= 0) {
    throw new Error("retained V1 source must publish a positive verification block");
  }
  if (source?.activationEvidence?.marketplacePolicy?.paused !== false) {
    throw new Error("retained V1 marketplace must be open for the V2 cutover template");
  }
  if (source?.activationEvidence?.controllerPolicy?.registrationsPaused !== true) {
    throw new Error(
      "retained V1 registrations must already be paused at the published cutover block",
    );
  }

  const contracts = {};
  for (const key of CONTRACT_KEYS) {
    const deployment = source?.contracts?.[key];
    if (
      !/^0x[0-9a-fA-F]{40}$/.test(deployment?.address ?? "") ||
      !Number.isSafeInteger(deployment?.deploymentBlock) ||
      deployment.deploymentBlock <= 0 ||
      deployment.deploymentBlock > verifiedAtBlock ||
      !/^0x[0-9a-fA-F]{64}$/.test(deployment?.runtimeCodeHash ?? "")
    ) {
      throw new Error(`retained V1 ${key} identity is incomplete`);
    }
    contracts[key] = {
      address: deployment.address,
      deploymentBlock: deployment.deploymentBlock,
      runtimeCodeHash: deployment.runtimeCodeHash,
    };
  }

  return validateLegacyReference({
    registrarVersion: "v1",
    releaseId: source.releaseId,
    verifiedAtBlock,
    contracts,
    // Copy the state that the retained V1 manifest already proves. Never turn
    // an open historical source into a synthetic paused cutover reference.
    controllerPolicy: {
      registrationsPaused:
        source.activationEvidence.controllerPolicy.registrationsPaused,
    },
    marketplacePolicy: { paused: false },
  });
}

const [input = "deployments/5042002.json", output, ...rawOptions] = process.argv.slice(2);
if (!output) {
  throw new Error(
    "usage: node scripts/create-fresh-deployment-template.mjs <input> <output> [--registrar-version <v1|v2>]",
  );
}
let registrarVersion;
if (rawOptions.length !== 0) {
  if (
    rawOptions.length !== 2 ||
    rawOptions[0] !== "--registrar-version" ||
    !["v1", "v2"].includes(rawOptions[1])
  ) {
    throw new Error(
      "usage: node scripts/create-fresh-deployment-template.mjs <input> <output> [--registrar-version <v1|v2>]",
    );
  }
  registrarVersion = rawOptions[1];
}

const source = JSON.parse(await readFile(resolve(input), "utf8"));
const retainedLegacyReference =
  registrarVersion === "v2" ? legacyReferenceFrom(source) : null;
const emptyContract = () => ({
  address: null,
  deploymentBlock: null,
  transactionHash: null,
  runtimeCodeHash: null,
  abiUrl: null,
  abiSha256: null,
  sourceVerified: false,
  sourceVerificationUrl: null,
  sourceVerificationSha256: null,
});

const template = {
  schemaVersion: "1.1.0",
  state: "draft",
  releaseId: null,
  ...(registrarVersion
    ? {
        registrarVersion,
        nftMetadata: registrarVersion === "v2"
          ? { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI }
          : null,
        ...(registrarVersion === "v2"
          ? { legacyReleases: [retainedLegacyReference] }
          : {}),
      }
    : {}),
  testnet: true,
  chain: source.chain,
  settlement: source.settlement,
  namespace: source.namespace,
  normalization: source.normalization,
  contracts: Object.fromEntries(CONTRACT_KEYS.map((key) => [key, emptyContract()])),
  activationEvidence: {
    productLive: false,
    verifiedAtBlock: null,
    artifacts: Object.fromEntries(ARTIFACT_KEYS.map((key) => [key, { url: null, sha256: null }])),
    governance: { account: null },
    controllerPolicy: {
      permitSigner: null,
      signerPolicyVersion: null,
      referralBps: null,
      registrationsPaused: null,
    },
    marketplacePolicy: { feeBps: null, paused: null },
  },
  permitIssuer: {
    url: null,
    signerAddress: null,
    publicKey: null,
    policyVersion: null,
    active: false,
  },
  resolverCapabilities: source.resolverCapabilities,
  discovery: source.discovery,
  bens: source.bens,
  x402: source.x402,
};

const target = resolve(output);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(template, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
process.stdout.write(`${target}\n`);
