#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  getAddress,
  keccak256,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  CONTRACT_KEYS,
  parseDeploymentManifest,
  registrarVersionOf,
} from "../packages/config/dist/index.js";
import {
  assertPromotionTargetAtHead,
  validatePromotionTargetPair,
} from "./lib/promotion-target.mjs";
import { rateLimitedArcHttp } from "./lib/arc-rpc-transport.mjs";
import { normalizeOperatorPrivateKey } from "./lib/operator-key.mjs";

export const ARC_TESTNET_CHAIN_ID = 5_042_002;

const MAX_HTTP_BODY_BYTES = 64 * 1024;
const DEFAULT_READINESS_ATTEMPTS = 5;
const DEFAULT_READINESS_RETRY_MS = 750;
const HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const CANONICAL_ARC_RPC_URL = "https://rpc.testnet.arc.network";

const controllerAbi = parseAbi([
  "function owner() view returns (address)",
  "function releaseId() view returns (bytes32)",
  "function registrationsPaused() view returns (bool)",
  "function setRegistrationsPaused(bool paused)",
]);
const marketplaceAbi = parseAbi([
  "function owner() view returns (address)",
  "function paused() view returns (bool)",
  "function setPaused(bool paused)",
]);

const TRANSACTION_PLAN = Object.freeze([
  Object.freeze({
    id: "controllerPause",
    target: "controller",
    functionName: "setRegistrationsPaused",
    paused: true,
  }),
  Object.freeze({
    id: "controllerUnpause",
    target: "controller",
    functionName: "setRegistrationsPaused",
    paused: false,
  }),
  Object.freeze({
    id: "marketplacePause",
    target: "marketplace",
    functionName: "setPaused",
    paused: true,
  }),
  Object.freeze({
    id: "marketplaceUnpause",
    target: "marketplace",
    functionName: "setPaused",
    paused: false,
  }),
]);

const STEP_STATES = Object.freeze({
  controllerPause: Object.freeze({
    before: Object.freeze({ controller: false, marketplace: false }),
    after: Object.freeze({ controller: true, marketplace: false }),
  }),
  controllerUnpause: Object.freeze({
    before: Object.freeze({ controller: true, marketplace: false }),
    after: Object.freeze({ controller: false, marketplace: false }),
  }),
  marketplacePause: Object.freeze({
    before: Object.freeze({ controller: false, marketplace: false }),
    after: Object.freeze({ controller: false, marketplace: true }),
  }),
  marketplaceUnpause: Object.freeze({
    before: Object.freeze({ controller: false, marketplace: true }),
    after: Object.freeze({ controller: false, marketplace: false }),
  }),
});

export class OperationsDrillError extends Error {
  constructor(message, options = {}) {
    super(`operations drill failed: ${message}`);
    this.name = "OperationsDrillError";
    this.rollback = options.rollback ?? null;
  }
}

function fail(message) {
  throw new OperationsDrillError(message);
}

function address(value, field) {
  try {
    return getAddress(value);
  } catch {
    fail(`${field} is not a valid address`);
  }
}

function sameAddress(left, right) {
  return address(left, "address").toLowerCase() === address(right, "address").toLowerCase();
}

function canonicalManifest(manifestValue, { requireActive = false } = {}) {
  let manifest;
  try {
    manifest = parseDeploymentManifest(structuredClone(manifestValue));
  } catch {
    fail("manifest is not structurally valid");
  }
  if (
    manifest.chain.id !== ARC_TESTNET_CHAIN_ID || manifest.testnet !== true ||
    manifest.chain.caip2 !== `eip155:${ARC_TESTNET_CHAIN_ID}`
  ) fail("manifest is not bound to Arc Testnet");
  if (registrarVersionOf(manifest) !== "v2") {
    fail("operations drill requires the canonical V2 cutover manifest");
  }
  if (
    !manifest.releaseId ||
    !manifest.activationEvidence.governance.account ||
    !manifest.contracts.controller.address ||
    !manifest.contracts.controller.runtimeCodeHash ||
    !manifest.contracts.marketplace.address ||
    !manifest.contracts.marketplace.runtimeCodeHash
  ) fail("canonical V2 execution identity is incomplete");
  if (requireActive && (
    manifest.state !== "active" || manifest.activationEvidence.productLive !== false ||
    !Number.isSafeInteger(manifest.activationEvidence.verifiedAtBlock) ||
    manifest.activationEvidence.verifiedAtBlock <= 0 ||
    manifest.activationEvidence.controllerPolicy.registrationsPaused !== false ||
    manifest.activationEvidence.marketplacePolicy.paused !== false ||
    manifest.permitIssuer.active !== true
  )) fail("broadcast requires an active, non-public, unpaused candidate manifest");
  return manifest;
}

function promotionTargetPair(candidate, target) {
  try {
    return validatePromotionTargetPair(candidate, target);
  } catch (error) {
    fail(error instanceof Error ? error.message : "promotion target validation failed");
  }
}

function promotionTargetAtHead(target, head) {
  try {
    return assertPromotionTargetAtHead(target, head);
  } catch (error) {
    fail(error instanceof Error ? error.message : "promotion target head validation failed");
  }
}

function targetFor(manifest, target) {
  return target === "controller"
    ? getAddress(manifest.contracts.controller.address)
    : getAddress(manifest.contracts.marketplace.address);
}

