import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const CHAIN_ID = 5_042_002;
const CAIP2 = `eip155:${CHAIN_ID}`;
const MANIFEST_SCHEMA_VERSION = "1.1.0";
const INDEX_SCHEMA_VERSION = "1.0.0";
const CONFIGURED_STATUS = "CONFIGURED_PAUSED_SOURCE_VERIFIED";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EXPECTED_TRANSACTION_COUNT = 15;
const CANONICAL_NFT_METADATA_BASE_URI =
  "https://contour-arc.vercel.app/api/metadata/";

const CONTRACT_ROLES = Object.freeze([
  "registry",
  "baseRegistrar",
  "controller",
  "publicResolver",
  "reverseRegistrar",
  "universalResolver",
  "marketplace",
]);

const CONTRACT_NAMES = Object.freeze({
  registry: "ArcNameRegistry",
  baseRegistrar: "ArcBaseRegistrar",
  controller: "ArcRegistrarController",
  publicResolver: "ArcPublicResolver",
  reverseRegistrar: "ArcReverseRegistrar",
  universalResolver: "ArcUniversalResolver",
  marketplace: "ArcNameMarketplace",
});

function expectedContractName(registrarVersion, role) {
  if (role === "baseRegistrar" && registrarVersion === "v2") {
    return "ArcBaseRegistrarV2";
  }
  return CONTRACT_NAMES[role];
}

const ARTIFACT_DEFINITIONS = Object.freeze([
  ["deployment-receipts.json", "deploymentReceipts", "contour/deployment-receipts@1"],
  ["constructor-wiring.json", "constructorWiring", "contour/constructor-wiring@1"],
  ["governance-roles.json", "governanceRoles", "contour/governance-roles@1"],
  ["treasury-controls.json", "treasuryControls", "contour/treasury-controls@1"],
  ["signer-policy.json", "signerPolicy", "contour/signer-policy@1"],
  ["release-attestation.json", "releaseAttestation", "contour/release-attestation@1"],
]);

const REQUIRED_ARGUMENTS = Object.freeze([
  "--manifest",
  "--deployment-evidence",
  "--chain-state",
  "--broadcast",
  "--arcscan-index",
  "--output-dir",
  "--base-url",
  "--commit",
]);

const USAGE = `usage: publish-configured-evidence ${REQUIRED_ARGUMENTS.map((flag) => `${flag} <value>`).join(" ")}`;

function fail(message) {
  throw new Error(message);
}

function record(value, field) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value;
}

function array(value, field) {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  return value;
}

function string(value, field) {
  if (typeof value !== "string" || value.length === 0) fail(`${field} must be a non-empty string`);
  return value;
}

function integer(value, field, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${field} must be an integer >= ${minimum}`);
  return value;
}

function exact(value, expected, field) {
  if (value !== expected) fail(`${field} must equal ${JSON.stringify(expected)}`);
  return value;
}

function exactKeys(value, expectedKeys, field) {
  const actual = Object.keys(record(value, field)).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(`${field} must contain exactly: ${expectedKeys.join(", ")}`);
  }
  return value;
}

function address(value, field) {
  const parsed = string(value, field);
  if (!/^0x[0-9a-fA-F]{40}$/.test(parsed)) fail(`${field} must be an EVM address`);
  return parsed;
}

function bytes32(value, field) {
  const parsed = string(value, field);
  if (!/^0x[0-9a-f]{64}$/.test(parsed)) fail(`${field} must be a canonical lowercase bytes32`);
  return parsed;
}

function sameAddress(left, right) {
  return address(left, "address").toLowerCase() === address(right, "address").toLowerCase();
}

function assertAddress(left, right, field) {
  if (!sameAddress(left, right)) fail(`${field} address mismatch`);
}

function assertBytes32(left, right, field) {
  if (bytes32(left, field) !== bytes32(right, field)) fail(`${field} hash mismatch`);
}

function decimalString(value, field) {
  const parsed = string(value, field);
  if (!/^(0|[1-9][0-9]*)$/.test(parsed)) fail(`${field} must be a canonical decimal string`);
  return parsed;
}

function rfc3339(value, field) {
  const parsed = string(value, field);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(parsed) || !Number.isFinite(Date.parse(parsed))) {
    fail(`${field} must be an RFC3339 UTC timestamp`);
  }
  return parsed;
}

function httpsUrl(value, field, { allowQuery = false } = {}) {
  const parsed = string(value, field);
  let url;
  try {
    url = new URL(parsed);
  } catch {
    fail(`${field} must be a valid HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    (!allowQuery && url.search !== "") ||
    url.hash !== "" ||
    !url.hostname
  ) {
    fail(`${field} must be a credential-free HTTPS URL without query or fragment`);
  }
  return url;
}

function normalizedBaseUrl(value) {
  const url = httpsUrl(value, "--base-url");
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment).toLowerCase());
  if (segments.some((segment) => ["latest", "current", "head"].includes(segment))) {
    fail("--base-url cannot contain a mutable latest/current/head path segment");
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

function commitSha(value) {
  const parsed = string(value, "--commit").toLowerCase();
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(parsed)) {
    fail("--commit must be a full 40- or 64-character hexadecimal commit SHA");
  }
  return parsed;
}

function parseJson(bytes, field) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    const suffix = error instanceof Error ? `: ${error.message}` : "";
    fail(`${field} must contain valid JSON${suffix}`);
  }
}

