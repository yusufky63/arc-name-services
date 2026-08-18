import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getAddress, keccak256 } from "viem";
import {
  CANONICAL_NFT_METADATA_BASE_URI,
  ERC721_METADATA_INTERFACE_ID,
  promotionSubjectDigest,
} from "../packages/config/dist/index.js";
import {
  accountsFromEnvironment,
  assertSecretFreeReport,
  buildFundedRunReport,
  createScopedCandidateFetcher,
  deterministicJson,
  FUNDED_ASSERTION_IDS,
  FUNDED_TRANSACTION_IDS,
  FUNDED_V2_METADATA_ASSERTION_IDS,
  fundedAssertionIdsForManifest,
  parseFundedAcceptanceArgs,
  runFundedAcceptance,
  registrationAcceptancePrimitives,
  verifyV2NftMetadataAcceptance,
} from "./lib/funded-acceptance.mjs";
import {
  createPromotionTargetIntent,
  validatePromotionTargetPair,
} from "./lib/promotion-target.mjs";
import { registrationSmokeBindingForMarketOpen } from "./registration-smoke-evidence.test-helper.mjs";

const ORIGIN = "https://candidate.example";
const SELLER = getAddress("0x1111111111111111111111111111111111111111");
const BUYER = getAddress("0x2222222222222222222222222222222222222222");
const HASH = (value) => `0x${value.toString(16).padStart(64, "0")}`;

function retainedV1ReferenceFixture(manifest) {
  return {
    registrarVersion: "v1",
    releaseId: HASH(880),
    verifiedAtBlock: 52_180_000,
    contracts: Object.fromEntries(
      Object.keys(manifest.contracts).map((key, index) => [
        key,
        {
          address: `0x${(index + 80).toString(16).padStart(40, "0")}`,
          deploymentBlock: 52_170_000 + index,
          runtimeCodeHash: HASH(index + 900),
        },
      ]),
    ),
    controllerPolicy: { registrationsPaused: true },
    marketplacePolicy: { paused: false },
  };
}

test("direct prepare permits use their own bounded clock instead of the compatibility challenge clock", () => {
  const { assertPreparedPermitWindow } = registrationAcceptancePrimitives;
  assert.doesNotThrow(() => assertPreparedPermitWindow({
    issuedAt: 1_002n,
    validAfter: 997n,
    validUntil: 1_182n,
    nowSeconds: 1_004,
  }));
  assert.throws(() => assertPreparedPermitWindow({
    issuedAt: 1_010n,
    validAfter: 1_005n,
    validUntil: 1_190n,
    nowSeconds: 1_004,
  }), /TTL mismatch/);
  assert.throws(() => assertPreparedPermitWindow({
    issuedAt: 800n,
    validAfter: 795n,
    validUntil: 1_100n,
    nowSeconds: 1_004,
  }), /TTL mismatch/);
  assert.throws(() => assertPreparedPermitWindow({
    issuedAt: 1_002n,
    validAfter: 996n,
    validUntil: 1_182n,
    nowSeconds: 1_004,
  }), /TTL mismatch/);
  assert.throws(() => assertPreparedPermitWindow({
    issuedAt: 1_002n,
    validAfter: 997n,
    validUntil: 1_035n,
    nowSeconds: 1_006,
  }), /TTL mismatch/);
});

async function activeCandidate() {
  const manifest = JSON.parse(await readFile("deployments/5042002.json", "utf8"));
  manifest.state = "active";
  manifest.activationEvidence.productLive = false;
  manifest.activationEvidence.verifiedAtBlock = 52_190_647;
  for (const [index, key] of [
    "deploymentReceipts",
    "constructorWiring",
    "governanceRoles",
    "treasuryControls",
    "signerPolicy",
    "releaseAttestation",
  ].entries()) {
    manifest.activationEvidence.artifacts[key] = {
      url: `https://evidence.example/releases/${key}.json`,
      sha256: HASH(index + 1),
    };
  }
  manifest.activationEvidence.controllerPolicy.registrationsPaused = false;
  manifest.activationEvidence.marketplacePolicy.paused = false;
  manifest.permitIssuer.url = `${ORIGIN}/api/registration/issuer/`;
  manifest.permitIssuer.active = true;
  for (const key of Object.keys(manifest.resolverCapabilities)) {
    manifest.resolverCapabilities[key] = key !== "ccipRead";
  }
  Object.values(manifest.contracts).forEach((deployment, index) => {
    deployment.runtimeCodeHash = keccak256(`0x60${index.toString(16).padStart(2, "0")}00`);
  });
  return manifest;
}

