import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { getAddress, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CANONICAL_NFT_METADATA_BASE_URI,
  CONTRACT_KEYS,
  EXPECTED_RESOLVER_CAPABILITIES,
  parseDeploymentManifest,
  promotionSubjectDigest,
} from "../packages/config/dist/index.js";
import {
  assertPublicDnsResolution,
  buildOperationsDrillPlan,
  isPublicDnsAddress,
  operationsDrillUsage,
  runOperationsDrill,
} from "./run-operations-drill.mjs";
import { createPromotionTargetIntent } from "./lib/promotion-target.mjs";
import { createSignedPassEnvelope } from "./sign-promotion-pass.mjs";

const candidateUrl = "https://candidate.example.com/private/";
const registrationReadinessUrl = "https://candidate.example.com/api/registration/readiness";
const marketplaceReadinessUrl = "https://candidate.example.com/api/marketplace/readiness";
const authorization = "Basic dXNlcjpwYXNz";
const reviewerPrivateKey = `0x${"03".repeat(32)}`;
const reviewer = privateKeyToAccount(reviewerPrivateKey);
const hash = (value) => `0x${BigInt(value).toString(16).padStart(64, "0")}`;
const fixtureAddress = (value) =>
  getAddress(`0x${BigInt(value).toString(16).padStart(40, "0")}`);
const V2_RELEASE_ID = hash(700);
const V1_RELEASE_ID = hash(701);
const V2_GOVERNANCE = fixtureAddress(700);
const V2_VERIFIED_BLOCK = 52_190_647;
const V1_VERIFIED_BLOCK = 52_190_000;
const HEAD_BLOCK = 52_200_000;

function runtimeCode(seed) {
  return `0x60${seed.toString(16).padStart(2, "0")}600052`;
}

const V2_RUNTIME_CODES = Object.freeze(
  Object.fromEntries(CONTRACT_KEYS.map((key, index) => [key, runtimeCode(index + 20)])),
);
const V1_RUNTIME_CODES = Object.freeze(
  Object.fromEntries(CONTRACT_KEYS.map((key, index) => [key, runtimeCode(index + 60)])),
);

function retainedV1Reference() {
  return {
    registrarVersion: "v1",
    releaseId: V1_RELEASE_ID,
    verifiedAtBlock: V1_VERIFIED_BLOCK,
    contracts: Object.fromEntries(CONTRACT_KEYS.map((key, index) => [
      key,
      {
        address: fixtureAddress(index + 800),
        deploymentBlock: 52_180_000 + index,
        runtimeCodeHash: keccak256(V1_RUNTIME_CODES[key]),
      },
    ])),
    controllerPolicy: { registrationsPaused: true },
    marketplacePolicy: { paused: false },
  };
}

async function configuredManifest() {
  const value = JSON.parse(
    await readFile(new URL("../deployments/5042002.json", import.meta.url), "utf8"),
  );
  value.releaseId = V2_RELEASE_ID;
  value.registrarVersion = "v2";
  value.nftMetadata = { metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI };
  value.legacyReleases = [retainedV1Reference()];
  value.activationEvidence.governance.account = V2_GOVERNANCE;
  value.activationEvidence.controllerPolicy.permitSigner = V2_GOVERNANCE;
  value.permitIssuer.signerAddress = V2_GOVERNANCE;
  value.activationEvidence.verifiedAtBlock = V2_VERIFIED_BLOCK;
  for (const [index, key] of CONTRACT_KEYS.entries()) {
    const deployment = value.contracts[key];
    const contractAddress = fixtureAddress(index + 900);
    deployment.address = contractAddress;
    deployment.runtimeCodeHash = keccak256(V2_RUNTIME_CODES[key]);
    deployment.abiUrl =
      `https://testnet.arcscan.app/api/v2/smart-contracts/${contractAddress.toLowerCase()}`;
    deployment.sourceVerificationUrl = deployment.abiUrl;
  }
  return parseDeploymentManifest(value);
}