export function sha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function compareSemantic(actual, expected, field) {
  if (typeof expected === "string" && /^0x[0-9a-fA-F]{40}$/.test(expected)) {
    assertAddress(actual, expected, field);
  } else if (typeof expected === "string" && /^0x[0-9a-f]{64}$/.test(expected)) {
    assertBytes32(actual, expected, field);
  } else if (actual !== expected) {
    fail(`${field} mismatch`);
  }
}

function validateRegistrarIdentity(root) {
  const registrarVersion = root.registrarVersion ?? "v1";
  if (!["v1", "v2"].includes(registrarVersion)) {
    fail("manifest.registrarVersion must be v1 or v2");
  }
  if (registrarVersion === "v1") {
    if (root.nftMetadata !== undefined && root.nftMetadata !== null) {
      fail("V1 manifest cannot publish nftMetadata");
    }
    return { registrarVersion, metadataBaseURI: null };
  }
  exact(root.registrarVersion, "v2", "manifest.registrarVersion");
  const nftMetadata = exactKeys(
    root.nftMetadata,
    ["metadataBaseURI"],
    "manifest.nftMetadata",
  );
  exact(
    nftMetadata.metadataBaseURI,
    CANONICAL_NFT_METADATA_BASE_URI,
    "manifest.nftMetadata.metadataBaseURI",
  );
  return {
    registrarVersion,
    metadataBaseURI: nftMetadata.metadataBaseURI,
  };
}

function validateLegacyReleases(root, identity, currentReleaseId, currentContracts) {
  if (identity.registrarVersion === "v2") {
    if (!Array.isArray(root.legacyReleases) || root.legacyReleases.length !== 1) {
      fail("V2 manifest must contain exactly one retained V1 release reference");
    }
  } else if (root.legacyReleases === undefined) {
    return [];
  }
  if (!Array.isArray(root.legacyReleases)) fail("manifest.legacyReleases must be an array");
  exact(identity.registrarVersion, "v2", "manifest registrar version for legacy releases");
  const releaseIds = new Set();
  const currentAddresses = new Set(
    CONTRACT_ROLES.map((role) => currentContracts[role].address.toLowerCase()),
  );
  return root.legacyReleases.map((rawLegacy, index) => {
    const field = `manifest.legacyReleases[${index}]`;
    const legacy = exactKeys(rawLegacy, [
      "registrarVersion",
      "releaseId",
      "verifiedAtBlock",
      "contracts",
      "controllerPolicy",
      "marketplacePolicy",
    ], field);
    exact(legacy.registrarVersion, "v1", `${field}.registrarVersion`);
    const releaseId = bytes32(legacy.releaseId, `${field}.releaseId`);
    if (releaseId === currentReleaseId) fail(`${field}.releaseId must differ from the V2 release`);
    if (releaseIds.has(releaseId)) fail(`${field}.releaseId is duplicated`);
    releaseIds.add(releaseId);
    const verifiedAtBlock = integer(legacy.verifiedAtBlock, `${field}.verifiedAtBlock`, 1);
    const contracts = exactKeys(legacy.contracts, CONTRACT_ROLES, `${field}.contracts`);
    const addresses = new Set();
    for (const role of CONTRACT_ROLES) {
      const contract = exactKeys(
        contracts[role],
        ["address", "deploymentBlock", "runtimeCodeHash"],
        `${field}.contracts.${role}`,
      );
      const contractAddress = address(contract.address, `${field}.contracts.${role}.address`).toLowerCase();
      if (addresses.has(contractAddress)) fail(`${field}.contracts.${role}.address is duplicated`);
      addresses.add(contractAddress);
      if (currentAddresses.has(contractAddress)) {
        fail(`${field}.contracts.${role}.address reuses a current V2 contract`);
      }
      const deploymentBlock = integer(
        contract.deploymentBlock,
        `${field}.contracts.${role}.deploymentBlock`,
        1,
      );
      if (deploymentBlock > verifiedAtBlock) {
        fail(`${field}.contracts.${role}.deploymentBlock exceeds verifiedAtBlock`);
      }
      bytes32(contract.runtimeCodeHash, `${field}.contracts.${role}.runtimeCodeHash`);
    }
    const controllerPolicy = exactKeys(
      legacy.controllerPolicy,
      ["registrationsPaused"],
      `${field}.controllerPolicy`,
    );
    exact(
      controllerPolicy.registrationsPaused,
      true,
      `${field}.controllerPolicy.registrationsPaused`,
    );
    const marketplacePolicy = exactKeys(
      legacy.marketplacePolicy,
      ["paused"],
      `${field}.marketplacePolicy`,
    );
    exact(marketplacePolicy.paused, false, `${field}.marketplacePolicy.paused`);
    return legacy;
  });
}

