import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ACTIVATION_ARTIFACT_KEYS,
  createPromotionAttestation,
  EXPECTED_RESOLVER_CAPABILITIES,
  parseDeploymentManifest,
} from "@contour/config";
import { renderBensArtifacts } from "../../../ops/bens/render-config-lib.mjs";

const manifestValue = JSON.parse(await readFile(
  new URL("../../../deployments/5042002.json", import.meta.url),
  "utf8",
));
const configuredAttestation = JSON.parse(await readFile(
  new URL("../../../deployments/5042002.promotion.json", import.meta.url),
  "utf8",
));
const template = await readFile(
  new URL("../../../ops/bens/config.template.json", import.meta.url),
  "utf8",
);

function productLiveManifest() {
  const value = structuredClone(manifestValue);
  value.state = "active";
  value.activationEvidence.productLive = true;
  value.activationEvidence.verifiedAtBlock = Math.max(
    ...Object.values(value.contracts).map((contract) => contract.deploymentBlock),
  ) + 100;
  for (const [index, key] of ACTIVATION_ARTIFACT_KEYS.entries()) {
    value.activationEvidence.artifacts[key] = {
      url: `https://evidence.example.com/contour-v1/${key}.json`,
      sha256: `0x${(index + 1).toString(16).padStart(64, "0")}`,
    };
  }
  for (const [index, contract] of Object.values(value.contracts).entries()) {
    const evidenceHash = `0x${(index + 101).toString(16).padStart(64, "0")}`;
    contract.sourceVerified = true;
    contract.abiUrl = `https://evidence.example.com/contour-v1/abi/${contract.address}.json`;
    contract.abiSha256 = evidenceHash;
    contract.sourceVerificationUrl = `https://testnet.arcscan.app/address/${contract.address}`;
    contract.sourceVerificationSha256 = evidenceHash;
  }
  value.activationEvidence.controllerPolicy.registrationsPaused = false;
  value.activationEvidence.marketplacePolicy.paused = false;
  value.permitIssuer.url = "https://issuer.example.com";
  value.permitIssuer.active = true;
  value.resolverCapabilities = { ...EXPECTED_RESOLVER_CAPABILITIES };
  value.bens = {
    protocolConfigured: true,
    subgraphSynced: false,
    apiUrl: "https://bens.example.com",
    subgraphUrl: "https://graph.example.com/subgraphs/name/contour-arc-testnet",
    hostedArcscanActive: false,
  };
  return parseDeploymentManifest(value);
}

function productLiveAttestation(manifest) {
  return createPromotionAttestation(
    manifest,
    String(manifest.activationEvidence.verifiedAtBlock),
  );
}

test("configured release cannot render BENS runtime config", () => {
  assert.throws(
    () => renderBensArtifacts(manifestValue, configuredAttestation, template),
    /live verification|active product-live/,
  );
});

test("product-live render binds config, manifest endpoints and attestation", () => {
  const manifest = productLiveManifest();
  const attestation = productLiveAttestation(manifest);
  const { configText, bindingText } = renderBensArtifacts(manifest, attestation, template);
  const config = JSON.parse(configText);
  const binding = JSON.parse(bindingText);

  assert.equal(config.subgraphs_reader.protocols.contour.subgraph_name, "contour-arc-testnet");
  assert.equal(config.subgraphs_reader.protocols.contour.specific.registry_contract, manifest.contracts.registry.address);
  assert.equal(binding.manifestSha256, attestation.manifestSha256);
  assert.equal(binding.productLive, true);
  assert.equal(binding.liveVerified, true);
  assert.equal(binding.bens.apiUrl, manifest.bens.apiUrl);
  assert.equal(binding.bens.subgraphUrl, manifest.bens.subgraphUrl);
  assert.match(binding.configSha256, /^0x[0-9a-f]{64}$/);
});

test("private candidate cannot render BENS runtime config", () => {
  const manifest = structuredClone(productLiveManifest());
  manifest.activationEvidence.productLive = false;
  manifest.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
  manifest.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
  const attestation = productLiveAttestation(manifest);
  assert.throws(
    () => renderBensArtifacts(manifest, attestation, template),
    /active product-live/,
  );
});

test("product-live BENS endpoints must be public and bind the configured subgraph name", () => {
  const local = structuredClone(productLiveManifest());
  local.bens.apiUrl = "https://localhost:8050";
  assert.throws(
    () => renderBensArtifacts(local, productLiveAttestation(local), template),
    /public HTTPS URL/,
  );

  const wrongSubgraph = structuredClone(productLiveManifest());
  wrongSubgraph.bens.subgraphUrl = "https://graph.example.com/subgraphs/name/other-release";
  assert.throws(
    () => renderBensArtifacts(
      wrongSubgraph,
      productLiveAttestation(wrongSubgraph),
      template,
    ),
    /subgraphs\/name\/contour-arc-testnet/,
  );
});
