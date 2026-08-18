import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { resolve } from "node:path";
import { getAddress, sha256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CANONICAL_NFT_METADATA_BASE_URI,
  EXPECTED_RESOLVER_CAPABILITIES,
  parseDeploymentManifest,
  promotionSubjectDigest,
} from "../packages/config/dist/index.js";
import { createSignedPassEnvelope } from "./sign-promotion-pass.mjs";
import {
  buildFundedRunReport,
  FUNDED_TRANSACTION_IDS,
  FUNDED_V2_METADATA_ASSERTION_IDS,
  fundedAssertionIdsForManifest,
} from "./lib/funded-acceptance.mjs";
import { registrationSmokeBindingForMarketOpen } from "./registration-smoke-evidence.test-helper.mjs";
import { prepareReleaseStage } from "./prepare-release-stage.mjs";
import { createPromotionTargetIntent } from "./lib/promotion-target.mjs";

const reviewerPrivateKey = `0x${"02".repeat(32)}`;
const reviewer = privateKeyToAccount(reviewerPrivateKey);

function retainedV1ReferenceFixture(manifest) {
  return {
    registrarVersion: "v1",
    releaseId: `0x${"88".repeat(32)}`,
    verifiedAtBlock: 52_190_000,
    contracts: Object.fromEntries(
      Object.keys(manifest.contracts).map((key, index) => [
        key,
        {
          address: `0x${(index + 80).toString(16).padStart(40, "0")}`,
          deploymentBlock: 52_180_000 + index,
          runtimeCodeHash: `0x${(index + 90).toString(16).padStart(64, "0")}`,
        },
      ]),
    ),
    controllerPolicy: { registrationsPaused: true },
    marketplacePolicy: { paused: false },
  };
}

async function productLiveTarget() {
  const value = JSON.parse(await readFile(resolve("deployments/5042002.json"), "utf8"));
  value.state = "active";
  value.activationEvidence.productLive = true;
  value.activationEvidence.verifiedAtBlock = 52_200_000;
  value.activationEvidence.controllerPolicy.registrationsPaused = false;
  value.activationEvidence.marketplacePolicy.paused = false;
  for (const [index, artifact] of Object.values(value.activationEvidence.artifacts).entries()) {
    artifact.url = `https://evidence.example.com/${index}.json`;
    artifact.sha256 = `0x${(index + 1).toString(16).padStart(64, "0")}`;
  }
  value.permitIssuer = {
    url: "https://issuer.example.com",
    signerAddress: value.activationEvidence.controllerPolicy.permitSigner,
    publicKey: null,
    policyVersion: value.activationEvidence.controllerPolicy.signerPolicyVersion,
    active: true,
  };
  value.resolverCapabilities = { ...EXPECTED_RESOLVER_CAPABILITIES };
  return parseDeploymentManifest(value);
}

async function productLiveV2Target() {
  const value = structuredClone(await productLiveTarget());
  value.registrarVersion = "v2";
  value.nftMetadata = {
    metadataBaseURI: CANONICAL_NFT_METADATA_BASE_URI,
  };
  value.legacyReleases = [retainedV1ReferenceFixture(value)];
  return parseDeploymentManifest(value);
}

test("signs a PASS envelope that binds an immutable run-report hash", async () => {
  const manifest = await productLiveTarget();
  const report = {
    schemaVersion: "1.0.0",
    artifact: "operationsDrill",
    verdict: "PASS",
    chainId: manifest.chain.id,
    releaseId: manifest.releaseId,
    promotionSubjectSha256: promotionSubjectDigest(manifest),
    verifiedAtBlock: manifest.activationEvidence.verifiedAtBlock,
    evidenceBlock: manifest.activationEvidence.verifiedAtBlock + 10,
    generatedAt: "2026-07-17T12:00:00.000Z",
    transactions: [{
      id: "controllerPause",
      hash: `0x${"12".repeat(32)}`,
      blockNumber: manifest.activationEvidence.verifiedAtBlock + 1,
      from: manifest.activationEvidence.governance.account,
      to: manifest.contracts.controller.address,
    }],
    assertions: [],
    redactions: {
      privateKeys: false,
      challengeSecrets: false,
      walletSignatures: false,
      permitSignatures: false,
    },
  };
  const runReportBytes = new TextEncoder().encode(JSON.stringify(report));
  const envelope = await createSignedPassEnvelope({
    manifestValue: manifest,
    artifact: "operationsDrill",
    runReportBytes,
    runReportUrl: "https://evidence.example.com/runs/operations.json",
    reviewerPrivateKey,
    approvedReviewerAddresses: [reviewer.address],
  });
  assert.equal(envelope.schemaVersion, "1.1.0");
  assert.equal(envelope.reviewer, reviewer.address);
  assert.equal(envelope.runReportSha256, sha256(runReportBytes));
  assert.match(envelope.signature, /^0x[0-9a-f]{130}$/);

  const sameBlockReport = {
    ...report,
    transactions: [{
      ...report.transactions[0],
      blockNumber: manifest.activationEvidence.verifiedAtBlock,
    }],
  };
  await assert.rejects(createSignedPassEnvelope({
    manifestValue: manifest,
    artifact: "operationsDrill",
    runReportBytes: new TextEncoder().encode(JSON.stringify(sameBlockReport)),
    runReportUrl: "https://evidence.example.com/runs/operations-same-block.json",
    reviewerPrivateKey,
    approvedReviewerAddresses: [reviewer.address],
  }), /outside the promotion target evidence interval/);
});

