#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const CANONICAL_ARC_RPC_URL = "https://rpc.testnet.arc.network";
// Historical signed manifests contain this metadata. Runtime transports are
// checked separately and may only use the canonical HTTPS endpoint.
export const CANONICAL_ARC_WS_URL = CANONICAL_ARC_RPC_URL.replace(/^https:/, "wss:");
export const EXPECTED_VERCEL_BUILD_COMMAND =
  "pnpm packages:build && pnpm --filter @contour/web lint && pnpm --filter @contour/web typecheck && pnpm --filter @contour/web test && pnpm --filter @contour/web build";
export const CANONICAL_PUBLIC_ORIGIN = "https://contour-arc.vercel.app";

export const REQUIRED_VERCELIGNORE_PATTERNS = Object.freeze([
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  ".local-keystores/",
  ".git/",
  ".agents/",
  ".codex/",
  ".vercel/",
  "broadcast/",
  "**/broadcast/",
  "output/",
  ".playwright-cli/",
  "node_modules/",
  "**/node_modules/",
  ".next/",
  "**/.next/",
  "dist/",
  "**/dist/",
  "coverage/",
  "**/coverage/",
  "artifacts/",
  "**/artifacts/",
  "cache/",
  "**/cache/",
  "out/",
  "**/out/",
  "*.log",
  "*.tsbuildinfo",
  ".pnpm-store/",
  ".github/",
  "contracts/",
  "deployments/evidence/",
  "deployments/local/",
  "docs/",
  "indexer/",
  "ops/",
  "apps/permit-issuer/",
  "apps/x402-keeper/",
]);

const SECRET_ENV_FILES = Object.freeze([
  ".env",
  "apps/web/.env.local",
  ".local-keystores/release-activation.env",
]);
const SECRET_KEY_PATTERN =
  /(?:^|_)(?:PRIVATE_KEY|SECRET|PASSWORD|TOKEN|MNEMONIC|SEED|KEYSTORE|CREDENTIAL|API_KEY)(?:$|_)/i;
const ENV_FILE_PATTERN = /^\.env(?:\..+)?$/;
const GIT_OBJECT_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i;
const PROMOTION_EVIDENCE_ARTIFACTS = Object.freeze([
  "fundedEndToEnd",
  "operationsDrill",
]);
const PROMOTION_EVIDENCE_ISSUE_CODES = Object.freeze({
  fundedEndToEnd: "PROMOTION_FUNDED_END_TO_END_EVIDENCE_MISSING",
  operationsDrill: "PROMOTION_OPERATIONS_DRILL_EVIDENCE_MISSING",
});
const LEGACY_CONTRACT_ROLES = Object.freeze([
  "registry",
  "baseRegistrar",
  "controller",
  "publicResolver",
  "reverseRegistrar",
  "universalResolver",
  "marketplace",
]);
const OPERATIONAL_EXTENSIONS = new Set([
  ".cjs", ".env", ".js", ".json", ".jsx", ".mjs", ".ps1", ".sh",
  ".sol", ".toml", ".ts", ".tsx", ".yaml", ".yml",
]);
const ALWAYS_SKIPPED_DIRECTORY_NAMES = new Set([
  ".git", ".next", ".pnpm-store", ".playwright-cli", ".turbo", ".vercel",
  "artifacts", "broadcast", "cache", "coverage", "dist", "node_modules", "out",
]);
const NON_OPERATIONAL_ROOT_PREFIXES = Object.freeze([
  ".agents",
  ".codex",
  ".github",
  ".local-keystores",
  "deployments/evidence",
  "deployments/local",
  "docs",
  "output",
]);
const SECRET_SCAN_ROOT_PREFIXES = Object.freeze([
  ".agents",
  ".codex",
  ".github",
  ".local-keystores",
  ".playwright-cli",
  ".vercel",
  "apps/permit-issuer",
  "apps/x402-keeper",
  "contracts",
  "deployments/evidence",
  "deployments/local",
  "docs",
  "indexer",
  "ops",
  "output",
]);
const HISTORICAL_WS_MANIFEST_PATHS = new Set([
  "deployments/5042002.json",
  "deployments/5042002.legacy.json",
  "deployments/5042002.verified.json",
  "deployments/5042002.candidate-paused.json",
  "deployments/5042002.candidate-controller-open.json",
  "deployments/5042002.candidate-market-open.json",
]);
const HISTORICAL_WS_VALIDATOR_PATH = "packages/config/src/manifest.ts";
const RUNTIME_CHAIN_PATH = "packages/config/src/chain.ts";
const WEBSOCKET_URL_PATTERN = /\bwss?:\/\//i;

function posixPath(value) {
  return value.split(sep).join("/");
}