function validateManifest(manifest) {
  const root = record(manifest, "manifest");
  exact(root.schemaVersion, MANIFEST_SCHEMA_VERSION, "manifest.schemaVersion");
  exact(root.state, "configured", "manifest.state");
  exact(root.testnet, true, "manifest.testnet");
  const releaseId = bytes32(root.releaseId, "manifest.releaseId");
  const registrarIdentity = validateRegistrarIdentity(root);

  const chain = record(root.chain, "manifest.chain");
  exact(chain.id, CHAIN_ID, "manifest.chain.id");
  exact(chain.caip2, CAIP2, "manifest.chain.caip2");
  exact(chain.rpcUrl, "https://rpc.testnet.arc.network", "manifest.chain.rpcUrl");
  exact(chain.explorerUrl, "https://testnet.arcscan.app", "manifest.chain.explorerUrl");

  const settlement = record(root.settlement, "manifest.settlement");
  const settlementAsset = address(settlement.erc20Address, "manifest.settlement.erc20Address");
  exact(settlement.symbol, "USDC", "manifest.settlement.symbol");
  exact(settlement.applicationDecimals, 6, "manifest.settlement.applicationDecimals");
  exact(settlement.sharedUnderlyingBalance, true, "manifest.settlement.sharedUnderlyingBalance");

  const namespace = record(root.namespace, "manifest.namespace");
  exact(namespace.suffix, "contour", "manifest.namespace.suffix");
  bytes32(namespace.baseNode, "manifest.namespace.baseNode");

  const contracts = exactKeys(root.contracts, CONTRACT_ROLES, "manifest.contracts");
  const seenAddresses = new Set();
  const seenTransactions = new Set();
  for (const role of CONTRACT_ROLES) {
    const contract = exactKeys(contracts[role], [
      "address",
      "deploymentBlock",
      "transactionHash",
      "runtimeCodeHash",
      "abiUrl",
      "abiSha256",
      "sourceVerified",
      "sourceVerificationUrl",
      "sourceVerificationSha256",
    ], `manifest.contracts.${role}`);
    const contractAddress = address(contract.address, `manifest.contracts.${role}.address`).toLowerCase();
    if (seenAddresses.has(contractAddress)) fail(`manifest.contracts.${role}.address is duplicated`);
    seenAddresses.add(contractAddress);
    integer(contract.deploymentBlock, `manifest.contracts.${role}.deploymentBlock`, 1);
    const transactionHash = bytes32(contract.transactionHash, `manifest.contracts.${role}.transactionHash`);
    if (seenTransactions.has(transactionHash)) fail(`manifest.contracts.${role}.transactionHash is duplicated`);
    seenTransactions.add(transactionHash);
    bytes32(contract.runtimeCodeHash, `manifest.contracts.${role}.runtimeCodeHash`);
    exact(contract.sourceVerified, true, `manifest.contracts.${role}.sourceVerified`);
    httpsUrl(contract.abiUrl, `manifest.contracts.${role}.abiUrl`);
    httpsUrl(contract.sourceVerificationUrl, `manifest.contracts.${role}.sourceVerificationUrl`);
    exact(contract.abiUrl, contract.sourceVerificationUrl, `manifest.contracts.${role} source/ABI URL`);
    assertBytes32(contract.abiSha256, contract.sourceVerificationSha256, `manifest.contracts.${role} source/ABI`);
  }
  const legacyReleases = validateLegacyReleases(
    root,
    registrarIdentity,
    releaseId,
    contracts,
  );

  const activation = record(root.activationEvidence, "manifest.activationEvidence");
  exact(activation.productLive, false, "manifest.activationEvidence.productLive");
  exact(activation.verifiedAtBlock, null, "manifest.activationEvidence.verifiedAtBlock");
  const governance = record(activation.governance, "manifest.activationEvidence.governance");
  const governanceAccount = address(governance.account, "manifest.activationEvidence.governance.account");
  const controllerPolicy = record(activation.controllerPolicy, "manifest.activationEvidence.controllerPolicy");
  const marketplacePolicy = record(activation.marketplacePolicy, "manifest.activationEvidence.marketplacePolicy");
  assertAddress(controllerPolicy.permitSigner, governanceAccount, "manifest controller permit signer/governance");
  exact(controllerPolicy.signerPolicyVersion, "1", "manifest.activationEvidence.controllerPolicy.signerPolicyVersion");
  exact(controllerPolicy.registrationsPaused, true, "manifest.activationEvidence.controllerPolicy.registrationsPaused");
  exact(marketplacePolicy.paused, true, "manifest.activationEvidence.marketplacePolicy.paused");
  integer(controllerPolicy.referralBps, "manifest.activationEvidence.controllerPolicy.referralBps");
  integer(marketplacePolicy.feeBps, "manifest.activationEvidence.marketplacePolicy.feeBps");

  const activationArtifacts = record(activation.artifacts, "manifest.activationEvidence.artifacts");
  for (const [artifactId] of ARTIFACT_DEFINITIONS.map(([, id]) => [id])) {
    const artifact = record(activationArtifacts[artifactId], `manifest.activationEvidence.artifacts.${artifactId}`);
    exact(artifact.url, null, `manifest.activationEvidence.artifacts.${artifactId}.url`);
    exact(artifact.sha256, null, `manifest.activationEvidence.artifacts.${artifactId}.sha256`);
  }
  for (const artifactId of ["fundedEndToEnd", "operationsDrill"]) {
    const artifact = record(activationArtifacts[artifactId], `manifest.activationEvidence.artifacts.${artifactId}`);
    exact(artifact.url, null, `manifest.activationEvidence.artifacts.${artifactId}.url`);
    exact(artifact.sha256, null, `manifest.activationEvidence.artifacts.${artifactId}.sha256`);
  }

  const issuer = record(root.permitIssuer, "manifest.permitIssuer");
  exact(issuer.active, false, "manifest.permitIssuer.active");
  exact(issuer.url, null, "manifest.permitIssuer.url");
  assertAddress(issuer.signerAddress, governanceAccount, "manifest permit issuer/governance");
  exact(issuer.policyVersion, controllerPolicy.signerPolicyVersion, "manifest.permitIssuer.policyVersion");

  return {
    root,
    releaseId,
    chain,
    settlementAsset,
    namespace,
    contracts,
    activation,
    governanceAccount,
    controllerPolicy,
    marketplacePolicy,
    registrarVersion: registrarIdentity.registrarVersion,
    metadataBaseURI: registrarIdentity.metadataBaseURI,
    legacyReleases,
  };
}