function assertSafeHttpsUrl(value, field) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} is not a valid URL`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" || url.username || url.password || url.hash ||
    (url.port && url.port !== "443") || !hostname || isIP(hostname) !== 0 ||
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")
  ) fail(`${field} must be credential-free public HTTPS`);
  return url;
}

function ipv4Octets(value) {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => Number(part));
  if (octets.some((octet, index) => (
    !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index]
  ))) return null;
  return octets;
}

function ipv6Integer(value) {
  if (value.includes("%")) return null;
  let normalized = value.toLowerCase();
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const octets = ipv4Octets(normalized.slice(separator + 1));
    if (separator < 0 || !octets) return null;
    normalized = `${normalized.slice(0, separator)}:${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && left.length + right.length >= 8) return null;
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) | BigInt(`0x${group}`), 0n);
}

function hasIpv6Prefix(value, base, prefixLength) {
  const shift = 128n - BigInt(prefixLength);
  return (value >> shift) === (base >> shift);
}

function isPublicIpv4(value) {
  const octets = ipv4Octets(value);
  if (!octets) return false;
  const [first, second, third] = octets;
  return !(
    first === 0 || first === 10 || first === 127 || first >= 224 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 0 && third === 0) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 192 && second === 168) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113)
  );
}

/** Returns true only for globally routable DNS answers suitable for credentialed HTTPS. */
export function isPublicDnsAddress(value) {
  const family = typeof value === "string" ? isIP(value) : 0;
  if (family === 4) return isPublicIpv4(value);
  if (family !== 6) return false;
  const parsed = ipv6Integer(value);
  if (parsed === null) return false;
  const mappedIpv4Prefix = 0xffffn;
  if ((parsed >> 32n) === mappedIpv4Prefix) {
    const ipv4 = Number(parsed & 0xffff_ffffn);
    return isPublicIpv4([
      (ipv4 >>> 24) & 255,
      (ipv4 >>> 16) & 255,
      (ipv4 >>> 8) & 255,
      ipv4 & 255,
    ].join("."));
  }
  const globalUnicast = hasIpv6Prefix(parsed, ipv6Integer("2000::"), 3);
  const reserved =
    hasIpv6Prefix(parsed, ipv6Integer("2001::"), 23) ||
    hasIpv6Prefix(parsed, ipv6Integer("2001:db8::"), 32) ||
    hasIpv6Prefix(parsed, ipv6Integer("2002::"), 16) ||
    hasIpv6Prefix(parsed, ipv6Integer("3fff::"), 20);
  return globalUnicast && !reserved;
}

export async function assertPublicDnsResolution(urlValue, dnsLookup = lookup, field = "candidate") {
  if (typeof dnsLookup !== "function") fail("DNS lookup dependency is required");
  const url = urlValue instanceof URL ? urlValue : assertSafeHttpsUrl(urlValue, `${field} URL`);
  let answers;
  try {
    answers = await dnsLookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw controlledExternalFailure(`${field} DNS resolution failed`);
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw controlledExternalFailure(`${field} DNS resolution returned no addresses`);
  }
  for (const answer of answers) {
    const resolvedAddress = typeof answer === "string" ? answer : answer?.address;
    if (!isPublicDnsAddress(resolvedAddress)) {
      throw controlledExternalFailure(`${field} DNS resolution returned a private or reserved address`);
    }
  }
  return Object.freeze(answers.map((answer) => typeof answer === "string" ? answer : answer.address));
}

function candidateEndpoints(candidateUrl, registrationUrl, marketplaceUrl) {
  const candidate = assertSafeHttpsUrl(candidateUrl, "candidate URL");
  candidate.pathname = candidate.pathname.endsWith("/") ? candidate.pathname : `${candidate.pathname}/`;
  candidate.search = "";
  const registration = assertSafeHttpsUrl(
    registrationUrl ?? new URL("/api/registration/readiness", candidate).href,
    "registration readiness URL",
  );
  const marketplace = assertSafeHttpsUrl(
    marketplaceUrl ?? new URL("/api/marketplace/readiness", candidate).href,
    "marketplace readiness URL",
  );
  if (registration.origin !== candidate.origin || marketplace.origin !== candidate.origin) {
    fail("candidate readiness URLs must use the candidate origin");
  }
  if (registration.search || marketplace.search) {
    fail("candidate readiness URLs must not contain query parameters");
  }
  return {
    origin: candidate.origin,
    registration: registration.href,
    marketplace: marketplace.href,
  };
}

function assertBasicAuthorization(value) {
  if (typeof value !== "string" || !/^Basic [A-Za-z0-9+/]+={0,2}$/.test(value)) {
    fail("candidate Basic authorization is required for broadcast");
  }
  return value;
}

function safePositiveInteger(value, field) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number <= 0) fail(`${field} is not a positive safe integer`);
  return number;
}

function controlledExternalFailure(message) {
  return new OperationsDrillError(message);
}

async function boundedText(response, field) {
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength && Number(contentLength) > MAX_HTTP_BODY_BYTES) {
    throw controlledExternalFailure(`${field} response exceeded the size limit`);
  }
  let text;
  try {
    text = await response.text();
  } catch {
    throw controlledExternalFailure(`${field} response could not be read`);
  }
  if (new TextEncoder().encode(text).byteLength > MAX_HTTP_BODY_BYTES) {
    throw controlledExternalFailure(`${field} response exceeded the size limit`);
  }
  return text;
}

