import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderBensArtifacts } from "./render-config-lib.mjs";

const source = resolve(process.argv[2] ?? "../../deployments/5042002.json");
const attestationSource = resolve(
  process.argv[3] ?? source.replace(/\.json$/i, ".promotion.json"),
);

const [manifestBytes, attestationBytes, template] = await Promise.all([
  readFile(source, "utf8"),
  readFile(attestationSource, "utf8"),
  readFile(new URL("./config.template.json", import.meta.url), "utf8"),
]);
const { configText, bindingText } = renderBensArtifacts(
  JSON.parse(manifestBytes),
  JSON.parse(attestationBytes),
  template,
);

await Promise.all([
  writeFile(new URL("./config.generated.json", import.meta.url), configText, { flag: "w" }),
  writeFile(new URL("./config.generated.binding.json", import.meta.url), bindingText, { flag: "w" }),
]);