async function activeV2Candidate() {
  const manifest = await activeCandidate();
  manifest.registrarVersion = "v2";
  manifest.nftMetadata = {
    metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI,
  };
  manifest.legacyReleases = [retainedV1ReferenceFixture(manifest)];
  return manifest;
}

function productLiveTarget(candidate, verifiedAtBlock = 52_199_999) {
  const target = structuredClone(candidate);
  target.activationEvidence.productLive = true;
  target.activationEvidence.verifiedAtBlock = verifiedAtBlock;
  target.activationEvidence.artifacts.fundedEndToEnd = {
    url: "https://evidence.example/releases/funded-end-to-end.json",
    sha256: HASH(90),
  };
  target.activationEvidence.artifacts.operationsDrill = {
    url: "https://evidence.example/releases/operations-drill.json",
    sha256: HASH(91),
  };
  return target;
}

function v2MetadataHarness(manifest, options = {}) {
  const identity = {
    normalized: "acceptance",
    name: "acceptance.contour",
    tokenId: 123n,
  };
  const expiry = 1_800_000_000n;
  const blockNumber = 52_200_000n;
  const query = `label=acceptance&release=${manifest.releaseId}`;
  const publicOrigin = new URL(CANONICAL_NFT_METADATA_BASE_URI).origin;
  const properties = {
    releaseId: manifest.releaseId,
    registrarVersion: "v2",
    chainId: 5_042_002,
    contract: getAddress(manifest.contracts.baseRegistrar.address),
    tokenId: identity.tokenId.toString(),
    owner: SELLER,
    lifecycle: "active",
    asOfBlock: blockNumber.toString(),
    ...(options.properties ?? {}),
  };
  const metadata = {
    name: identity.name,
    description: `${identity.name} is a Contour name registered on Arc Testnet.`,
    image: `${publicOrigin}/api/image/${identity.tokenId}?${query}`,
    external_url: `${publicOrigin}/name/${identity.normalized}?release=${manifest.releaseId}`,
    background_color: "000B24",
    attributes: [
      { trait_type: "Namespace", value: ".contour" },
      { trait_type: "Network", value: "Arc Testnet" },
      { trait_type: "Length", value: 10 },
      { trait_type: "Status", value: "ACTIVE" },
      { trait_type: "Expires", display_type: "date", value: Number(expiry) },
    ],
    properties,
    ...(options.metadata ?? {}),
  };
  const imageBody = options.imageBody ??
    `<svg xmlns="http://www.w3.org/2000/svg"><title id="title">${identity.name}</title>` +
    `<desc>Contour name identity visual for ${identity.name}</desc>` +
    "<text>OWNER / 0x111111...111111</text><text>TOKEN / 123</text></svg>";
  const requests = [];
  let metadataTransientFailures = options.metadataTransientFailures ?? 0;
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, init });
    assert.equal(url.origin, ORIGIN);
    if (url.pathname === `/api/metadata/${identity.tokenId}`) {
      assert.equal(url.search, "");
      if (metadataTransientFailures > 0) {
        metadataTransientFailures -= 1;
        return new Response("not indexed yet", { status: 404 });
      }
      return new Response(JSON.stringify(metadata), {
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
          "content-type": "application/json; charset=utf-8",
          "x-content-type-options": "nosniff",
          ...(options.metadataHeaders ?? {}),
        },
      });
    }
    if (url.pathname === `/api/image/${identity.tokenId}`) {
      assert.equal(url.searchParams.get("label"), identity.normalized);
      assert.equal(url.searchParams.get("release"), manifest.releaseId);
      return new Response(imageBody, {
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
          "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          "content-type": "image/svg+xml; charset=utf-8",
          "x-content-type-options": "nosniff",
          ...(options.imageHeaders ?? {}),
        },
      });
    }
    throw new Error(`unexpected candidate collectible request ${url.pathname}`);
  };
  const publicClient = {
    async readContract({ address, functionName, args, blockNumber: readBlock }) {
      assert.equal(getAddress(address), getAddress(manifest.contracts.baseRegistrar.address));
      assert.equal(readBlock, blockNumber);
      if (functionName === "supportsInterface") {
        assert.deepEqual(args, [ERC721_METADATA_INTERFACE_ID]);
        return options.supportsMetadata ?? true;
      }
      if (functionName === "tokenURI") {
        assert.deepEqual(args, [identity.tokenId]);
        return options.tokenURI ?? `${CANONICAL_NFT_METADATA_BASE_URI}${identity.tokenId}`;
      }
      throw new Error(`unexpected metadata contract read ${functionName}`);
    },
  };
  return {
    identity,
    expiry,
    blockNumber,
    fetcher,
    publicClient,
    requests,
  };
}