function validateArcscanIndex(index, manifest) {
  const root = record(index, "ArcScan index");
  exact(root.schemaVersion, MANIFEST_SCHEMA_VERSION, "ArcScan index.schemaVersion");
  exact(root.chainId, CHAIN_ID, "ArcScan index.chainId");
  assertBytes32(root.releaseId, manifest.releaseId, "ArcScan index.releaseId");
  exact(root.explorer, manifest.chain.explorerUrl, "ArcScan index.explorer");

  const verification = exactKeys(root.verification, [
    "compilerVersion",
    "optimizerEnabled",
    "optimizerRuns",
    "evmVersion",
    "status",
    "constructorArgumentsMatched",
  ], "ArcScan index.verification");
  exact(verification.compilerVersion, "v0.8.24+commit.e11b9ed9", "ArcScan index.verification.compilerVersion");
  exact(verification.optimizerEnabled, true, "ArcScan index.verification.optimizerEnabled");
  exact(verification.optimizerRuns, 10_000, "ArcScan index.verification.optimizerRuns");
  exact(verification.evmVersion, "cancun", "ArcScan index.verification.evmVersion");
  exact(verification.status, "all-seven-verified", "ArcScan index.verification.status");
  exact(verification.constructorArgumentsMatched, true, "ArcScan index.verification.constructorArgumentsMatched");

  const contracts = exactKeys(root.contracts, CONTRACT_ROLES, "ArcScan index.contracts");
  const verifiedAt = [];
  for (const role of CONTRACT_ROLES) {
    const entry = exactKeys(contracts[role], ["address", "url", "uiUrl", "verifiedAt", "sha256"], `ArcScan index.contracts.${role}`);
    const manifestContract = manifest.contracts[role];
    assertAddress(entry.address, manifestContract.address, `ArcScan index.contracts.${role}.address`);
    exact(entry.url, manifestContract.sourceVerificationUrl, `ArcScan index.contracts.${role}.url`);
    exact(entry.url, manifestContract.abiUrl, `ArcScan index.contracts.${role}.url/manifest ABI URL`);
    assertBytes32(entry.sha256, manifestContract.sourceVerificationSha256, `ArcScan index.contracts.${role}.sha256`);
    assertBytes32(entry.sha256, manifestContract.abiSha256, `ArcScan index.contracts.${role}.sha256/manifest ABI hash`);

    const api = httpsUrl(entry.url, `ArcScan index.contracts.${role}.url`);
    const ui = httpsUrl(entry.uiUrl, `ArcScan index.contracts.${role}.uiUrl`, { allowQuery: true });
    exact(api.origin, manifest.chain.explorerUrl, `ArcScan index.contracts.${role}.url origin`);
    exact(ui.origin, manifest.chain.explorerUrl, `ArcScan index.contracts.${role}.uiUrl origin`);
    exact(api.pathname, `/api/v2/smart-contracts/${manifestContract.address.toLowerCase()}`, `ArcScan index.contracts.${role}.url path`);
    exact(ui.pathname, `/address/${manifestContract.address.toLowerCase()}`, `ArcScan index.contracts.${role}.uiUrl path`);
    exact(ui.search, "?tab=contract", `ArcScan index.contracts.${role}.uiUrl query`);
    verifiedAt.push(rfc3339(entry.verifiedAt, `ArcScan index.contracts.${role}.verifiedAt`));
  }

  const generatedAt = verifiedAt.reduce((latest, candidate) => (
    Date.parse(candidate) > Date.parse(latest) ? candidate : latest
  ));
  return { root, verification, contracts, generatedAt };
}

