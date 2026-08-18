import assert from "node:assert/strict";
import {
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  getAddress,
  parseAbi,
  parseAbiParameters,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deriveNameIdentity } from "../packages/normalization/dist/index.js";
import {
  controllerAbi,
  prepareApprovalPlan,
  registrationPermitDomain,
  registrationPermitTypes,
  resolverDataHash,
} from "../packages/sdk/dist/index.js";

export const BROADCAST_QUOTE = 500_000n;
export const BROADCAST_NONCE = 7n;
export const BROADCAST_PERMIT_ID = `0x${"77".repeat(32)}`;
export const BROADCAST_EXPIRY = 1_900_000_000n;
export const BROADCAST_NOW_SECONDS = 1_752_750_000;

const PERMIT_SIGNER = privateKeyToAccount(`0x${"33".repeat(32)}`);
const APPROVAL_HASH = `0x${"61".repeat(32)}`;
const REGISTRATION_HASH = `0x${"62".repeat(32)}`;
const APPROVAL_BLOCK_HASH = `0x${"71".repeat(32)}`;
const REGISTRATION_BLOCK_HASH = `0x${"72".repeat(32)}`;
const EVIDENCE_BLOCK_HASH = `0x${"73".repeat(32)}`;
const BUYER_SECRET = `0x${"88".repeat(32)}`;

