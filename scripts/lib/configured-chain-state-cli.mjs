import { resolve } from "node:path";

const DEFAULT_MANIFEST = resolve("deployments", "5042002.json");

function fail(message) {
  throw new Error(
    `usage: capture-configured-chain-state [--manifest <manifest.json>] [--output <new-file>]: ${message}`,
  );
}

export function parseConfiguredChainStateArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!["--manifest", "--output"].includes(flag) || values.has(flag)) {
      fail(`unknown or duplicate argument ${String(flag)}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires one value`);
    values.set(flag, value);
    index += 1;
  }
  return {
    manifestPath: resolve(values.get("--manifest") ?? DEFAULT_MANIFEST),
    outputPath: values.has("--output") ? resolve(values.get("--output")) : null,
  };
}