function hasPathPrefix(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function extensionOf(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(".");
  return index === -1 ? "" : name.slice(index).toLowerCase();
}

function isEnvironmentFile(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return ENV_FILE_PATTERN.test(name);
}

function isOperationalFile(path) {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (/(?:^|\.)(?:test|spec)\.[^.]+$/i.test(name)) return false;
  if (/^(?:readme|license)(?:\.|$)/i.test(name) || /\.md$/i.test(name)) return false;
  if (isEnvironmentFile(path)) return true;
  if (["Dockerfile", "vercel.json"].includes(name)) return true;
  return OPERATIONAL_EXTENSIONS.has(extensionOf(path));
}

function isRuntimeWebsocketPath(path) {
  return path === RUNTIME_CHAIN_PATH || path.startsWith("apps/") || isEnvironmentFile(path);
}

function hasExactHistoricalManifestWebsocket(path, content) {
  if (!HISTORICAL_WS_MANIFEST_PATHS.has(path)) return false;
  try {
    const manifest = JSON.parse(content);
    const websocketUrls = content.match(/\bwss?:\/\/[^\s\"'`<>)}\],;]+/gi) ?? [];
    return manifest?.chain?.websocketUrl === CANONICAL_ARC_WS_URL
      && websocketUrls.length === 1
      && websocketUrls[0] === CANONICAL_ARC_WS_URL;
  } catch {
    return false;
  }
}

function hasExactHistoricalValidatorWebsocket(path, content) {
  if (path !== HISTORICAL_WS_VALIDATOR_PATH) return false;
  const escapedWs = CANONICAL_ARC_WS_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const websocketUrls = content.match(/\bwss?:\/\/[^\s\"'`<>)}\],;]+/gi) ?? [];
  return new RegExp(
    `manifest\\.chain\\.websocketUrl\\s*!==\\s*[\"']${escapedWs}[\"']`,
  ).test(content)
    && websocketUrls.length === 1
    && websocketUrls[0] === CANONICAL_ARC_WS_URL;
}

function allowsHistoricalWebsocketMetadata(path, content) {
  return hasExactHistoricalManifestWebsocket(path, content)
    || hasExactHistoricalValidatorWebsocket(path, content);
}

async function collectFiles(root, { rootPrefixes = [], include = () => true } = {}) {
  const files = [];
  const pending = [""];
  let skippedSymlinks = 0;

  while (pending.length > 0) {
    const directory = pending.pop();
    const absoluteDirectory = directory ? join(root, ...directory.split("/")) : root;
    let entries;
    try {
      entries = await readdir(absoluteDirectory, { withFileTypes: true });
    } catch {
      throw new Error("release preflight could not enumerate the local workspace");
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skippedSymlinks += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (ALWAYS_SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        if (rootPrefixes.some((prefix) => hasPathPrefix(path, prefix))) continue;
        pending.push(path);
        continue;
      }
      if (entry.isFile() && include(path)) files.push(path);
    }
  }

  files.sort();
  return { files, skippedSymlinks };
}

function parseEnv(content) {
  const values = new Map();
  for (const rawLine of content.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (value.startsWith("\"") || value.startsWith("'")) {
      const quote = value[0];
      let closingQuote = -1;
      for (let index = 1; index < value.length; index += 1) {
        if (value[index] !== quote) continue;
        if (quote === "\"" && value[index - 1] === "\\") continue;
        closingQuote = index;
        break;
      }
      value = closingQuote === -1 ? value.slice(1) : value.slice(1, closingQuote);
      if (quote === "\"") {
        value = value
          .replace(/\\n/g, "\n")
          .replace(/\\r/g, "\r")
          .replace(/\\t/g, "\t")
          .replace(/\\\"/g, "\"")
          .replace(/\\\\/g, "\\");
      }
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    values.set(key, value);
  }
  return values;
}

async function readUtf8(root, path) {
  return readFile(join(root, ...path.split("/")), "utf8");
}

function safeIssue(code, path = undefined) {
  return path ? { code, path } : { code };
}

function sameCaseInsensitive(left, right) {
  return typeof left === "string"
    && typeof right === "string"
    && left.toLowerCase() === right.toLowerCase();
}

function isNonZeroHex32(value) {
  return typeof value === "string"
    && /^0x[0-9a-fA-F]{64}$/.test(value)
    && !/^0x0{64}$/i.test(value);
}

function isNonZeroAddress(value) {
  return typeof value === "string"
    && /^0x[0-9a-fA-F]{40}$/.test(value)
    && !/^0x0{40}$/i.test(value);
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

/**
 * The checked-in canonical V2 document is intentionally compact, so preflight
 * cross-binds its one retained-release reference to the complete V1 manifest.
 * A field-less/current V1 canonical remains compatible before cutover.
 */
export async function checkLegacyCutoverParity(root) {
  const canonicalPath = "deployments/5042002.json";
  const legacyPath = "deployments/5042002.legacy.json";
  let canonical;
  try {
    canonical = JSON.parse(await readUtf8(root, canonicalPath));
  } catch {
    return {
      ok: false,
      mode: null,
      referenceCount: null,
      issues: [safeIssue("LEGACY_CUTOVER_CANONICAL_UNREADABLE", canonicalPath)],
    };
  }

  const registrarVersion = canonical?.registrarVersion ?? "v1";
  if (registrarVersion === "v1") {
    const issues = canonical?.legacyReleases === undefined
      ? []
      : [safeIssue("LEGACY_RELEASES_INVALID_FOR_V1", canonicalPath)];
    return {
      ok: issues.length === 0,
      mode: "v1",
      referenceCount: 0,
      issues,
    };
  }
  if (registrarVersion !== "v2") {
    return {
      ok: false,
      mode: null,
      referenceCount: null,
      issues: [safeIssue("LEGACY_CUTOVER_REGISTRAR_VERSION_INVALID", canonicalPath)],
    };
  }

  const references = canonical?.legacyReleases;
  if (!Array.isArray(references) || references.length !== 1) {
    return {
      ok: false,
      mode: "v2",
      referenceCount: Array.isArray(references) ? references.length : null,
      issues: [safeIssue("LEGACY_CUTOVER_REFERENCE_COUNT_INVALID", canonicalPath)],
    };
  }
  const reference = references[0];
  let legacy;
  try {
    legacy = JSON.parse(await readUtf8(root, legacyPath));
  } catch {
    return {
      ok: false,
      mode: "v2",
      referenceCount: 1,
      issues: [safeIssue("LEGACY_CUTOVER_MANIFEST_UNREADABLE", legacyPath)],
    };
  }

  const issues = [];
  const referenceShapeValid =
    hasExactKeys(reference, [
      "registrarVersion",
      "releaseId",
      "verifiedAtBlock",
      "contracts",
      "controllerPolicy",
      "marketplacePolicy",
    ])
    && isNonZeroHex32(reference.releaseId)
    && Number.isSafeInteger(reference.verifiedAtBlock)
    && reference.verifiedAtBlock > 0
    && hasExactKeys(reference.controllerPolicy, ["registrationsPaused"])
    && hasExactKeys(reference.marketplacePolicy, ["paused"]);
  if (!referenceShapeValid) {
    issues.push(safeIssue("LEGACY_CUTOVER_REFERENCE_INVALID", canonicalPath));
  }
  if (
    isNonZeroHex32(canonical?.releaseId) &&
    sameCaseInsensitive(canonical.releaseId, reference?.releaseId)
  ) {
    issues.push(safeIssue("LEGACY_CUTOVER_RELEASE_ID_REUSED", canonicalPath));
  }
  if ((legacy?.registrarVersion ?? "v1") !== "v1") {
    issues.push(safeIssue("LEGACY_CUTOVER_MANIFEST_NOT_V1", legacyPath));
  }
  if (legacy?.state !== "active") {
    issues.push(safeIssue("LEGACY_CUTOVER_MANIFEST_NOT_ACTIVE", legacyPath));
  }
  if (reference?.registrarVersion !== "v1") {
    issues.push(safeIssue("LEGACY_CUTOVER_REFERENCE_NOT_V1", canonicalPath));
  }
  if (!sameCaseInsensitive(legacy?.releaseId, reference?.releaseId)) {
    issues.push(safeIssue("LEGACY_CUTOVER_RELEASE_ID_MISMATCH", legacyPath));
  }
  if (
    !Number.isSafeInteger(reference?.verifiedAtBlock) ||
    reference.verifiedAtBlock <= 0 ||
    legacy?.activationEvidence?.verifiedAtBlock !== reference.verifiedAtBlock
  ) {
    issues.push(safeIssue("LEGACY_CUTOVER_VERIFICATION_BLOCK_MISMATCH", legacyPath));
  }
  if (
    reference?.controllerPolicy?.registrationsPaused !== true ||
    legacy?.activationEvidence?.controllerPolicy?.registrationsPaused !== true
  ) {
    issues.push(safeIssue("LEGACY_CUTOVER_REGISTRATION_NOT_PAUSED", legacyPath));
  }
  if (
    reference?.marketplacePolicy?.paused !== false ||
    legacy?.activationEvidence?.marketplacePolicy?.paused !== false
  ) {
    issues.push(safeIssue("LEGACY_CUTOVER_MARKETPLACE_NOT_OPEN", legacyPath));
  }

  const referenceContracts = reference?.contracts;
  const legacyContracts = legacy?.contracts;
  const referenceRoles = referenceContracts && typeof referenceContracts === "object"
    ? Object.keys(referenceContracts).sort()
    : [];
  const legacyRoles = legacyContracts && typeof legacyContracts === "object"
    ? Object.keys(legacyContracts).sort()
    : [];
  const expectedRoles = [...LEGACY_CONTRACT_ROLES].sort();
  if (
    referenceRoles.join(",") !== expectedRoles.join(",") ||
    legacyRoles.join(",") !== expectedRoles.join(",")
  ) {
    issues.push(safeIssue("LEGACY_CUTOVER_CONTRACT_SET_MISMATCH", legacyPath));
  } else {
    const canonicalAddresses = new Set(
      LEGACY_CONTRACT_ROLES
        .map((role) => canonical?.contracts?.[role]?.address)
        .filter(isNonZeroAddress)
        .map((value) => value.toLowerCase()),
    );
    for (const role of LEGACY_CONTRACT_ROLES) {
      const expected = referenceContracts[role];
      const actual = legacyContracts[role];
      if (
        !hasExactKeys(expected, ["address", "deploymentBlock", "runtimeCodeHash"]) ||
        !isNonZeroAddress(expected?.address) ||
        !Number.isSafeInteger(expected?.deploymentBlock) ||
        expected.deploymentBlock <= 0 ||
        expected.deploymentBlock > reference.verifiedAtBlock ||
        !isNonZeroHex32(expected?.runtimeCodeHash)
      ) {
        issues.push(safeIssue("LEGACY_CUTOVER_REFERENCE_INVALID", canonicalPath));
        continue;
      }
      if (canonicalAddresses.has(expected.address.toLowerCase())) {
        issues.push(safeIssue("LEGACY_CUTOVER_CONTRACT_ADDRESS_REUSED", canonicalPath));
      }
      if (
        !isNonZeroAddress(actual?.address) ||
        !Number.isSafeInteger(actual?.deploymentBlock) ||
        !isNonZeroHex32(actual?.runtimeCodeHash) ||
        !sameCaseInsensitive(actual?.address, expected?.address) ||
        actual?.deploymentBlock !== expected?.deploymentBlock ||
        !sameCaseInsensitive(actual?.runtimeCodeHash, expected?.runtimeCodeHash)
      ) {
        issues.push(safeIssue(
          `LEGACY_CUTOVER_${role.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase()}_MISMATCH`,
          legacyPath,
        ));
      }
    }
  }

  return {
    ok: issues.length === 0,
    mode: "v2",
    referenceCount: 1,
    releaseId: typeof reference?.releaseId === "string" ? reference.releaseId : null,
    verifiedAtBlock: Number.isSafeInteger(reference?.verifiedAtBlock)
      ? reference.verifiedAtBlock
      : null,
    issues,
  };
}

export async function checkPinnedPublicEvidence(root) {
  const manifestPath = "deployments/5042002.json";
  let manifest;
  try {
    manifest = JSON.parse(await readUtf8(root, manifestPath));
  } catch {
    return {
      ok: false,
      filesChecked: 0,
      issues: [safeIssue("PINNED_EVIDENCE_MANIFEST_UNREADABLE", manifestPath)],
    };
  }

  const artifacts = manifest?.activationEvidence?.artifacts;
  if (!artifacts || typeof artifacts !== "object" || Array.isArray(artifacts)) {
    return { ok: true, filesChecked: 0, issues: [] };
  }

  const issues = [];
  let filesChecked = 0;
  for (const artifact of Object.values(artifacts)) {
    if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) continue;
    if (artifact.url === null && artifact.sha256 === null) continue;
    if (
      typeof artifact.url !== "string"
      || !/^0x[0-9a-fA-F]{64}$/.test(artifact.sha256 ?? "")
    ) {
      issues.push(safeIssue("PINNED_EVIDENCE_REFERENCE_INVALID", manifestPath));
      continue;
    }

    let url;
    try {
      url = new URL(artifact.url);
    } catch {
      issues.push(safeIssue("PINNED_EVIDENCE_URL_INVALID", manifestPath));
      continue;
    }
    if (
      url.origin !== CANONICAL_PUBLIC_ORIGIN
      || url.search
      || url.hash
      || !/^\/evidence\/[A-Za-z0-9._/-]+\.json$/.test(url.pathname)
      || url.pathname.includes("..")
    ) {
      issues.push(safeIssue("PINNED_EVIDENCE_URL_INVALID", manifestPath));
      continue;
    }

    const localPath = `apps/web/public${url.pathname}`;
    let bytes;
    try {
      bytes = await readFile(join(root, ...localPath.split("/")));
    } catch {
      issues.push(safeIssue("PINNED_EVIDENCE_FILE_UNREADABLE", localPath));
      continue;
    }
    filesChecked += 1;
    if (bytes.includes(0x0d)) {
      issues.push(safeIssue("PINNED_EVIDENCE_CRLF_PRESENT", localPath));
    }
    const digest = `0x${createHash("sha256").update(bytes).digest("hex")}`;
    if (digest.toLowerCase() !== artifact.sha256.toLowerCase()) {
      issues.push(safeIssue("PINNED_EVIDENCE_SHA256_MISMATCH", localPath));
    }
  }

  return { ok: issues.length === 0, filesChecked, issues };
}

export async function checkCanonicalOperationalRpc(root) {
  const issues = [];
  let manifest;
  try {
    manifest = JSON.parse(await readUtf8(root, "deployments/5042002.json"));
  } catch {
    issues.push(safeIssue("CANONICAL_MANIFEST_UNREADABLE", "deployments/5042002.json"));
  }
  if (manifest && manifest?.chain?.rpcUrl !== CANONICAL_ARC_RPC_URL) {
    issues.push(safeIssue("CANONICAL_MANIFEST_HTTP_RPC_MISMATCH", "deployments/5042002.json"));
  }
  if (manifest && manifest?.chain?.websocketUrl !== CANONICAL_ARC_WS_URL) {
    issues.push(safeIssue("CANONICAL_MANIFEST_WS_RPC_MISMATCH", "deployments/5042002.json"));
  }

  try {
    const chainSource = await readUtf8(root, RUNTIME_CHAIN_PATH);
    const escapedHttp = CANONICAL_ARC_RPC_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`ARC_TESTNET_RPC_URL\\s*=\\s*[\"']${escapedHttp}[\"']`).test(chainSource)) {
      issues.push(safeIssue("CHAIN_CONSTANT_HTTP_RPC_MISMATCH", RUNTIME_CHAIN_PATH));
    }
    if (/\bARC_TESTNET_WS_URL\b|\bwss?:\/\/|\bwebSocket\s*:/i.test(chainSource)) {
      issues.push(safeIssue("CHAIN_WEBSOCKET_TRANSPORT_PRESENT", RUNTIME_CHAIN_PATH));
    }
  } catch {
    issues.push(safeIssue("CHAIN_CONSTANTS_UNREADABLE", RUNTIME_CHAIN_PATH));
  }

  const { files, skippedSymlinks } = await collectFiles(root, {
    rootPrefixes: NON_OPERATIONAL_ROOT_PREFIXES,
    include: isOperationalFile,
  });
  if (skippedSymlinks > 0) issues.push(safeIssue("OPERATIONAL_SYMLINK_UNSCANNED"));
  const rpcUrlPattern = /\b(?:https?|wss?):\/\/rpc\.testnet\.arc\.[^\s\"'`<>)}\],;]+/gi;
  const forbiddenHost = ["rpc", "testnet", "arc", "io"].join(".");
  for (const path of files) {
    let content;
    try {
      content = await readUtf8(root, path);
    } catch {
      issues.push(safeIssue("OPERATIONAL_FILE_UNREADABLE", path));
      continue;
    }

    if (content.toLowerCase().includes(forbiddenHost)) {
      issues.push(safeIssue("FORBIDDEN_ARC_RPC_HOST", path));
    }
    if (isRuntimeWebsocketPath(path) && WEBSOCKET_URL_PATTERN.test(content)) {
      issues.push(safeIssue("RUNTIME_WEBSOCKET_URL_PRESENT", path));
    }
    const historicalWebsocketMetadataAllowed = allowsHistoricalWebsocketMetadata(path, content);
    for (const [url] of content.matchAll(rpcUrlPattern)) {
      if (
        url !== CANONICAL_ARC_RPC_URL
        && !(url === CANONICAL_ARC_WS_URL && historicalWebsocketMetadataAllowed)
      ) {
        issues.push(safeIssue("NON_CANONICAL_ARC_RPC_URL", path));
        break;
      }
    }
    if (isEnvironmentFile(path)) {
      const configuredRpc = parseEnv(content).get("ARC_RPC_URL");
      if (configuredRpc && configuredRpc !== CANONICAL_ARC_RPC_URL) {
        issues.push(safeIssue("ENV_ARC_RPC_URL_MISMATCH", path));
      }
    }
  }

  return {
    ok: issues.length === 0,
    filesChecked: files.length,
    skippedSymlinks,
    issues,
  };
}

function normalizedIgnoreLines(content) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter((line) => line && !line.startsWith("#"));
}

export async function checkVercelIgnore(root) {
  let lines;
  try {
    lines = normalizedIgnoreLines(await readUtf8(root, ".vercelignore"));
  } catch {
    return {
      ok: false,
      requiredCount: REQUIRED_VERCELIGNORE_PATTERNS.length,
      missingPatterns: [...REQUIRED_VERCELIGNORE_PATTERNS],
      unsafeNegations: [],
      issues: [safeIssue("VERCELIGNORE_UNREADABLE", ".vercelignore")],
    };
  }
  const entries = new Set(lines.filter((line) => !line.startsWith("!")));
  const missingPatterns = REQUIRED_VERCELIGNORE_PATTERNS.filter((pattern) => !entries.has(pattern));
  const unsafeNegations = lines
    .filter((line) => {
      if (!line.startsWith("!")) return false;
      const pattern = line.slice(1).replace(/^\.\//, "");
      return /(?:^|\/)\.env(?:[.*\/]|$)|local-keystores/i.test(pattern);
    })
    .map(() => "SECRET_EXCLUSION_NEGATED");
  const issues = [
    ...missingPatterns.map(() => safeIssue("REQUIRED_VERCELIGNORE_PATTERN_MISSING", ".vercelignore")),
    ...unsafeNegations.map(() => safeIssue("SECRET_VERCELIGNORE_NEGATION", ".vercelignore")),
  ];
  return {
    ok: issues.length === 0,
    requiredCount: REQUIRED_VERCELIGNORE_PATTERNS.length,
    missingPatterns,
    unsafeNegations,
    issues,
  };
}

export async function checkVercelBuild(root) {
  const issues = [];
  let config;
  try {
    config = JSON.parse(await readUtf8(root, "vercel.json"));
  } catch {
    issues.push(safeIssue("VERCEL_CONFIG_UNREADABLE", "vercel.json"));
  }
  if (config && config.buildCommand !== EXPECTED_VERCEL_BUILD_COMMAND) {
    issues.push(safeIssue("VERCEL_BUILD_COMMAND_MISMATCH", "vercel.json"));
  }
  if (config && config.outputDirectory !== "apps/web/.next") {
    issues.push(safeIssue("VERCEL_OUTPUT_DIRECTORY_MISMATCH", "vercel.json"));
  }
  return {
    ok: issues.length === 0,
    profile: "contour-web-dependency-closure",
    issues,
  };
}

async function loadLocalSecrets(root) {
  const secrets = [];
  const unreadableSources = [];
  for (const path of SECRET_ENV_FILES) {
    let content;
    try {
      content = await readUtf8(root, path);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      unreadableSources.push(path);
      continue;
    }
    for (const [variable, value] of parseEnv(content)) {
      if (!SECRET_KEY_PATTERN.test(variable) || value.length === 0) continue;
      secrets.push({ variable, value, bytes: Buffer.from(value) });
    }
  }
  return { secrets, unreadableSources };
}

function redactedLeakPath(path, secrets) {
  return secrets.some(({ value }) => path.includes(value)) ? "<redacted-path>" : path;
}

export async function checkLocalSecretIsolation(root) {
  const { secrets, unreadableSources } = await loadLocalSecrets(root);
  const issues = unreadableSources.map((path) => safeIssue("SECRET_SOURCE_UNREADABLE", path));
  const { files, skippedSymlinks } = await collectFiles(root, {
    rootPrefixes: SECRET_SCAN_ROOT_PREFIXES,
    include: (path) => !isEnvironmentFile(path) && !path.endsWith(".log") && !path.endsWith(".tsbuildinfo"),
  });
  const leaks = [];
  if (skippedSymlinks > 0) issues.push(safeIssue("SECRET_SYMLINK_UNSCANNED"));

  for (const path of files) {
    let content;
    try {
      content = await readFile(join(root, ...path.split("/")));
    } catch {
      issues.push(safeIssue("SECRET_SCAN_FILE_UNREADABLE", path));
      continue;
    }
    const variables = secrets
      .filter(({ bytes }) => bytes.length > 0 && content.includes(bytes))
      .map(({ variable }) => variable)
      .sort();
    if (variables.length > 0) {
      const safePath = redactedLeakPath(path, secrets);
      leaks.push({ path: safePath, variables });
      issues.push(safeIssue("LOCAL_SECRET_VALUE_EXPOSED", safePath));
    }
  }

  return {
    ok: issues.length === 0,
    secretVariablesChecked: secrets.length,
    filesScanned: files.length,
    skippedSymlinks,
    leaks,
    issues,
  };
}

async function resolveGitDirectory(root) {
  const dotGit = join(root, ".git");
  try {
    const stat = await lstat(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;
    const pointer = await readFile(dotGit, "utf8");
    const match = pointer.trim().match(/^gitdir:\s*(.+)$/i);
    return match ? resolve(dirname(dotGit), match[1]) : null;
  } catch {
    return null;
  }
}

async function readPackedRef(gitDirectory, ref) {
  try {
    const packed = await readFile(join(gitDirectory, "packed-refs"), "utf8");
    for (const line of packed.split(/\r?\n/)) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const separator = line.indexOf(" ");
      if (separator === -1 || line.slice(separator + 1) !== ref) continue;
      const object = line.slice(0, separator);
      return GIT_OBJECT_PATTERN.test(object) ? object : null;
    }
  } catch {
    return null;
  }
  return null;
}

export async function checkGitHead(root) {
  const gitDirectory = await resolveGitDirectory(root);
  if (!gitDirectory) return { present: false, status: "absent", commit: null };
  let head;
  try {
    head = (await readFile(join(gitDirectory, "HEAD"), "utf8")).trim();
  } catch {
    return { present: false, status: "absent", commit: null };
  }
  if (GIT_OBJECT_PATTERN.test(head)) {
    return { present: true, status: "present", commit: head.toLowerCase() };
  }
  const match = head.match(/^ref:\s*(refs\/[A-Za-z0-9._\/-]+)$/);
  if (!match || match[1].split("/").includes("..")) {
    return { present: false, status: "absent", commit: null };
  }
  const ref = match[1];
  try {
    const object = (await readFile(join(gitDirectory, ...ref.split("/")), "utf8")).trim();
    if (GIT_OBJECT_PATTERN.test(object)) {
      return { present: true, status: "present", commit: object.toLowerCase() };
    }
  } catch {
    // A symbolic HEAD can be resolved from packed-refs as well.
  }
  const packedObject = await readPackedRef(gitDirectory, ref);
  return packedObject
    ? { present: true, status: "present", commit: packedObject.toLowerCase() }
    : { present: false, status: "absent", commit: null };
}

export async function checkGitWorktree(root) {
  if (!(await resolveGitDirectory(root))) {
    return {
      ok: false,
      clean: false,
      status: "git-directory-absent",
      changedEntries: null,
      issues: [safeIssue("PROMOTION_GIT_DIRECTORY_ABSENT")],
    };
  }

  try {
    const { stdout } = await execFileAsync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-C",
        root,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ],
      {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
        windowsHide: true,
      },
    );
    const changedEntries = stdout.split(/\r?\n/).filter(Boolean).length;
    const clean = changedEntries === 0;
    return {
      ok: clean,
      clean,
      status: clean ? "clean" : "dirty",
      changedEntries,
      issues: clean ? [] : [safeIssue("PROMOTION_GIT_WORKTREE_DIRTY")],
    };
  } catch {
    return {
      ok: false,
      clean: false,
      status: "unavailable",
      changedEntries: null,
      issues: [safeIssue("PROMOTION_GIT_STATUS_UNAVAILABLE")],
    };
  }
}

export async function checkPromotionManifest(root) {
  const manifestPath = "deployments/5042002.json";
  let manifest;
  try {
    manifest = JSON.parse(await readUtf8(root, manifestPath));
  } catch {
    return {
      ok: false,
      state: null,
      productLive: false,
      evidence: Object.fromEntries(
        PROMOTION_EVIDENCE_ARTIFACTS.map((artifact) => [artifact, false]),
      ),
      issues: [safeIssue("PROMOTION_MANIFEST_UNREADABLE", manifestPath)],
    };
  }

  const issues = [];
  if (manifest?.state !== "active") {
    issues.push(safeIssue("PROMOTION_MANIFEST_NOT_ACTIVE", manifestPath));
  }
  if (manifest?.activationEvidence?.productLive !== true) {
    issues.push(safeIssue("PROMOTION_PRODUCT_LIVE_DISABLED", manifestPath));
  }

  const evidence = {};
  for (const artifact of PROMOTION_EVIDENCE_ARTIFACTS) {
    const reference = manifest?.activationEvidence?.artifacts?.[artifact];
    const populated = typeof reference?.url === "string"
      && reference.url.length > 0
      && /^0x[0-9a-fA-F]{64}$/.test(reference?.sha256 ?? "");
    evidence[artifact] = populated;
    if (!populated) {
      issues.push(safeIssue(PROMOTION_EVIDENCE_ISSUE_CODES[artifact], manifestPath));
    }
  }

  return {
    ok: issues.length === 0,
    state: typeof manifest?.state === "string" ? manifest.state : null,
    productLive: manifest?.activationEvidence?.productLive === true,
    evidence,
    issues,
  };
}

export function checkDeploymentCommitBinding(
  gitHead,
  environment = process.env,
) {
  const candidates = [];
  if (environment?.GITHUB_ACTIONS === "true") {
    candidates.push({
      source: "github-actions",
      value: environment.GITHUB_SHA,
    });
  }
  if (environment?.VERCEL === "1") {
    candidates.push({
      source: "vercel",
      value: environment.VERCEL_GIT_COMMIT_SHA,
    });
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      status: "absent",
      sources: [],
      issues: [safeIssue("PROMOTION_DEPLOYMENT_COMMIT_BINDING_ABSENT")],
    };
  }

  const sources = candidates.map(({ source, value }) => {
    const valid = typeof value === "string" && GIT_OBJECT_PATTERN.test(value);
    return {
      source,
      valid,
      matchesHead: valid
        && gitHead.present
        && value.toLowerCase() === gitHead.commit,
    };
  });
  const valid = sources.every((source) => source.valid);
  const matchesHead = valid && sources.every((source) => source.matchesHead);
  const issues = [];
  if (!valid) issues.push(safeIssue("PROMOTION_DEPLOYMENT_COMMIT_BINDING_INVALID"));
  if (valid && !matchesHead) {
    issues.push(safeIssue("PROMOTION_DEPLOYMENT_COMMIT_MISMATCH"));
  }
  return {
    ok: valid && matchesHead,
    status: !valid ? "invalid" : matchesHead ? "matched" : "mismatch",
    sources,
    issues,
  };
}

export function parseReleasePreflightArguments(argv) {
  const options = { root: process.cwd(), strictPromotion: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--strict-promotion") {
      options.strictPromotion = true;
      continue;
    }
    if (argument === "--root") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--root requires a local directory");
      options.root = resolve(value);
      index += 1;
      continue;
    }
    throw new Error("unsupported release preflight argument");
  }
  return options;
}

