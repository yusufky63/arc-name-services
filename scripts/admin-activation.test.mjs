import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AdminActivationFailure,
  adminActivationConstants,
  createAdminClients,
  deriveCanonicalAdminAccount,
  executeAdminActivation,
  parseAdminActivationArguments,
  readCanonicalAdminState,
  runAdminActivation,
  validateCanonicalAdminManifest,
} from "./admin-activation.mjs";
import {
  TEST_CONTROLLER_RUNTIME_CODE,
  TEST_MARKETPLACE_RUNTIME_CODE,
  testRuntimeCodeHasher,
} from "./canonical-runtime-fixtures.test-helper.mjs";
import {
  registrationControllerOpenManifest,
  registrationSmokeEvidence,
  registrationSmokeChainFixture,
  TEST_CANDIDATE_ORIGIN,
  TEST_EVIDENCE_BLOCK,
} from "./registration-smoke-evidence.test-helper.mjs";

const canonicalManifest = JSON.parse(
  await readFile(new URL("../deployments/5042002.json", import.meta.url), "utf8"),
);
const governance = canonicalManifest.activationEvidence.governance.account;
const zeroAddress = "0x0000000000000000000000000000000000000000";

function activeManifest() {
  const manifest = structuredClone(canonicalManifest);
  manifest.state = "active";
  manifest.permitIssuer.active = true;
  manifest.permitIssuer.url = "https://candidate.example/api/registration/issuer/v1";
  return manifest;
}

function alternateReleaseManifest() {
  const manifest = activeManifest();
  manifest.releaseId = `0x${"44".repeat(32)}`;
  manifest.activationEvidence.governance.account = "0x3333333333333333333333333333333333333333";
  manifest.contracts.controller.address = "0x1111111111111111111111111111111111111111";
  manifest.contracts.controller.runtimeCodeHash = `0x${"55".repeat(32)}`;
  manifest.contracts.marketplace.address = "0x2222222222222222222222222222222222222222";
  manifest.contracts.marketplace.runtimeCodeHash = `0x${"66".repeat(32)}`;
  return manifest;
}

function txHash(index) {
  return `0x${index.toString(16).padStart(64, "0")}`;
}

function blockHash(index) {
  return `0x${(1000 + index).toString(16).padStart(64, "0")}`;
}