function validateDeploymentEvidence(deployment, deploymentBytesHash, broadcastHash, manifest) {
  const root = record(deployment, "deployment evidence");
  exact(root.schemaVersion, MANIFEST_SCHEMA_VERSION, "deployment evidence.schemaVersion");
  exact(root.artifact, "contour-offline-deployment-evidence", "deployment evidence.artifact");
  const chain = record(root.chain, "deployment evidence.chain");
  exact(chain.id, CHAIN_ID, "deployment evidence.chain.id");
  exact(chain.caip2, CAIP2, "deployment evidence.chain.caip2");

  const config = record(root.config, "deployment evidence.config");
  assertBytes32(config.releaseId, manifest.releaseId, "deployment evidence.config.releaseId");
  for (const field of ["deployer", "governanceAccount", "permitSigner"]) {
    assertAddress(config[field], manifest.governanceAccount, `deployment evidence.config.${field}`);
  }
  exact(config.referralBps, manifest.controllerPolicy.referralBps, "deployment evidence.config.referralBps");
  exact(config.marketplaceFeeBps, manifest.marketplacePolicy.feeBps, "deployment evidence.config.marketplaceFeeBps");
  const evidenceRegistrarVersion = config.registrarVersion ?? "v1";
  exact(
    evidenceRegistrarVersion,
    manifest.registrarVersion,
    "deployment evidence.config.registrarVersion",
  );
  if (manifest.registrarVersion === "v2") {
    exact(
      config.metadataBaseURI,
      manifest.metadataBaseURI,
      "deployment evidence.config.metadataBaseURI",
    );
  } else if (config.metadataBaseURI !== undefined && config.metadataBaseURI !== null) {
    fail("V1 deployment evidence cannot publish metadataBaseURI");
  }

  const contracts = exactKeys(root.contracts, CONTRACT_ROLES, "deployment evidence.contracts");
  for (const role of CONTRACT_ROLES) {
    const contract = record(contracts[role], `deployment evidence.contracts.${role}`);
    const manifestContract = manifest.contracts[role];
    exact(
      contract.contractName,
      expectedContractName(manifest.registrarVersion, role),
      `deployment evidence.contracts.${role}.contractName`,
    );
    assertAddress(contract.address, manifestContract.address, `deployment evidence.contracts.${role}.address`);
    assertBytes32(contract.transactionHash, manifestContract.transactionHash, `deployment evidence.contracts.${role}.transactionHash`);
    exact(contract.deploymentBlock, manifestContract.deploymentBlock, `deployment evidence.contracts.${role}.deploymentBlock`);
    assertBytes32(contract.runtimeCodeHash, manifestContract.runtimeCodeHash, `deployment evidence.contracts.${role}.runtimeCodeHash`);
    bytes32(contract.creationCodeHash, `deployment evidence.contracts.${role}.creationCodeHash`);
    bytes32(contract.canonicalAbiSha256, `deployment evidence.contracts.${role}.canonicalAbiSha256`);
    bytes32(contract.sourceKeccak256, `deployment evidence.contracts.${role}.sourceKeccak256`);
  }

  const wiring = record(root.wiring, "deployment evidence.wiring");
  exact(wiring.validated, true, "deployment evidence.wiring.validated");
  exact(wiring.transactionCount, EXPECTED_TRANSACTION_COUNT, "deployment evidence.wiring.transactionCount");
  exact(wiring.suffix, manifest.namespace.suffix, "deployment evidence.wiring.suffix");
  assertBytes32(wiring.baseNode, manifest.namespace.baseNode, "deployment evidence.wiring.baseNode");
  assertAddress(wiring.settlementAsset, manifest.settlementAsset, "deployment evidence.wiring.settlementAsset");

  const inputs = record(root.inputs, "deployment evidence.inputs");
  const broadcastInput = record(inputs.broadcast, "deployment evidence.inputs.broadcast");
  assertBytes32(broadcastInput.sha256, broadcastHash, "deployment evidence.inputs.broadcast.sha256");
  bytes32(deploymentBytesHash, "deployment evidence SHA-256");
  return { root, config, contracts, wiring };
}

function validateBroadcast(broadcast, manifest, captureBlock) {
  const root = record(broadcast, "hydrated broadcast");
  exact(root.chain, CHAIN_ID, "hydrated broadcast.chain");
  const transactions = array(root.transactions, "hydrated broadcast.transactions");
  const receipts = array(root.receipts, "hydrated broadcast.receipts");
  exact(transactions.length, EXPECTED_TRANSACTION_COUNT, "hydrated broadcast.transactions.length");
  exact(receipts.length, EXPECTED_TRANSACTION_COUNT, "hydrated broadcast.receipts.length");

  const transactionByHash = new Map();
  const receiptByHash = new Map();
  for (let index = 0; index < transactions.length; index += 1) {
    const transaction = record(transactions[index], `hydrated broadcast.transactions[${index}]`);
    const hash = bytes32(transaction.hash, `hydrated broadcast.transactions[${index}].hash`);
    if (transactionByHash.has(hash)) fail(`hydrated broadcast transaction ${hash} is duplicated`);
    transactionByHash.set(hash, transaction);
    assertAddress(record(transaction.transaction, `hydrated broadcast.transactions[${index}].transaction`).from, manifest.governanceAccount, `hydrated broadcast.transactions[${index}].from`);
  }
  for (let index = 0; index < receipts.length; index += 1) {
    const receipt = record(receipts[index], `hydrated broadcast.receipts[${index}]`);
    const hash = bytes32(receipt.transactionHash, `hydrated broadcast.receipts[${index}].transactionHash`);
    if (receiptByHash.has(hash)) fail(`hydrated broadcast receipt ${hash} is duplicated`);
    receiptByHash.set(hash, receipt);
    exact(receipt.status, "0x1", `hydrated broadcast.receipts[${index}].status`);
    assertAddress(receipt.from, manifest.governanceAccount, `hydrated broadcast.receipts[${index}].from`);
    const blockNumber = Number(BigInt(string(receipt.blockNumber, `hydrated broadcast.receipts[${index}].blockNumber`)));
    integer(blockNumber, `hydrated broadcast.receipts[${index}].blockNumber`, 1);
    if (blockNumber > captureBlock) fail(`hydrated broadcast receipt ${hash} is newer than the configured-state capture`);
  }
  if (transactionByHash.size !== receiptByHash.size || [...transactionByHash.keys()].some((hash) => !receiptByHash.has(hash))) {
    fail("hydrated broadcast transaction and receipt hashes do not match exactly");
  }

  for (const role of CONTRACT_ROLES) {
    const manifestContract = manifest.contracts[role];
    const transaction = transactionByHash.get(manifestContract.transactionHash);
    const receipt = receiptByHash.get(manifestContract.transactionHash);
    if (!transaction || !receipt) fail(`hydrated broadcast is missing the ${role} deployment transaction`);
    exact(transaction.transactionType, "CREATE", `hydrated broadcast ${role} transactionType`);
    assertAddress(transaction.contractAddress, manifestContract.address, `hydrated broadcast ${role} contractAddress`);
    assertAddress(receipt.contractAddress, manifestContract.address, `hydrated broadcast ${role} receipt contractAddress`);
    exact(Number(BigInt(receipt.blockNumber)), manifestContract.deploymentBlock, `hydrated broadcast ${role} deployment block`);
  }
  return { root, transactions, receipts };
}