async function fetchWithoutRedirect(fetcher, url, init, field) {
  let response;
  try {
    response = await fetcher(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: init?.signal ?? AbortSignal.timeout(10_000),
    });
  } catch {
    throw controlledExternalFailure(`${field} request failed`);
  }
  if (!response || typeof response.status !== "number" || response.redirected === true) {
    throw controlledExternalFailure(`${field} returned an invalid or redirected response`);
  }
  return response;
}

async function readinessObservation({
  fetcher,
  url,
  authorization,
  candidateOrigin,
  dnsLookup,
  expectedReady,
  field,
  attempts,
  retryMs,
  sleep,
}) {
  const expectedStatus = expectedReady ? 200 : 503;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const requestUrl = assertSafeHttpsUrl(url, `${field} URL`);
    if (requestUrl.origin !== candidateOrigin) fail(`${field} URL escaped the candidate origin`);
    await assertPublicDnsResolution(requestUrl, dnsLookup, field);
    try {
      const response = await fetchWithoutRedirect(fetcher, requestUrl.href, {
        headers: {
          accept: "application/json",
          authorization,
        },
      }, field);
      const text = await boundedText(response, field);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (
        response.status === expectedStatus && body && typeof body === "object" &&
        !Array.isArray(body) && body.ready === expectedReady
      ) {
        return Object.freeze({ url, status: response.status, ready: body.ready });
      }
    } catch (error) {
      if (!(error instanceof OperationsDrillError)) {
        throw controlledExternalFailure(`${field} request failed`);
      }
    }
    if (attempt < attempts) await sleep(retryMs);
  }
  throw controlledExternalFailure(`${field} did not reach the required readiness state`);
}

function observationAssertion(id, observation) {
  const expected = `HTTP ${observation.status} and ready=${observation.ready}`;
  const actual = `url=${observation.url};status=${observation.status};ready=${observation.ready}`;
  if (actual.length > 512) fail(`${id} observation binding is too long for the run report`);
  return Object.freeze({
    id,
    verdict: "PASS",
    source: "http",
    expected,
    actual,
  });
}

async function guardedRead(client, request, failureMessage) {
  try {
    return await client.readContract(request);
  } catch {
    throw controlledExternalFailure(failureMessage);
  }
}

async function guardedCode(client, request, failureMessage) {
  try {
    return await client.getCode(request);
  } catch {
    throw controlledExternalFailure(failureMessage);
  }
}

function assertRuntimeCode(code, expectedHash, runtimeCodeHasher, field) {
  if (!code || code === "0x") fail(`${field} has no runtime code`);
  if (runtimeCodeHasher(code).toLowerCase() !== expectedHash.toLowerCase()) {
    fail(`${field} runtime bytecode hash mismatch`);
  }
}

/**
 * Re-binds both mutable V2 execution surfaces to the exact manifest identity at
 * one pinned block. The marketplace has no releaseId getter, so its immutable
 * runtime identity is paired with the controller releaseId at the same block.
 */
async function verifyV2ExecutionIdentityAtBlock({
  manifest,
  publicClient,
  account,
  blockNumber,
  runtimeCodeHasher,
  expectedControllerPaused,
  expectedMarketplacePaused,
  verifyGovernanceEoa = false,
}) {
  const controller = getAddress(manifest.contracts.controller.address);
  const marketplace = getAddress(manifest.contracts.marketplace.address);
  const governance = getAddress(manifest.activationEvidence.governance.account);
  const [controllerCode, marketplaceCode, governanceCode] = await Promise.all([
    guardedCode(
      publicClient,
      { address: controller, blockNumber },
      "V2 controller runtime guard could not be read",
    ),
    guardedCode(
      publicClient,
      { address: marketplace, blockNumber },
      "V2 marketplace runtime guard could not be read",
    ),
    verifyGovernanceEoa
      ? guardedCode(
          publicClient,
          { address: governance, blockNumber },
          "V2 governance code guard could not be read",
        )
      : Promise.resolve("0x"),
  ]);
  assertRuntimeCode(
    controllerCode,
    manifest.contracts.controller.runtimeCodeHash,
    runtimeCodeHasher,
    "V2 controller",
  );
  assertRuntimeCode(
    marketplaceCode,
    manifest.contracts.marketplace.runtimeCodeHash,
    runtimeCodeHasher,
    "V2 marketplace",
  );
  if (verifyGovernanceEoa && governanceCode && governanceCode !== "0x") {
    fail("governance account is not an EOA");
  }

  const [controllerOwner, marketplaceOwner, onchainRelease, controllerPaused, marketplacePaused] =
    await Promise.all([
      guardedRead(publicClient, {
        address: controller,
        abi: controllerAbi,
        functionName: "owner",
        blockNumber,
      }, "V2 controller owner guard could not be read"),
      guardedRead(publicClient, {
        address: marketplace,
        abi: marketplaceAbi,
        functionName: "owner",
        blockNumber,
      }, "V2 marketplace owner guard could not be read"),
      guardedRead(publicClient, {
        address: controller,
        abi: controllerAbi,
        functionName: "releaseId",
        blockNumber,
      }, "V2 controller release guard could not be read"),
      guardedRead(publicClient, {
        address: controller,
        abi: controllerAbi,
        functionName: "registrationsPaused",
        blockNumber,
      }, "V2 controller pause guard could not be read"),
      guardedRead(publicClient, {
        address: marketplace,
        abi: marketplaceAbi,
        functionName: "paused",
        blockNumber,
      }, "V2 marketplace pause guard could not be read"),
    ]);
  if (!sameAddress(controllerOwner, governance) || !sameAddress(marketplaceOwner, governance)) {
    fail("governance account does not own both manifest V2 targets");
  }
  if (!sameAddress(account.address, governance)) {
    fail("governance key does not match the manifest governance account");
  }
  if (onchainRelease?.toLowerCase() !== manifest.releaseId.toLowerCase()) {
    fail("V2 controller release ID does not match the manifest");
  }
  if (
    typeof expectedControllerPaused === "boolean" &&
    controllerPaused !== expectedControllerPaused
  ) fail("V2 controller pause state does not match the exact drill step");
  if (
    typeof expectedMarketplacePaused === "boolean" &&
    marketplacePaused !== expectedMarketplacePaused
  ) fail("V2 marketplace pause state does not match the exact drill step");
  return Object.freeze({ controllerPaused, marketplacePaused });
}