async function activeCandidateManifest() {
  const value = await configuredManifest();
  value.state = "active";
  value.activationEvidence.productLive = false;
  value.activationEvidence.verifiedAtBlock = V2_VERIFIED_BLOCK;
  value.activationEvidence.controllerPolicy.registrationsPaused = false;
  value.activationEvidence.marketplacePolicy.paused = false;
  for (const [index, [key, artifact]] of Object.entries(value.activationEvidence.artifacts).entries()) {
    if (key === "fundedEndToEnd" || key === "operationsDrill") continue;
    artifact.url = `https://evidence.example.com/releases/${key}.json`;
    artifact.sha256 = `0x${(index + 1).toString(16).padStart(64, "0")}`;
  }
  value.permitIssuer = {
    url: "https://candidate.example.com/api/registration/issuer/",
    signerAddress: V2_GOVERNANCE,
    publicKey: null,
    policyVersion: "1",
    active: true,
  };
  value.resolverCapabilities = { ...EXPECTED_RESOLVER_CAPABILITIES };
  return parseDeploymentManifest(value);
}

function productLiveTarget(candidate, verifiedAtBlock = HEAD_BLOCK - 1) {
  const target = structuredClone(candidate);
  target.activationEvidence.productLive = true;
  target.activationEvidence.verifiedAtBlock = verifiedAtBlock;
  target.activationEvidence.artifacts.fundedEndToEnd = {
    url: "https://evidence.example.com/releases/funded-end-to-end.json",
    sha256: `0x${"90".padStart(64, "0")}`,
  };
  target.activationEvidence.artifacts.operationsDrill = {
    url: "https://evidence.example.com/releases/operations-drill.json",
    sha256: `0x${"91".padStart(64, "0")}`,
  };
  return parseDeploymentManifest(target);
}