function validateChainState(state, manifest) {
  const root = record(state, "configured chain state");
  exact(root.schemaVersion, MANIFEST_SCHEMA_VERSION, "configured chain state.schemaVersion");
  exact(root.chainId, CHAIN_ID, "configured chain state.chainId");
  assertBytes32(root.releaseId, manifest.releaseId, "configured chain state.releaseId");
  const captureBlock = integer(root.captureBlock, "configured chain state.captureBlock", 1);
  const highestDeploymentBlock = Math.max(...CONTRACT_ROLES.map((role) => manifest.contracts[role].deploymentBlock));
  if (captureBlock < highestDeploymentBlock) fail("configured chain state capture predates the deployment");

  const governance = exactKeys(root.governance, ["account", "accountType", "runtimeCode", "nativeBalanceWei"], "configured chain state.governance");
  assertAddress(governance.account, manifest.governanceAccount, "configured chain state.governance.account");
  exact(governance.accountType, "EOA", "configured chain state.governance.accountType");
  exact(governance.runtimeCode, "0x", "configured chain state.governance.runtimeCode");
  if (BigInt(decimalString(governance.nativeBalanceWei, "configured chain state.governance.nativeBalanceWei")) <= 0n) {
    fail("configured chain state governance account must be funded");
  }

  const roles = exactKeys(root.roles, ["registrar", "controller", "marketplace", "registry"], "configured chain state.roles");
  for (const role of ["registrar", "controller", "marketplace"]) {
    const ownership = exactKeys(roles[role], ["owner", "pendingOwner"], `configured chain state.roles.${role}`);
    assertAddress(ownership.owner, manifest.governanceAccount, `configured chain state.roles.${role}.owner`);
    assertAddress(ownership.pendingOwner, ZERO_ADDRESS, `configured chain state.roles.${role}.pendingOwner`);
  }
  const registryRole = exactKeys(roles.registry, ["rootOwner", "baseOwner", "reverseRootOwner", "reverseOwner"], "configured chain state.roles.registry");
  assertAddress(registryRole.rootOwner, manifest.governanceAccount, "configured chain state.roles.registry.rootOwner");
  assertAddress(registryRole.reverseRootOwner, manifest.governanceAccount, "configured chain state.roles.registry.reverseRootOwner");
  assertAddress(registryRole.baseOwner, manifest.contracts.baseRegistrar.address, "configured chain state.roles.registry.baseOwner");
  assertAddress(registryRole.reverseOwner, manifest.contracts.reverseRegistrar.address, "configured chain state.roles.registry.reverseOwner");

  const policy = exactKeys(root.policy, ["controller", "marketplace"], "configured chain state.policy");
  const controllerPolicy = exactKeys(policy.controller, ["paused", "permitSigner", "treasury", "referralBps"], "configured chain state.policy.controller");
  const marketplacePolicy = exactKeys(policy.marketplace, ["paused", "treasury", "feeBps"], "configured chain state.policy.marketplace");
  exact(controllerPolicy.paused, true, "configured chain state.policy.controller.paused");
  exact(marketplacePolicy.paused, true, "configured chain state.policy.marketplace.paused");
  assertAddress(controllerPolicy.permitSigner, manifest.governanceAccount, "configured chain state.policy.controller.permitSigner");
  assertAddress(controllerPolicy.treasury, manifest.governanceAccount, "configured chain state.policy.controller.treasury");
  assertAddress(marketplacePolicy.treasury, manifest.governanceAccount, "configured chain state.policy.marketplace.treasury");
  exact(controllerPolicy.referralBps, manifest.controllerPolicy.referralBps, "configured chain state.policy.controller.referralBps");
  exact(marketplacePolicy.feeBps, manifest.marketplacePolicy.feeBps, "configured chain state.policy.marketplace.feeBps");

  const wiring = root.wiring;
  const expectedWiring = {
    registrarRegistry: manifest.contracts.registry.address,
    registrarControllerEnabled: true,
    controllerRegistrar: manifest.contracts.baseRegistrar.address,
    controllerSettlementAsset: manifest.settlementAsset,
    controllerPublicResolver: manifest.contracts.publicResolver.address,
    resolverRegistry: manifest.contracts.registry.address,
    reverseRegistry: manifest.contracts.registry.address,
    reverseDefaultResolver: manifest.contracts.publicResolver.address,
    reverseBaseRegistrar: manifest.contracts.baseRegistrar.address,
    reverseNode: "0x91d1777781884d03a6757a803996e38de2a42967fb37eeaca72729271025a9e2",
    reverseBaseNode: manifest.namespace.baseNode,
    reverseSuffix: manifest.namespace.suffix,
    universalRegistry: manifest.contracts.registry.address,
    universalReverseRegistrar: manifest.contracts.reverseRegistrar.address,
    marketplaceRegistrar: manifest.contracts.baseRegistrar.address,
    marketplaceSettlementAsset: manifest.settlementAsset,
  };
  exactKeys(wiring, Object.keys(expectedWiring), "configured chain state.wiring");
  for (const [field, expected] of Object.entries(expectedWiring)) {
    compareSemantic(wiring[field], expected, `configured chain state.wiring.${field}`);
  }

  return { root, captureBlock, governance, roles, policy, wiring };
}