export async function runReleasePreflight({
  root = process.cwd(),
  strictPromotion = false,
  environment = process.env,
} = {}) {
  const workspaceRoot = resolve(root);
  const [
    operationalRpc,
    pinnedEvidence,
    vercelIgnore,
    vercelBuild,
    secretIsolation,
    gitHead,
    gitWorktree,
    promotionManifest,
    legacyCutover,
  ] = await Promise.all([
    checkCanonicalOperationalRpc(workspaceRoot),
    checkPinnedPublicEvidence(workspaceRoot),
    checkVercelIgnore(workspaceRoot),
    checkVercelBuild(workspaceRoot),
    checkLocalSecretIsolation(workspaceRoot),
    checkGitHead(workspaceRoot),
    checkGitWorktree(workspaceRoot),
    checkPromotionManifest(workspaceRoot),
    checkLegacyCutoverParity(workspaceRoot),
  ]);
  const baselineReady = operationalRpc.ok && pinnedEvidence.ok
    && vercelIgnore.ok && vercelBuild.ok && secretIsolation.ok
    && legacyCutover.ok;
  const deploymentCommit = checkDeploymentCommitBinding(gitHead, environment);
  const promotionReady = baselineReady
    && gitHead.present
    && gitWorktree.ok
    && promotionManifest.ok
    && deploymentCommit.ok;
  const promotionEvidenceComplete = PROMOTION_EVIDENCE_ARTIFACTS.every(
    (artifact) => promotionManifest.evidence[artifact],
  );
  const promotionStatus = !baselineReady
    ? "baseline-checks-failed"
    : !gitHead.present
      ? "git-head-absent"
      : !promotionManifest.productLive
        ? "product-live-disabled"
        : !promotionEvidenceComplete
          ? "promotion-evidence-incomplete"
          : !promotionManifest.ok
            ? "promotion-manifest-invalid"
          : !gitWorktree.ok
            ? gitWorktree.status === "dirty"
              ? "git-worktree-dirty"
              : "git-worktree-unavailable"
            : !deploymentCommit.ok
              ? deploymentCommit.status === "absent"
                ? "deployment-commit-unbound"
                : deploymentCommit.status === "invalid"
                  ? "deployment-commit-invalid"
                  : "deployment-commit-mismatch"
              : "ready";
  return {
    schemaVersion: "1.1.0",
    mode: strictPromotion ? "strict-promotion" : "baseline",
    ok: baselineReady && (!strictPromotion || promotionReady),
    baselineReady,
    promotionReady,
    promotionStatus,
    checks: {
      operationalRpc,
      pinnedEvidence,
      vercelIgnore,
      vercelBuild,
      secretIsolation,
      gitHead,
      gitWorktree,
      promotionManifest,
      deploymentCommit,
      legacyCutover,
    },
  };
}

async function main() {
  let options;
  try {
    options = parseReleasePreflightArguments(process.argv.slice(2));
    const report = await runReleasePreflight(options);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } catch {
    process.stderr.write("release preflight failed safely\n");
    process.exitCode = 1;
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