function fixtureBytecode(manifest, address) {
  const index = Object.values(manifest.contracts).findIndex(
    (deployment) => getAddress(deployment.address) === getAddress(address),
  );
  if (index < 0) throw new Error("unknown contract");
  return `0x60${index.toString(16).padStart(2, "0")}00`;
}

function jsonResponse(value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() { return JSON.stringify(value); },
  };
}

function dryRunHarness(manifest) {
  const quote = 500_000n;
  let writes = 0;
  let signatures = 0;
  const publicClient = {
    async getChainId() { return 5_042_002; },
    async getBlockNumber() { return 52_200_000n; },
    async getBytecode({ address }) { return fixtureBytecode(manifest, address); },
    async getBalance() { return 1_000_000_000_000_000_000n; },
    async readContract({ functionName, args }) {
      if (functionName === "registrationsPaused" || functionName === "paused") return false;
      if (functionName === "releaseId") return manifest.releaseId;
      if (functionName === "permitSigner") return manifest.permitIssuer.signerAddress;
      if (functionName === "signerPolicyVersion") return 1n;
      if (functionName === "feeBps") return 250;
      if (functionName === "quote") return quote;
      if (functionName === "available") return true;
      if (functionName === "nonces") return 7n;
      if (functionName === "balanceOf") {
        assert.ok([SELLER, BUYER].includes(getAddress(args[0])));
        return 10_000_000n;
      }
      throw new Error(`unexpected read ${functionName}`);
    },
  };
  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/api/manifest" && !init.method) return jsonResponse(manifest);
    if (url.pathname === "/api/registration/readiness" && !init.method) return jsonResponse({ ready: true });
    if (url.pathname === "/api/registration/preflight" && init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.equal(body.payer, SELLER);
      return jsonResponse({ normalizedLabel: "acceptance", expectedAmount: quote.toString(), approvalTransaction: null });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const seller = {
    address: SELLER,
    async signMessage() { signatures += 1; throw new Error("dry run signed"); },
  };
  const buyer = { address: BUYER };
  const wallet = { async writeContract() { writes += 1; throw new Error("dry run wrote"); } };
  return {
    quote,
    publicClient,
    fetcher,
    accounts: { seller, buyer, sensitiveValues: ["seller-secret-value", "buyer-secret-value"] },
    sellerWalletClient: wallet,
    buyerWalletClient: wallet,
    counters: () => ({ writes, signatures }),
  };
}

test("default mode performs readiness checks and emits a transaction-free dry-run plan", async () => {
  const manifest = await activeCandidate();
  const harness = dryRunHarness(manifest);
  const result = await runFundedAcceptance({
    manifest,
    candidateOrigin: ORIGIN,
    label: "acceptance",
    accounts: harness.accounts,
    publicClient: harness.publicClient,
    sellerWalletClient: harness.sellerWalletClient,
    buyerWalletClient: harness.buyerWalletClient,
    fetcher: harness.fetcher,
  });
  assert.equal(result.mode, "DRY_RUN");
  assert.equal(result.verdict, "NOT_EXECUTED");
  assert.equal(result.promotionTargetExplicit, false);
  assert.equal(result.promotionSubjectSha256, null);
  assert.equal(result.verifiedAtBlock, null);
  assert.deepEqual(result.transactions.map(({ id }) => id), FUNDED_TRANSACTION_IDS);
  assert.deepEqual(result.assertions.map(({ id }) => id), FUNDED_ASSERTION_IDS);
  assert.deepEqual(harness.counters(), { writes: 0, signatures: 0 });
  const output = deterministicJson(result);
  assert.equal(output, deterministicJson(JSON.parse(output)));
  assert.doesNotMatch(output, /secret-value/);

  const targetManifest = productLiveTarget(manifest);
  const targeted = await runFundedAcceptance({
    manifest,
    targetManifest,
    candidateOrigin: ORIGIN,
    label: "acceptance",
    accounts: harness.accounts,
    publicClient: harness.publicClient,
    sellerWalletClient: harness.sellerWalletClient,
    buyerWalletClient: harness.buyerWalletClient,
    fetcher: harness.fetcher,
  });
  assert.equal(targeted.promotionTargetExplicit, true);
  assert.equal(targeted.promotionSubjectSha256, promotionSubjectDigest(targetManifest));
  assert.equal(targeted.verifiedAtBlock, targetManifest.activationEvidence.verifiedAtBlock);
  assert.deepEqual(harness.counters(), { writes: 0, signatures: 0 });
});

test("V2 dry-run and broadcast reports require collectible metadata assertions", async () => {
  const manifest = await activeV2Candidate();
  const harness = dryRunHarness(manifest);
  const result = await runFundedAcceptance({
    manifest,
    candidateOrigin: ORIGIN,
    label: "acceptance",
    accounts: harness.accounts,
    publicClient: harness.publicClient,
    sellerWalletClient: harness.sellerWalletClient,
    buyerWalletClient: harness.buyerWalletClient,
    fetcher: harness.fetcher,
  });

  assert.deepEqual(
    result.assertions.map(({ id }) => id),
    fundedAssertionIdsForManifest(manifest),
  );
  assert.deepEqual(
    result.assertions.slice(-FUNDED_V2_METADATA_ASSERTION_IDS.length).map(({ id }) => id),
    FUNDED_V2_METADATA_ASSERTION_IDS,
  );

  const targetManifest = productLiveTarget(manifest);
  const targetFor = (id) => ({
    registrationUsdcApproval: manifest.settlement.erc20Address,
    registration: manifest.contracts.controller.address,
    sellerNftApproval: manifest.contracts.baseRegistrar.address,
    firstListing: manifest.contracts.marketplace.address,
    firstCancellation: manifest.contracts.marketplace.address,
    secondListing: manifest.contracts.marketplace.address,
    buyerUsdcApproval: manifest.settlement.erc20Address,
    purchase: manifest.contracts.marketplace.address,
    sellerClaimProceeds: manifest.contracts.marketplace.address,
    buyerNftApproval: manifest.contracts.baseRegistrar.address,
    buyerRelisting: manifest.contracts.marketplace.address,
    buyerDirectTransfer: manifest.contracts.baseRegistrar.address,
    listingInvalidation: manifest.contracts.marketplace.address,
  })[id];
  const transactions = FUNDED_TRANSACTION_IDS.map((id, index) => ({
    id,
    hash: HASH(index + 600),
    blockNumber: targetManifest.activationEvidence.verifiedAtBlock + index + 1,
    from: SELLER,
    to: targetFor(id),
  }));
  const assertions = fundedAssertionIdsForManifest(manifest).map((id) => ({
    id,
    verdict: "PASS",
    source: id === "nftMetadataDocument" || id === "nftImageDocument" ? "http" : "rpc",
    expected: "exact expected state",
    actual: "exact observed state",
  }));
  const registrationSmokeBinding = registrationSmokeBindingForMarketOpen(manifest);
  assert.doesNotThrow(() => buildFundedRunReport({
    manifest,
    targetManifest,
    registrationSmokeBinding,
    evidenceBlock: targetManifest.activationEvidence.verifiedAtBlock + 100,
    generatedAt: "2026-07-17T12:00:00.000Z",
    transactions,
    assertions,
  }));
  assert.throws(() => buildFundedRunReport({
    manifest,
    targetManifest,
    registrationSmokeBinding,
    evidenceBlock: targetManifest.activationEvidence.verifiedAtBlock + 100,
    generatedAt: "2026-07-17T12:00:00.000Z",
    transactions,
    assertions: assertions.slice(0, -1),
  }), /assertion coverage/);
});

test("V2 collectible verification binds the production tokenURI to candidate JSON and SVG", async () => {
  const manifest = await activeV2Candidate();
  const harness = v2MetadataHarness(manifest);
  const assertions = await verifyV2NftMetadataAcceptance({
    manifest,
    candidateOrigin: ORIGIN,
    fetcher: harness.fetcher,
    publicClient: harness.publicClient,
    identity: harness.identity,
    owner: SELLER,
    expiry: harness.expiry,
    blockNumber: harness.blockNumber,
  });

  assert.deepEqual(assertions.map(({ id }) => id), FUNDED_V2_METADATA_ASSERTION_IDS);
  assert.deepEqual(assertions.map(({ source }) => source), ["rpc", "rpc", "http", "http"]);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[0].url.pathname, `/api/metadata/${harness.identity.tokenId}`);
  assert.equal(harness.requests[0].url.search, "");
  assert.equal(
    harness.requests[0].url.toString(),
    `${ORIGIN}/api/metadata/${harness.identity.tokenId}`,
  );
  assert.equal(harness.requests[1].url.pathname, `/api/image/${harness.identity.tokenId}`);
  assert.equal(harness.requests[0].init.redirect, "error");
  assert.match(assertions[2].actual, /^sha256=0x[0-9a-f]{64},contract=/);
  assert.match(assertions[3].actual, /^sha256=0x[0-9a-f]{64},contentType=image\/svg\+xml/);
});