function fakeExecution(manifest, {
  readinessMode = "state",
  controllerCode = V2_RUNTIME_CODES.controller,
  marketplaceCode = V2_RUNTIME_CODES.marketplace,
  v2ReleaseId = manifest.releaseId,
  legacyReleaseId = manifest.legacyReleases[0].releaseId,
  legacyControllerPaused = true,
  legacyMarketplacePaused = false,
  legacyRuntimeRole = null,
} = {}) {
  const currentController = getAddress(manifest.contracts.controller.address);
  const currentMarketplace = getAddress(manifest.contracts.marketplace.address);
  const legacy = manifest.legacyReleases[0];
  const legacyController = getAddress(legacy.contracts.controller.address);
  const legacyMarketplace = getAddress(legacy.contracts.marketplace.address);
  const currentCodeByAddress = new Map(CONTRACT_KEYS.map((key) => [
    getAddress(manifest.contracts[key].address).toLowerCase(),
    key === "controller"
      ? controllerCode
      : key === "marketplace"
        ? marketplaceCode
        : V2_RUNTIME_CODES[key],
  ]));
  const legacyCodeByAddress = new Map(CONTRACT_KEYS.map((key) => [
    getAddress(legacy.contracts[key].address).toLowerCase(),
    key === legacyRuntimeRole ? "0x60006000" : V1_RUNTIME_CODES[key],
  ]));
  const state = {
    controllerPaused: false,
    marketplacePaused: false,
    legacyControllerPaused,
    legacyMarketplacePaused,
    v2ReleaseId,
    legacyReleaseId,
    block: HEAD_BLOCK,
    writes: [],
    authorizationHeaders: [],
    contractReads: [],
    codeReads: [],
  };
  const receipts = new Map();
  const account = { address: V2_GOVERNANCE };
  const publicClient = {
    async getChainId() {
      return 5_042_002;
    },
    async getCode(request) {
      state.codeReads.push(request);
      const normalized = request.address.toLowerCase();
      if (normalized === V2_GOVERNANCE.toLowerCase()) return "0x";
      if (currentCodeByAddress.has(normalized)) return currentCodeByAddress.get(normalized);
      if (legacyCodeByAddress.has(normalized)) return legacyCodeByAddress.get(normalized);
      throw new Error("unexpected code read");
    },
    async readContract(request) {
      state.contractReads.push(request);
      const { address, functionName } = request;
      const normalized = address.toLowerCase();
      if (
        functionName === "owner" &&
        (normalized === currentController.toLowerCase() ||
          normalized === currentMarketplace.toLowerCase())
      ) return V2_GOVERNANCE;
      if (functionName === "releaseId" && normalized === currentController.toLowerCase()) {
        return state.v2ReleaseId;
      }
      if (functionName === "releaseId" && normalized === legacyController.toLowerCase()) {
        return state.legacyReleaseId;
      }
      if (
        normalized === currentController.toLowerCase() &&
        functionName === "registrationsPaused"
      ) return state.controllerPaused;
      if (
        normalized === currentMarketplace.toLowerCase() &&
        functionName === "paused"
      ) return state.marketplacePaused;
      if (
        normalized === legacyController.toLowerCase() &&
        functionName === "registrationsPaused"
      ) return state.legacyControllerPaused;
      if (
        normalized === legacyMarketplace.toLowerCase() &&
        functionName === "paused"
      ) return state.legacyMarketplacePaused;
      throw new Error("unexpected read");
    },
    async waitForTransactionReceipt({ hash }) {
      const receipt = receipts.get(hash);
      if (!receipt) throw new Error("missing receipt");
      return receipt;
    },
    async getTransactionReceipt({ hash }) {
      const receipt = receipts.get(hash);
      if (!receipt) throw new Error("missing receipt");
      return receipt;
    },
    async getBlockNumber() {
      return BigInt(state.block);
    },
  };
  const walletClient = {
    async writeContract({ address, functionName, args }) {
      assert.deepEqual(args, [args[0] === true]);
      assert.ok(["setRegistrationsPaused", "setPaused"].includes(functionName));
      const expectedTarget = functionName === "setRegistrationsPaused"
        ? currentController
        : currentMarketplace;
      assert.equal(getAddress(address), expectedTarget);
      if (functionName === "setRegistrationsPaused") state.controllerPaused = args[0];
      if (functionName === "setPaused") state.marketplacePaused = args[0];
      state.block += 1;
      const hash = `0x${state.block.toString(16).padStart(64, "0")}`;
      state.writes.push({ address, functionName, paused: args[0], hash, blockNumber: state.block });
      receipts.set(hash, {
        status: "success",
        transactionHash: hash,
        blockNumber: BigInt(state.block),
        from: V2_GOVERNANCE,
        to: address,
      });
      return hash;
    },
  };
  const fetcher = async (url, init) => {
    state.authorizationHeaders.push(init.headers.authorization);
    if (url === registrationReadinessUrl) {
      const ready = readinessMode === "always-open" ? true : !state.controllerPaused;
      return new Response(JSON.stringify({ ready }), {
        status: ready ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === marketplaceReadinessUrl) {
      const ready = !state.marketplacePaused;
      return new Response(JSON.stringify({ ready }), {
        status: ready ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return { state, account, publicClient, walletClient, fetcher, receipts };
}

function runOptions(manifest, execution, overrides = {}) {
  const options = {
    manifestValue: manifest,
    targetManifestValue: productLiveTarget(manifest),
    confirmedReleaseId: manifest.releaseId,
    account: execution.account,
    publicClient: execution.publicClient,
    walletClient: execution.walletClient,
    fetcher: execution.fetcher,
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    runtimeCodeHasher: keccak256,
    candidateUrl,
    registrationReadinessUrl,
    marketplaceReadinessUrl,
    candidateAuthorization: authorization,
    readinessAttempts: 1,
    readinessRetryMs: 0,
    sleep: async () => {},
    now: () => new Date("2026-07-17T12:01:00.000Z"),
    ...overrides,
  };
  return options;
}

test("default plan is a no-broadcast canonical pause/reopen drill", async () => {
  const manifest = await configuredManifest();
  const plan = buildOperationsDrillPlan(manifest);
  assert.equal(plan.mode, "DRY_RUN");
  assert.equal(plan.releaseId, manifest.releaseId);
  assert.deepEqual(plan.targets, {
    controller: getAddress(manifest.contracts.controller.address),
    marketplace: getAddress(manifest.contracts.marketplace.address),
  });
  assert.deepEqual(plan.runtimeCodeHashes, {
    controller: manifest.contracts.controller.runtimeCodeHash,
    marketplace: manifest.contracts.marketplace.runtimeCodeHash,
  });
  assert.deepEqual(plan.retainedV1, {
    releaseId: manifest.legacyReleases[0].releaseId,
    controller: getAddress(manifest.legacyReleases[0].contracts.controller.address),
    marketplace: getAddress(manifest.legacyReleases[0].contracts.marketplace.address),
    registrationsPaused: true,
    marketplacePaused: false,
    mutatedByDrill: false,
  });
  assert.equal(plan.promotionTargetExplicit, false);
  assert.equal(plan.promotionSubjectSha256, null);
  assert.equal(plan.verifiedAtBlock, null);
  assert.equal(plan.safety.broadcasts, false);
  assert.equal(plan.safety.destructiveSignerChanges, false);
  assert.deepEqual(
    plan.transactions.map(({ id, functionName, paused }) => ({ id, functionName, paused })),
    [
      { id: "controllerPause", functionName: "setRegistrationsPaused", paused: true },
      { id: "controllerUnpause", functionName: "setRegistrationsPaused", paused: false },
      { id: "marketplacePause", functionName: "setPaused", paused: true },
      { id: "marketplaceUnpause", functionName: "setPaused", paused: false },
    ],
  );
  assert.match(operationsDrillUsage(), /--target-intent <promotion-target-intent\.json>/);

  const candidate = await activeCandidateManifest();
  const target = productLiveTarget(candidate);
  const intent = createPromotionTargetIntent(candidate, target.activationEvidence.verifiedAtBlock);
  const targetedPlan = buildOperationsDrillPlan(candidate, intent);
  assert.equal(targetedPlan.promotionTargetExplicit, true);
  assert.equal(targetedPlan.promotionSubjectSha256, promotionSubjectDigest(target));
  assert.equal(targetedPlan.verifiedAtBlock, target.activationEvidence.verifiedAtBlock);
});

test("requires V2 and derives release, targets, and runtime hashes only from the manifest", async () => {
  const legacyManifest = await configuredManifest();
  legacyManifest.registrarVersion = "v1";
  delete legacyManifest.nftMetadata;
  delete legacyManifest.legacyReleases;
  assert.throws(
    () => buildOperationsDrillPlan(legacyManifest),
    /requires the canonical V2 cutover manifest/,
  );

  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest, { controllerCode: "0x60006000" });
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, execution)),
    /V2 controller runtime bytecode hash mismatch/,
  );
  assert.equal(execution.state.writes.length, 0);
  assert.equal(execution.state.authorizationHeaders.length, 0);
});

test("fails closed when the retained V1 registration/market escape identity drifts", async () => {
  const cases = [
    {
      options: { legacyReleaseId: hash(999) },
      message: /retained V1 controller release ID/,
    },
    {
      options: { legacyControllerPaused: false },
      message: /retained V1 registrations must remain paused/,
    },
    {
      options: { legacyMarketplacePaused: true },
      message: /retained V1 marketplace escape paths must remain open/,
    },
    {
      options: { legacyRuntimeRole: "marketplace" },
      message: /retained V1 marketplace runtime bytecode hash mismatch/,
    },
  ];
  for (const fixture of cases) {
    const manifest = await activeCandidateManifest();
    const execution = fakeExecution(manifest, fixture.options);
    await assert.rejects(
      runOperationsDrill(runOptions(manifest, execution)),
      fixture.message,
    );
    assert.equal(execution.state.writes.length, 0);
    assert.equal(execution.state.authorizationHeaders.length, 0);
  }
});

test("re-checks the manifest release identity before entering the V2 marketplace drill", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest);
  const fetcher = execution.fetcher;
  let readinessReads = 0;
  execution.fetcher = async (...arguments_) => {
    const response = await fetcher(...arguments_);
    readinessReads += 1;
    if (readinessReads === 4) execution.state.v2ReleaseId = hash(1_337);
    return response;
  };
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, execution)),
    /V2 controller release ID does not match the manifest/,
  );
  assert.deepEqual(
    execution.state.writes.map(({ functionName }) => functionName),
    ["setRegistrationsPaused", "setRegistrationsPaused"],
  );
  assert.equal(
    execution.state.writes.some(({ address }) =>
      getAddress(address) === getAddress(manifest.contracts.marketplace.address)),
    false,
  );
});

