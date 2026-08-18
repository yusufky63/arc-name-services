import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import {
  CANONICAL_ARC_RPC_URL,
  CANONICAL_ARC_WS_URL,
  CANONICAL_PUBLIC_ORIGIN,
  EXPECTED_VERCEL_BUILD_COMMAND,
  REQUIRED_VERCELIGNORE_PATTERNS,
  checkGitHead,
  checkLegacyCutoverParity,
  parseReleasePreflightArguments,
  runReleasePreflight,
} from "./release-preflight.mjs";

const ROOT_SECRET = `root-${"private-material-".repeat(3)}fixture`;
const WEB_SECRET = `challenge-${"secret-material-".repeat(3)}fixture`;

async function write(root, path, content) {
  const absolute = join(root, ...path.split("/"));
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content);
}

async function createFixture(context) {
  const root = await mkdtemp(join(tmpdir(), "contour-release-preflight-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await write(root, ".env", `PRIVATE_KEY=${ROOT_SECRET}\n`);
  await write(
    root,
    "apps/web/.env.local",
    [
      "NEXT_PUBLIC_SITE_URL=http://localhost:3002",
      `REGISTRATION_CHALLENGE_SECRET=\"${WEB_SECRET}\" # local only`,
      "PRIVATE_CANDIDATE_MODE=false",
      "",
    ].join("\n"),
  );
  await write(root, "apps/web/src/page.ts", "export const releaseSurface = 'contour';\n");
  await write(
    root,
    "packages/config/src/chain.ts",
    [
      `export const ARC_TESTNET_RPC_URL = \"${CANONICAL_ARC_RPC_URL}\" as const;`,
      "",
    ].join("\n"),
  );
  await write(
    root,
    "deployments/5042002.json",
    `${JSON.stringify({
      state: "active",
      chain: { rpcUrl: CANONICAL_ARC_RPC_URL, websocketUrl: CANONICAL_ARC_WS_URL },
      activationEvidence: {
        productLive: false,
        artifacts: {
          fundedEndToEnd: { url: null, sha256: null },
          operationsDrill: { url: null, sha256: null },
        },
      },
    }, null, 2)}\n`,
  );
  await write(root, ".env.deployment.local", `ARC_RPC_URL=${CANONICAL_ARC_RPC_URL}\n`);
  await write(root, ".vercelignore", `${REQUIRED_VERCELIGNORE_PATTERNS.join("\n")}\n`);
  await write(
    root,
    "vercel.json",
    `${JSON.stringify({
      buildCommand: EXPECTED_VERCEL_BUILD_COMMAND,
      outputDirectory: "apps/web/.next",
    }, null, 2)}\n`,
  );
  return root;
}

async function writeProductLiveManifest(
  root,
  { fundedEndToEnd = true, operationsDrill = true } = {},
) {
  const artifacts = {};
  for (const [artifact, populated] of Object.entries({
    fundedEndToEnd,
    operationsDrill,
  })) {
    if (!populated) {
      artifacts[artifact] = { url: null, sha256: null };
      continue;
    }
    const path = `evidence/test/${artifact}.json`;
    const bytes = `${JSON.stringify({
      schemaVersion: "1.0.0",
      artifact,
      verdict: "PASS",
    }, null, 2)}\n`;
    await write(root, `apps/web/public/${path}`, bytes);
    artifacts[artifact] = {
      url: `${CANONICAL_PUBLIC_ORIGIN}/${path}`,
      sha256: `0x${createHash("sha256").update(bytes).digest("hex")}`,
    };
  }
  await write(
    root,
    "deployments/5042002.json",
    `${JSON.stringify({
      state: "active",
      chain: { rpcUrl: CANONICAL_ARC_RPC_URL, websocketUrl: CANONICAL_ARC_WS_URL },
      activationEvidence: { productLive: true, artifacts },
    }, null, 2)}\n`,
  );
}

async function writeV2CutoverManifests(
  root,
  { mutateCanonical = () => {}, mutateLegacy = () => {} } = {},
) {
  const contracts = Object.fromEntries(
    [
      "registry",
      "baseRegistrar",
      "controller",
      "publicResolver",
      "reverseRegistrar",
      "universalResolver",
      "marketplace",
    ].map((role, index) => [
      role,
      {
        address: `0x${(index + 10).toString(16).padStart(40, "0")}`,
        deploymentBlock: 100 + index,
        runtimeCodeHash: `0x${(index + 20).toString(16).padStart(64, "0")}`,
      },
    ]),
  );
  const reference = {
    registrarVersion: "v1",
    releaseId: `0x${"88".repeat(32)}`,
    verifiedAtBlock: 200,
    contracts,
    controllerPolicy: { registrationsPaused: true },
    marketplacePolicy: { paused: false },
  };
  const canonical = {
    registrarVersion: "v2",
    state: "active",
    chain: {
      rpcUrl: CANONICAL_ARC_RPC_URL,
      websocketUrl: CANONICAL_ARC_WS_URL,
    },
    activationEvidence: {
      productLive: false,
      artifacts: {},
    },
    legacyReleases: [reference],
  };
  const legacy = {
    state: "active",
    releaseId: reference.releaseId,
    chain: {
      rpcUrl: CANONICAL_ARC_RPC_URL,
      websocketUrl: CANONICAL_ARC_WS_URL,
    },
    contracts: structuredClone(contracts),
    activationEvidence: {
      verifiedAtBlock: reference.verifiedAtBlock,
      controllerPolicy: { registrationsPaused: true },
      marketplacePolicy: { paused: false },
    },
  };
  mutateCanonical(canonical);
  mutateLegacy(legacy);
  await write(
    root,
    "deployments/5042002.json",
    `${JSON.stringify(canonical, null, 2)}\n`,
  );
  await write(
    root,
    "deployments/5042002.legacy.json",
    `${JSON.stringify(legacy, null, 2)}\n`,
  );
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(
    result.status,
    0,
    `git ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

function initializeCleanGit(root) {
  git(root, ["init", "--quiet"]);
  git(root, ["add", "--all"]);
  git(root, [
    "-c",
    "user.name=Contour Release Test",
    "-c",
    "user.email=release-test@contour.invalid",
    "commit",
    "--quiet",
    "-m",
    "release fixture",
  ]);
  return git(root, ["rev-parse", "HEAD"]).toLowerCase();
}

test("baseline passes local security/build checks and reports an absent HEAD as promotion-not-ready", async (context) => {
  const root = await createFixture(context);
  const report = await runReleasePreflight({ root });

  assert.equal(report.mode, "baseline");
  assert.equal(report.ok, true);
  assert.equal(report.baselineReady, true);
  assert.equal(report.promotionReady, false);
  assert.equal(report.promotionStatus, "git-head-absent");
  assert.deepEqual(report.checks.gitHead, {
    present: false,
    status: "absent",
    commit: null,
  });
  assert.equal(report.checks.operationalRpc.ok, true);
  assert.equal(report.checks.vercelIgnore.ok, true);
  assert.equal(report.checks.vercelBuild.ok, true);
  assert.equal(report.checks.secretIsolation.ok, true);

  const strict = await runReleasePreflight({ root, strictPromotion: true });
  assert.equal(strict.mode, "strict-promotion");
  assert.equal(strict.baselineReady, true);
  assert.equal(strict.promotionReady, false);
  assert.equal(strict.ok, false);
});

test("baseline preserves V1 compatibility but requires exact full-manifest parity for V2 cutover", async (context) => {
  const root = await createFixture(context);
  let report = await checkLegacyCutoverParity(root);
  assert.deepEqual(report, {
    ok: true,
    mode: "v1",
    referenceCount: 0,
    issues: [],
  });

  await writeV2CutoverManifests(root);
  report = await checkLegacyCutoverParity(root);
  assert.equal(report.ok, true);
  assert.equal(report.mode, "v2");
  assert.equal(report.referenceCount, 1);
  assert.equal(report.releaseId, `0x${"88".repeat(32)}`);
  assert.equal((await runReleasePreflight({ root })).baselineReady, true);
});

test("V2 baseline rejects an empty reference directory and stale full V1 cutover policy", async (context) => {
  const root = await createFixture(context);
  await writeV2CutoverManifests(root, {
    mutateCanonical: (canonical) => {
      canonical.legacyReleases = [];
    },
  });
  let report = await checkLegacyCutoverParity(root);
  assert.equal(report.ok, false);
  assert.deepEqual(report.issues, [{
    code: "LEGACY_CUTOVER_REFERENCE_COUNT_INVALID",
    path: "deployments/5042002.json",
  }]);

  await writeV2CutoverManifests(root, {
    mutateLegacy: (legacy) => {
      legacy.activationEvidence.controllerPolicy.registrationsPaused = false;
      legacy.activationEvidence.marketplacePolicy.paused = true;
    },
  });
  report = await checkLegacyCutoverParity(root);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    [
      "LEGACY_CUTOVER_REGISTRATION_NOT_PAUSED",
      "LEGACY_CUTOVER_MARKETPLACE_NOT_OPEN",
    ],
  );
  const baseline = await runReleasePreflight({ root });
  assert.equal(baseline.baselineReady, false);
  assert.equal(baseline.checks.legacyCutover.ok, false);
});

test("V2 baseline rejects verification-block or runtime identity drift from the full V1 manifest", async (context) => {
  const root = await createFixture(context);
  await writeV2CutoverManifests(root, {
    mutateLegacy: (legacy) => {
      legacy.activationEvidence.verifiedAtBlock += 1;
      legacy.contracts.marketplace.runtimeCodeHash = `0x${"77".repeat(32)}`;
    },
  });
  const report = await checkLegacyCutoverParity(root);
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.issues.map((issue) => issue.code),
    [
      "LEGACY_CUTOVER_VERIFICATION_BLOCK_MISMATCH",
      "LEGACY_CUTOVER_MARKETPLACE_MISMATCH",
    ],
  );
});

test("strict promotion requires a clean product-live GitHub build bound to exact HEAD", async (context) => {
  const root = await createFixture(context);
  await writeProductLiveManifest(root);
  const commit = initializeCleanGit(root);
  assert.deepEqual(await checkGitHead(root), {
    present: true,
    status: "present",
    commit,
  });

  const report = await runReleasePreflight({
    root,
    strictPromotion: true,
    environment: {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: commit,
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.promotionReady, true);
  assert.equal(report.promotionStatus, "ready");
  assert.equal(report.checks.gitWorktree.clean, true);
  assert.equal(report.checks.promotionManifest.productLive, true);
  assert.deepEqual(report.checks.promotionManifest.evidence, {
    fundedEndToEnd: true,
    operationsDrill: true,
  });
  assert.deepEqual(report.checks.deploymentCommit.sources, [{
    source: "github-actions",
    valid: true,
    matchesHead: true,
  }]);
});

test("strict promotion rejects productLive=false and missing funded/operations evidence", async (context) => {
  const root = await createFixture(context);
  const commit = initializeCleanGit(root);

  const report = await runReleasePreflight({
    root,
    strictPromotion: true,
    environment: {
      VERCEL: "1",
      VERCEL_GIT_COMMIT_SHA: commit,
    },
  });

  assert.equal(report.baselineReady, true);
  assert.equal(report.ok, false);
  assert.equal(report.promotionReady, false);
  assert.equal(report.promotionStatus, "product-live-disabled");
  assert.deepEqual(
    report.checks.promotionManifest.issues.map((issue) => issue.code),
    [
      "PROMOTION_PRODUCT_LIVE_DISABLED",
      "PROMOTION_FUNDED_END_TO_END_EVIDENCE_MISSING",
      "PROMOTION_OPERATIONS_DRILL_EVIDENCE_MISSING",
    ],
  );
});

test("strict promotion rejects incomplete live evidence even when baseline checks pass", async (context) => {
  const root = await createFixture(context);
  await writeProductLiveManifest(root, { operationsDrill: false });
  const commit = initializeCleanGit(root);

  const report = await runReleasePreflight({
    root,
    strictPromotion: true,
    environment: {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: commit,
    },
  });

  assert.equal(report.baselineReady, true);
  assert.equal(report.ok, false);
  assert.equal(report.promotionStatus, "promotion-evidence-incomplete");
  assert.deepEqual(report.checks.promotionManifest.evidence, {
    fundedEndToEnd: true,
    operationsDrill: false,
  });
});

test("strict promotion rejects a dirty worktree", async (context) => {
  const root = await createFixture(context);
  await writeProductLiveManifest(root);
  const commit = initializeCleanGit(root);
  await write(root, "apps/web/src/page.ts", "export const releaseSurface = 'changed';\n");

  const report = await runReleasePreflight({
    root,
    strictPromotion: true,
    environment: {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: commit,
    },
  });

  assert.equal(report.baselineReady, true);
  assert.equal(report.ok, false);
  assert.equal(report.promotionStatus, "git-worktree-dirty");
  assert.equal(report.checks.gitWorktree.clean, false);
  assert.equal(report.checks.gitWorktree.changedEntries, 1);
});

test("strict promotion rejects absent, invalid, or mismatched CI/deploy commit binding", async (context) => {
  const root = await createFixture(context);
  await writeProductLiveManifest(root);
  const commit = initializeCleanGit(root);

  const absent = await runReleasePreflight({
    root,
    strictPromotion: true,
    environment: {},
  });
  assert.equal(absent.ok, false);
  assert.equal(absent.promotionStatus, "deployment-commit-unbound");
  assert.deepEqual(absent.checks.deploymentCommit.issues, [{
    code: "PROMOTION_DEPLOYMENT_COMMIT_BINDING_ABSENT",
  }]);

  const invalid = await runReleasePreflight({
    root,
    strictPromotion: true,
    environment: {
      VERCEL: "1",
      VERCEL_GIT_COMMIT_SHA: "not-a-commit",
    },
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.promotionStatus, "deployment-commit-invalid");
  assert.equal(invalid.checks.deploymentCommit.status, "invalid");

  const mismatch = await runReleasePreflight({
    root,
    strictPromotion: true,
    environment: {
      GITHUB_ACTIONS: "true",
      GITHUB_SHA: commit === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40),
    },
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.promotionStatus, "deployment-commit-mismatch");
  assert.deepEqual(mismatch.checks.deploymentCommit.issues, [{
    code: "PROMOTION_DEPLOYMENT_COMMIT_MISMATCH",
  }]);
});

test("hash-pinned public evidence is LF-only and byte-identical to the manifest", async (context) => {
  const root = await createFixture(context);
  const evidencePath = "evidence/test/treasury-controls.json";
  const evidence = `${JSON.stringify({ schemaVersion: "1.1.0", status: "PASS" }, null, 2)}\n`;
  const sha256 = `0x${createHash("sha256").update(evidence).digest("hex")}`;
  await write(root, `apps/web/public/${evidencePath}`, evidence);
  await write(
    root,
    "deployments/5042002.json",
    `${JSON.stringify({
      chain: { rpcUrl: CANONICAL_ARC_RPC_URL, websocketUrl: CANONICAL_ARC_WS_URL },
      activationEvidence: {
        artifacts: {
          treasuryControls: {
            url: `${CANONICAL_PUBLIC_ORIGIN}/${evidencePath}`,
            sha256,
          },
        },
      },
    }, null, 2)}\n`,
  );

  const pass = await runReleasePreflight({ root });
  assert.equal(pass.checks.pinnedEvidence.ok, true);
  assert.equal(pass.checks.pinnedEvidence.filesChecked, 1);

  await write(root, `apps/web/public/${evidencePath}`, evidence.replaceAll("\n", "\r\n"));
  const fail = await runReleasePreflight({ root });
  assert.equal(fail.ok, false);
  assert.deepEqual(fail.checks.pinnedEvidence.issues, [
    {
      code: "PINNED_EVIDENCE_CRLF_PRESENT",
      path: "apps/web/public/evidence/test/treasury-controls.json",
    },
    {
      code: "PINNED_EVIDENCE_SHA256_MISMATCH",
      path: "apps/web/public/evidence/test/treasury-controls.json",
    },
  ]);
});

test("an exact local secret leak fails closed without emitting its value or prefix", async (context) => {
  const root = await createFixture(context);
  await write(
    root,
    "apps/web/src/accidental-release.ts",
    `export const accidental = ${JSON.stringify(WEB_SECRET)};\n`,
  );

  const report = await runReleasePreflight({ root });
  assert.equal(report.ok, false);
  assert.equal(report.checks.secretIsolation.ok, false);
  assert.deepEqual(report.checks.secretIsolation.leaks, [{
    path: "apps/web/src/accidental-release.ts",
    variables: ["REGISTRATION_CHALLENGE_SECRET"],
  }]);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(WEB_SECRET), false);
  assert.equal(serialized.includes(WEB_SECRET.slice(0, 16)), false);
  assert.equal(serialized.includes(ROOT_SECRET), false);
  assert.equal(serialized.includes(ROOT_SECRET.slice(0, 16)), false);

  const result = spawnSync(process.execPath, [resolve("scripts/release-preflight.mjs"), "--root", root], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes(WEB_SECRET), false);
  assert.equal(result.stdout.includes(WEB_SECRET.slice(0, 16)), false);
  assert.equal(result.stderr.includes(WEB_SECRET), false);
});

test("secret scanning excludes environment, Vercel-ignored, and build trees", async (context) => {
  const root = await createFixture(context);
  await write(root, ".env.deployment.local", `ANOTHER_SECRET=${WEB_SECRET}\n`);
  await write(root, "apps/web/.next/server/chunk.js", WEB_SECRET);
  await write(root, "apps/web/node_modules/example/index.js", WEB_SECRET);
  await write(root, "docs/local-only.md", WEB_SECRET);
  await write(root, "contracts/local-only.sol", ROOT_SECRET);

  const report = await runReleasePreflight({ root });
  assert.equal(report.checks.secretIsolation.ok, true);
  assert.deepEqual(report.checks.secretIsolation.leaks, []);
});

test("non-canonical and retired Arc RPC URLs are rejected only in operational files", async (context) => {
  const root = await createFixture(context);
  const retiredRpc = `https://${["rpc", "testnet", "arc", "io"].join(".")}`;
  await write(root, "apps/web/src/retired-rpc.ts", `export const rpc = ${JSON.stringify(retiredRpc)};\n`);
  await write(root, "docs/historical-rpc.md", retiredRpc);

  const report = await runReleasePreflight({ root });
  assert.equal(report.checks.operationalRpc.ok, false);
  assert.ok(report.checks.operationalRpc.issues.some((issue) =>
    issue.code === "FORBIDDEN_ARC_RPC_HOST" && issue.path === "apps/web/src/retired-rpc.ts"));
  assert.equal(report.checks.operationalRpc.issues.some((issue) => issue.path === "docs/historical-rpc.md"), false);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(retiredRpc), false);
});

test("canonical manifest, runtime constants, and populated ARC_RPC_URL values are exact", async (context) => {
  const root = await createFixture(context);
  await write(root, ".env.deployment.local", "ARC_RPC_URL=https://rpc.testnet.arc.network/path\n");
  const report = await runReleasePreflight({ root });
  assert.equal(report.checks.operationalRpc.ok, false);
  assert.ok(report.checks.operationalRpc.issues.some((issue) => issue.code === "ENV_ARC_RPC_URL_MISMATCH"));
  assert.ok(report.checks.operationalRpc.issues.some((issue) => issue.code === "NON_CANONICAL_ARC_RPC_URL"));
});

test("runtime source and environment files reject every websocket URL", async (context) => {
  const root = await createFixture(context);
  await write(root, "apps/web/src/runtime-websocket.ts", "export const stream = 'wss://relay.example.test';\n");
  await write(root, "apps/web/.env.production", "ARC_STREAM_URL=" + CANONICAL_ARC_WS_URL + "\n");
  await write(
    root,
    "packages/config/src/chain.ts",
    [
      "export const ARC_TESTNET_RPC_URL = \"" + CANONICAL_ARC_RPC_URL + "\" as const;",
      "export const ARC_TESTNET_WS_URL = \"" + CANONICAL_ARC_WS_URL + "\" as const;",
      "",
    ].join("\n"),
  );

  const report = await runReleasePreflight({ root });
  assert.equal(report.checks.operationalRpc.ok, false);
  assert.ok(report.checks.operationalRpc.issues.some((issue) =>
    issue.code === "CHAIN_WEBSOCKET_TRANSPORT_PRESENT" &&
    issue.path === "packages/config/src/chain.ts"));
  assert.ok(report.checks.operationalRpc.issues.some((issue) =>
    issue.code === "RUNTIME_WEBSOCKET_URL_PRESENT" &&
    issue.path === "apps/web/src/runtime-websocket.ts"));
  assert.ok(report.checks.operationalRpc.issues.some((issue) =>
    issue.code === "RUNTIME_WEBSOCKET_URL_PRESENT" &&
    issue.path === "apps/web/.env.production"));
});

test("canonical signed manifest requires exact historical websocket metadata", async (context) => {
  const root = await createFixture(context);
  await write(
    root,
    "deployments/5042002.json",
    JSON.stringify({
      chain: { rpcUrl: CANONICAL_ARC_RPC_URL, websocketUrl: null },
    }, null, 2) + "\n",
  );

  const report = await runReleasePreflight({ root });
  assert.equal(report.checks.operationalRpc.ok, false);
  assert.ok(report.checks.operationalRpc.issues.some((issue) =>
    issue.code === "CANONICAL_MANIFEST_WS_RPC_MISMATCH"));
});

test("retained V1 manifest may preserve only the exact historical websocket metadata", async (context) => {
  const root = await createFixture(context);
  await write(
    root,
    "deployments/5042002.legacy.json",
    `${JSON.stringify({
      chain: {
        rpcUrl: CANONICAL_ARC_RPC_URL,
        websocketUrl: CANONICAL_ARC_WS_URL,
      },
    }, null, 2)}\n`,
  );

  let report = await runReleasePreflight({ root });
  assert.equal(report.checks.operationalRpc.ok, true);

  await write(
    root,
    "deployments/5042002.legacy.json",
    `${JSON.stringify({
      chain: {
        rpcUrl: CANONICAL_ARC_RPC_URL,
        websocketUrl: `${CANONICAL_ARC_WS_URL}/unexpected`,
      },
    }, null, 2)}\n`,
  );
  report = await runReleasePreflight({ root });
  assert.equal(report.checks.operationalRpc.ok, false);
  assert.ok(report.checks.operationalRpc.issues.some((issue) =>
    issue.code === "NON_CANONICAL_ARC_RPC_URL"
    && issue.path === "deployments/5042002.legacy.json"));
});

test("required Vercel exclusions and the focused web build are fail-closed", async (context) => {
  const root = await createFixture(context);
  const incompleteIgnore = REQUIRED_VERCELIGNORE_PATTERNS.filter((line) => line !== "**/.env.*");
  await write(root, ".vercelignore", `${incompleteIgnore.join("\n")}\n!.env\n`);
  await write(
    root,
    "vercel.json",
    `${JSON.stringify({ buildCommand: "pnpm build", outputDirectory: "dist" }, null, 2)}\n`,
  );

  const report = await runReleasePreflight({ root });
  assert.equal(report.ok, false);
  assert.equal(report.checks.vercelIgnore.ok, false);
  assert.deepEqual(report.checks.vercelIgnore.missingPatterns, ["**/.env.*"]);
  assert.deepEqual(report.checks.vercelIgnore.unsafeNegations, ["SECRET_EXCLUSION_NEGATED"]);
  assert.equal(report.checks.vercelBuild.ok, false);
  assert.ok(report.checks.vercelBuild.issues.some((issue) => issue.code === "VERCEL_BUILD_COMMAND_MISMATCH"));
  assert.ok(report.checks.vercelBuild.issues.some((issue) => issue.code === "VERCEL_OUTPUT_DIRECTORY_MISMATCH"));
});

test("CLI argument parsing is local and explicit", () => {
  assert.deepEqual(
    parseReleasePreflightArguments(["--root", ".", "--strict-promotion"]),
    { root: resolve("."), strictPromotion: true },
  );
  assert.throws(() => parseReleasePreflightArguments(["--root"]), /requires a local directory/);
  assert.throws(() => parseReleasePreflightArguments(["--network"]), /unsupported/);
});