test("V2 collectible verification retries bounded transient indexing lag at the exact tokenURI path", async () => {
  const manifest = await activeV2Candidate();
  const harness = v2MetadataHarness(manifest, { metadataTransientFailures: 1 });
  const assertions = await verifyV2NftMetadataAcceptance({
    manifest,
    candidateOrigin: ORIGIN,
    fetcher: harness.fetcher,
    publicClient: harness.publicClient,
    identity: harness.identity,
    owner: SELLER,
    expiry: harness.expiry,
    blockNumber: harness.blockNumber,
  });

  assert.deepEqual(assertions.map(({ id }) => id), FUNDED_V2_METADATA_ASSERTION_IDS);
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.requests[0].url.toString(), harness.requests[1].url.toString());
  assert.equal(harness.requests[0].url.search, "");
  assert.equal(harness.requests[2].url.pathname, `/api/image/${harness.identity.tokenId}`);
});

test("V2 collectible verification fails closed on each trust boundary", async () => {
  const manifest = await activeV2Candidate();
  const cases = [
    {
      options: { supportsMetadata: false },
      message: /does not support ERC-721 Metadata/,
    },
    {
      options: { tokenURI: "https://evil.example/metadata/123" },
      message: /exact production metadata URL/,
    },
    {
      options: { properties: { owner: BUYER } },
      message: /identity binding mismatch/,
    },
    {
      options: { imageHeaders: { "content-security-policy": "default-src *" } },
      message: /security, cache, or content-type headers/,
    },
    {
      options: { imageBody: "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>" },
      message: /body does not match/,
    },
  ];
  for (const { options, message } of cases) {
    const harness = v2MetadataHarness(manifest, options);
    await assert.rejects(verifyV2NftMetadataAcceptance({
      manifest,
      candidateOrigin: ORIGIN,
      fetcher: harness.fetcher,
      publicClient: harness.publicClient,
      identity: harness.identity,
      owner: SELLER,
      expiry: harness.expiry,
      blockNumber: harness.blockNumber,
    }), message);
  }
});