/**
 * The drill must never consume the V1 escape hatch. It verifies the complete
 * retained runtime suite plus the cutover policy at the same block used for
 * the V2 identity, and all writes continue to target only V2 addresses.
 */
async function verifyRetainedV1AtBlock({
  manifest,
  publicClient,
  blockNumber,
  runtimeCodeHasher,
}) {
  const legacy = manifest.legacyReleases[0];
  if (blockNumber < BigInt(legacy.verifiedAtBlock)) {
    fail("retained V1 verification block is ahead of the drill block");
  }
  await Promise.all(CONTRACT_KEYS.map(async (key) => {
    const deployment = legacy.contracts[key];
    const code = await guardedCode(
      publicClient,
      { address: getAddress(deployment.address), blockNumber },
      `retained V1 ${key} runtime guard could not be read`,
    );
    assertRuntimeCode(
      code,
      deployment.runtimeCodeHash,
      runtimeCodeHasher,
      `retained V1 ${key}`,
    );
  }));
  const controller = getAddress(legacy.contracts.controller.address);
  const marketplace = getAddress(legacy.contracts.marketplace.address);
  const [releaseId, registrationsPaused, marketplacePaused] = await Promise.all([
    guardedRead(publicClient, {
      address: controller,
      abi: controllerAbi,
      functionName: "releaseId",
      blockNumber,
    }, "retained V1 controller release guard could not be read"),
    guardedRead(publicClient, {
      address: controller,
      abi: controllerAbi,
      functionName: "registrationsPaused",
      blockNumber,
    }, "retained V1 registration cutover guard could not be read"),
    guardedRead(publicClient, {
      address: marketplace,
      abi: marketplaceAbi,
      functionName: "paused",
      blockNumber,
    }, "retained V1 marketplace escape guard could not be read"),
  ]);
  if (releaseId?.toLowerCase() !== legacy.releaseId.toLowerCase()) {
    fail("retained V1 controller release ID does not match the manifest reference");
  }
  if (registrationsPaused !== true) {
    fail("retained V1 registrations must remain paused during the V2 drill");
  }
  if (marketplacePaused !== false) {
    fail("retained V1 marketplace escape paths must remain open during the V2 drill");
  }
}

async function verifyExactReleaseAtBlock(options) {
  const [v2State] = await Promise.all([
    verifyV2ExecutionIdentityAtBlock(options),
    verifyRetainedV1AtBlock(options),
  ]);
  return v2State;
}

async function verifyLiveGuards({
  manifest,
  publicClient,
  account,
  confirmedReleaseId,
  runtimeCodeHasher,
}) {
  if (confirmedReleaseId?.toLowerCase() !== manifest.releaseId.toLowerCase()) {
    fail("--confirm-release must exactly match the manifest V2 release ID");
  }
  let chainId;
  try {
    chainId = await publicClient.getChainId();
  } catch {
    throw controlledExternalFailure("Arc chain ID could not be read");
  }
  if (chainId !== ARC_TESTNET_CHAIN_ID) fail("RPC chain ID is not Arc Testnet");
  let head;
  try {
    head = safePositiveInteger(await publicClient.getBlockNumber(), "Arc head block");
  } catch (error) {
    if (error instanceof OperationsDrillError) throw error;
    throw controlledExternalFailure("Arc head block could not be read");
  }
  if (head < manifest.activationEvidence.verifiedAtBlock) {
    fail("Arc head predates the manifest verification block");
  }
  await verifyExactReleaseAtBlock({
    manifest,
    publicClient,
    account,
    blockNumber: BigInt(head),
    runtimeCodeHasher,
    expectedControllerPaused: false,
    expectedMarketplacePaused: false,
    verifyGovernanceEoa: true,
  });
  return head;
}

