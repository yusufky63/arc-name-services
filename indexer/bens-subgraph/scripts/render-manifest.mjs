import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertProductLivePromotionAttestation,
  parseDeploymentManifest,
} from "@contour/config";

const manifestPath = resolve(process.argv[2] ?? "../../deployments/5042002.json");
const attestationPath = resolve(
  process.argv[3] ?? manifestPath.replace(/\.json$/i, ".promotion.json"),
);
const manifest = parseDeploymentManifest(JSON.parse(await readFile(manifestPath, "utf8")));
const attestation = JSON.parse(await readFile(attestationPath, "utf8"));
assertProductLivePromotionAttestation(attestation, manifest);
if (!manifest.namespace.suffix || !manifest.namespace.baseNode) {
  throw new Error("suffix/baseNode are not configured");
}

const required = ["registry", "baseRegistrar", "controller", "publicResolver"];
for (const key of required) {
  const item = manifest.contracts[key];
  if (!item.address || !item.deploymentBlock) {
    throw new Error(`${key} requires a real address and positive deployment block`);
  }
}
const replacement = {
  suffix: manifest.namespace.suffix,
  baseNode: manifest.namespace.baseNode,
  registryAddress: manifest.contracts.registry.address,
  registryStartBlock: manifest.contracts.registry.deploymentBlock,
  baseRegistrarAddress: manifest.contracts.baseRegistrar.address,
  baseRegistrarStartBlock: manifest.contracts.baseRegistrar.deploymentBlock,
  controllerAddress: manifest.contracts.controller.address,
  controllerStartBlock: manifest.contracts.controller.deploymentBlock,
  publicResolverAddress: manifest.contracts.publicResolver.address,
  publicResolverStartBlock: manifest.contracts.publicResolver.deploymentBlock,
};
let template = await readFile(new URL("../subgraph.template.yaml", import.meta.url), "utf8");
for (const [key, value] of Object.entries(replacement)) template = template.replaceAll(`{{${key}}}`, String(value));
if (/{{[^}]+}}/.test(template)) throw new Error("unresolved subgraph template value");
await writeFile(new URL("../subgraph.yaml", import.meta.url), template, { flag: "w" });