test("broadcast requires the exact manifest release before any RPC, fetch, signature, or write", async () => {
  const manifest = await activeCandidate();
  let effects = 0;
  await assert.rejects(runFundedAcceptance({
    manifest,
    candidateOrigin: ORIGIN,
    label: "acceptance",
    broadcastReleaseId: HASH(999),
    accounts: {
      seller: { address: SELLER, async signMessage() { effects += 1; } },
      buyer: { address: BUYER },
      sensitiveValues: [],
    },
    publicClient: { async getChainId() { effects += 1; } },
    sellerWalletClient: { async writeContract() { effects += 1; } },
    buyerWalletClient: { async writeContract() { effects += 1; } },
    fetcher: async () => { effects += 1; },
  }), /--broadcast must exactly equal releaseId/);
  assert.equal(effects, 0);
  assert.throws(() => parseFundedAcceptanceArgs([
    "--manifest", "candidate.json", "--candidate-origin", ORIGIN,
    "--label", "acceptance", "--broadcast",
  ]), /--broadcast requires an explicit value/);
  assert.throws(() => parseFundedAcceptanceArgs([
    "--manifest", "candidate.json", "--candidate-origin", ORIGIN,
    "--label", "acceptance", "--broadcast", manifest.releaseId,
  ]), /--target-intent is required/);
  await assert.rejects(runFundedAcceptance({
    manifest,
    candidateOrigin: ORIGIN,
    label: "acceptance",
    broadcastReleaseId: manifest.releaseId,
    accounts: {
      seller: { address: SELLER, async signMessage() { effects += 1; } },
      buyer: { address: BUYER },
      sensitiveValues: [],
    },
    publicClient: { async getChainId() { effects += 1; } },
    sellerWalletClient: { async writeContract() { effects += 1; } },
    buyerWalletClient: { async writeContract() { effects += 1; } },
    fetcher: async () => { effects += 1; },
  }), /--target-intent is required for broadcast/);
  assert.equal(effects, 0);
});