async function executePauseTransaction({
  manifest,
  publicClient,
  walletClient,
  account,
  step,
  runtimeCodeHasher,
}) {
  const address = targetFor(manifest, step.target);
  const abi = step.target === "controller" ? controllerAbi : marketplaceAbi;
  const expected = STEP_STATES[step.id];
  if (!expected) fail(`${step.id} is not part of the exact V2 drill plan`);
  let preBlock;
  try {
    preBlock = safePositiveInteger(
      await publicClient.getBlockNumber(),
      `${step.id} preflight block`,
    );
  } catch (error) {
    if (error instanceof OperationsDrillError) throw error;
    throw controlledExternalFailure(`${step.id} preflight block could not be read`);
  }
  await verifyExactReleaseAtBlock({
    manifest,
    publicClient,
    account,
    blockNumber: BigInt(preBlock),
    runtimeCodeHasher,
    expectedControllerPaused: expected.before.controller,
    expectedMarketplacePaused: expected.before.marketplace,
  });
  let hash;
  try {
    hash = await walletClient.writeContract({
      account,
      address,
      abi,
      functionName: step.functionName,
      args: [step.paused],
    });
  } catch {
    throw controlledExternalFailure(`${step.id} transaction submission failed`);
  }
  if (!HASH_PATTERN.test(hash ?? "")) {
    throw controlledExternalFailure(`${step.id} returned an invalid transaction hash`);
  }
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({
      hash,
      confirmations: manifest.chain.confirmations,
    });
  } catch {
    throw controlledExternalFailure(`${step.id} receipt was not confirmed`);
  }
  if (
    receipt?.status !== "success" ||
    receipt.transactionHash?.toLowerCase() !== hash.toLowerCase() ||
    !receipt.to || !receipt.from ||
    !sameAddress(receipt.to, address) || !sameAddress(receipt.from, account.address)
  ) throw controlledExternalFailure(`${step.id} receipt identity or status mismatch`);
  const blockNumber = safePositiveInteger(receipt.blockNumber, `${step.id} receipt block`);
  if (blockNumber < preBlock) {
    throw controlledExternalFailure(`${step.id} receipt predates its exact identity guard`);
  }
  await verifyExactReleaseAtBlock({
    manifest,
    publicClient,
    account,
    blockNumber: BigInt(blockNumber),
    runtimeCodeHasher,
    expectedControllerPaused: expected.after.controller,
    expectedMarketplacePaused: expected.after.marketplace,
  });
  return Object.freeze({
    id: step.id,
    hash,
    blockNumber,
    from: getAddress(receipt.from),
    to: getAddress(receipt.to),
  });
}

async function failSafeRepause({
  manifest,
  publicClient,
  walletClient,
  account,
  runtimeCodeHasher,
}) {
  const outcomes = [];
  for (const target of ["controller", "marketplace"]) {
    const address = targetFor(manifest, target);
    const abi = target === "controller" ? controllerAbi : marketplaceAbi;
    const writeFunction = target === "controller" ? "setRegistrationsPaused" : "setPaused";
    let pinnedBlock;
    let state;
    try {
      pinnedBlock = safePositiveInteger(
        await publicClient.getBlockNumber(),
        `${target} rollback guard block`,
      );
      state = await verifyExactReleaseAtBlock({
        manifest,
        publicClient,
        account,
        blockNumber: BigInt(pinnedBlock),
        runtimeCodeHasher,
      });
    } catch {
      outcomes.push(Object.freeze({ target, paused: false, attempted: false, confirmed: false }));
      continue;
    }
    const paused = target === "controller"
      ? state.controllerPaused
      : state.marketplacePaused;
    if (paused === true) {
      outcomes.push(Object.freeze({ target, paused: true, attempted: false, confirmed: true }));
      continue;
    }
    try {
      const hash = await walletClient.writeContract({
        account,
        address,
        abi,
        functionName: writeFunction,
        args: [true],
      });
      if (!HASH_PATTERN.test(hash ?? "")) throw new Error("invalid hash");
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        confirmations: manifest.chain.confirmations,
      });
      if (
        receipt?.status !== "success" ||
        receipt.transactionHash?.toLowerCase() !== hash.toLowerCase() ||
        !receipt.to || !receipt.from ||
        !sameAddress(receipt.to, address) ||
        !sameAddress(receipt.from, account.address)
      ) throw new Error("rollback receipt mismatch");
      const receiptBlock = safePositiveInteger(receipt.blockNumber, `${target} rollback receipt block`);
      if (receiptBlock < pinnedBlock) throw new Error("rollback receipt predates guard");
      const confirmedState = await verifyExactReleaseAtBlock({
        manifest,
        publicClient,
        account,
        blockNumber: BigInt(receiptBlock),
        runtimeCodeHasher,
        expectedControllerPaused: target === "controller" ? true : state.controllerPaused,
        expectedMarketplacePaused: target === "marketplace" ? true : state.marketplacePaused,
      });
      const confirmed = target === "controller"
        ? confirmedState.controllerPaused === true
        : confirmedState.marketplacePaused === true;
      outcomes.push(Object.freeze({ target, paused: confirmed, attempted: true, confirmed }));
    } catch {
      outcomes.push(Object.freeze({ target, paused: false, attempted: true, confirmed: false }));
    }
  }
  return Object.freeze(outcomes);
}

function rollbackRepausedAssertion() {
  return Object.freeze({
    id: "rollbackRepaused",
    verdict: "PASS",
    source: "receipt",
    expected: "both execution surfaces were paused before explicit recovery",
    actual: "controllerPause=success;marketplacePause=success",
  });
}

