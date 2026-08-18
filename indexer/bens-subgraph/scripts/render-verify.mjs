import { readFile, writeFile } from "node:fs/promises";

const baseNode = "0xb0622ac8c513b1e04f26418271b595fae314dbed2e3dea63916fc45cde7c5bbe";
let template = await readFile(new URL("../subgraph.template.yaml", import.meta.url), "utf8");

// Compile the exact production mappings without inventing deployment data. A
// contract data source may omit `address`; the output is ignored and is never
// deployable or accepted by the activation renderer.
template = template
  .replaceAll("{{suffix}}", "contour")
  .replaceAll("{{baseNode}}", baseNode)
  .replaceAll(/\{\{(?:registry|baseRegistrar|controller|publicResolver)StartBlock\}\}/g, "1")
  .replace(/^[ \t]*address:[ \t]*"\{\{(?:registry|baseRegistrar|controller|publicResolver)Address\}\}"\r?\n/gm, "");

if (/\{\{[^}]+\}\}/.test(template)) throw new Error("unresolved verification manifest value");
await writeFile(
  new URL("../subgraph.verify.yaml", import.meta.url),
  "# COMPILE-ONLY: address-less mapping verification; never deploy this file.\n" + template,
  { flag: "w" },
);