test("requires an explicit later product-live target and rejects cross-phase drift before writes", async () => {
  const manifest = await activeCandidateManifest();

  const missingExecution = fakeExecution(manifest);
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, missingExecution, { targetManifestValue: undefined })),
    /--target-intent is required for broadcast/,
  );
  assert.equal(missingExecution.state.writes.length, 0);

  const changedIssuer = productLiveTarget(manifest);
  changedIssuer.permitIssuer.url = "https://other.example.com/api/registration/issuer/";
  const mismatchExecution = fakeExecution(manifest);
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, mismatchExecution, { targetManifestValue: changedIssuer })),
    /differs from the execution candidate outside permitted promotion fields/,
  );
  assert.equal(mismatchExecution.state.writes.length, 0);

  const nonLaterTarget = productLiveTarget(
    manifest,
    manifest.activationEvidence.verifiedAtBlock,
  );
  const nonLaterExecution = fakeExecution(manifest);
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, nonLaterExecution, { targetManifestValue: nonLaterTarget })),
    /verifiedAtBlock must be later than the execution candidate/,
  );
  assert.equal(nonLaterExecution.state.writes.length, 0);

  const futureTarget = productLiveTarget(manifest, 52_200_001);
  const futureExecution = fakeExecution(manifest);
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, futureExecution, { targetManifestValue: futureTarget })),
    /verifiedAtBlock is later than the pre-run Arc head/,
  );
  assert.equal(futureExecution.state.writes.length, 0);
});