export function buildOperationsDrillPlan(manifestValue, targetManifestValue) {
  const manifest = canonicalManifest(manifestValue);
  const promotion = targetManifestValue === undefined
    ? null
    : promotionTargetPair(manifest, targetManifestValue);
  return Object.freeze({
    schemaVersion: "1.0.0",
    mode: "DRY_RUN",
    chainId: ARC_TESTNET_CHAIN_ID,
    releaseId: manifest.releaseId,
    promotionTargetExplicit: promotion !== null,
    promotionSubjectSha256: promotion?.promotionSubjectSha256 ?? null,
    verifiedAtBlock: promotion?.targetVerifiedAtBlock ?? null,
    governance: getAddress(manifest.activationEvidence.governance.account),
    targets: Object.freeze({
      controller: getAddress(manifest.contracts.controller.address),
      marketplace: getAddress(manifest.contracts.marketplace.address),
    }),
    runtimeCodeHashes: Object.freeze({
      controller: manifest.contracts.controller.runtimeCodeHash,
      marketplace: manifest.contracts.marketplace.runtimeCodeHash,
    }),
    retainedV1: Object.freeze({
      releaseId: manifest.legacyReleases[0].releaseId,
      controller: getAddress(manifest.legacyReleases[0].contracts.controller.address),
      marketplace: getAddress(manifest.legacyReleases[0].contracts.marketplace.address),
      registrationsPaused: true,
      marketplacePaused: false,
      mutatedByDrill: false,
    }),
    transactions: TRANSACTION_PLAN.map((step) => Object.freeze({ ...step })),
    safety: Object.freeze({
      broadcasts: false,
      destructiveSignerChanges: false,
      failSafeRepauseOnError: true,
      requiresExplicitBroadcastAndReleaseConfirmation: true,
      receiptBoundPassReport: true,
    }),
  });
}

