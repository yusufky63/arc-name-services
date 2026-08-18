import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const manifest = JSON.parse(await readFile(resolve(process.argv[2] ?? "../../deployments/5042002.json"), "utf8"));
if (manifest.chain?.id !== 5042002 || manifest.state === "draft" || !manifest.namespace?.suffix || !manifest.namespace?.baseNode) {
  throw new Error("Arc protocol handoff requires an activated suffix/base node");
}
for (const key of ["registry", "publicResolver", "controller", "baseRegistrar"]) {
  const item = manifest.contracts?.[key];
  if (!/^0x[0-9a-fA-F]{40}$/.test(item?.address ?? "") || !Number.isSafeInteger(item?.deploymentBlock) || item.deploymentBlock <= 0) {
    throw new Error(`${key} deployment evidence is incomplete`);
  }
}
const q = (value) => JSON.stringify(value);
const generated = [
  "network: arc-testnet",
  `registry_address: ${q(manifest.contracts.registry.address)}`,
  `registry_start_block: ${manifest.contracts.registry.deploymentBlock}`,
  `resolver_address: ${q(manifest.contracts.publicResolver.address)}`,
  `resolver_start_block: ${manifest.contracts.publicResolver.deploymentBlock}`,
  `controller_address: ${q(manifest.contracts.controller.address)}`,
  `controller_start_block: ${manifest.contracts.controller.deploymentBlock}`,
  `base_address: ${q(manifest.contracts.baseRegistrar.address)}`,
  `base_start_block: ${manifest.contracts.baseRegistrar.deploymentBlock}`,
  `base_tld: ${q("." + manifest.namespace.suffix)}`,
  `base_tld_hash: ${q(manifest.namespace.baseNode)}`,
  "",
].join("\n");
await writeFile(new URL("./protocol.generated.yaml", import.meta.url), generated, { flag: "w" });
