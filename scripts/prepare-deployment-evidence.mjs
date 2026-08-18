#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  CONTRACT_KEYS,
  deploymentArtifactPaths,
  prepareConfiguredDeploymentManifest,
  prepareDeploymentEvidence,
  renderPublicDeploymentEnv,
} from "../packages/config/dist/index.js";

const HELP = `Usage:
  pnpm prepare:deployment-evidence --broadcast <run-latest.json> [options]

Options:
  --broadcast <path>   Completed Foundry run-latest JSON (required)
  --artifacts <dir>    Foundry artifact root (default: contracts/out)
  --manifest <path>    Draft or receipt-matching configured manifest (default: deployments/5042002.json)
  --output-dir <dir>   New output directory (default: deployments/local/5042002-prepared)
  --registrar-version <v1|v2>
                       Registrar artifact/release profile (default: v1; V2 must be explicit)
  --help               Show this message

The command is offline: it never reads process environment variables, calls RPC,
loads a wallet, or sends a transaction. A configured input must remain unverified,
paused and product-live false; verified/active or mismatched inputs fail closed.
Contract ABI/source-verification metadata is untrusted here and is reset in the output.
The output directory must not already exist.
`;

function parseArguments(argv) {
  const result = {
    artifacts: "contracts/out",
    manifest: "deployments/5042002.json",
    outputDir: "deployments/local/5042002-prepared",
    registrarVersion: "v1",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help") return { help: true };
    if (![
      "--broadcast",
      "--artifacts",
      "--manifest",
      "--output-dir",
      "--registrar-version",
    ].includes(argument)) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
    index += 1;
    if (argument === "--broadcast") result.broadcast = value;
    if (argument === "--artifacts") result.artifacts = value;
    if (argument === "--manifest") result.manifest = value;
    if (argument === "--output-dir") result.outputDir = value;
    if (argument === "--registrar-version") result.registrarVersion = value;
  }
  if (!result.broadcast) throw new Error("--broadcast is required");
  if (!["v1", "v2"].includes(result.registrarVersion)) {
    throw new Error("--registrar-version must be v1 or v2");
  }
  return result;
}

function parseJson(bytes, field) {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${field} is not valid JSON`);
  }
}

function sha256(bytes) {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeOutputDirectory(outputDir, files) {
  const target = resolve(outputDir);
  if (await exists(target)) {
    throw new Error(`output directory already exists: ${target}`);
  }
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, `.${basename(target)}.tmp-`));
  try {
    for (const [name, contents] of Object.entries(files)) {
      await writeFile(join(staging, name), contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
    }
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
  return target;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }

  const broadcastPath = resolve(options.broadcast);
  const artifactRoot = resolve(options.artifacts);
  const manifestPath = resolve(options.manifest);
  const artifactPaths = deploymentArtifactPaths(options.registrarVersion);
  const [broadcastBytes, manifestBytes] = await Promise.all([
    readFile(broadcastPath),
    readFile(manifestPath),
  ]);
  const artifactResults = await Promise.all(CONTRACT_KEYS.map(async (key) => {
    const artifactPath = join(artifactRoot, artifactPaths[key]);
    const bytes = await readFile(artifactPath);
    return {
      key,
      value: parseJson(bytes, `${key} artifact`),
      input: {
        file: artifactPaths[key].replaceAll("\\", "/"),
        sha256: sha256(bytes),
      },
    };
  }));
  const artifactValues = Object.fromEntries(artifactResults.map(({ key, value }) => [key, value]));
  const artifactInputs = Object.fromEntries(artifactResults.map(({ key, input }) => [key, input]));

  const evidence = prepareDeploymentEvidence(
    parseJson(broadcastBytes, "Foundry broadcast"),
    artifactValues,
    { registrarVersion: options.registrarVersion },
  );
  const manifest = prepareConfiguredDeploymentManifest(
    parseJson(manifestBytes, "manifest template"),
    evidence,
  );
  const report = {
    ...evidence,
    inputs: {
      broadcast: { sha256: sha256(broadcastBytes) },
      artifacts: artifactInputs,
      manifestTemplate: { sha256: sha256(manifestBytes) },
    },
  };

  const target = await writeOutputDirectory(options.outputDir, {
    "deployment-evidence.json": `${JSON.stringify(report, null, 2)}\n`,
    "manifest.configured.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "deployment.public.env": renderPublicDeploymentEnv(evidence),
  });
  process.stdout.write(`${JSON.stringify({
    status: "prepared",
    outputDirectory: target,
    files: ["deployment-evidence.json", "manifest.configured.json", "deployment.public.env"],
    chainId: evidence.chain.id,
    releaseId: evidence.config.releaseId,
    registrarVersion: evidence.config.registrarVersion,
  }, null, 2)}\n`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`deployment evidence preparation failed: ${message}\n`);
  process.exitCode = 1;
});