export async function runOperationsDrill({
  manifestValue,
  targetManifestValue,
  confirmedReleaseId,
  account,
  publicClient,
  walletClient,
  fetcher = fetch,
  dnsLookup = lookup,
  runtimeCodeHasher = keccak256,
  candidateUrl,
  registrationReadinessUrl,
  marketplaceReadinessUrl,
  candidateAuthorization,
  readinessAttempts = DEFAULT_READINESS_ATTEMPTS,
  readinessRetryMs = DEFAULT_READINESS_RETRY_MS,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
  now = () => new Date(),
}) {
  const manifest = canonicalManifest(manifestValue, { requireActive: true });
  const promotion = promotionTargetPair(manifest, targetManifestValue);
  const promotionTarget = promotion.target;
  if (!account || typeof account.address !== "string") fail("governance account is required");
  if (
    !publicClient || !walletClient || typeof fetcher !== "function" ||
    typeof dnsLookup !== "function" || typeof runtimeCodeHasher !== "function"
  ) {
    fail("public client, wallet client, fetcher, DNS lookup, and runtime code hasher are required");
  }
  if (!Number.isSafeInteger(readinessAttempts) || readinessAttempts <= 0 || readinessAttempts > 20) {
    fail("readiness attempts must be between 1 and 20");
  }
  if (!Number.isSafeInteger(readinessRetryMs) || readinessRetryMs < 0 || readinessRetryMs > 10_000) {
    fail("readiness retry delay is outside the safe range");
  }
  const endpoints = candidateEndpoints(
    candidateUrl,
    registrationReadinessUrl,
    marketplaceReadinessUrl,
  );
  const issuerUrl = assertSafeHttpsUrl(manifest.permitIssuer.url, "manifest permit issuer URL");
  if (issuerUrl.origin !== endpoints.origin) {
    fail("candidate origin does not match the manifest permit issuer origin");
  }
  const authorization = assertBasicAuthorization(candidateAuthorization);

  let liveGuardsPassed = false;
  const transactions = [];
  const assertions = [];
  try {
    const preRunHead = await verifyLiveGuards({
      manifest,
      publicClient,
      account,
      confirmedReleaseId,
      runtimeCodeHasher,
    });
    promotionTargetAtHead(promotionTarget, preRunHead);
    liveGuardsPassed = true;

    await readinessObservation({
      fetcher,
      url: endpoints.registration,
      authorization,
      candidateOrigin: endpoints.origin,
      dnsLookup,
      expectedReady: true,
      field: "initial registration readiness",
      attempts: readinessAttempts,
      retryMs: readinessRetryMs,
      sleep,
    });
    await readinessObservation({
      fetcher,
      url: endpoints.marketplace,
      authorization,
      candidateOrigin: endpoints.origin,
      dnsLookup,
      expectedReady: true,
      field: "initial marketplace readiness",
      attempts: readinessAttempts,
      retryMs: readinessRetryMs,
      sleep,
    });

    const controllerPause = await executePauseTransaction({
      manifest,
      publicClient,
      walletClient,
      account,
      step: TRANSACTION_PLAN[0],
      runtimeCodeHasher,
    });
    transactions.push(controllerPause);
    const registrationClosed = await readinessObservation({
      fetcher,
      url: endpoints.registration,
      authorization,
      candidateOrigin: endpoints.origin,
      dnsLookup,
      expectedReady: false,
      field: "paused registration readiness",
      attempts: readinessAttempts,
      retryMs: readinessRetryMs,
      sleep,
    });
    assertions.push(observationAssertion("registrationReadinessClosed", registrationClosed));

    transactions.push(await executePauseTransaction({
      manifest,
      publicClient,
      walletClient,
      account,
      step: TRANSACTION_PLAN[1],
      runtimeCodeHasher,
    }));
    const registrationRecovered = await readinessObservation({
      fetcher,
      url: endpoints.registration,
      authorization,
      candidateOrigin: endpoints.origin,
      dnsLookup,
      expectedReady: true,
      field: "recovered registration readiness",
      attempts: readinessAttempts,
      retryMs: readinessRetryMs,
      sleep,
    });
    assertions.push(observationAssertion("registrationReadinessRecovered", registrationRecovered));

    const marketplacePause = await executePauseTransaction({
      manifest,
      publicClient,
      walletClient,
      account,
      step: TRANSACTION_PLAN[2],
      runtimeCodeHasher,
    });
    transactions.push(marketplacePause);
    const marketplaceClosed = await readinessObservation({
      fetcher,
      url: endpoints.marketplace,
      authorization,
      candidateOrigin: endpoints.origin,
      dnsLookup,
      expectedReady: false,
      field: "paused marketplace readiness",
      attempts: readinessAttempts,
      retryMs: readinessRetryMs,
      sleep,
    });
    assertions.push(observationAssertion("marketplaceReadinessClosed", marketplaceClosed));

    transactions.push(await executePauseTransaction({
      manifest,
      publicClient,
      walletClient,
      account,
      step: TRANSACTION_PLAN[3],
      runtimeCodeHasher,
    }));
    const marketplaceRecovered = await readinessObservation({
      fetcher,
      url: endpoints.marketplace,
      authorization,
      candidateOrigin: endpoints.origin,
      dnsLookup,
      expectedReady: true,
      field: "recovered marketplace readiness",
      attempts: readinessAttempts,
      retryMs: readinessRetryMs,
      sleep,
    });
    assertions.push(observationAssertion("marketplaceReadinessRecovered", marketplaceRecovered));
    assertions.push(rollbackRepausedAssertion());
    let latestBlock;
    try {
      latestBlock = await publicClient.getBlockNumber();
    } catch {
      throw controlledExternalFailure("evidence block could not be read");
    }
    const observedHead = safePositiveInteger(latestBlock, "evidence block");
    await verifyExactReleaseAtBlock({
      manifest,
      publicClient,
      account,
      blockNumber: BigInt(observedHead),
      runtimeCodeHasher,
      expectedControllerPaused: false,
      expectedMarketplacePaused: false,
    });
    const latestReceiptBlock = Math.max(...transactions.map((transaction) => transaction.blockNumber));
    const earliestReceiptBlock = Math.min(...transactions.map((transaction) => transaction.blockNumber));
    if (
      observedHead < latestReceiptBlock ||
      earliestReceiptBlock <= promotion.targetVerifiedAtBlock
    ) fail("evidence block predates the verified release or drill receipts");
    // Bind the report to the last receipt rather than a moving chain head.
    const evidenceBlock = latestReceiptBlock;
    const generatedAt = now();
    if (!(generatedAt instanceof Date) || Number.isNaN(generatedAt.valueOf())) {
      fail("report clock returned an invalid date");
    }
    return Object.freeze({
      schemaVersion: "1.0.0",
      artifact: "operationsDrill",
      verdict: "PASS",
      chainId: ARC_TESTNET_CHAIN_ID,
      releaseId: promotionTarget.releaseId,
      promotionSubjectSha256: promotion.promotionSubjectSha256,
      verifiedAtBlock: promotion.targetVerifiedAtBlock,
      evidenceBlock,
      generatedAt: generatedAt.toISOString(),
      transactions: Object.freeze(transactions),
      assertions: Object.freeze(assertions),
      redactions: Object.freeze({
        privateKeys: false,
        challengeSecrets: false,
        walletSignatures: false,
        permitSignatures: false,
      }),
    });
  } catch (error) {
    const rollback = liveGuardsPassed
      ? await failSafeRepause({
          manifest,
          publicClient,
          walletClient,
          account,
          runtimeCodeHasher,
        })
      : null;
    const message = error instanceof OperationsDrillError
      ? error.message.replace(/^operations drill failed: /, "")
      : "unexpected execution failure";
    throw new OperationsDrillError(message, { rollback });
  }
}

function parseCli(arguments_) {
  const values = new Map();
  let broadcast = false;
  let help = false;
  const valueFlags = new Set([
    "--confirm-release",
    "--manifest",
    "--target-intent",
    "--candidate-url",
    "--registration-readiness-url",
    "--marketplace-readiness-url",
    "--output",
  ]);
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--broadcast") {
      if (broadcast) fail("--broadcast may be supplied only once");
      broadcast = true;
      continue;
    }
    if (argument === "--help") {
      help = true;
      continue;
    }
    if (!valueFlags.has(argument)) fail(`unknown argument: ${argument}`);
    if (values.has(argument) || !arguments_[index + 1] || arguments_[index + 1].startsWith("--")) {
      fail(`${argument} requires exactly one value`);
    }
    values.set(argument, arguments_[index + 1]);
    index += 1;
  }
  return { broadcast, help, values };
}