function createFakeClients({
  manifest = canonicalManifest,
  chainId = adminActivationConstants.chainId,
  controllerPaused = true,
  marketplacePaused = true,
  failWaitAt = null,
  failureMessage = "receipt wait failed",
  controllerCode = TEST_CONTROLLER_RUNTIME_CODE,
  marketplaceCode = TEST_MARKETPLACE_RUNTIME_CODE,
  controllerReleaseId = manifest.releaseId,
  controllerOwner = manifest.activationEvidence.governance.account,
  marketplaceOwner = manifest.activationEvidence.governance.account,
  registrationFixture = null,
  captureBlock = registrationFixture ? BigInt(TEST_EVIDENCE_BLOCK + 10) : 100n,
  runtimeCodeHasher,
} = {}) {
  const selectedGovernance = manifest.activationEvidence.governance.account;
  const selectedController = manifest.contracts.controller.address;
  const selectedMarketplace = manifest.contracts.marketplace.address;
  const selectedRuntimeCodeHasher = runtimeCodeHasher ?? ((code) => {
    if (code === TEST_CONTROLLER_RUNTIME_CODE) return manifest.contracts.controller.runtimeCodeHash;
    if (code === TEST_MARKETPLACE_RUNTIME_CODE) return manifest.contracts.marketplace.runtimeCodeHash;
    return testRuntimeCodeHasher(code);
  });
  const state = {
    controllerPaused,
    marketplacePaused,
    block: captureBlock,
    simulations: [],
    writes: [],
    waits: 0,
    receipts: new Map(),
  };

  const publicClient = {
    async getChainId() {
      return chainId;
    },
    async getBlockNumber() {
      return state.block;
    },
    async getCode({ address }) {
      if (address.toLowerCase() === selectedGovernance.toLowerCase()) return "0x";
      if (address.toLowerCase() === selectedController.toLowerCase()) return controllerCode;
      if (address.toLowerCase() === selectedMarketplace.toLowerCase()) return marketplaceCode;
      throw new Error("unexpected code read");
    },
    async readContract(request) {
      const { address, functionName, blockNumber } = request;
      if (registrationFixture && blockNumber === BigInt(TEST_EVIDENCE_BLOCK)) {
        return registrationFixture.publicClient.readContract(request);
      }
      const isController = address.toLowerCase() === selectedController.toLowerCase();
      if (functionName === "owner") return isController ? controllerOwner : marketplaceOwner;
      if (functionName === "pendingOwner") return zeroAddress;
      if (functionName === "releaseId") return controllerReleaseId;
      if (functionName === "registrationsPaused" && isController) return state.controllerPaused;
      if (functionName === "paused" && !isController) return state.marketplacePaused;
      throw new Error(`unexpected read ${functionName}`);
    },
    async simulateContract(request) {
      state.simulations.push({ target: request.functionName, paused: request.args[0] });
      return { request };
    },
    async waitForTransactionReceipt({ hash }) {
      state.waits += 1;
      if (state.waits === failWaitAt) throw new Error(failureMessage);
      return state.receipts.get(hash);
    },
    async getTransactionReceipt({ hash }) {
      if (registrationFixture?.receipts.has(hash.toLowerCase())) {
        return structuredClone(registrationFixture.receipts.get(hash.toLowerCase()));
      }
      return state.receipts.get(hash);
    },
    async getBlock(request) {
      if (!registrationFixture) throw new Error("unexpected block read");
      return registrationFixture.publicClient.getBlock(request);
    },
  };

  const walletClient = {
    async writeContract(request) {
      const hash = txHash(state.writes.length + 1);
      const target = request.functionName === "setRegistrationsPaused" ? "controller" : "marketplace";
      const paused = request.args[0];
      state.writes.push({ target, paused, hash });
      if (target === "controller") state.controllerPaused = paused;
      else state.marketplacePaused = paused;
      state.block += 1n;
      state.receipts.set(hash, {
        transactionHash: hash,
        blockHash: blockHash(state.writes.length),
        blockNumber: state.block,
        status: "success",
        from: selectedGovernance,
        to: target === "controller" ? selectedController : selectedMarketplace,
      });
      return hash;
    },
  };
  return { publicClient, walletClient, state, runtimeCodeHasher: selectedRuntimeCodeHasher };
}

test("canonical state reads stay sequential while remaining pinned to one capture block", async () => {
  const clients = createFakeClients();
  const methodNames = ["getChainId", "getBlockNumber", "getCode", "readContract"];
  let activeReads = 0;
  let maximumConcurrentReads = 0;

  for (const methodName of methodNames) {
    const original = clients.publicClient[methodName];
    clients.publicClient[methodName] = async (...args) => {
      activeReads += 1;
      maximumConcurrentReads = Math.max(maximumConcurrentReads, activeReads);
      try {
        await new Promise((resolveTurn) => setImmediate(resolveTurn));
        return await original(...args);
      } finally {
        activeReads -= 1;
      }
    };
  }

  const state = await readCanonicalAdminState(clients.publicClient, canonicalManifest, {
    sleep: async () => {},
    runtimeCodeHasher: clients.runtimeCodeHasher,
  });
  assert.deepEqual(state, { blockNumber: 100, controllerPaused: true, marketplacePaused: true });
  assert.equal(maximumConcurrentReads, 1);
});

test("rejects non-canonical runtime bytecode before simulation or broadcast", async () => {
  const clients = createFakeClients({ controllerCode: "0x60006000" });
  await assert.rejects(
    executeAdminActivation({
      manifest: activeManifest(),
      action: "controller-open",
      account: { address: governance },
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
    }),
    (error) => error instanceof AdminActivationFailure &&
      /on-chain controller runtime code hash/.test(error.report.error.message),
  );
  assert.equal(clients.state.simulations.length, 0);
  assert.equal(clients.state.writes.length, 0);
});

