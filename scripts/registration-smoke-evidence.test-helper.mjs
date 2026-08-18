import { readFile } from "node:fs/promises";
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
} from "viem";
import {
  deploymentManifestDigest,
  parseDeploymentManifest,
} from "../packages/config/dist/index.js";
import { deriveNameIdentity } from "../packages/normalization/dist/index.js";
import {
  canonicalRegistrationSmokeJson,
  parseCanonicalRegistrationSmokeBytes,
  REGISTRATION_SMOKE_ASSERTION_IDS,
  REGISTRATION_SMOKE_RPC_URL,
  validateRegistrationSmokeLifecycle,
} from "./lib/registration-smoke-evidence.mjs";

export const TEST_CANDIDATE_ORIGIN = "https://candidate.example";
export const TEST_REGISTRANT = getAddress("0x2222222222222222222222222222222222222222");
export const TEST_SMOKE_LABEL = "registration-smoke";
export const TEST_EXPECTED_AMOUNT = 500_000n;
export const TEST_PERMIT_ID = `0x${"77".repeat(32)}`;
export const TEST_VERIFIED_BLOCK = 52_200_000;
export const TEST_APPROVAL_BLOCK = 52_200_010;
export const TEST_REGISTRATION_BLOCK = 52_200_011;
export const TEST_EVIDENCE_BLOCK = 52_200_012;
export const TEST_APPROVAL_BLOCK_HASH = `0x${"86".repeat(32)}`;
export const TEST_REGISTRATION_BLOCK_HASH = `0x${"87".repeat(32)}`;
export const TEST_EVIDENCE_BLOCK_HASH = `0x${"88".repeat(32)}`;
export const TEST_EVIDENCE_TIMESTAMP = 1_752_750_000n;