test("seller and buyer keys must resolve to distinct accounts", () => {
  const key = `0x${"11".repeat(32)}`;
  assert.throws(() => accountsFromEnvironment({
    PRIVATE_KEY: key,
    E2E_BUYER_PRIVATE_KEY: key,
  }), /distinct/);
});

test("funded acceptance accepts prefixless keys loaded from the local env file", () => {
  const accounts = accountsFromEnvironment({
    PRIVATE_KEY: "11".repeat(32),
    E2E_BUYER_PRIVATE_KEY: "22".repeat(32),
  });
  assert.notEqual(accounts.seller.address, accounts.buyer.address);
  assert.deepEqual(accounts.sensitiveValues, [
    `0x${"11".repeat(32)}`,
    `0x${"22".repeat(32)}`,
  ]);
});

test("non-publishable target intent binds the exact eventual live subject without placeholder evidence", async () => {
  const candidate = await activeCandidate();
  const finalTarget = productLiveTarget(candidate);
  const intent = createPromotionTargetIntent(
    candidate,
    finalTarget.activationEvidence.verifiedAtBlock,
  );
  const validated = validatePromotionTargetPair(candidate, intent);
  assert.equal(validated.targetInputKind, "intent");
  assert.equal(validated.promotionSubjectSha256, promotionSubjectDigest(finalTarget));
  assert.equal(intent.promotionSubjectSha256, promotionSubjectDigest(finalTarget));
  assert.equal(intent.verifiedAtBlock, finalTarget.activationEvidence.verifiedAtBlock);
  assert.equal(Object.hasOwn(intent, "artifacts"), false);

  assert.throws(
    () => validatePromotionTargetPair(candidate, {
      ...intent,
      promotionSubjectSha256: HASH(777),
    }),
    /promotionSubjectSha256 does not match/,
  );
  assert.throws(
    () => validatePromotionTargetPair(candidate, { ...intent, placeholderUrl: "https://example.test" }),
    /unexpected or missing fields/,
  );
});