const erc20EventAbi = parseAbi([
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const controllerEventAbi = parseAbi([
  "event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)",
  "event PermitConsumed(bytes32 indexed permitId, address indexed requester, uint256 indexed nonce)",
]);

function jsonResponse(value) {
  return {
    ok: true,
    status: 200,
    async text() { return JSON.stringify(value); },
  };
}

function eventLog(address, abi, eventName, args, data = "0x") {
  return {
    address,
    topics: encodeEventTopics({ abi, eventName, args }),
    data,
  };
}

export async function createRegistrationBroadcastHarness(inputManifest, {
  initialAllowance = 0n,
  evidenceBlock: evidenceBlockOverride,
  finalityShortfall = false,
  reorgRegistrationReceipt = false,
  finalMarketplacePaused = true,
} = {}) {
  const manifest = structuredClone(inputManifest);
  const permitSigner = getAddress(PERMIT_SIGNER.address);
  manifest.activationEvidence.governance.account = permitSigner;
  manifest.activationEvidence.controllerPolicy.permitSigner = permitSigner;
  manifest.permitIssuer.signerAddress = permitSigner;

  const origin = new URL(manifest.permitIssuer.url).origin;
  const registrant = getAddress("0x2222222222222222222222222222222222222222");
  const controller = getAddress(manifest.contracts.controller.address);
  const settlement = getAddress(manifest.settlement.erc20Address);
  const registrar = getAddress(manifest.contracts.baseRegistrar.address);
  const registry = getAddress(manifest.contracts.registry.address);
  const resolver = getAddress(manifest.contracts.publicResolver.address);
  const marketplace = getAddress(manifest.contracts.marketplace.address);
  const identity = deriveNameIdentity("registration-smoke", manifest.namespace.suffix);
  const approvalRequired = initialAllowance < BROADCAST_QUOTE;
  const readinessHead = BigInt(manifest.activationEvidence.verifiedAtBlock) + 100n;
  const approvalBlock = readinessHead + 1n;
  const registrationBlock = readinessHead + (approvalRequired ? 2n : 1n);
  const evidenceBlock = evidenceBlockOverride ??
    (finalityShortfall ? registrationBlock - 1n : registrationBlock + 2n);
  const evidenceTimestamp = BigInt(BROADCAST_NOW_SECONDS + 60);
  const controllerBalanceBefore = 1_000_000n;
  const controllerLiability = 100_000n;
  const requestId = `registration-smoke-${manifest.releaseId.slice(2, 10)}-${identity.labelhash.slice(2, 18)}`;
  const issuedAt = BROADCAST_NOW_SECONDS - 5;
  const validAfter = issuedAt - 1;
  const validUntil = BROADCAST_NOW_SECONDS + 120;
  const wirePermit = {
    chainId: BigInt(manifest.chain.id),
    controller,
    releaseId: manifest.releaseId,
    normalizationProfileHash: manifest.normalization.profileHash,
    normalizedLabelHash: identity.labelhash,
    namehash: identity.namehash,
    requester: registrant,
    recipient: registrant,
    payer: registrant,
    authorizedExecutor: registrant,
    durationYears: 1n,
    resolverDataHash: resolverDataHash([]),
    referrer: zeroAddress,
    settlementAsset: settlement,
    expectedAmount: BROADCAST_QUOTE,
    expectedReferralBps: 0n,
    permitId: BROADCAST_PERMIT_ID,
    nonce: BROADCAST_NONCE,
    issuedAt: BigInt(issuedAt),
    validAfter: BigInt(validAfter),
    validUntil: BigInt(validUntil),
  };
  const permitSignature = await PERMIT_SIGNER.signTypedData({
    domain: registrationPermitDomain(controller),
    types: registrationPermitTypes,
    primaryType: "RegistrationPermit",
    message: wirePermit,
  });
  const registrationData = encodeFunctionData({
    abi: controllerAbi,
    functionName: "register",
    args: [identity.normalized, wirePermit, [], permitSignature],
  });
  const prepared = {
    permitId: BROADCAST_PERMIT_ID,
    validUntil: String(validUntil),
    signature: permitSignature,
    permit: Object.fromEntries(Object.entries(wirePermit).map(([key, value]) => [
      key,
      typeof value === "bigint" ? value.toString() : value,
    ])),
    registrationTransaction: { to: controller, data: registrationData, value: "0x0" },
  };
  const approvalPlan = prepareApprovalPlan(manifest, BROADCAST_QUOTE);
  const preflightApproval = approvalRequired
    ? { to: approvalPlan.to, data: approvalPlan.data, value: "0x0" }
    : null;

  const approvalReceipt = {
    status: "success",
    transactionHash: APPROVAL_HASH,
    blockNumber: approvalBlock,
    blockHash: APPROVAL_BLOCK_HASH,
    from: registrant,
    to: settlement,
    logs: [eventLog(
      settlement,
      erc20EventAbi,
      "Approval",
      { owner: registrant, spender: controller },
      encodeAbiParameters(parseAbiParameters("uint256"), [BROADCAST_QUOTE]),
    )],
  };
  const registrationReceipt = {
    status: "success",
    transactionHash: REGISTRATION_HASH,
    blockNumber: registrationBlock,
    blockHash: REGISTRATION_BLOCK_HASH,
    from: registrant,
    to: controller,
    logs: [
      eventLog(
        settlement,
        erc20EventAbi,
        "Transfer",
        { from: registrant, to: controller },
        encodeAbiParameters(parseAbiParameters("uint256"), [BROADCAST_QUOTE]),
      ),
      eventLog(controller, controllerEventAbi, "PermitConsumed", {
        permitId: BROADCAST_PERMIT_ID,
        requester: registrant,
        nonce: BROADCAST_NONCE,
      }),
      eventLog(
        controller,
        controllerEventAbi,
        "NameRegistered",
        { label: identity.labelhash, owner: registrant },
        encodeAbiParameters(
          parseAbiParameters("string,uint256,uint256,uint256"),
          [identity.normalized, BROADCAST_QUOTE, 0n, BROADCAST_EXPIRY],
        ),
      ),
    ],
  };
  const receipts = new Map([[REGISTRATION_HASH.toLowerCase(), registrationReceipt]]);
  if (approvalRequired) receipts.set(APPROVAL_HASH.toLowerCase(), approvalReceipt);

  const calls = {
    blockNumbers: 0,
    fetches: [],
    receiptWaits: [],
    receiptRevalidations: [],
    blockReads: [],
    stateReads: [],
    sends: [],
    signatures: 0,
    writeContracts: 0,
  };
  const publicClient = {
    async getChainId() { return manifest.chain.id; },
    async getBlockNumber() {
      calls.blockNumbers += 1;
      return calls.blockNumbers === 1 ? readinessHead : evidenceBlock;
    },
    async getBytecode({ address }) {
      const index = Object.values(manifest.contracts).findIndex(
        (deployment) => getAddress(deployment.address) === getAddress(address),
      );
      if (index < 0) throw new Error("unknown contract");
      return `0x60${index.toString(16).padStart(2, "0")}00`;
    },
    async getBalance({ address }) {
      assert.equal(getAddress(address), registrant);
      return 1_000_000_000_000_000_000n;
    },
    async waitForTransactionReceipt(request) {
      calls.receiptWaits.push(request);
      const receipt = receipts.get(request.hash.toLowerCase());
      if (!receipt) throw new Error("unknown receipt");
      return structuredClone(receipt);
    },
    async getTransactionReceipt({ hash }) {
      calls.receiptRevalidations.push(hash);
      const receipt = receipts.get(hash.toLowerCase());
      if (!receipt) throw new Error("unknown receipt");
      const copy = structuredClone(receipt);
      if (reorgRegistrationReceipt && hash.toLowerCase() === REGISTRATION_HASH.toLowerCase()) {
        copy.blockHash = `0x${"99".repeat(32)}`;
      }
      return copy;
    },
    async getBlock({ blockNumber }) {
      const block = BigInt(blockNumber);
      calls.blockReads.push(block);
      if (approvalRequired && block === approvalBlock) {
        return { number: approvalBlock, hash: APPROVAL_BLOCK_HASH, timestamp: evidenceTimestamp - 2n };
      }
      if (block === registrationBlock) {
        return { number: registrationBlock, hash: REGISTRATION_BLOCK_HASH, timestamp: evidenceTimestamp - 1n };
      }
      if (block === evidenceBlock) {
        return { number: evidenceBlock, hash: EVIDENCE_BLOCK_HASH, timestamp: evidenceTimestamp };
      }
      throw new Error(`unexpected block ${block}`);
    },
    async readContract({ address, functionName, args = [], blockNumber }) {
      const target = getAddress(address);
      const block = blockNumber === undefined ? null : BigInt(blockNumber);
      calls.stateReads.push({ target, functionName, blockNumber: block });
      const postRegistration = block !== null && block >= registrationBlock;
      if (target === controller && functionName === "registrationsPaused") return false;
      if (target === marketplace && functionName === "paused") {
        return postRegistration ? finalMarketplacePaused : true;
      }
      if (target === controller && functionName === "releaseId") return manifest.releaseId;
      if (target === controller && functionName === "permitSigner") return manifest.permitIssuer.signerAddress;
      if (target === controller && functionName === "signerPolicyVersion") return 1n;
      if (target === controller && functionName === "quote") return BROADCAST_QUOTE;
      if (target === registrar && functionName === "available") return true;
      if (target === controller && functionName === "nonces") {
        return postRegistration ? BROADCAST_NONCE + 1n : BROADCAST_NONCE;
      }
      if (target === settlement && functionName === "allowance") {
        if (postRegistration) return 0n;
        if (approvalRequired && block === approvalBlock) return BROADCAST_QUOTE;
        return initialAllowance;
      }
      if (target === settlement && functionName === "balanceOf") {
        const owner = getAddress(args[0]);
        if (owner === registrant) return 10_000_000n;
        if (owner === controller) {
          return postRegistration
            ? controllerBalanceBefore + BROADCAST_QUOTE
            : controllerBalanceBefore;
        }
      }
      if (target === controller && functionName === "totalReferralLiability") {
        return controllerLiability;
      }
      if (target === controller && functionName === "usedPermit") return postRegistration;
      if (target === registrar && functionName === "ownerOf") return registrant;
      if (target === registry && functionName === "owner") return registrant;
      if (target === registry && functionName === "resolver") return resolver;
      if (target === resolver && functionName === "addr") return zeroAddress;
      if (target === registrar && functionName === "nameExpires") return BROADCAST_EXPIRY;
      throw new Error(`unexpected read ${target}.${functionName}`);
    },
  };

  const fetcher = async (input, init = {}) => {
    const url = new URL(input);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.fetches.push({ path: url.pathname, method: init.method ?? "GET", body });
    if (url.pathname === "/api/manifest" && !init.method) return jsonResponse(manifest);
    if (url.pathname === "/api/registration/readiness" && !init.method) {
      return jsonResponse({ ready: true });
    }
    if (url.pathname === "/api/registration/preflight" && init.method === "POST") {
      assert.deepEqual(body, {
        rawLabel: identity.normalized,
        normalizationAccepted: true,
        durationYears: 1,
        payer: registrant,
      });
      return jsonResponse({
        normalizedLabel: identity.normalized,
        expectedAmount: BROADCAST_QUOTE.toString(),
        approvalTransaction: preflightApproval,
      });
    }
    if (url.pathname === "/api/registration/prepare" && init.method === "POST") {
      assert.deepEqual(body, {
        rawLabel: identity.normalized,
        normalizationAccepted: true,
        durationYears: 1,
        requester: registrant,
        payer: registrant,
        recipient: registrant,
        requestId,
      });
      return jsonResponse(prepared);
    }
    if (url.pathname === "/api/registration/verify" && init.method === "POST") {
      assert.equal(body.transactionHash, REGISTRATION_HASH);
      assert.equal(body.permitId, BROADCAST_PERMIT_ID);
      return jsonResponse({
        verified: true,
        issuerReconciled: true,
        transactionHash: REGISTRATION_HASH,
        tokenId: identity.tokenId.toString(),
        owner: registrant,
      });
    }
    throw new Error(`unexpected fetch ${url.pathname}`);
  };
  const walletClient = {
    async writeContract() {
      calls.writeContracts += 1;
      throw new Error("broadcast must consume the preflight transaction plan");
    },
    async sendTransaction(request) {
      calls.sends.push(request);
      const target = getAddress(request.to);
      if (target === settlement) {
        assert.equal(approvalRequired, true);
        assert.equal(request.data.toLowerCase(), approvalPlan.data.toLowerCase());
        assert.equal(request.value, 0n);
        return APPROVAL_HASH;
      }
      if (target === controller) {
        assert.equal(request.data.toLowerCase(), registrationData.toLowerCase());
        assert.equal(request.value, 0n);
        return REGISTRATION_HASH;
      }
      throw new Error("unexpected transaction target");
    },
  };
  const account = {
    registrant: {
      address: registrant,
      async signMessage() {
        calls.signatures += 1;
        throw new Error("direct registration smoke must not sign a compatibility challenge");
      },
    },
    sensitiveValues: [BUYER_SECRET],
  };
  return {
    manifest,
    origin,
    identity,
    registrant,
    controller,
    settlement,
    resolver,
    marketplace,
    approvalRequired,
    approvalBlock,
    registrationBlock,
    evidenceBlock,
    evidenceBlockHash: EVIDENCE_BLOCK_HASH,
    evidenceTimestamp,
    approvalHash: APPROVAL_HASH,
    registrationHash: REGISTRATION_HASH,
    publicClient,
    walletClient,
    fetcher,
    account,
    calls,
    secrets: [BUYER_SECRET, permitSignature],
  };
}
