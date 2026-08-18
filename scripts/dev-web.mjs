#!/usr/bin/env node

import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function parseEnvValue(rawValue) {
  const value = rawValue.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
      .replaceAll("\\n", "\n")
      .replaceAll("\\r", "\r")
      .replaceAll("\\t", "\t")
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\");
  }
  return value.replace(/\s+#.*$/, "").trimEnd();
}

async function loadRootEnv() {
  let source;
  try {
    source = await readFile(resolve(".env"), "utf8");
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }

  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    // Explicit shell/CI values win over the local file. Values are loaded into
    // the child environment only and are never written to stdout.
    if (process.env[key] === undefined) process.env[key] = parseEnvValue(rawValue);
  }
}

async function loadLocalDevelopmentSecrets() {
  if (!process.env.REGISTRATION_CHALLENGE_SECRET?.trim()) {
    process.env.REGISTRATION_CHALLENGE_SECRET = randomBytes(32).toString("hex");
  }
  if (process.env.REGISTRATION_ALLOW_LOOPBACK_CANONICAL_ORIGIN === undefined) {
    process.env.REGISTRATION_ALLOW_LOOPBACK_CANONICAL_ORIGIN = "true";
  }
}

await loadRootEnv();
await loadLocalDevelopmentSecrets();

const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const port = process.env.PORT?.trim() || "3002";
if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535) {
  throw new Error("PORT must be a decimal TCP port between 1 and 65535");
}
const child = spawn(
  command,
  ["--filter", "@contour/web", "exec", "next", "dev", "--port", port],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
    // Node 22 no longer launches .cmd shims directly on Windows. The command
    // and arguments are fixed application constants, so using cmd.exe here
    // only unwraps pnpm.cmd and never evaluates data from .env.
    shell: process.platform === "win32",
  },
);

child.once("error", (error) => {
  process.stderr.write(`web development process failed: ${error.message}\n`);
  process.exitCode = 1;
});

child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