test("targets an alternate V2 release entirely from its explicit manifest identity", async () => {
  const manifest = alternateReleaseManifest();
  const clients = createFakeClients({ manifest });
  const report = await executeAdminActivation({
    manifest,
    action: "controller-open",
    account: { address: manifest.activationEvidence.governance.account },
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    runtimeCodeHasher: clients.runtimeCodeHasher,
  });
  assert.equal(report.ok, true);
  assert.equal(report.releaseId, manifest.releaseId);
  assert.equal(report.governanceAccount, manifest.activationEvidence.governance.account);
  assert.equal(report.targets.controller, manifest.contracts.controller.address);
  assert.equal(report.targets.marketplace, manifest.contracts.marketplace.address);
  assert.equal(clients.state.simulations[0].target, "setRegistrationsPaused");
});

test("fails closed before simulation when the selected controller belongs to another release", async () => {
  const manifest = alternateReleaseManifest();
  const clients = createFakeClients({
    manifest,
    controllerReleaseId: canonicalManifest.releaseId,
  });
  await assert.rejects(
    executeAdminActivation({
      manifest,
      action: "controller-open",
      account: { address: manifest.activationEvidence.governance.account },
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
      runtimeCodeHasher: clients.runtimeCodeHasher,
    }),
    (error) => error instanceof AdminActivationFailure &&
      /on-chain controller releaseId/.test(error.report.error.message),
  );
  assert.equal(clients.state.simulations.length, 0);
  assert.equal(clients.state.writes.length, 0);
});

test("canonical reads retry 429 and nested transient transport failures with bounded backoff", async () => {
  const clients = createFakeClients();
  const originalGetCode = clients.publicClient.getCode;
  const delays = [];
  let governanceCodeAttempts = 0;

  clients.publicClient.getCode = async (request) => {
    if (request.address.toLowerCase() === governance.toLowerCase()) {
      governanceCodeAttempts += 1;
      if (governanceCodeAttempts === 1) {
        const rateLimit = new Error("HTTP request failed");
        rateLimit.status = 429;
        throw rateLimit;
      }
      if (governanceCodeAttempts === 2) {
        const socketFailure = new Error("socket closed");
        socketFailure.code = "ECONNRESET";
        throw new Error("transport failed", { cause: socketFailure });
      }
    }
    return originalGetCode(request);
  };

  const state = await readCanonicalAdminState(clients.publicClient, canonicalManifest, {
    maxAttempts: 4,
    baseDelayMs: 10,
    maxDelayMs: 15,
    sleep: async (delayMs) => delays.push(delayMs),
    runtimeCodeHasher: clients.runtimeCodeHasher,
  });
  assert.equal(state.controllerPaused, true);
  assert.equal(governanceCodeAttempts, 3);
  assert.deepEqual(delays, [10, 15]);
});

test("canonical read retries are capped and deterministic RPC failures are not retried", async () => {
  const rateLimited = createFakeClients();
  const rateLimitDelays = [];
  let rateLimitAttempts = 0;
  rateLimited.publicClient.getChainId = async () => {
    rateLimitAttempts += 1;
    const error = new Error("Too Many Requests");
    error.statusCode = 429;
    throw error;
  };

  await assert.rejects(
    readCanonicalAdminState(rateLimited.publicClient, canonicalManifest, {
      maxAttempts: 3,
      baseDelayMs: 2,
      maxDelayMs: 4,
      sleep: async (delayMs) => rateLimitDelays.push(delayMs),
      runtimeCodeHasher: rateLimited.runtimeCodeHasher,
    }),
    /Too Many Requests/,
  );
  assert.equal(rateLimitAttempts, 3);
  assert.deepEqual(rateLimitDelays, [2, 4]);

  const deterministicFailure = createFakeClients();
  const deterministicDelays = [];
  let deterministicAttempts = 0;
  deterministicFailure.publicClient.getBlockNumber = async () => {
    deterministicAttempts += 1;
    throw new Error("execution reverted while reading capture block");
  };
  await assert.rejects(
    readCanonicalAdminState(deterministicFailure.publicClient, canonicalManifest, {
      maxAttempts: 4,
      baseDelayMs: 1,
      maxDelayMs: 4,
      sleep: async (delayMs) => deterministicDelays.push(delayMs),
      runtimeCodeHasher: deterministicFailure.runtimeCodeHasher,
    }),
    /execution reverted/,
  );
  assert.equal(deterministicAttempts, 1);
  assert.deepEqual(deterministicDelays, []);
});