test("stages, reports, and independently signs one later-block product-live target", async () => {
  const finalFixture = await productLiveV2Target();
  const candidateValue = structuredClone(finalFixture);
  candidateValue.activationEvidence.productLive = false;
  candidateValue.activationEvidence.verifiedAtBlock = finalFixture.activationEvidence.verifiedAtBlock - 100;
  candidateValue.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
  candidateValue.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
  const candidate = parseDeploymentManifest(candidateValue);
  const targetIntent = createPromotionTargetIntent(
    candidate,
    finalFixture.activationEvidence.verifiedAtBlock,
  );
  const target = prepareReleaseStage(candidate, {
    phase: "product-live",
    verifiedAtBlock: finalFixture.activationEvidence.verifiedAtBlock,
    targetIntent,
    artifacts: {
      fundedEndToEnd: finalFixture.activationEvidence.artifacts.fundedEndToEnd,
      operationsDrill: finalFixture.activationEvidence.artifacts.operationsDrill,
    },
  });

  const seller = getAddress(target.activationEvidence.governance.account);
  const buyer = getAddress("0x1111111111111111111111111111111111111111");
  const buyerTransactions = new Set([
    "buyerUsdcApproval", "purchase", "buyerNftApproval", "buyerRelisting",
    "buyerDirectTransfer", "listingInvalidation",
  ]);
  const targetFor = (id) => ({
    registrationUsdcApproval: target.settlement.erc20Address,
    registration: target.contracts.controller.address,
    sellerNftApproval: target.contracts.baseRegistrar.address,
    firstListing: target.contracts.marketplace.address,
    firstCancellation: target.contracts.marketplace.address,
    secondListing: target.contracts.marketplace.address,
    buyerUsdcApproval: target.settlement.erc20Address,
    purchase: target.contracts.marketplace.address,
    sellerClaimProceeds: target.contracts.marketplace.address,
    buyerNftApproval: target.contracts.baseRegistrar.address,
    buyerRelisting: target.contracts.marketplace.address,
    buyerDirectTransfer: target.contracts.baseRegistrar.address,
    listingInvalidation: target.contracts.marketplace.address,
  })[id];
  const report = buildFundedRunReport({
    manifest: candidate,
    targetManifest: targetIntent,
    registrationSmokeBinding: registrationSmokeBindingForMarketOpen(candidate),
    evidenceBlock: target.activationEvidence.verifiedAtBlock + 50,
    generatedAt: "2026-07-17T12:00:00.000Z",
    transactions: FUNDED_TRANSACTION_IDS.map((id, index) => ({
      id,
      hash: `0x${(index + 100).toString(16).padStart(64, "0")}`,
      blockNumber: target.activationEvidence.verifiedAtBlock + index + 1,
      from: buyerTransactions.has(id) ? buyer : seller,
      to: targetFor(id),
    })),
    assertions: fundedAssertionIdsForManifest(candidate).map((id) => ({
      id,
      verdict: "PASS",
      source: id === "nftMetadataDocument" || id === "nftImageDocument" ? "http" : "rpc",
      expected: "target-bound expected state",
      actual: "target-bound observed state",
    })),
  });
  const runReportBytes = new TextEncoder().encode(JSON.stringify(report));
  const envelope = await createSignedPassEnvelope({
    candidateManifestValue: candidate,
    targetIntentValue: targetIntent,
    artifact: "fundedEndToEnd",
    runReportBytes,
    runReportUrl: "https://evidence.example.com/runs/funded-target-bound.json",
    reviewerPrivateKey,
    approvedReviewerAddresses: [reviewer.address],
  });

  assert.equal(report.promotionSubjectSha256, promotionSubjectDigest(target));
  assert.equal(envelope.promotionSubjectSha256, report.promotionSubjectSha256);
  assert.equal(envelope.verifiedAtBlock, target.activationEvidence.verifiedAtBlock);
  assert.ok(report.transactions.every(({ blockNumber }) => blockNumber > envelope.verifiedAtBlock));
  assert.deepEqual(
    report.assertions.slice(-FUNDED_V2_METADATA_ASSERTION_IDS.length).map(({ id }) => id),
    FUNDED_V2_METADATA_ASSERTION_IDS,
  );
});

test("refuses unapproved reviewers and mismatched run reports", async () => {
  const manifest = await productLiveTarget();
  const report = {
    schemaVersion: "1.0.0",
    artifact: "fundedEndToEnd",
    verdict: "PASS",
    chainId: manifest.chain.id,
    releaseId: manifest.releaseId,
    promotionSubjectSha256: `0x${"00".repeat(32)}`,
    verifiedAtBlock: manifest.activationEvidence.verifiedAtBlock,
    evidenceBlock: manifest.activationEvidence.verifiedAtBlock + 1,
    transactions: [{
      from: manifest.activationEvidence.governance.account,
      blockNumber: manifest.activationEvidence.verifiedAtBlock + 1,
    }],
  };
  const runReportBytes = new TextEncoder().encode(JSON.stringify(report));
  await assert.rejects(createSignedPassEnvelope({
    manifestValue: manifest,
    artifact: "fundedEndToEnd",
    runReportBytes,
    runReportUrl: "https://evidence.example.com/runs/funded.json",
    reviewerPrivateKey,
    approvedReviewerAddresses: [reviewer.address],
  }), /not bound/);

  report.promotionSubjectSha256 = promotionSubjectDigest(manifest);
  await assert.rejects(createSignedPassEnvelope({
    manifestValue: manifest,
    artifact: "fundedEndToEnd",
    runReportBytes: new TextEncoder().encode(JSON.stringify(report)),
    runReportUrl: "https://evidence.example.com/runs/funded.json",
    reviewerPrivateKey,
    approvedReviewerAddresses: [],
  }), /not operator-approved/);
});