function buildArtifactValues({ manifest, state, arcscan, hashes, transactionCount }) {
  const releaseIdentity = manifest.registrarVersion === "v2"
    ? {
        registrarVersion: "v2",
        nftMetadata: { metadataBaseURI: manifest.metadataBaseURI },
        legacyReleaseIds: manifest.legacyReleases.map((release) => release.releaseId),
      }
    : {};
  const common = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    chainId: CHAIN_ID,
    releaseId: manifest.releaseId,
    captureBlock: state.captureBlock,
    status: CONFIGURED_STATUS,
    ...releaseIdentity,
  };
  const contracts = Object.fromEntries(CONTRACT_ROLES.map((role) => {
    const contract = manifest.contracts[role];
    return [role, {
      address: contract.address,
      transactionHash: contract.transactionHash,
      deploymentBlock: contract.deploymentBlock,
      runtimeCodeHash: contract.runtimeCodeHash,
    }];
  }));

  return {
    "deployment-receipts.json": {
      ...common,
      artifact: "deploymentReceipts",
      hydratedFoundryReceiptSha256: hashes.broadcast,
      deploymentEvidenceSha256: hashes.deploymentEvidence,
      transactionCount,
      receiptsSuccessful: true,
      contracts,
    },
    "constructor-wiring.json": {
      ...common,
      artifact: "constructorWiring",
      configuredChainStateSha256: hashes.chainState,
      wiring: state.wiring,
    },
    "governance-roles.json": {
      ...common,
      artifact: "governanceRoles",
      governance: state.governance,
      roles: state.roles,
    },
    "treasury-controls.json": {
      ...common,
      artifact: "treasuryControls",
      governanceAccount: manifest.governanceAccount,
      controller: {
        treasury: state.policy.controller.treasury,
        referralBps: state.policy.controller.referralBps,
        registrationsPaused: state.policy.controller.paused,
      },
      marketplace: {
        treasury: state.policy.marketplace.treasury,
        feeBps: state.policy.marketplace.feeBps,
        paused: state.policy.marketplace.paused,
      },
    },
    "signer-policy.json": {
      ...common,
      artifact: "signerPolicy",
      controller: manifest.contracts.controller.address,
      permitSigner: state.policy.controller.permitSigner,
      signerPolicyVersion: "1",
      registrationsPaused: state.policy.controller.paused,
      custodyModel: "SINGLE_ARC_TESTNET_EOA_SERVER_SECRET",
      challengeModel: "STATELESS_HMAC_SHA256",
      challengeTtlSeconds: 120,
      permitTtlSeconds: 180,
      postgresRequiredForCoreIssuer: false,
      kmsRequiredForCoreIssuer: false,
      serverSignerReadinessProven: false,
    },
    "release-attestation.json": {
      ...common,
      artifact: "releaseAttestation",
      productLive: false,
      independentReviewerApproved: false,
      sourceVerificationPending: false,
      sourceVerifiedContracts: CONTRACT_ROLES.length,
      compilerVersion: arcscan.verification.compilerVersion,
      optimizerRuns: arcscan.verification.optimizerRuns,
      evmVersion: arcscan.verification.evmVersion,
      configuredManifestSha256: hashes.manifest,
      arcscanEvidenceIndexSha256: hashes.arcscanIndex,
      configuredChainStateSha256: hashes.chainState,
      deploymentEvidenceSha256: hashes.deploymentEvidence,
      statement: "This record proves the paused single-owner Arc Testnet deployment and seven matching ArcScan source/ABI verifications; issuer readiness, funded acceptance and product-live activation remain pending.",
    },
  };
}