test("requires an explicit manifest/action and exact release confirmation for broadcast", () => {
  assert.throws(() => parseAdminActivationArguments([]), /--manifest is required/);
  assert.throws(
    () => parseAdminActivationArguments(["--manifest", "x.json", "--action", "controller-open", "--broadcast"]),
    /--confirm-release/,
  );
  assert.throws(
    () => parseAdminActivationArguments([
      "--manifest",
      "x.json",
      "--action",
      "controller-open",
      "--broadcast",
      "--confirm-release",
      "0x11",
    ]),
    /--confirm-release/,
  );
  assert.throws(
    () => parseAdminActivationArguments(["--manifest", "x.json", "--action", "market-open"]),
    /--registration-smoke/,
  );
  const marketOpen = parseAdminActivationArguments([
    "--manifest", "x.json",
    "--action", "market-open",
    "--registration-smoke", "smoke.json",
    "--candidate-origin", TEST_CANDIDATE_ORIGIN,
  ]);
  assert.match(marketOpen.registrationSmokePath, /smoke\.json$/);
  assert.equal(marketOpen.candidateOrigin, TEST_CANDIDATE_ORIGIN);
  const parsed = parseAdminActivationArguments([
    "--manifest",
    "x.json",
    "--action",
    "pause-all",
    "--broadcast",
    "--confirm-release",
    canonicalManifest.releaseId,
  ]);
  assert.equal(parsed.action, "pause-all");
  assert.equal(parsed.broadcast, true);
  assert.equal(parsed.confirmRelease, canonicalManifest.releaseId);
});

test("CLI binds broadcast confirmation to the release ID in the selected manifest", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "contour-admin-release-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const manifest = alternateReleaseManifest();
  const manifestPath = join(directory, "alternate-release.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await assert.rejects(
    runAdminActivation([
      "--manifest", manifestPath,
      "--action", "controller-open",
      "--broadcast",
      "--confirm-release", canonicalManifest.releaseId,
    ], {
      env: {},
    }),
    new RegExp(`--broadcast requires --confirm-release ${manifest.releaseId}`),
  );
});

test("validates release identities from the selected deployment manifest", () => {
  assert.equal(validateCanonicalAdminManifest(structuredClone(canonicalManifest)).releaseId, canonicalManifest.releaseId);
  const alternate = alternateReleaseManifest();
  assert.equal(validateCanonicalAdminManifest(alternate).releaseId, alternate.releaseId);

  const wrongChain = structuredClone(canonicalManifest);
  wrongChain.chain.id = 1;
  assert.throws(() => validateCanonicalAdminManifest(wrongChain), /chain ID is not Arc Testnet/);

  const zeroController = structuredClone(canonicalManifest);
  zeroController.contracts.controller.address = zeroAddress;
  assert.throws(() => validateCanonicalAdminManifest(zeroController), /must not be the zero address/);

  const invalidRuntimeHash = structuredClone(canonicalManifest);
  invalidRuntimeHash.contracts.controller.runtimeCodeHash = "0x11";
  assert.throws(() => validateCanonicalAdminManifest(invalidRuntimeHash), /non-zero bytes32/);
});