test("accepts only globally routable IPv4 and IPv6 DNS answers", () => {
  for (const value of ["93.184.216.34", "2606:4700:4700::1111"]) {
    assert.equal(isPublicDnsAddress(value), true, value);
  }
  for (const value of [
    "0.0.0.0",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.0.0.1",
    "192.0.2.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "2001:db8::1",
    "2002::1",
    "3fff::1",
  ]) {
    assert.equal(isPublicDnsAddress(value), false, value);
  }
});

test("rejects mixed DNS answers when any result is private", async () => {
  await assert.rejects(
    assertPublicDnsResolution(
      candidateUrl,
      async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.7", family: 4 },
      ],
      "candidate",
    ),
    /private or reserved address/,
  );
});

test("re-resolves before every Basic request and blocks DNS rebinding", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest);
  const underlyingFetch = execution.fetcher;
  let dnsCalls = 0;
  let fetchCalls = 0;
  const options = runOptions(manifest, execution, {
    dnsLookup: async () => {
      dnsCalls += 1;
      return [{ address: dnsCalls === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
    },
    fetcher: async (...arguments_) => {
      fetchCalls += 1;
      return underlyingFetch(...arguments_);
    },
  });
  await assert.rejects(runOperationsDrill(options), /private or reserved address/);
  assert.equal(dnsCalls, 2);
  assert.equal(fetchCalls, 1);
  assert.deepEqual(execution.state.authorizationHeaders, [authorization]);
});

