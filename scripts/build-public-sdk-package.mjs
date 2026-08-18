import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifestPath = join(root, "npm", "sdk", "package.json");
const outputRoot = join(root, "npm", "sdk", "dist");

const packageManifest = JSON.parse(await readFile(packageManifestPath, "utf8"));
if (packageManifest.name !== "contour-sdk") {
  throw new Error(
    `Refusing to build unexpected public package ${String(packageManifest.name)}; expected contour-sdk`,
  );
}

async function copyCompiledPackage(sourceName, destinationName, replacements = []) {
  const source = join(root, "packages", sourceName, "dist");
  const destination = join(outputRoot, destinationName);
  await mkdir(destination, { recursive: true });

  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      throw new Error(`Unexpected nested build directory: ${join(source, entry.name)}`);
    }
    if (entry.name.includes(".test.") || entry.name.endsWith(".map")) continue;
    if (!entry.name.endsWith(".js") && !entry.name.endsWith(".d.ts")) continue;

    let contents = await readFile(join(source, entry.name), "utf8");
    for (const [from, to] of replacements) contents = contents.replaceAll(from, to);
    contents = contents.replace(/\r?\n\/\/# sourceMappingURL=.*(?:\r?\n)?$/u, "\n");
    await writeFile(join(destination, entry.name), contents, "utf8");
  }
}

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

await copyCompiledPackage("config", "config");
await copyCompiledPackage("normalization", "normalization");
await copyCompiledPackage("sdk", "sdk", [
  ["@contour/config", "../config/index.js"],
  ["@contour/normalization", "../normalization/index.js"],
]);

const publicEntry = [
  'export * from "./sdk/index.js";',
  'export * from "./config/index.js";',
  'export * from "./normalization/index.js";',
  "",
].join("\n");

await writeFile(join(outputRoot, "index.js"), publicEntry, "utf8");
await writeFile(join(outputRoot, "index.d.ts"), publicEntry, "utf8");

console.log(`Prepared public SDK package at ${outputRoot}`);