export function operationsDrillUsage() {
  return [
    "Dry-run (default; no RPC writes):",
    "  node scripts/run-operations-drill.mjs [--manifest <candidate.json>]",
    "    [--target-intent <promotion-target-intent.json>]",
    "",
    "Broadcast (operator-only; writes a receipt-bound PASS report):",
    "  node scripts/run-operations-drill.mjs --broadcast",
    "    --manifest <active-candidate.json>",
    "    --target-intent <promotion-target-intent.json>",
    "    --confirm-release <bytes32-release-id>",
    "    --candidate-url <https-url>",
    "    --output <new-pass-report.json>",
    "",
    "A dry run binds no promotion subject unless --target-intent is explicit.",
    "",
    "Broadcast environment (never printed): PRIVATE_KEY, ARC_RPC_URL,",
    "PROMOTION_CANDIDATE_INGRESS_USERNAME, PROMOTION_CANDIDATE_INGRESS_PASSWORD.",
  ].join("\n");
}

function basicAuthorization(username, password) {
  if (
    typeof username !== "string" || username.length === 0 || username.includes(":") ||
    /[\r\n\0]/.test(username) || typeof password !== "string" || password.length === 0 ||
    /[\r\n\0]/.test(password)
  ) fail("candidate Basic credentials are incomplete or malformed");
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

async function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(`${operationsDrillUsage()}\n`);
    return;
  }
  const manifestPath = resolve(cli.values.get("--manifest") ?? "deployments/5042002.json");
  let manifestValue;
  try {
    manifestValue = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch {
    fail("manifest file could not be read as JSON");
  }
  const targetManifestPath = cli.values.get("--target-intent");
  let targetManifestValue;
  if (targetManifestPath) {
    try {
      targetManifestValue = JSON.parse(await readFile(resolve(targetManifestPath), "utf8"));
    } catch {
      fail("promotion target intent file could not be read as JSON");
    }
  }
  if (!cli.broadcast) {
    const forbidden = [...cli.values.keys()].filter(
      (key) => key !== "--manifest" && key !== "--target-intent",
    );
    if (forbidden.length > 0) fail("execution arguments require explicit --broadcast");
    process.stdout.write(`${JSON.stringify(buildOperationsDrillPlan(manifestValue, targetManifestValue), null, 2)}\n`);
    return;
  }
  const manifest = canonicalManifest(manifestValue, { requireActive: true });
  const configuredRpcUrl = process.env.ARC_RPC_URL?.trim();
  if (
    manifest.chain.rpcUrl !== CANONICAL_ARC_RPC_URL ||
    (configuredRpcUrl && configuredRpcUrl !== CANONICAL_ARC_RPC_URL)
  ) fail(`ARC_RPC_URL must exactly equal ${CANONICAL_ARC_RPC_URL}`);
  const rpcUrl = CANONICAL_ARC_RPC_URL;
  const chain = {
    id: ARC_TESTNET_CHAIN_ID,
    name: "Arc Testnet",
    nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  };
  const transport = rateLimitedArcHttp(rpcUrl);
  const publicClient = createPublicClient({
    chain,
    transport,
    batch: { multicall: { wait: 25 } },
  });
  const required = ["--confirm-release", "--target-intent", "--candidate-url", "--output"];
  for (const flag of required) {
    if (!cli.values.get(flag)) fail(`${flag} is required with --broadcast`);
  }
  let privateKey;
  try { privateKey = normalizeOperatorPrivateKey(process.env.PRIVATE_KEY); }
  catch { fail("PRIVATE_KEY is missing or malformed"); }
  const account = privateKeyToAccount(privateKey);
  const authorization = basicAuthorization(
    process.env.PROMOTION_CANDIDATE_INGRESS_USERNAME,
    process.env.PROMOTION_CANDIDATE_INGRESS_PASSWORD,
  );
  const report = await runOperationsDrill({
    manifestValue: manifest,
    targetManifestValue,
    confirmedReleaseId: cli.values.get("--confirm-release"),
    account,
    publicClient,
    walletClient: createWalletClient({ account, chain, transport }),
    candidateUrl: cli.values.get("--candidate-url"),
    registrationReadinessUrl: cli.values.get("--registration-readiness-url"),
    marketplaceReadinessUrl: cli.values.get("--marketplace-readiness-url"),
    candidateAuthorization: authorization,
  });
  const output = resolve(cli.values.get("--output"));
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  process.stdout.write(`${JSON.stringify({
    output,
    artifact: report.artifact,
    verdict: report.verdict,
    chainId: report.chainId,
    releaseId: report.releaseId,
    evidenceBlock: report.evidenceBlock,
    transactions: report.transactions.map(({ id, hash }) => ({ id, hash })),
  })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const safeMessage = error instanceof OperationsDrillError
      ? error.message
      : "operations drill failed safely";
    const rollback = error instanceof OperationsDrillError && Array.isArray(error.rollback)
      ? {
          attempted: true,
          confirmed: error.rollback.every((item) => item.confirmed === true),
          targets: error.rollback.map((item) => ({
            target: item.target,
            attempted: item.attempted,
            confirmed: item.confirmed,
          })),
        }
      : null;
    process.stderr.write(`${JSON.stringify({ error: safeMessage, rollback })}\n`);
    process.exitCode = 1;
  });
}