test("broadcast emits a receipt-bound promotion-compatible PASS", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest);
  const finalTarget = productLiveTarget(manifest);
  const targetIntent = createPromotionTargetIntent(
    manifest,
    finalTarget.activationEvidence.verifiedAtBlock,
  );
  const options = runOptions(manifest, execution, {
    targetManifestValue: targetIntent,
  });
  const report = await runOperationsDrill(options);

  assert.equal(report.schemaVersion, "1.0.0");
  assert.equal(report.artifact, "operationsDrill");
  assert.equal(report.verdict, "PASS");
  assert.equal(report.promotionSubjectSha256, promotionSubjectDigest(finalTarget));
  assert.equal(report.verifiedAtBlock, finalTarget.activationEvidence.verifiedAtBlock);
  assert.equal(report.evidenceBlock, execution.state.block);
  assert.deepEqual(report.redactions, {
    privateKeys: false,
    challengeSecrets: false,
    walletSignatures: false,
    permitSignatures: false,
  });
  assert.deepEqual(
    report.transactions.map(({ id }) => id),
    ["controllerPause", "controllerUnpause", "marketplacePause", "marketplaceUnpause"],
  );
  assert.deepEqual(
    report.assertions.map(({ id }) => id).sort(),
    [
      "registrationReadinessClosed",
      "registrationReadinessRecovered",
      "marketplaceReadinessClosed",
      "marketplaceReadinessRecovered",
      "rollbackRepaused",
    ].sort(),
  );
  assert.deepEqual(
    execution.state.writes.map(({ functionName, paused }) => ({ functionName, paused })),
    [
      { functionName: "setRegistrationsPaused", paused: true },
      { functionName: "setRegistrationsPaused", paused: false },
      { functionName: "setPaused", paused: true },
      { functionName: "setPaused", paused: false },
    ],
  );
  assert.equal(execution.state.controllerPaused, false);
  assert.equal(execution.state.marketplacePaused, false);
  assert.equal(execution.state.legacyControllerPaused, true);
  assert.equal(execution.state.legacyMarketplacePaused, false);
  const currentTargets = new Set([
    getAddress(manifest.contracts.controller.address).toLowerCase(),
    getAddress(manifest.contracts.marketplace.address).toLowerCase(),
  ]);
  const legacyTargets = new Set(CONTRACT_KEYS.map((key) =>
    getAddress(manifest.legacyReleases[0].contracts[key].address).toLowerCase()));
  assert.ok(execution.state.writes.every(({ address }) =>
    currentTargets.has(getAddress(address).toLowerCase())));
  assert.ok(execution.state.writes.every(({ address }) =>
    !legacyTargets.has(getAddress(address).toLowerCase())));
  assert.ok(execution.state.codeReads.length > 0);
  assert.ok(execution.state.contractReads.length > 0);
  assert.ok(execution.state.codeReads.every(({ blockNumber }) => typeof blockNumber === "bigint"));
  assert.ok(
    execution.state.contractReads.every(({ blockNumber }) => typeof blockNumber === "bigint"),
  );
  assert.ok(execution.state.contractReads.filter(({ address, functionName }) =>
    getAddress(address) === getAddress(manifest.contracts.controller.address) &&
    functionName === "releaseId").length >= 10);
  assert.ok(execution.state.authorizationHeaders.every((header) => header === authorization));
  assert.doesNotMatch(JSON.stringify(report), /dXNlcjpwYXNz|PRIVATE_KEY|walletSignatures":true/);

  const runReportBytes = new TextEncoder().encode(JSON.stringify(report));
  const envelope = await createSignedPassEnvelope({
    manifestValue: finalTarget,
    artifact: "operationsDrill",
    runReportBytes,
    runReportUrl: "https://evidence.example.com/runs/operations-cross-phase.json",
    reviewerPrivateKey,
    approvedReviewerAddresses: [reviewer.address],
  });
  assert.equal(envelope.promotionSubjectSha256, promotionSubjectDigest(finalTarget));
  assert.equal(envelope.verifiedAtBlock, finalTarget.activationEvidence.verifiedAtBlock);
});

test("requires exact release confirmation before any transaction", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest);
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, execution, {
      confirmedReleaseId: `0x${"ff".repeat(32)}`,
    })),
    /confirm-release/,
  );
  assert.equal(execution.state.writes.length, 0);
});

test("refuses all writes when the Arc head predates manifest verification", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest);
  execution.publicClient.getBlockNumber = async () =>
    BigInt(manifest.activationEvidence.verifiedAtBlock - 1);
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, execution)),
    /Arc head predates the manifest verification block/,
  );
  assert.equal(execution.state.writes.length, 0);
  assert.equal(execution.state.controllerPaused, false);
  assert.equal(execution.state.marketplacePaused, false);
});