test("derives the canonical account only from the two supported environment variables", () => {
  const adminKey = `0x${"01".repeat(32)}`;
  const fallbackKey = `0x${"02".repeat(32)}`;
  const derive = (key) => ({
    address: key === fallbackKey ? "0x0000000000000000000000000000000000000001" : governance,
  });

  assert.equal(deriveCanonicalAdminAccount({ ADMIN_PRIVATE_KEY: adminKey }, derive, governance).address, governance);
  assert.equal(deriveCanonicalAdminAccount({ PRIVATE_KEY: adminKey }, derive, governance).address, governance);
  assert.throws(() => deriveCanonicalAdminAccount({}, derive, governance), /ADMIN_PRIVATE_KEY or PRIVATE_KEY/);
  assert.throws(
    () => deriveCanonicalAdminAccount(
      { ADMIN_PRIVATE_KEY: adminKey, PRIVATE_KEY: fallbackKey },
      derive,
      governance,
    ),
    /resolve to different accounts/,
  );
});

test("injects one selected transport into public and wallet clients", () => {
  const transport = Symbol("transport");
  const account = { address: governance };
  const seen = [];
  const clients = createAdminClients({
    rpcUrl: "https://rpc.testnet.arc.network",
    account,
    transport,
    publicClientFactory: (config) => {
      seen.push(["public", config]);
      return { kind: "public" };
    },
    walletClientFactory: (config) => {
      seen.push(["wallet", config]);
      return { kind: "wallet" };
    },
  });
  assert.equal(clients.publicClient.kind, "public");
  assert.equal(clients.walletClient.kind, "wallet");
  assert.equal(seen[0][1].transport, transport);
  assert.equal(seen[1][1].transport, transport);
  assert.equal(seen[1][1].account, account);
  assert.equal(seen[0][1].chain.id, adminActivationConstants.chainId);
});

test("dry-run reads canonical policy and simulates without broadcasting", async () => {
  const clients = createFakeClients();
  const report = await executeAdminActivation({
    manifest: activeManifest(),
    action: "controller-open",
    account: { address: governance },
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    runtimeCodeHasher: clients.runtimeCodeHasher,
  });
  assert.equal(report.ok, true);
  assert.equal(report.mode, "dry-run");
  assert.deepEqual(report.preState, { blockNumber: 100, controllerPaused: true, marketplacePaused: true });
  assert.deepEqual(report.expectedState, { controllerPaused: false, marketplacePaused: true });
  assert.equal(report.operations[0].simulated, true);
  assert.equal(report.operations[0].broadcast, false);
  assert.equal(report.operations[0].transactionHash, null);
  assert.equal(clients.state.writes.length, 0);
  assert.equal(report.postState.controllerPaused, true);
});

test("broadcast simulates, writes, confirms the receipt, and rereads exact state", async () => {
  const clients = createFakeClients();
  const report = await executeAdminActivation({
    manifest: activeManifest(),
    action: "controller-open",
    broadcast: true,
    account: { address: governance },
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    runtimeCodeHasher: clients.runtimeCodeHasher,
  });
  assert.equal(report.ok, true);
  assert.equal(report.operations[0].transactionHash, txHash(1));
  assert.equal(report.operations[0].blockNumber, 101);
  assert.equal(report.operations[0].receiptStatus, "success");
  assert.equal(report.operations[0].receiptConfirmed, true);
  assert.equal(report.postState.controllerPaused, false);
  assert.equal(report.postState.marketplacePaused, true);
});

test("market-open revalidates registration smoke before simulation", async () => {
  const manifest = await registrationControllerOpenManifest();
  const fixture = registrationSmokeChainFixture(manifest);
  const clients = createFakeClients({
    controllerPaused: false,
    marketplacePaused: true,
    registrationFixture: fixture,
  });
  const report = await executeAdminActivation({
    manifest,
    action: "market-open",
    account: { address: governance },
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    runtimeCodeHasher: clients.runtimeCodeHasher,
    registrationSmoke: fixture.evidence,
    candidateOrigin: TEST_CANDIDATE_ORIGIN,
  });
  assert.equal(report.ok, true);
  assert.equal(report.registrationSmoke.reportSha256, fixture.evidence.reportSha256);
  assert.equal(clients.state.simulations.length, 1);
  assert.equal(clients.state.writes.length, 0);
});