export function buildConfiguredEvidencePublication({
  manifestBytes,
  deploymentEvidenceBytes,
  chainStateBytes,
  broadcastBytes,
  arcscanIndexBytes,
  baseUrl,
  commit,
}) {
  for (const [field, bytes] of Object.entries({ manifestBytes, deploymentEvidenceBytes, chainStateBytes, broadcastBytes, arcscanIndexBytes })) {
    if (!Buffer.isBuffer(bytes)) fail(`${field} must be a Buffer`);
  }
  const immutableBaseUrl = normalizedBaseUrl(baseUrl);
  const exactCommit = commitSha(commit);
  const hashes = {
    manifest: sha256(manifestBytes),
    deploymentEvidence: sha256(deploymentEvidenceBytes),
    chainState: sha256(chainStateBytes),
    broadcast: sha256(broadcastBytes),
    arcscanIndex: sha256(arcscanIndexBytes),
  };

  const manifest = validateManifest(parseJson(manifestBytes, "manifest"));
  const state = validateChainState(parseJson(chainStateBytes, "configured chain state"), manifest);
  const broadcast = validateBroadcast(parseJson(broadcastBytes, "hydrated broadcast"), manifest, state.captureBlock);
  validateDeploymentEvidence(
    parseJson(deploymentEvidenceBytes, "deployment evidence"),
    hashes.deploymentEvidence,
    hashes.broadcast,
    manifest,
  );
  const arcscan = validateArcscanIndex(parseJson(arcscanIndexBytes, "ArcScan index"), manifest);

  const artifactValues = buildArtifactValues({
    manifest,
    state,
    arcscan,
    hashes,
    transactionCount: broadcast.transactions.length,
  });
  const artifacts = Object.fromEntries(ARTIFACT_DEFINITIONS.map(([name, artifactId, schema]) => {
    const bytes = jsonBytes(artifactValues[name]);
    return [name, { name, artifactId, schema, value: artifactValues[name], bytes, sha256: sha256(bytes) }];
  }));

  const publicationDescriptor = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chainId: CHAIN_ID,
    releaseId: manifest.releaseId,
    manifestSha256: hashes.manifest,
    arcscanEvidenceIndexSha256: hashes.arcscanIndex,
    generatedAt: arcscan.generatedAt,
    commit: exactCommit,
    baseUrl: immutableBaseUrl,
    artifacts: ARTIFACT_DEFINITIONS.map(([name, artifactId]) => ({ artifactId, sha256: artifacts[name].sha256 })),
  };
  const publicationDigest = sha256(jsonBytes(publicationDescriptor));
  const publicationSegment = publicationDigest.slice(2);
  const indexValue = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    chainId: CHAIN_ID,
    releaseId: manifest.releaseId,
    manifestSha256: hashes.manifest,
    arcscanEvidenceIndexSha256: hashes.arcscanIndex,
    publicationDigest,
    generatedAt: arcscan.generatedAt,
    commit: exactCommit,
    artifacts: ARTIFACT_DEFINITIONS.map(([name, artifactId, schema]) => ({
      artifactId,
      schema,
      url: `${immutableBaseUrl}/${publicationSegment}/${name}`,
      sha256: artifacts[name].sha256,
      mediaType: "application/json",
      chainId: CHAIN_ID,
      releaseId: manifest.releaseId,
      blockNumber: state.captureBlock,
      createdAt: arcscan.generatedAt,
    })),
  };
  const indexBytes = jsonBytes(indexValue);

  return {
    chainId: CHAIN_ID,
    releaseId: manifest.releaseId,
    publicationDigest,
    publicationSegment,
    generatedAt: arcscan.generatedAt,
    commit: exactCommit,
    baseUrl: immutableBaseUrl,
    inputHashes: hashes,
    artifacts,
    index: { value: indexValue, bytes: indexBytes, sha256: sha256(indexBytes) },
  };
}

export function parseConfiguredEvidenceArguments(argv) {
  if (!Array.isArray(argv) || argv.length !== REQUIRED_ARGUMENTS.length * 2) fail(USAGE);
  const allowed = new Set(REQUIRED_ARGUMENTS);
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!allowed.has(flag) || typeof value !== "string" || value.length === 0 || value.startsWith("--") || values.has(flag)) {
      fail(USAGE);
    }
    values.set(flag, value);
  }
  if (values.size !== REQUIRED_ARGUMENTS.length) fail(USAGE);
  return {
    manifest: resolve(values.get("--manifest")),
    deploymentEvidence: resolve(values.get("--deployment-evidence")),
    chainState: resolve(values.get("--chain-state")),
    broadcast: resolve(values.get("--broadcast")),
    arcscanIndex: resolve(values.get("--arcscan-index")),
    outputDir: resolve(values.get("--output-dir")),
    baseUrl: values.get("--base-url"),
    commit: values.get("--commit"),
  };
}

export async function publishConfiguredEvidence(options) {
  const paths = record(options, "publication options");
  const [manifestBytes, deploymentEvidenceBytes, chainStateBytes, broadcastBytes, arcscanIndexBytes] = await Promise.all([
    readFile(paths.manifest),
    readFile(paths.deploymentEvidence),
    readFile(paths.chainState),
    readFile(paths.broadcast),
    readFile(paths.arcscanIndex),
  ]);
  const publication = buildConfiguredEvidencePublication({
    manifestBytes,
    deploymentEvidenceBytes,
    chainStateBytes,
    broadcastBytes,
    arcscanIndexBytes,
    baseUrl: paths.baseUrl,
    commit: paths.commit,
  });

  const outputDir = resolve(string(paths.outputDir, "outputDir"));
  const publicationDir = resolve(outputDir, publication.publicationSegment);
  await mkdir(outputDir, { recursive: true, mode: 0o755 });
  try {
    await mkdir(publicationDir, { mode: 0o755 });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      fail(`immutable publication ${publication.publicationDigest} already exists; refusing to overwrite it`);
    }
    throw error;
  }

  for (const [name] of ARTIFACT_DEFINITIONS) {
    await writeFile(resolve(publicationDir, name), publication.artifacts[name].bytes, { flag: "wx", mode: 0o644 });
  }
  await writeFile(resolve(publicationDir, "index.json"), publication.index.bytes, { flag: "wx", mode: 0o644 });

  return {
    status: "PUBLISHED_CONFIGURED_EVIDENCE",
    chainId: publication.chainId,
    releaseId: publication.releaseId,
    publicationDigest: publication.publicationDigest,
    publicationDirectory: publicationDir,
    index: {
      file: resolve(publicationDir, "index.json"),
      sha256: publication.index.sha256,
    },
    artifacts: Object.fromEntries(ARTIFACT_DEFINITIONS.map(([name]) => [name, {
      file: resolve(publicationDir, name),
      sha256: publication.artifacts[name].sha256,
    }])),
  };
}

export const configuredEvidenceConstants = Object.freeze({
  chainId: CHAIN_ID,
  contractRoles: CONTRACT_ROLES,
  configuredStatus: CONFIGURED_STATUS,
  artifactNames: ARTIFACT_DEFINITIONS.map(([name]) => name),
});