test("refuses a promotion target whose later verification block is not yet at the pre-run head", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest);
  const targetManifestValue = productLiveTarget(manifest, execution.state.block + 1);
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, execution, { targetManifestValue })),
    /promotion target verifiedAtBlock is later than the pre-run Arc head/,
  );
  assert.equal(execution.state.writes.length, 0);
  assert.equal(execution.state.controllerPaused, false);
  assert.equal(execution.state.marketplacePaused, false);
});

test("refuses a product-live target that changes candidate execution state", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest);
  const targetManifestValue = productLiveTarget(manifest);
  targetManifestValue.activationEvidence.marketplacePolicy.feeBps += 1;
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, execution, { targetManifestValue })),
    /differs from the execution candidate/,
  );
  assert.equal(execution.state.writes.length, 0);
  assert.equal(execution.state.authorizationHeaders.length, 0);
});

test("never emits PASS from a receipt returned for a different transaction hash", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest);
  const waitForReceipt = execution.publicClient.waitForTransactionReceipt;
  let first = true;
  execution.publicClient.waitForTransactionReceipt = async (request) => {
    const receipt = await waitForReceipt(request);
    if (!first) return receipt;
    first = false;
    return { ...receipt, transactionHash: `0x${"ee".repeat(32)}` };
  };
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, execution)),
    /controllerPause receipt identity or status mismatch/,
  );
  assert.equal(execution.state.controllerPaused, true);
  assert.equal(execution.state.marketplacePaused, true);
});

test("will not send candidate Basic credentials to an origin outside the manifest", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest);
  let fetches = 0;
  execution.fetcher = async () => {
    fetches += 1;
    throw new Error("must not fetch");
  };
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, execution, {
      candidateUrl: "https://attacker.example.com/",
      registrationReadinessUrl: "https://attacker.example.com/api/registration/readiness",
      marketplaceReadinessUrl: "https://attacker.example.com/api/marketplace/readiness",
    })),
    /candidate origin does not match/,
  );
  assert.equal(fetches, 0);
  assert.equal(execution.state.writes.length, 0);
});

test("re-pauses both execution surfaces after an unexpected readiness failure", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest, { readinessMode: "always-open" });
  let caught;
  try {
    await runOperationsDrill(runOptions(manifest, execution));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught);
  assert.match(caught.message, /paused registration readiness did not reach/);
  assert.equal(caught.rollback.length, 2);
  assert.ok(caught.rollback.every(({ confirmed }) => confirmed));
  assert.equal(execution.state.controllerPaused, true);
  assert.equal(execution.state.marketplacePaused, true);
  assert.deepEqual(
    execution.state.writes.map(({ functionName, paused }) => ({ functionName, paused })),
    [
      { functionName: "setRegistrationsPaused", paused: true },
      { functionName: "setPaused", paused: true },
    ],
  );
});

test("does not expose fetcher error text that could contain secrets", async () => {
  const manifest = await activeCandidateManifest();
  const execution = fakeExecution(manifest);
  execution.fetcher = async () => {
    throw new Error("PRIVATE_KEY=0xsecret PROMOTION_CANDIDATE_INGRESS_PASSWORD=secret");
  };
  await assert.rejects(
    runOperationsDrill(runOptions(manifest, execution)),
    (error) => {
      assert.doesNotMatch(error.message, /PRIVATE_KEY|PASSWORD|0xsecret/);
      assert.match(error.message, /initial registration readiness/);
      return true;
    },
  );
  assert.deepEqual(
    execution.state.writes.map(({ functionName, paused }) => ({ functionName, paused })),
    [
      { functionName: "setRegistrationsPaused", paused: true },
      { functionName: "setPaused", paused: true },
    ],
  );
  assert.equal(execution.state.controllerPaused, true);
  assert.equal(execution.state.marketplacePaused, true);
});