const HASH = (value) => `0x${value.toString(16).padStart(64, "0")}`;
const approvalAbi = parseAbi([
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const controllerAbi = parseAbi([
  "event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)",
  "event PermitConsumed(bytes32 indexed permitId, address indexed requester, uint256 indexed nonce)",
]);

export async function registrationControllerOpenManifest() {
  const manifest = JSON.parse(await readFile("deployments/5042002.json", "utf8"));
  manifest.state = "active";
  manifest.activationEvidence.productLive = false;
  manifest.activationEvidence.verifiedAtBlock = TEST_VERIFIED_BLOCK;
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
  manifest.activationEvidence.artifacts.fundedEndToEnd = { url: null, sha256: null };
  manifest.activationEvidence.artifacts.operationsDrill = { url: null, sha256: null };
  manifest.activationEvidence.controllerPolicy.registrationsPaused = false;
  manifest.activationEvidence.marketplacePolicy.paused = true;
  manifest.permitIssuer.url = `${TEST_CANDIDATE_ORIGIN}/api/registration/issuer/`;
  manifest.permitIssuer.active = true;
  for (const key of Object.keys(manifest.resolverCapabilities)) {
    manifest.resolverCapabilities[key] = key !== "ccipRead";
  }
  return parseDeploymentManifest(manifest);
}

export function registrationSmokeReport(manifest, overrides = {}) {
  const identity = deriveNameIdentity(TEST_SMOKE_LABEL, manifest.namespace.suffix);
  const candidateOrigin = new URL(manifest.permitIssuer.url).origin;
  const controller = getAddress(manifest.contracts.controller.address);
  const settlement = getAddress(manifest.settlement.erc20Address);
  return {
    schemaVersion: "1.0.0",
    artifact: "registrationActivationSmoke",
    mode: "BROADCAST",
    verdict: "PASS",
    chainId: manifest.chain.id,
    rpcUrl: REGISTRATION_SMOKE_RPC_URL,
    releaseId: manifest.releaseId,
    candidateManifestSha256: deploymentManifestDigest(manifest),
    verifiedAtBlock: manifest.activationEvidence.verifiedAtBlock,
    evidenceBlock: TEST_EVIDENCE_BLOCK,
    evidenceBlockHash: TEST_EVIDENCE_BLOCK_HASH,
    generatedAt: new Date(Number(TEST_EVIDENCE_TIMESTAMP) * 1_000).toISOString(),
    candidateOrigin,
    registrant: TEST_REGISTRANT,
    normalizedLabel: identity.normalized,
    fullName: identity.name,
    tokenId: identity.tokenId.toString(),
    durationYears: 1,
    expectedAmount: TEST_EXPECTED_AMOUNT.toString(),
    requiredState: { registrationsPaused: false, marketplacePaused: true },
    transactions: [
      {
        id: "registrationUsdcApproval",
        hash: HASH(101),
        blockNumber: TEST_APPROVAL_BLOCK,
        from: TEST_REGISTRANT,
        to: settlement,
      },
      {
        id: "registration",
        hash: HASH(102),
        blockNumber: TEST_REGISTRATION_BLOCK,
        from: TEST_REGISTRANT,
        to: controller,
      },
    ],
    assertions: REGISTRATION_SMOKE_ASSERTION_IDS.map((id) => ({
      id,
      verdict: "PASS",
      source: id === "issuerReconciled" ? "candidate-api" : "rpc",
      expected: ["issuerReconciled", "marketplaceRemainedPaused"].includes(id) ? "true" : "expected",
      actual: ["issuerReconciled", "marketplaceRemainedPaused"].includes(id) ? "true" : "actual",
    })),
    redactions: {
      privateKeys: false,
      challengeSecrets: false,
      walletSignatures: false,
      permitSignatures: false,
    },
    ...overrides,
  };
}

export function registrationSmokeEvidence(manifest, overrides = {}) {
  const report = registrationSmokeReport(manifest, overrides);
  return parseCanonicalRegistrationSmokeBytes(canonicalRegistrationSmokeJson(report));
}

export function registrationSmokeBinding(manifest, overrides = {}) {
  const evidence = registrationSmokeEvidence(manifest, overrides);
  return {
    evidence,
    binding: validateRegistrationSmokeLifecycle({
      ...evidence,
      controllerOpenManifest: manifest,
      candidateOrigin: TEST_CANDIDATE_ORIGIN,
    }),
  };
}

export function registrationSmokeBindingForMarketOpen(marketOpenManifest, {
  candidateVerifiedAtBlock = marketOpenManifest.activationEvidence.verifiedAtBlock - 2,
  evidenceBlock = marketOpenManifest.activationEvidence.verifiedAtBlock - 1,
} = {}) {
  const predecessor = structuredClone(marketOpenManifest);
  predecessor.activationEvidence.verifiedAtBlock = candidateVerifiedAtBlock;
  predecessor.activationEvidence.marketplacePolicy.paused = true;
  const parsedPredecessor = parseDeploymentManifest(predecessor);
  return Object.freeze({
    schemaVersion: "1.0.0",
    artifact: "registrationActivationSmoke",
    reportSha256: HASH(800),
    candidateManifestSha256: deploymentManifestDigest(parsedPredecessor),
    candidateVerifiedAtBlock,
    evidenceBlock,
    evidenceBlockHash: HASH(801),
    registrant: TEST_REGISTRANT,
    registrationTransactionHash: HASH(802),
  });
}

export function registrationSmokeChainFixture(manifest, overrides = {}) {
  const { evidence, binding } = registrationSmokeBinding(manifest, overrides.report);
  const report = binding.report;
  const identity = binding.identity;
  const controller = getAddress(manifest.contracts.controller.address);
  const settlement = getAddress(manifest.settlement.erc20Address);
  const registrar = getAddress(manifest.contracts.baseRegistrar.address);
  const registry = getAddress(manifest.contracts.registry.address);
  const resolver = getAddress(manifest.contracts.publicResolver.address);
  const marketplace = getAddress(manifest.contracts.marketplace.address);
  const expiry = 1_900_000_000n;
  const approvalReceipt = {
    status: "success",
    transactionHash: report.transactions[0].hash,
    blockNumber: BigInt(report.transactions[0].blockNumber),
    blockHash: overrides.approvalReceiptBlockHash ?? TEST_APPROVAL_BLOCK_HASH,
    from: TEST_REGISTRANT,
    to: settlement,
    logs: [{
      address: settlement,
      topics: encodeEventTopics({
        abi: approvalAbi,
        eventName: "Approval",
        args: { owner: TEST_REGISTRANT, spender: controller },
      }),
      data: encodeAbiParameters(parseAbiParameters("uint256"), [TEST_EXPECTED_AMOUNT]),
    }],
  };
  const registrationReceipt = {
    status: "success",
    transactionHash: report.transactions[1].hash,
    blockNumber: BigInt(report.transactions[1].blockNumber),
    blockHash: overrides.registrationReceiptBlockHash ?? TEST_REGISTRATION_BLOCK_HASH,
    from: TEST_REGISTRANT,
    to: controller,
    logs: [
      {
        address: settlement,
        topics: encodeEventTopics({
          abi: approvalAbi,
          eventName: "Transfer",
          args: { from: TEST_REGISTRANT, to: controller },
        }),
        data: encodeAbiParameters(parseAbiParameters("uint256"), [TEST_EXPECTED_AMOUNT]),
      },
      {
        address: controller,
        topics: encodeEventTopics({
          abi: controllerAbi,
          eventName: "PermitConsumed",
          args: { permitId: TEST_PERMIT_ID, requester: TEST_REGISTRANT, nonce: 7n },
        }),
        data: "0x",
      },
      {
        address: controller,
        topics: encodeEventTopics({
          abi: controllerAbi,
          eventName: "NameRegistered",
          args: { label: identity.labelhash, owner: TEST_REGISTRANT },
        }),
        data: encodeAbiParameters(
          parseAbiParameters("string,uint256,uint256,uint256"),
          [identity.normalized, TEST_EXPECTED_AMOUNT, 0n, expiry],
        ),
      },
    ],
  };
  const receipts = new Map([
    [approvalReceipt.transactionHash.toLowerCase(), approvalReceipt],
    [registrationReceipt.transactionHash.toLowerCase(), registrationReceipt],
  ]);
  const state = {
    marketplacePaused: true,
    registrarOwner: TEST_REGISTRANT,
    registryOwner: TEST_REGISTRANT,
    registryResolver: resolver,
    resolvedAddress: zeroAddress,
    expiry,
    usedPermit: true,
    nonce: 8n,
    allowance: 0n,
    controllerBalance: 1_000_000n,
    controllerLiability: 0n,
    ...overrides.state,
  };
  const publicClient = {
    async getChainId() { return overrides.chainId ?? manifest.chain.id; },
    async getTransactionReceipt({ hash }) {
      const receipt = receipts.get(hash.toLowerCase());
      if (!receipt) throw new Error("missing test receipt");
      return structuredClone(receipt);
    },
    async getBlock({ blockNumber }) {
      if (blockNumber === BigInt(report.transactions[0].blockNumber)) {
        return {
          number: blockNumber,
          hash: overrides.approvalHeaderBlockHash ?? TEST_APPROVAL_BLOCK_HASH,
          timestamp: TEST_EVIDENCE_TIMESTAMP - 2n,
        };
      }
      if (blockNumber === BigInt(report.transactions[1].blockNumber)) {
        return {
          number: blockNumber,
          hash: overrides.registrationHeaderBlockHash ?? TEST_REGISTRATION_BLOCK_HASH,
          timestamp: TEST_EVIDENCE_TIMESTAMP - 1n,
        };
      }
      if (blockNumber === BigInt(report.evidenceBlock)) {
        return {
          number: blockNumber,
          hash: overrides.evidenceBlockHash ?? report.evidenceBlockHash,
          timestamp: TEST_EVIDENCE_TIMESTAMP,
        };
      }
      throw new Error("unexpected block");
    },
    async readContract({ address, functionName }) {
      const target = getAddress(address);
      if (target === marketplace && functionName === "paused") return state.marketplacePaused;
      if (target === registrar && functionName === "ownerOf") return state.registrarOwner;
      if (target === registrar && functionName === "nameExpires") return state.expiry;
      if (target === registry && functionName === "owner") return state.registryOwner;
      if (target === registry && functionName === "resolver") return state.registryResolver;
      if (target === resolver && functionName === "addr") return state.resolvedAddress;
      if (target === controller && functionName === "usedPermit") return state.usedPermit;
      if (target === controller && functionName === "nonces") return state.nonce;
      if (target === controller && functionName === "totalReferralLiability") return state.controllerLiability;
      if (target === settlement && functionName === "allowance") return state.allowance;
      if (target === settlement && functionName === "balanceOf") return state.controllerBalance;
      throw new Error(`unexpected historical read ${target}:${functionName}`);
    },
  };
  return { evidence, binding, publicClient, receipts, state };
}