test("private-candidate Basic auth is file-backed and scoped to the explicit origin", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "contour-funded-auth-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const credential = `operator:${"p".repeat(40)}`;
  const credentialFile = join(directory, "candidate-basic.txt");
  await writeFile(credentialFile, `${credential}\n`);
  const observed = [];
  const scoped = await createScopedCandidateFetcher({
    candidateOrigin: ORIGIN,
    basicAuthFile: credentialFile,
    baseFetcher: async (input, init) => {
      const request = {
        url: new URL(input).toString(),
        authorization: new Headers(init.headers).get("authorization"),
        redirect: init.redirect,
      };
      observed.push(request);
      if (observed.length === 1) {
        return new Response(null, {
          status: 401,
          headers: {
            "cache-control": "no-store, max-age=0",
            "www-authenticate": 'Basic realm="Contour private candidate"',
          },
        });
      }
      return jsonResponse({ ok: true });
    },
  });
  await scoped(`${ORIGIN}/api/registration/readiness`);
  assert.deepEqual(observed[0], {
    url: `${ORIGIN}/api/registration/issuer/healthz`,
    authorization: null,
    redirect: "manual",
  });
  assert.equal(observed[1].authorization, `Basic ${Buffer.from(credential).toString("base64")}`);
  assert.equal(observed[1].redirect, "manual");
  await assert.rejects(
    scoped("https://attacker.example/collect"),
    /cannot be sent outside the explicit origin/,
  );
});

test("private-candidate fetcher fails before authenticated traffic without an uncacheable challenge", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "contour-funded-auth-fail-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const credentialFile = join(directory, "candidate-basic.txt");
  await writeFile(credentialFile, `operator:${"p".repeat(40)}\n`);
  let calls = 0;

  await assert.rejects(createScopedCandidateFetcher({
    candidateOrigin: ORIGIN,
    basicAuthFile: credentialFile,
    baseFetcher: async () => {
      calls += 1;
      return new Response(null, {
        status: 401,
        headers: { "www-authenticate": 'Basic realm="Contour private candidate"' },
      });
    },
  }), /uncacheable Basic challenge/);
  assert.equal(calls, 1);
});