test("market-open CLI loads the required registration report", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "contour-admin-market-"));
  context.after(async () => rm(directory, { recursive: true, force: true }));
  const manifest = await registrationControllerOpenManifest();
  const fixture = registrationSmokeChainFixture(manifest);
  const manifestPath = join(directory, "controller-open.json");
  const smokePath = join(directory, "registration-smoke.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(smokePath, fixture.evidence.reportBytes);
  const clients = createFakeClients({
    controllerPaused: false,
    marketplacePaused: true,
    registrationFixture: fixture,
  });
  const report = await runAdminActivation([
    "--manifest", manifestPath,
    "--action", "market-open",
    "--registration-smoke", smokePath,
    "--candidate-origin", TEST_CANDIDATE_ORIGIN,
  ], {
    env: { PRIVATE_KEY: "01".repeat(32) },
    privateKeyToAccount: () => ({ address: governance }),
    runtimeCodeHasher: clients.runtimeCodeHasher,
    clients,
  });
  assert.equal(report.registrationSmoke.reportSha256, fixture.evidence.reportSha256);
  assert.equal(clients.state.simulations.length, 1);
  assert.equal(clients.state.writes.length, 0);
});

test("market-open rejects missing or tampered smoke before simulation", async () => {
  const manifest = await registrationControllerOpenManifest();
  const fixture = registrationSmokeChainFixture(manifest);
  const clients = createFakeClients({
    controllerPaused: false,
    marketplacePaused: true,
    registrationFixture: fixture,
  });
  await assert.rejects(executeAdminActivation({
    manifest,
    action: "market-open",
    account: { address: governance },
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    runtimeCodeHasher: clients.runtimeCodeHasher,
  }), /requires registration smoke PASS evidence/);
  const tampered = registrationSmokeEvidence(manifest, {
    candidateManifestSha256: txHash(999),
  });
  await assert.rejects(executeAdminActivation({
    manifest,
    action: "market-open",
    account: { address: governance },
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    runtimeCodeHasher: clients.runtimeCodeHasher,
    registrationSmoke: tampered,
    candidateOrigin: TEST_CANDIDATE_ORIGIN,
  }), (error) => error instanceof AdminActivationFailure && /exact controller-open predecessor/.test(error.report.error.message));
  assert.equal(clients.state.simulations.length, 0);
  assert.equal(clients.state.writes.length, 0);
});

for (const [name, fixtureOptions, captureBlock, pattern] of [
  ["reorg", { evidenceBlockHash: txHash(700) }, undefined, /block hash or timestamp mismatch/],
  ["historical state", { state: { marketplacePaused: false } }, undefined, /historical state/],
  ["finality", {}, BigInt(TEST_EVIDENCE_BLOCK - 1), /finality policy/],
]) {
  test(`market-open rejects registration smoke ${name} before simulation`, async () => {
    const manifest = await registrationControllerOpenManifest();
    const fixture = registrationSmokeChainFixture(manifest, fixtureOptions);
    const clients = createFakeClients({
      controllerPaused: false,
      marketplacePaused: true,
      registrationFixture: fixture,
      ...(captureBlock === undefined ? {} : { captureBlock }),
    });
    await assert.rejects(executeAdminActivation({
      manifest,
      action: "market-open",
      account: { address: governance },
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
      runtimeCodeHasher: clients.runtimeCodeHasher,
      registrationSmoke: fixture.evidence,
      candidateOrigin: TEST_CANDIDATE_ORIGIN,
    }), (error) => error instanceof AdminActivationFailure && pattern.test(error.report.error.message));
    assert.equal(clients.state.simulations.length, 0);
    assert.equal(clients.state.writes.length, 0);
  });
}

test("rejects a successful receipt that does not bind the canonical target", async () => {
  const clients = createFakeClients();
  const getReceipt = clients.publicClient.getTransactionReceipt;
  clients.publicClient.getTransactionReceipt = async (request) => ({
    ...await getReceipt(request),
    to: null,
  });
  await assert.rejects(
    executeAdminActivation({
      manifest: activeManifest(),
      action: "controller-open",
      broadcast: true,
      account: { address: governance },
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
      runtimeCodeHasher: clients.runtimeCodeHasher,
    }),
    (error) => error instanceof AdminActivationFailure &&
      /receipt target does not match the canonical contract/.test(error.report.error.message),
  );
});