test("PASS report has exact promotion coverage and rejects secret-bearing paths and values", async () => {
  const manifest = await activeCandidate();
  const targetManifest = productLiveTarget(manifest);
  const targetFor = (id) => ({
    registrationUsdcApproval: manifest.settlement.erc20Address,
    registration: manifest.contracts.controller.address,
    sellerNftApproval: manifest.contracts.baseRegistrar.address,
    firstListing: manifest.contracts.marketplace.address,
    firstCancellation: manifest.contracts.marketplace.address,
    secondListing: manifest.contracts.marketplace.address,
    buyerUsdcApproval: manifest.settlement.erc20Address,
    purchase: manifest.contracts.marketplace.address,
    sellerClaimProceeds: manifest.contracts.marketplace.address,
    buyerNftApproval: manifest.contracts.baseRegistrar.address,
    buyerRelisting: manifest.contracts.marketplace.address,
    buyerDirectTransfer: manifest.contracts.baseRegistrar.address,
    listingInvalidation: manifest.contracts.marketplace.address,
  })[id];
  const buyerTransactions = new Set([
    "buyerUsdcApproval",
    "purchase",
    "buyerNftApproval",
    "buyerRelisting",
    "buyerDirectTransfer",
    "listingInvalidation",
  ]);
  const transactions = FUNDED_TRANSACTION_IDS.map((id, index) => ({
    id,
    hash: HASH(index + 100),
    blockNumber: 52_200_000 + index,
    from: buyerTransactions.has(id) ? BUYER : SELLER,
    to: targetFor(id),
  }));
  const assertions = FUNDED_ASSERTION_IDS.map((id) => ({
    id,
    verdict: "PASS",
    source: "rpc",
    expected: "expected exact state",
    actual: "observed exact state",
  }));
  const secret = `0x${"ab".repeat(32)}`;
  const registrationSmokeBinding = registrationSmokeBindingForMarketOpen(manifest);
  const report = buildFundedRunReport({
    manifest,
    targetManifest,
    registrationSmokeBinding,
    evidenceBlock: 52_200_100,
    generatedAt: "2026-07-17T12:00:00.000Z",
    transactions,
    assertions,
    sensitiveValues: [secret],
  });
  assert.equal(report.verdict, "PASS");
  assert.equal(report.promotionSubjectSha256, promotionSubjectDigest(targetManifest));
  assert.equal(report.verifiedAtBlock, targetManifest.activationEvidence.verifiedAtBlock);
  assert.deepEqual(report.transactions.map(({ id }) => id), FUNDED_TRANSACTION_IDS);
  assert.doesNotThrow(() => assertSecretFreeReport(report, [secret]));
  const targetIntent = createPromotionTargetIntent(
    manifest,
    targetManifest.activationEvidence.verifiedAtBlock,
  );
  const intentBoundReport = buildFundedRunReport({
    manifest,
    targetManifest: targetIntent,
    registrationSmokeBinding,
    evidenceBlock: 52_200_100,
    generatedAt: "2026-07-17T12:00:00.000Z",
    transactions,
    assertions,
  });
  assert.equal(intentBoundReport.promotionSubjectSha256, report.promotionSubjectSha256);
  assert.equal(intentBoundReport.verifiedAtBlock, report.verifiedAtBlock);
  assert.throws(
    () => assertSecretFreeReport({ ...report, challengeSignature: `0x${"cc".repeat(65)}` }),
    /forbidden secret material/,
  );
  assert.throws(
    () => assertSecretFreeReport({ ...report, note: secret }, [secret]),
    /contains sensitive material/,
  );
  assert.throws(
    () => buildFundedRunReport({
      manifest,
      targetManifest,
      registrationSmokeBinding,
      evidenceBlock: 52_200_100,
      generatedAt: "2026-07-17T12:00:00.000Z",
      transactions: transactions.map((transaction) => transaction.id === "registration"
        ? { ...transaction, to: manifest.contracts.marketplace.address }
        : transaction),
      assertions,
    }),
    /registration transaction target mismatch/,
  );
  assert.throws(
    () => buildFundedRunReport({
      manifest,
      targetManifest,
      registrationSmokeBinding,
      evidenceBlock: 52_200_100,
      generatedAt: "2026-07-17T12:00:00.000Z",
      transactions: transactions.map((transaction) => transaction.id === "registration"
        ? { ...transaction, blockNumber: Number.MAX_SAFE_INTEGER + 1 }
        : transaction),
      assertions,
    }),
    /registration transaction block is not a positive safe integer/,
  );
  assert.throws(
    () => buildFundedRunReport({
      manifest,
      targetManifest,
      registrationSmokeBinding,
      evidenceBlock: 52_200_100,
      generatedAt: "2026-07-17T12:00:00.000Z",
      transactions: transactions.map((transaction) => transaction.id === "registration"
        ? { ...transaction, blockNumber: targetManifest.activationEvidence.verifiedAtBlock }
        : transaction),
      assertions,
    }),
    /registration transaction is outside the verified evidence interval/,
  );

  const changedTarget = structuredClone(targetManifest);
  changedTarget.activationEvidence.marketplacePolicy.feeBps += 1;
  assert.throws(
    () => buildFundedRunReport({
      manifest,
      targetManifest: changedTarget,
      registrationSmokeBinding,
      evidenceBlock: 52_200_100,
      generatedAt: "2026-07-17T12:00:00.000Z",
      transactions,
      assertions,
    }),
    /differs from the execution candidate/,
  );
  assert.throws(
    () => buildFundedRunReport({
      manifest,
      targetManifest: productLiveTarget(manifest, manifest.activationEvidence.verifiedAtBlock),
      registrationSmokeBinding,
      evidenceBlock: 52_200_100,
      generatedAt: "2026-07-17T12:00:00.000Z",
      transactions,
      assertions,
    }),
    /must be later than the execution candidate/,
  );
});