test("pause-all broadcasts marketplace pause before controller pause", async () => {
  const clients = createFakeClients({ controllerPaused: false, marketplacePaused: false });
  const report = await executeAdminActivation({
    manifest: activeManifest(),
    action: "pause-all",
    broadcast: true,
    account: { address: governance },
    publicClient: clients.publicClient,
    walletClient: clients.walletClient,
    runtimeCodeHasher: clients.runtimeCodeHasher,
  });
  assert.equal(report.ok, true);
  assert.deepEqual(clients.state.writes.map(({ target, paused }) => [target, paused]), [
    ["marketplace", true],
    ["controller", true],
  ]);
  assert.equal(report.postState.controllerPaused, true);
  assert.equal(report.postState.marketplacePaused, true);
});

for (const fixture of [
  { action: "controller-open", target: "controller", initial: { controllerPaused: true, marketplacePaused: true } },
  { action: "market-open", target: "marketplace", initial: { controllerPaused: false, marketplacePaused: true } },
]) {
  test(`${fixture.action} attempts and confirms an automatic re-pause after a post-write failure`, async () => {
    const secret = `0x${"ab".repeat(32)}`;
    const manifest = fixture.action === "market-open"
      ? await registrationControllerOpenManifest()
      : activeManifest();
    const registrationFixture = fixture.action === "market-open"
      ? registrationSmokeChainFixture(manifest)
      : null;
    const clients = createFakeClients({
      ...fixture.initial,
      failWaitAt: 1,
      failureMessage: `failed ${secret}`,
      registrationFixture,
    });
    await assert.rejects(
      executeAdminActivation({
        manifest,
        action: fixture.action,
        broadcast: true,
        account: { address: governance },
        publicClient: clients.publicClient,
        walletClient: clients.walletClient,
        sensitiveValues: [secret],
        runtimeCodeHasher: clients.runtimeCodeHasher,
        ...(registrationFixture
          ? {
              registrationSmoke: registrationFixture.evidence,
              candidateOrigin: TEST_CANDIDATE_ORIGIN,
            }
          : {}),
      }),
      (error) => {
        assert.ok(error instanceof AdminActivationFailure);
        assert.equal(error.report.ok, false);
        assert.equal(error.report.rollback.attempted, true);
        assert.equal(error.report.rollback.target, fixture.target);
        assert.equal(error.report.rollback.succeeded, true);
        assert.equal(error.report.rollback.operation.desiredPaused, true);
        assert.equal(error.report.rollback.operation.transactionHash, txHash(2));
        assert.equal(error.report.postState[fixture.target === "controller" ? "controllerPaused" : "marketplacePaused"], true);
        assert.equal(JSON.stringify(error.report).includes(secret), false);
        assert.match(error.report.error.message, /\[REDACTED\]/);
        return true;
      },
    );
  });
}

test("rejects the wrong connected chain and the wrong administration account", async () => {
  const wrongChain = createFakeClients({ chainId: 1 });
  await assert.rejects(
    executeAdminActivation({
      manifest: activeManifest(),
      action: "controller-open",
      account: { address: governance },
      publicClient: wrongChain.publicClient,
      walletClient: wrongChain.walletClient,
    }),
    (error) => error instanceof AdminActivationFailure && /not Arc Testnet/.test(error.report.error.message),
  );

  const clients = createFakeClients();
  await assert.rejects(
    executeAdminActivation({
      manifest: activeManifest(),
      action: "controller-open",
      account: { address: "0x0000000000000000000000000000000000000001" },
      publicClient: clients.publicClient,
      walletClient: clients.walletClient,
    }),
    /selected deployment manifest/,
  );
  assert.equal(clients.state.simulations.length, 0);
});
