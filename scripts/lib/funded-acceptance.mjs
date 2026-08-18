import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  verifyTypedData,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet } from "viem/chains";
import {
  ARC_TESTNET_CHAIN_ID,
  deploymentManifestDigest,
  ERC721_METADATA_INTERFACE_ID,
  EXPECTED_RESOLVER_CAPABILITIES,
  parseDeploymentManifest,
  promotionSubjectDigest,
  registrarVersionOf,
  requireActivatedContract,
} from "../../packages/config/dist/index.js";
import { deriveNameIdentity } from "../../packages/normalization/dist/index.js";
import {
  baseRegistrarAbi,
  controllerAbi,
  erc20Abi,
  marketplaceAbi,
  publicResolverAbi,
  registrationPermitDomain,
  registrationPermitTypes,
  registryAbi,
  resolverDataHash,
} from "../../packages/sdk/dist/index.js";
import {
  assertPromotionTargetAtHead,
  validatePromotionTargetPair,
} from "./promotion-target.mjs";
import { rateLimitedArcHttp } from "./arc-rpc-transport.mjs";
import { normalizeOperatorPrivateKey } from "./operator-key.mjs";
import {
  controllerOpenPredecessorFromMarketOpen,
  parseCanonicalRegistrationSmokeBytes,
  registrationSmokeBindingRecord,
  revalidateRegistrationSmokeEvidence,
  validateRegistrationSmokeLifecycle,
} from "./registration-smoke-evidence.mjs";

export const FUNDED_TRANSACTION_IDS = Object.freeze([
  "registrationUsdcApproval",
  "registration",
  "sellerNftApproval",
  "firstListing",
  "firstCancellation",
  "secondListing",
  "buyerUsdcApproval",
  "purchase",
  "sellerClaimProceeds",
  // ERC-721 token approval is cleared by purchase. A fresh buyer approval is
  // therefore an unavoidable transaction before buyerRelisting.
  "buyerNftApproval",
  "buyerRelisting",
  "buyerDirectTransfer",
  "listingInvalidation",
]);

export const FUNDED_ASSERTION_IDS = Object.freeze([
  "registrationPermitConsumed",
  "registrationNonceIncremented",
  "registrationSettlementExact",
  "registrarOwner",
  "registryOwner",
  "resolverAddress",
  "marketplacePurchase",
  "sellerProceedsClaimed",
  "marketplaceLiability",
  "marketplaceSolvent",
  "staleListingInvalidated",
]);

export const FUNDED_V2_METADATA_ASSERTION_IDS = Object.freeze([
  "erc721MetadataInterface",
  "nftTokenUri",
  "nftMetadataDocument",
  "nftImageDocument",
]);

export function fundedAssertionIdsForManifest(manifest) {
  return registrarVersionOf(manifest) === "v2"
    ? Object.freeze([...FUNDED_ASSERTION_IDS, ...FUNDED_V2_METADATA_ASSERTION_IDS])
    : FUNDED_ASSERTION_IDS;
}

const FUNDED_TRANSACTION_TARGET_KEYS = Object.freeze({
  registrationUsdcApproval: "settlement",
  registration: "controller",
  sellerNftApproval: "baseRegistrar",
  firstListing: "marketplace",
  firstCancellation: "marketplace",
  secondListing: "marketplace",
  buyerUsdcApproval: "settlement",
  purchase: "marketplace",
  sellerClaimProceeds: "marketplace",
  buyerNftApproval: "baseRegistrar",
  buyerRelisting: "marketplace",
  buyerDirectTransfer: "baseRegistrar",
  listingInvalidation: "marketplace",
});

const controllerInspectionAbi = parseAbi([
  "function registrationsPaused() view returns (bool)",
  "function permitSigner() view returns (address)",
  "function signerPolicyVersion() view returns (uint64)",
  "function releaseId() view returns (bytes32)",
  "function totalReferralLiability() view returns (uint256)",
  "event NameRegistered(string name, bytes32 indexed label, address indexed owner, uint256 baseCost, uint256 premium, uint256 expires)",
  "event PermitConsumed(bytes32 indexed permitId, address indexed requester, uint256 indexed nonce)",
]);

const marketInspectionAbi = parseAbi([
  "function paused() view returns (bool)",
  "function feeBps() view returns (uint16)",
  "function totalSellerLiability() view returns (uint256)",
  "function rawListingOf(uint256 tokenId) view returns (address seller, uint256 price, uint64 validUntil)",
  "function listingOf(uint256 tokenId) view returns (address seller, uint256 price, uint64 validUntil)",
  "function invalidateListing(uint256 tokenId) returns (bool invalidated)",
  "event Listed(uint256 indexed tokenId, address indexed seller, uint256 price, uint64 validUntil)",
  "event ListingCancelled(uint256 indexed tokenId, address indexed seller)",
  "event ListingInvalidated(uint256 indexed tokenId, address indexed formerSeller)",
  "event Purchased(uint256 indexed tokenId, address indexed seller, address indexed buyer, uint256 price, uint256 fee)",
  "event ProceedsClaimed(address indexed seller, uint256 amount)",
]);

const registrarInspectionAbi = parseAbi([
  "function transferFrom(address from, address to, uint256 tokenId)",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
  "event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)",
]);

const registrarMetadataInspectionAbi = parseAbi([
  "function supportsInterface(bytes4 interfaceId) view returns (bool)",
  "function tokenURI(uint256 tokenId) view returns (string)",
]);

const erc20InspectionAbi = parseAbi([
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_REPORT_KEYS = new Set([
  "privateKey",
  "challengeSecret",
  "challengeProof",
  "challengeSignature",
  "walletSignature",
  "permitSignature",
  "signature",
]);

function fail(message) {
  throw new Error(message);
}

function asBigInt(value, field) {
  try { return BigInt(value); }
  catch { fail(`${field} is not an integer`); }
}

function safePositiveBlockNumber(value, field) {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (
    !Number.isSafeInteger(number) || number <= 0 ||
    (typeof value === "bigint" && BigInt(number) !== value)
  ) fail(`${field} is not a positive safe integer`);
  return number;
}

function assertPreparedPermitWindow({ issuedAt, validAfter, validUntil, nowSeconds }) {
  const currentTime = BigInt(nowSeconds);
  if (
    issuedAt > currentTime + 5n || currentTime - issuedAt > 180n ||
    validAfter > issuedAt || issuedAt > validUntil ||
    issuedAt - validAfter > 5n || validUntil - validAfter > 300n ||
    validUntil - currentTime < 30n
  ) fail("prepared permit TTL mismatch");
}

function exactAddress(value, field) {
  if (typeof value !== "string" || !isAddress(value)) fail(`${field} is not an address`);
  return getAddress(value);
}

function requiredContract(manifest, key) {
  try { return requireActivatedContract(manifest, key); }
  catch { fail(`manifest contract ${key} is not active`); }
}

function canonicalUrl(value, field) {
  let url;
  try { url = new URL(value); }
  catch { fail(`${field} is not a URL`); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username || url.password || url.search || url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) fail(`${field} must be a credential-free HTTPS origin (HTTP is allowed only locally)`);
  return url.origin;
}

function normalizeIssuerUrl(value) {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function sortJson(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, sortJson(value[key])]),
  );
}

export function deterministicJson(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function assertSecretFreeReport(report, sensitiveValues = []) {
  const visit = (value, path = "report") => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (FORBIDDEN_REPORT_KEYS.has(key)) fail(`${path}.${key} is forbidden secret material`);
        visit(item, `${path}.${key}`);
      }
    }
  };
  visit(report);
  const serialized = JSON.stringify(report).toLowerCase();
  for (const value of sensitiveValues) {
    if (typeof value === "string" && value.length >= 16 && serialized.includes(value.toLowerCase())) {
      fail("run report contains sensitive material");
    }
  }
  return report;
}

function assertPrivateKey(value, field) {
  let normalized;
  try {
    normalized = normalizeOperatorPrivateKey(value, field);
  } catch {
    fail(`${field} must be a non-zero 32-byte private key`);
  }
  if (/^0x0{64}$/i.test(normalized)) fail(`${field} must be a non-zero 32-byte private key`);
  return normalized;
}

export function accountsFromEnvironment(env = process.env) {
  const sellerKey = assertPrivateKey(env.PRIVATE_KEY, "PRIVATE_KEY");
  const buyerKey = assertPrivateKey(env.E2E_BUYER_PRIVATE_KEY, "E2E_BUYER_PRIVATE_KEY");
  let seller;
  let buyer;
  try {
    seller = privateKeyToAccount(sellerKey);
    buyer = privateKeyToAccount(buyerKey);
  } catch {
    fail("funded acceptance wallet key is invalid");
  }
  if (getAddress(seller.address) === getAddress(buyer.address)) {
    fail("E2E_BUYER_PRIVATE_KEY must resolve to a wallet distinct from PRIVATE_KEY");
  }
  return { seller, buyer, sensitiveValues: [sellerKey, buyerKey] };
}

function assertManifestForCandidate(manifest, candidateOrigin) {
  if (manifest.chain.id !== ARC_TESTNET_CHAIN_ID || manifest.testnet !== true) {
    fail("funded acceptance is restricted to Arc Testnet chain 5042002");
  }
  if (manifest.state !== "active" || manifest.activationEvidence.productLive !== false) {
    fail("manifest must be an active private candidate with productLive=false");
  }
  if (!manifest.releaseId || !BYTES32_PATTERN.test(manifest.releaseId)) fail("manifest releaseId is missing");
  if (!Number.isSafeInteger(manifest.activationEvidence.verifiedAtBlock)) {
    fail("manifest verifiedAtBlock is required before funded acceptance");
  }
  if (!manifest.permitIssuer.active || !manifest.permitIssuer.url || !manifest.permitIssuer.signerAddress) {
    fail("manifest permit issuer is not active");
  }
  const expectedIssuer = new URL("/api/registration/issuer/", candidateOrigin).toString();
  if (normalizeIssuerUrl(manifest.permitIssuer.url) !== normalizeIssuerUrl(expectedIssuer)) {
    fail("manifest permit issuer is not bound to the explicit candidate origin");
  }
  if (
    manifest.activationEvidence.controllerPolicy.registrationsPaused !== false ||
    manifest.activationEvidence.marketplacePolicy.paused !== false
  ) fail("active candidate manifest pause policies must both be false");
  for (const [key, deployment] of Object.entries(manifest.contracts)) {
    if (!deployment?.address || deployment.sourceVerified !== true) {
      fail(`manifest contract ${key} is not source-verified and active`);
    }
  }
  for (const [key, expected] of Object.entries(EXPECTED_RESOLVER_CAPABILITIES)) {
    if (manifest.resolverCapabilities[key] !== expected) fail(`resolver capability ${key} mismatch`);
  }
}

export async function loadExplicitManifest(reference, fetcher = fetch) {
  if (typeof reference !== "string" || reference.trim() === "") fail("--manifest is required");
  let value;
  if (/^https?:\/\//i.test(reference)) {
    const response = await fetcher(reference, { headers: { accept: "application/json" } });
    if (!response?.ok) fail("explicit manifest could not be fetched");
    const text = await response.text();
    if (Buffer.byteLength(text) > 1_000_000) fail("explicit manifest response is too large");
    try { value = JSON.parse(text); }
    catch { fail("explicit manifest is not valid JSON"); }
  } else {
    let text;
    try { text = await readFile(reference, "utf8"); }
    catch { fail("explicit manifest file could not be read"); }
    try { value = JSON.parse(text); }
    catch { fail("explicit manifest is not valid JSON"); }
  }
  try { return parseDeploymentManifest(value); }
  catch { fail("explicit manifest failed canonical validation"); }
}

export async function createScopedCandidateFetcher({
  baseFetcher = fetch,
  candidateOrigin,
  basicAuthFile,
}) {
  if (!basicAuthFile) return baseFetcher;
  const origin = canonicalUrl(candidateOrigin, "--candidate-origin");
  let raw;
  try { raw = await readFile(basicAuthFile, "utf8"); }
  catch { fail("candidate Basic auth file could not be read"); }
  if (Buffer.byteLength(raw) > 4_096) fail("candidate Basic auth file is too large");
  const credential = raw.replace(/\r?\n$/, "");
  if (credential.includes("\n") || credential.includes("\r")) {
    fail("candidate Basic auth file must contain one username:password line");
  }
  const separator = credential.indexOf(":");
  const username = separator > 0 ? credential.slice(0, separator) : "";
  const password = separator > 0 ? credential.slice(separator + 1) : "";
  if (
    !username ||
    username.length > 256 ||
    username.includes(":") ||
    !/^[\u0021-\u007e]+$/.test(username) ||
    password.length < 32 ||
    password.length > 3_800 ||
    !/^[\u0020-\u007e]+$/.test(password)
  ) {
    fail("candidate Basic auth file must contain bounded printable ASCII credentials");
  }
  const authorization = `Basic ${Buffer.from(credential, "utf8").toString("base64")}`;
  let challenge;
  try {
    challenge = await baseFetcher(
      new URL("/api/registration/issuer/healthz", origin),
      {
        headers: { accept: "application/json,text/plain;q=0.9,*/*;q=0.1" },
        cache: "no-store",
        redirect: "manual",
      },
    );
  } catch {
    fail("candidate anonymous ingress challenge could not be verified");
  }
  const challengeHeader = challenge?.headers?.get?.("www-authenticate") ?? "";
  const cacheControl = challenge?.headers?.get?.("cache-control") ?? "";
  if (
    challenge?.status !== 401 ||
    !/^Basic(?:\s|$)/i.test(challengeHeader) ||
    !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl)
  ) {
    fail("candidate ingress must reject anonymous health requests with an uncacheable Basic challenge");
  }
  if (challenge.body) await challenge.body.cancel().catch(() => undefined);
  return async (input, init = {}) => {
    let url;
    try { url = new URL(input); }
    catch { fail("candidate request URL is invalid"); }
    if (url.origin !== origin) fail("candidate credentials cannot be sent outside the explicit origin");
    const headers = new Headers(init.headers);
    headers.set("authorization", authorization);
    // A credentialed candidate request must never follow a redirect to another
    // trust boundary. Callers treat the resulting 3xx as a failed request.
    return baseFetcher(input, { ...init, headers, redirect: "manual" });
  };
}

async function readJsonResponse(response, field) {
  if (!response || typeof response.text !== "function") fail(`${field} response is invalid`);
  const text = await response.text();
  if (Buffer.byteLength(text) > 1_000_000) fail(`${field} response is too large`);
  let body;
  try { body = JSON.parse(text); }
  catch { fail(`${field} did not return JSON`); }
  if (!response.ok) {
    const code = typeof body?.code === "string" ? ` (${body.code})` : "";
    fail(`${field} rejected the request${code}`);
  }
  return body;
}

async function getJson(fetcher, url, field) {
  let response;
  try { response = await fetcher(url, { headers: { accept: "application/json" }, cache: "no-store" }); }
  catch { fail(`${field} request failed`); }
  return readJsonResponse(response, field);
}

async function postJson(fetcher, url, body, field) {
  let response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body),
    });
  } catch {
    fail(`${field} request failed`);
  }
  return readJsonResponse(response, field);
}

function assertCandidateManifest(local, remote) {
  let parsed;
  try { parsed = parseDeploymentManifest(remote); }
  catch { fail("candidate /api/manifest failed canonical validation"); }
  if (deterministicJson(parsed) !== deterministicJson(local)) {
    fail("candidate /api/manifest does not exactly match the explicit manifest");
  }
}

function normalizeListing(value) {
  const seller = value?.seller ?? value?.[0];
  const price = value?.price ?? value?.[1];
  const validUntil = value?.validUntil ?? value?.[2];
  return {
    seller: exactAddress(seller, "listing seller"),
    price: asBigInt(price, "listing price"),
    validUntil: asBigInt(validUntil, "listing validUntil"),
  };
}

async function readAt(client, address, abi, functionName, args = [], blockNumber) {
  try {
    return await client.readContract({
      address,
      abi,
      functionName,
      args,
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
  } catch {
    fail(`Arc RPC read failed for ${functionName}`);
  }
}

async function snapshotMarket(client, manifest, tokenId, seller, blockNumber) {
  const market = requiredContract(manifest, "marketplace");
  const settlement = manifest.settlement.erc20Address;
  const [rawListing, liveListing, proceeds, liability, balance] = await Promise.all([
    readAt(client, market, marketInspectionAbi, "rawListingOf", [tokenId], blockNumber),
    readAt(client, market, marketInspectionAbi, "listingOf", [tokenId], blockNumber),
    readAt(client, market, marketplaceAbi, "proceeds", [seller], blockNumber),
    readAt(client, market, marketInspectionAbi, "totalSellerLiability", [], blockNumber),
    readAt(client, settlement, erc20Abi, "balanceOf", [market], blockNumber),
  ]);
  return {
    rawListing: normalizeListing(rawListing),
    liveListing: normalizeListing(liveListing),
    proceeds: asBigInt(proceeds, "market proceeds"),
    liability: asBigInt(liability, "market liability"),
    balance: asBigInt(balance, "market balance"),
  };
}

async function snapshotRegistration(client, manifest, identity, permitId, requester, blockNumber) {
  const controller = requiredContract(manifest, "controller");
  const registrar = requiredContract(manifest, "baseRegistrar");
  const registry = requiredContract(manifest, "registry");
  const resolver = requiredContract(manifest, "publicResolver");
  const settlement = manifest.settlement.erc20Address;
  const [usedPermit, nonce, registrarOwner, registryOwner, registryResolver, resolvedAddress, expiry, balance, liability] = await Promise.all([
    readAt(client, controller, controllerAbi, "usedPermit", [permitId], blockNumber),
    readAt(client, controller, controllerAbi, "nonces", [requester], blockNumber),
    readAt(client, registrar, baseRegistrarAbi, "ownerOf", [identity.tokenId], blockNumber),
    readAt(client, registry, registryAbi, "owner", [identity.namehash], blockNumber),
    readAt(client, registry, registryAbi, "resolver", [identity.namehash], blockNumber),
    readAt(client, resolver, publicResolverAbi, "addr", [identity.namehash], blockNumber),
    readAt(client, registrar, baseRegistrarAbi, "nameExpires", [identity.tokenId], blockNumber),
    readAt(client, settlement, erc20Abi, "balanceOf", [controller], blockNumber),
    readAt(client, controller, controllerInspectionAbi, "totalReferralLiability", [], blockNumber),
  ]);
  return {
    usedPermit: usedPermit === true,
    nonce: asBigInt(nonce, "registration nonce"),
    registrarOwner: exactAddress(registrarOwner, "registrar owner"),
    registryOwner: exactAddress(registryOwner, "registry owner"),
    registryResolver: exactAddress(registryResolver, "registry resolver"),
    resolvedAddress: exactAddress(resolvedAddress, "resolved address"),
    expiry: asBigInt(expiry, "registrar expiry"),
    balance: asBigInt(balance, "controller balance"),
    liability: asBigInt(liability, "controller liability"),
  };
}

function receiptTransaction(id, receipt) {
  if (
    receipt.status !== "success" || !TX_HASH_PATTERN.test(receipt.transactionHash ?? "") ||
    typeof receipt.blockNumber !== "bigint" || !receipt.to || !receipt.from
  ) fail(`${id} receipt is not a successful finalized transaction`);
  return {
    id,
    hash: receipt.transactionHash,
    blockNumber: safePositiveBlockNumber(receipt.blockNumber, `${id} receipt block`),
    from: exactAddress(receipt.from, `${id} receipt from`),
    to: exactAddress(receipt.to, `${id} receipt to`),
  };
}

function requireEvent(receipt, address, abi, eventName, predicate = () => true) {
  for (const log of receipt.logs ?? []) {
    if (!log.address || getAddress(log.address) !== getAddress(address)) continue;
    try {
      const decoded = decodeEventLog({ abi, data: log.data, topics: log.topics, strict: true });
      if (decoded.eventName === eventName && predicate(decoded.args)) return decoded.args;
    } catch {
      // A receipt contains logs from multiple contracts; unrelated topics are expected.
    }
  }
  fail(`expected ${eventName} event is missing`);
}

async function sendAndConfirm({ id, publicClient, walletClient, account, to, send, confirmations = 1 }) {
  let hash;
  try { hash = await send(); }
  catch { fail(`${id} transaction could not be submitted`); }
  if (!TX_HASH_PATTERN.test(hash ?? "")) fail(`${id} returned an invalid transaction hash`);
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash, confirmations, timeout: 180_000 });
  } catch {
    fail(`${id} transaction did not finalize successfully`);
  }
  const transaction = receiptTransaction(id, receipt);
  if (
    transaction.hash.toLowerCase() !== hash.toLowerCase() ||
    transaction.from !== getAddress(account.address) || transaction.to !== getAddress(to)
  ) {
    fail(`${id} receipt hash, sender, or target mismatch`);
  }
  return { receipt, transaction };
}

async function sendContract(input) {
  return sendAndConfirm({
    ...input,
    send: () => input.walletClient.writeContract({
      account: input.account,
      address: input.to,
      abi: input.abi,
      functionName: input.functionName,
      args: input.args ?? [],
    }),
  });
}

function expectEqual(actual, expected, field) {
  if (actual !== expected) fail(`${field} mismatch`);
}

function compactPairs(values) {
  return Object.entries(values).map(([key, value]) => `${key}=${String(value)}`).join(",");
}

function passAssertion(id, source, expected, actual) {
  const assertion = { id, verdict: "PASS", source, expected, actual };
  if (expected.length > 512 || actual.length > 512) fail(`${id} assertion is too large`);
  return assertion;
}

function exactJsonKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be a JSON object`);
  }
  const actual = Object.keys(value).sort();
  const required = [...expected].sort();
  if (actual.join(",") !== required.join(",")) fail(`${field} has unexpected fields`);
}

function requiredResponseHeader(response, name, field) {
  if (!response?.headers || typeof response.headers.get !== "function") {
    fail(`${field} response headers are unavailable`);
  }
  const value = response.headers.get(name);
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} response is missing ${name}`);
  }
  return value;
}

const COLLECTIBLE_RETRY_DELAYS_MS = Object.freeze([250, 750, 1_500, 3_000]);
const TRANSIENT_COLLECTIBLE_STATUSES = new Set([404, 408, 425, 429, 500, 502, 503, 504]);

function waitForRetry(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchCandidateText(fetcher, url, accept, field) {
  for (let attempt = 0; attempt <= COLLECTIBLE_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await waitForRetry(COLLECTIBLE_RETRY_DELAYS_MS[attempt - 1]);

    let response;
    try {
      response = await fetcher(url, {
        headers: { accept },
        cache: "no-store",
        redirect: "error",
      });
    } catch {
      if (attempt < COLLECTIBLE_RETRY_DELAYS_MS.length) continue;
      fail(`${field} request failed`);
    }

    if (!response?.ok || typeof response.text !== "function") {
      const transientStatus =
        Number.isInteger(response?.status) &&
        TRANSIENT_COLLECTIBLE_STATUSES.has(response.status);
      if (transientStatus && attempt < COLLECTIBLE_RETRY_DELAYS_MS.length) continue;
      fail(`${field} rejected the request`);
    }

    const text = await response.text();
    if (Buffer.byteLength(text) > 1_000_000) fail(`${field} response is too large`);
    return { response, text };
  }

  fail(`${field} request failed`);
}

function exactMetadataAttribute(attributes, traitType, expectedValue, displayType) {
  const matches = attributes.filter((attribute) => attribute?.trait_type === traitType);
  if (matches.length !== 1) fail(`candidate NFT metadata ${traitType} attribute is missing or duplicated`);
  const attribute = matches[0];
  exactJsonKeys(
    attribute,
    displayType === undefined
      ? ["trait_type", "value"]
      : ["display_type", "trait_type", "value"],
    `candidate NFT metadata ${traitType} attribute`,
  );
  if (attribute.value !== expectedValue || attribute.display_type !== displayType) {
    fail(`candidate NFT metadata ${traitType} attribute mismatch`);
  }
}

function escapeXmlText(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function candidateCollectibleUrl(origin, pathname, identity, releaseId) {
  const url = new URL(pathname, origin);
  url.searchParams.set("label", identity.normalized);
  url.searchParams.set("release", releaseId);
  return url;
}

function candidateEquivalentUrl(candidateOrigin, productionUrl) {
  let production;
  let candidate;
  try {
    production = new URL(productionUrl);
    candidate = new URL(candidateOrigin);
  } catch {
    fail("V2 NFT metadata URL is invalid");
  }
  candidate.pathname = production.pathname;
  candidate.search = production.search;
  candidate.hash = "";
  return candidate;
}

/**
 * V2-only collectible verification. The immutable on-chain tokenURI remains
 * bound to the production metadata origin, while the same route is exercised
 * through the explicitly selected candidate deployment before promotion.
 */
export async function verifyV2NftMetadataAcceptance({
  manifest,
  candidateOrigin,
  fetcher,
  publicClient,
  identity,
  owner,
  expiry,
  blockNumber,
}) {
  if (registrarVersionOf(manifest) !== "v2") return [];
  const registrar = requiredContract(manifest, "baseRegistrar");
  const metadataBaseURI = manifest.nftMetadata?.metadataBaseURI;
  if (typeof metadataBaseURI !== "string" || !manifest.releaseId) {
    fail("V2 NFT metadata configuration is incomplete");
  }
  const tokenId = identity.tokenId.toString();
  const expectedTokenURI = `${metadataBaseURI}${tokenId}`;
  const [supportsMetadata, tokenURI] = await Promise.all([
    readAt(
      publicClient,
      registrar,
      registrarMetadataInspectionAbi,
      "supportsInterface",
      [ERC721_METADATA_INTERFACE_ID],
      blockNumber,
    ),
    readAt(
      publicClient,
      registrar,
      registrarMetadataInspectionAbi,
      "tokenURI",
      [identity.tokenId],
      blockNumber,
    ),
  ]);
  if (supportsMetadata !== true) fail("registrar does not support ERC-721 Metadata");
  if (tokenURI !== expectedTokenURI) fail("registrar tokenURI is not the exact production metadata URL");

  const publicOrigin = new URL(metadataBaseURI).origin;
  const metadataUrl = candidateEquivalentUrl(candidateOrigin, tokenURI);
  const imageUrl = candidateCollectibleUrl(
    candidateOrigin,
    `/api/image/${tokenId}`,
    identity,
    manifest.releaseId,
  );
  const expectedPublicImageUrl = candidateCollectibleUrl(
    publicOrigin,
    `/api/image/${tokenId}`,
    identity,
    manifest.releaseId,
  ).toString();
  const expectedExternalUrl = new URL(
    `/name/${encodeURIComponent(identity.normalized)}?release=${encodeURIComponent(manifest.releaseId)}`,
    publicOrigin,
  ).toString();

  const metadataResult = await fetchCandidateText(
    fetcher,
    metadataUrl,
    "application/json",
    "candidate NFT metadata",
  );
  const metadataContentType = requiredResponseHeader(
    metadataResult.response,
    "content-type",
    "candidate NFT metadata",
  );
  if (!/^application\/json(?:\s*;|$)/i.test(metadataContentType)) {
    fail("candidate NFT metadata content-type mismatch");
  }
  if (
    requiredResponseHeader(metadataResult.response, "x-content-type-options", "candidate NFT metadata")
      .toLowerCase() !== "nosniff" ||
    requiredResponseHeader(metadataResult.response, "access-control-allow-origin", "candidate NFT metadata") !== "*" ||
    requiredResponseHeader(metadataResult.response, "cache-control", "candidate NFT metadata") !==
      "public, s-maxage=30, stale-while-revalidate=120"
  ) {
    fail("candidate NFT metadata security or cache headers mismatch");
  }
  let metadata;
  try { metadata = JSON.parse(metadataResult.text); }
  catch { fail("candidate NFT metadata is not valid JSON"); }
  exactJsonKeys(metadata, [
    "attributes",
    "background_color",
    "description",
    "external_url",
    "image",
    "name",
    "properties",
  ], "candidate NFT metadata");
  exactJsonKeys(metadata.properties, [
    "asOfBlock",
    "chainId",
    "contract",
    "lifecycle",
    "owner",
    "registrarVersion",
    "releaseId",
    "tokenId",
  ], "candidate NFT metadata properties");
  if (
    metadata.name !== identity.name ||
    metadata.description !== `${identity.name} is a Contour name registered on Arc Testnet.` ||
    metadata.image !== expectedPublicImageUrl ||
    metadata.external_url !== expectedExternalUrl ||
    metadata.background_color !== "000B24" ||
    metadata.properties.releaseId !== manifest.releaseId ||
    metadata.properties.registrarVersion !== "v2" ||
    metadata.properties.chainId !== ARC_TESTNET_CHAIN_ID ||
    metadata.properties.tokenId !== tokenId ||
    metadata.properties.lifecycle !== "active" ||
    exactAddress(metadata.properties.contract, "candidate NFT metadata contract") !== getAddress(registrar) ||
    exactAddress(metadata.properties.owner, "candidate NFT metadata owner") !== getAddress(owner)
  ) {
    fail("candidate NFT metadata identity binding mismatch");
  }
  if (
    typeof metadata.properties.asOfBlock !== "string" ||
    !/^(0|[1-9][0-9]*)$/.test(metadata.properties.asOfBlock) ||
    BigInt(metadata.properties.asOfBlock) < blockNumber
  ) {
    fail("candidate NFT metadata block binding mismatch");
  }
  if (!Array.isArray(metadata.attributes) || metadata.attributes.length !== 5) {
    fail("candidate NFT metadata attributes are incomplete");
  }
  exactMetadataAttribute(metadata.attributes, "Namespace", `.${manifest.namespace.suffix}`, undefined);
  exactMetadataAttribute(metadata.attributes, "Network", "Arc Testnet", undefined);
  exactMetadataAttribute(metadata.attributes, "Length", Array.from(identity.normalized).length, undefined);
  exactMetadataAttribute(metadata.attributes, "Status", "ACTIVE", undefined);
  const expectedExpiry = expiry <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(expiry)
    : expiry.toString();
  exactMetadataAttribute(metadata.attributes, "Expires", expectedExpiry, "date");

  const imageResult = await fetchCandidateText(
    fetcher,
    imageUrl,
    "image/svg+xml",
    "candidate NFT image",
  );
  const imageContentType = requiredResponseHeader(
    imageResult.response,
    "content-type",
    "candidate NFT image",
  );
  const imageCsp = requiredResponseHeader(
    imageResult.response,
    "content-security-policy",
    "candidate NFT image",
  );
  if (
    !/^image\/svg\+xml(?:\s*;|$)/i.test(imageContentType) ||
    imageCsp !== "default-src 'none'; style-src 'unsafe-inline'; sandbox" ||
    requiredResponseHeader(imageResult.response, "x-content-type-options", "candidate NFT image")
      .toLowerCase() !== "nosniff" ||
    requiredResponseHeader(imageResult.response, "access-control-allow-origin", "candidate NFT image") !== "*" ||
    requiredResponseHeader(imageResult.response, "cache-control", "candidate NFT image") !==
      "public, s-maxage=30, stale-while-revalidate=120"
  ) {
    fail("candidate NFT image security, cache, or content-type headers mismatch");
  }
  const escapedName = escapeXmlText(identity.name);
  const shortOwner = `${owner.slice(0, 8)}...${owner.slice(-6)}`;
  if (
    !imageResult.text.startsWith("<svg ") ||
    !imageResult.text.endsWith("</svg>") ||
    !imageResult.text.includes(`xmlns="http://www.w3.org/2000/svg"`) ||
    !imageResult.text.includes(`<title id="title">${escapedName}</title>`) ||
    !imageResult.text.includes(`Contour name identity visual for ${escapedName}`) ||
    !imageResult.text.includes(`OWNER / ${shortOwner}`) ||
    !imageResult.text.includes(`TOKEN / ${escapeXmlText(tokenId.slice(0, 18))}`) ||
    /<script\b|javascript:|\son[a-z]+\s*=/i.test(imageResult.text)
  ) {
    fail("candidate NFT image body does not match the registered collectible");
  }

  const metadataSha256 = `0x${createHash("sha256").update(metadataResult.text).digest("hex")}`;
  const imageSha256 = `0x${createHash("sha256").update(imageResult.text).digest("hex")}`;
  return [
    passAssertion(
      "erc721MetadataInterface",
      "rpc",
      `supportsInterface(${ERC721_METADATA_INTERFACE_ID})=true`,
      `interface=${ERC721_METADATA_INTERFACE_ID},supported=${supportsMetadata}`,
    ),
    passAssertion(
      "nftTokenUri",
      "rpc",
      expectedTokenURI,
      String(tokenURI),
    ),
    passAssertion(
      "nftMetadataDocument",
      "http",
      "candidate JSON exactly binds V2 name, contract, token, owner, image and external URL",
      compactPairs({
        sha256: metadataSha256,
        contract: metadata.properties.contract,
        tokenId,
        owner: metadata.properties.owner,
        asOfBlock: metadata.properties.asOfBlock,
      }),
    ),
    passAssertion(
      "nftImageDocument",
      "http",
      "candidate SVG has the exact collectible body and pinned security/cache headers",
      compactPairs({
        sha256: imageSha256,
        contentType: imageContentType,
        csp: imageCsp,
      }),
    ),
  ];
}

function assertRegistrationActivationBinding(binding, executionManifest) {
  const expectedKeys = [
    "artifact", "candidateManifestSha256", "candidateVerifiedAtBlock", "evidenceBlock",
    "evidenceBlockHash", "registrant", "registrationTransactionHash", "reportSha256",
    "schemaVersion",
  ].sort();
  if (
    !binding || typeof binding !== "object" || Array.isArray(binding) ||
    Object.keys(binding).sort().join(",") !== expectedKeys.join(",") ||
    binding.schemaVersion !== "1.0.0" || binding.artifact !== "registrationActivationSmoke"
  ) fail("funded run requires the exact registration activation smoke binding");
  for (const field of [
    "candidateManifestSha256", "evidenceBlockHash", "registrationTransactionHash", "reportSha256",
  ]) {
    if (!BYTES32_PATTERN.test(binding[field] ?? "") || /^0x0{64}$/i.test(binding[field])) {
      fail(`registration activation smoke ${field} is invalid`);
    }
  }
  exactAddress(binding.registrant, "registration activation smoke registrant");
  const candidateBlock = safePositiveBlockNumber(
    binding.candidateVerifiedAtBlock,
    "registration activation smoke candidate block",
  );
  const evidenceBlock = safePositiveBlockNumber(
    binding.evidenceBlock,
    "registration activation smoke evidence block",
  );
  const marketOpenBlock = safePositiveBlockNumber(
    executionManifest.activationEvidence.verifiedAtBlock,
    "market-open candidate verified block",
  );
  if (candidateBlock > evidenceBlock || evidenceBlock >= marketOpenBlock) {
    fail("registration activation smoke is outside the controller-open to market-open interval");
  }
  const controllerOpenCandidate = structuredClone(executionManifest);
  controllerOpenCandidate.activationEvidence.verifiedAtBlock = candidateBlock;
  controllerOpenCandidate.activationEvidence.marketplacePolicy.paused = true;
  if (
    deploymentManifestDigest(parseDeploymentManifest(controllerOpenCandidate)).toLowerCase() !==
    binding.candidateManifestSha256.toLowerCase()
  ) fail("registration activation smoke predecessor digest mismatch");
  return binding;
}

export function buildFundedRunReport({
  manifest,
  targetManifest,
  registrationSmokeBinding,
  evidenceBlock,
  generatedAt,
  transactions,
  assertions,
  sensitiveValues = [],
}) {
  const promotion = validatePromotionTargetPair(manifest, targetManifest);
  const executionManifest = promotion.candidate;
  const promotionTarget = promotion.target;
  const exactRegistrationBinding = assertRegistrationActivationBinding(
    registrationSmokeBinding,
    executionManifest,
  );
  if (transactions.map(({ id }) => id).join(",") !== FUNDED_TRANSACTION_IDS.join(",")) {
    fail("funded run transaction coverage or order is incomplete");
  }
  const requiredAssertionIds = fundedAssertionIdsForManifest(executionManifest);
  if (assertions.map(({ id }) => id).join(",") !== requiredAssertionIds.join(",")) {
    fail("funded run assertion coverage or order is incomplete");
  }
  const verifiedAtBlock = safePositiveBlockNumber(
    promotionTarget.activationEvidence.verifiedAtBlock,
    "promotion target verified block",
  );
  const reportEvidenceBlock = safePositiveBlockNumber(evidenceBlock, "funded evidence block");
  if (reportEvidenceBlock < verifiedAtBlock) {
    fail("funded evidence block predates manifest verification");
  }
  for (const transaction of transactions) {
    const transactionBlock = safePositiveBlockNumber(
      transaction.blockNumber,
      `${transaction.id} transaction block`,
    );
    if (transactionBlock <= verifiedAtBlock || transactionBlock > reportEvidenceBlock) {
      fail(`${transaction.id} transaction is outside the verified evidence interval`);
    }
    if (!TX_HASH_PATTERN.test(transaction.hash ?? "")) {
      fail(`${transaction.id} transaction hash is malformed`);
    }
    exactAddress(transaction.from, `${transaction.id} transaction sender`);
    const targetKey = FUNDED_TRANSACTION_TARGET_KEYS[transaction.id];
    const expectedTarget = targetKey === "settlement"
      ? executionManifest.settlement.erc20Address
      : executionManifest.contracts[targetKey]?.address;
    if (
      !expectedTarget ||
      exactAddress(transaction.to, `${transaction.id} transaction target`) !==
        exactAddress(expectedTarget, `${transaction.id} expected target`)
    ) fail(`${transaction.id} transaction target mismatch`);
  }
  const report = {
    schemaVersion: "1.0.0",
    artifact: "fundedEndToEnd",
    verdict: "PASS",
    chainId: ARC_TESTNET_CHAIN_ID,
    releaseId: promotionTarget.releaseId,
    promotionSubjectSha256: promotion.promotionSubjectSha256,
    registrationActivationSmoke: exactRegistrationBinding,
    verifiedAtBlock,
    evidenceBlock: reportEvidenceBlock,
    generatedAt,
    transactions,
    assertions,
    redactions: {
      privateKeys: false,
      challengeSecrets: false,
      walletSignatures: false,
      permitSignatures: false,
    },
  };
  return assertSecretFreeReport(report, sensitiveValues);
}

function buildDryRunPlan({
  manifest,
  targetManifest,
  candidateOrigin,
  seller,
  buyer,
  identity,
  durationYears,
  expectedAmount,
  listingPrice,
  registrationSmokeBinding,
}) {
  const targets = {
    registrationUsdcApproval: manifest.settlement.erc20Address,
    registration: requiredContract(manifest, "controller"),
    sellerNftApproval: requiredContract(manifest, "baseRegistrar"),
    firstListing: requiredContract(manifest, "marketplace"),
    firstCancellation: requiredContract(manifest, "marketplace"),
    secondListing: requiredContract(manifest, "marketplace"),
    buyerUsdcApproval: manifest.settlement.erc20Address,
    purchase: requiredContract(manifest, "marketplace"),
    sellerClaimProceeds: requiredContract(manifest, "marketplace"),
    buyerNftApproval: requiredContract(manifest, "baseRegistrar"),
    buyerRelisting: requiredContract(manifest, "marketplace"),
    buyerDirectTransfer: requiredContract(manifest, "baseRegistrar"),
    listingInvalidation: requiredContract(manifest, "marketplace"),
  };
  const sellerIds = new Set([
    "registrationUsdcApproval", "registration", "sellerNftApproval", "firstListing",
    "firstCancellation", "secondListing", "sellerClaimProceeds",
  ]);
  return {
    schemaVersion: "1.0.0",
    artifact: "fundedEndToEnd",
    mode: "DRY_RUN",
    verdict: "NOT_EXECUTED",
    chainId: manifest.chain.id,
    releaseId: manifest.releaseId,
    promotionTargetExplicit: targetManifest !== undefined,
    promotionSubjectSha256: targetManifest === undefined
      ? null
      : promotionSubjectDigest(targetManifest),
    verifiedAtBlock: targetManifest?.activationEvidence.verifiedAtBlock ?? null,
    registrationActivationSmoke: registrationSmokeBinding ?? null,
    candidateOrigin,
    seller: seller.address,
    buyer: buyer.address,
    normalizedLabel: identity.normalized,
    fullName: identity.name,
    tokenId: identity.tokenId.toString(),
    durationYears,
    expectedAmount: expectedAmount.toString(),
    listingPrice: listingPrice.toString(),
    transactions: FUNDED_TRANSACTION_IDS.map((id) => ({
      id,
      from: sellerIds.has(id) ? seller.address : buyer.address,
      to: targets[id],
    })),
    assertions: fundedAssertionIdsForManifest(manifest)
      .map((id) => ({ id, verdict: "PENDING_BROADCAST" })),
    redactions: {
      privateKeys: false,
      challengeSecrets: false,
      walletSignatures: false,
      permitSignatures: false,
    },
  };
}

async function inspectReadiness({ manifest, candidateOrigin, fetcher, publicClient, seller, buyer, identity, durationYears, listingPrice }) {
  const controller = requiredContract(manifest, "controller");
  const registrar = requiredContract(manifest, "baseRegistrar");
  const market = requiredContract(manifest, "marketplace");
  const settlement = manifest.settlement.erc20Address;
  let chainId;
  let head;
  try {
    [chainId, head] = await Promise.all([publicClient.getChainId(), publicClient.getBlockNumber()]);
  } catch {
    fail("Arc RPC readiness request failed");
  }
  expectEqual(chainId, ARC_TESTNET_CHAIN_ID, "Arc RPC chain ID");
  if (head < BigInt(manifest.activationEvidence.verifiedAtBlock)) fail("Arc RPC head predates manifest verification");
  await Promise.all(Object.entries(manifest.contracts).map(async ([key, deployment]) => {
    let bytecode;
    try { bytecode = await publicClient.getBytecode({ address: deployment.address, blockNumber: head }); }
    catch { fail(`Arc RPC bytecode read failed for ${key}`); }
    if (!bytecode || bytecode === "0x" || keccak256(bytecode).toLowerCase() !== deployment.runtimeCodeHash.toLowerCase()) {
      fail(`${key} runtime code does not match the explicit manifest`);
    }
  }));

  const [remoteManifest, issuerReadiness, registrationsPaused, marketplacePaused, onchainRelease, activeSigner, policyVersion, feeBps, expectedAmount, available, nonce, sellerBalance, buyerBalance, sellerNative, buyerNative] = await Promise.all([
    getJson(fetcher, new URL("/api/manifest", candidateOrigin), "candidate manifest"),
    getJson(fetcher, new URL("/api/registration/readiness", candidateOrigin), "issuer readiness"),
    readAt(publicClient, controller, controllerInspectionAbi, "registrationsPaused"),
    readAt(publicClient, market, marketInspectionAbi, "paused"),
    readAt(publicClient, controller, controllerInspectionAbi, "releaseId"),
    readAt(publicClient, controller, controllerInspectionAbi, "permitSigner"),
    readAt(publicClient, controller, controllerInspectionAbi, "signerPolicyVersion"),
    readAt(publicClient, market, marketInspectionAbi, "feeBps"),
    readAt(publicClient, controller, controllerAbi, "quote", [identity.normalized, BigInt(durationYears)]),
    readAt(publicClient, registrar, baseRegistrarAbi, "available", [identity.tokenId]),
    readAt(publicClient, controller, controllerAbi, "nonces", [seller.address]),
    readAt(publicClient, settlement, erc20Abi, "balanceOf", [seller.address]),
    readAt(publicClient, settlement, erc20Abi, "balanceOf", [buyer.address]),
    publicClient.getBalance({ address: seller.address }).catch(() => fail("seller native balance read failed")),
    publicClient.getBalance({ address: buyer.address }).catch(() => fail("buyer native balance read failed")),
  ]);
  assertCandidateManifest(manifest, remoteManifest);
  if (issuerReadiness?.ready !== true) fail("candidate permit issuer is not ready");
  if (registrationsPaused !== false || marketplacePaused !== false) fail("controller or marketplace is paused");
  if (String(onchainRelease).toLowerCase() !== manifest.releaseId.toLowerCase()) fail("controller releaseId mismatch");
  if (getAddress(activeSigner) !== getAddress(manifest.permitIssuer.signerAddress)) fail("permit signer mismatch");
  if (String(policyVersion) !== manifest.permitIssuer.policyVersion) fail("permit signer policy version mismatch");
  if (Number(feeBps) !== manifest.activationEvidence.marketplacePolicy.feeBps) fail("marketplace fee mismatch");
  const quote = asBigInt(expectedAmount, "registration quote");
  const price = listingPrice === undefined ? quote : asBigInt(listingPrice, "listing price");
  if (quote <= 0n || price <= 0n) fail("funded acceptance amounts must be positive");
  if (available !== true) fail("funded acceptance label is not available");
  if (asBigInt(sellerBalance, "seller USDC balance") < quote) fail("seller has insufficient USDC");
  if (asBigInt(buyerBalance, "buyer USDC balance") < price) fail("buyer has insufficient USDC");
  if (sellerNative <= 0n || buyerNative <= 0n) fail("seller and buyer must both have Arc gas balance");
  return { head, expectedAmount: quote, listingPrice: price, nonce: asBigInt(nonce, "seller nonce") };
}

function registrationFingerprint({ manifest, candidateOrigin, requestId, identity, seller, durationYears, expectedAmount }) {
  const canonical = {
    requestId,
    normalizedLabel: identity.normalized,
    labelHash: identity.labelhash,
    namehash: identity.namehash,
    requester: seller.address,
    recipient: seller.address,
    payer: seller.address,
    authorizedExecutor: seller.address,
    durationYears,
    resolverDataHash: resolverDataHash([]),
    referrer: zeroAddress,
    chainId: manifest.chain.id,
    controller: requiredContract(manifest, "controller"),
    releaseId: manifest.releaseId,
    normalizationProfileHash: manifest.normalization.profileHash,
    settlementAsset: manifest.settlement.erc20Address,
    expectedAmount: expectedAmount.toString(),
    expectedReferralBps: "0",
    origin: candidateOrigin,
  };
  return `0x${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function validateChallenge({ challenge, manifest, candidateOrigin, requestId, identity, seller, durationYears, expectedAmount, nowSeconds }) {
  if (
    !UUID_PATTERN.test(challenge?.id ?? "") || typeof challenge.message !== "string" ||
    !BYTES32_PATTERN.test(challenge.proof ?? "") || challenge.requestId !== requestId ||
    getAddress(challenge.requester) !== getAddress(seller.address) ||
    challenge.normalizedLabel !== identity.normalized || challenge.fullName !== identity.name ||
    challenge.expectedAmount !== expectedAmount.toString()
  ) fail("issuer challenge envelope mismatch");
  const lines = challenge.message.split("\n");
  const issued = /^Issued at: ([0-9]{10})$/.exec(lines[19] ?? "");
  const expires = /^Expires at: ([0-9]{10})$/.exec(lines[20] ?? "");
  const nonce = /^Challenge: (0x[0-9a-fA-F]{64})$/.exec(lines[18] ?? "");
  const issuedAt = Number(issued?.[1]);
  const expiresAt = Number(expires?.[1]);
  const fingerprint = registrationFingerprint({ manifest, candidateOrigin, requestId, identity, seller, durationYears, expectedAmount });
  const expectedLines = [
    "Contour Name Protocol registration intent",
    `Domain: ${new URL(candidateOrigin).hostname}`,
    `Origin: ${candidateOrigin}`,
    `Chain ID: ${manifest.chain.id}`,
    `Controller: ${requiredContract(manifest, "controller")}`,
    `Release ID: ${manifest.releaseId}`,
    `Request ID: ${requestId}`,
    `Name: ${identity.name}`,
    `Requester: ${seller.address}`,
    `Recipient: ${seller.address}`,
    `Payer: ${seller.address}`,
    `Authorized executor: ${seller.address}`,
    `Duration: ${durationYears} year(s)`,
    `Exact amount: ${expectedAmount} USDC base units`,
    `Resolver data hash: ${resolverDataHash([])}`,
    `Referrer: ${zeroAddress}`,
    "Expected referral BPS: 0",
    `Intent fingerprint: ${fingerprint}`,
    `Challenge: ${nonce?.[1]}`,
    `Issued at: ${issuedAt}`,
    `Expires at: ${expiresAt}`,
  ];
  if (
    lines.length !== 21 || expectedLines.some((line, index) => line !== lines[index]) ||
    challenge.requestFingerprint?.toLowerCase() !== fingerprint.toLowerCase() ||
    !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) ||
    issuedAt > nowSeconds + 5 || nowSeconds - issuedAt > 180 ||
    expiresAt <= issuedAt || expiresAt - issuedAt > 180 || expiresAt <= nowSeconds ||
    new Date(expiresAt * 1_000).toISOString() !== challenge.expiresAt
  ) fail("issuer challenge content or TTL mismatch");
  return { issuedAt, expiresAt };
}

async function validatePreparedRegistration({
  prepared,
  manifest,
  identity,
  seller,
  durationYears,
  expectedAmount,
  nonce,
  nowSeconds,
}) {
  const tx = prepared?.registrationTransaction;
  const permit = prepared?.permit;
  if (
    !tx || getAddress(tx.to) !== getAddress(requiredContract(manifest, "controller")) ||
    typeof tx.data !== "string" || !/^0x[0-9a-fA-F]+$/.test(tx.data) ||
    !["0x0", "0x00"].includes(tx.value) || !permit ||
    !BYTES32_PATTERN.test(prepared.permitId ?? "") || prepared.permitId !== permit.permitId ||
    !/^0x[0-9a-fA-F]{130}$/.test(prepared.signature ?? "")
  ) fail("issuer prepared an invalid registration transaction");
  const partyFields = ["requester", "recipient", "payer", "authorizedExecutor"];
  if (partyFields.some((field) => getAddress(permit[field]) !== getAddress(seller.address))) {
    fail("permit parties are not bound to the seller wallet");
  }
  const issuedAt = asBigInt(permit.issuedAt, "permit issuedAt");
  const validAfter = asBigInt(permit.validAfter, "permit validAfter");
  const validUntil = asBigInt(permit.validUntil, "permit validUntil");
  if (
    asBigInt(permit.chainId, "permit chainId") !== BigInt(manifest.chain.id) ||
    getAddress(permit.controller) !== getAddress(requiredContract(manifest, "controller")) ||
    permit.releaseId?.toLowerCase() !== manifest.releaseId.toLowerCase() ||
    permit.normalizationProfileHash?.toLowerCase() !== manifest.normalization.profileHash.toLowerCase() ||
    permit.normalizedLabelHash?.toLowerCase() !== identity.labelhash.toLowerCase() ||
    permit.namehash?.toLowerCase() !== identity.namehash.toLowerCase() ||
    permit.resolverDataHash?.toLowerCase() !== resolverDataHash([]).toLowerCase() ||
    getAddress(permit.settlementAsset) !== getAddress(manifest.settlement.erc20Address) ||
    asBigInt(permit.durationYears, "permit duration") !== BigInt(durationYears) ||
    asBigInt(permit.expectedAmount, "permit amount") !== expectedAmount ||
    asBigInt(permit.expectedReferralBps, "permit referral BPS") !== 0n ||
    getAddress(permit.referrer) !== zeroAddress || asBigInt(permit.nonce, "permit nonce") !== nonce ||
    prepared.validUntil !== permit.validUntil
  ) fail("prepared permit release, amount, or nonce mismatch");
  assertPreparedPermitWindow({ issuedAt, validAfter, validUntil, nowSeconds });
  const wirePermit = {
    chainId: asBigInt(permit.chainId, "permit chainId"),
    controller: exactAddress(permit.controller, "permit controller"),
    releaseId: permit.releaseId,
    normalizationProfileHash: permit.normalizationProfileHash,
    normalizedLabelHash: permit.normalizedLabelHash,
    namehash: permit.namehash,
    requester: exactAddress(permit.requester, "permit requester"),
    recipient: exactAddress(permit.recipient, "permit recipient"),
    payer: exactAddress(permit.payer, "permit payer"),
    authorizedExecutor: exactAddress(permit.authorizedExecutor, "permit authorizedExecutor"),
    durationYears: asBigInt(permit.durationYears, "permit duration"),
    resolverDataHash: permit.resolverDataHash,
    referrer: exactAddress(permit.referrer, "permit referrer"),
    settlementAsset: exactAddress(permit.settlementAsset, "permit settlement asset"),
    expectedAmount: asBigInt(permit.expectedAmount, "permit amount"),
    expectedReferralBps: asBigInt(permit.expectedReferralBps, "permit referral BPS"),
    permitId: permit.permitId,
    nonce: asBigInt(permit.nonce, "permit nonce"),
    issuedAt,
    validAfter,
    validUntil,
  };
  let signatureValid;
  try {
    signatureValid = await verifyTypedData({
      address: getAddress(manifest.permitIssuer.signerAddress),
      domain: registrationPermitDomain(requiredContract(manifest, "controller")),
      types: registrationPermitTypes,
      primaryType: "RegistrationPermit",
      message: wirePermit,
      signature: prepared.signature,
    });
  } catch {
    fail("permit signature could not be verified locally");
  }
  if (!signatureValid) fail("permit signature does not match the manifest signer");
  const expectedData = encodeFunctionData({
    abi: controllerAbi,
    functionName: "register",
    args: [identity.normalized, wirePermit, [], prepared.signature],
  });
  if (tx.data.toLowerCase() !== expectedData.toLowerCase()) {
    fail("registration calldata is not the exact locally verified permit transaction");
  }
  return { transaction: tx, permitId: permit.permitId, permitNonce: nonce };
}

// Registration activation is deliberately verified before the marketplace is
// opened. Keep the security-critical permit and receipt validation shared with
// the full funded acceptance runner so both gates enforce identical wire data.
export const registrationAcceptancePrimitives = Object.freeze({
  asBigInt,
  assertPreparedPermitWindow,
  assertCandidateManifest,
  canonicalUrl,
  controllerInspectionAbi,
  erc20InspectionAbi,
  exactAddress,
  expectEqual,
  getJson,
  postJson,
  readAt,
  requiredContract,
  requireEvent,
  safePositiveBlockNumber,
  sendAndConfirm,
  sendContract,
  snapshotRegistration,
  validateChallenge,
  validatePreparedRegistration,
});

export async function runFundedAcceptance({
  manifest,
  targetManifest,
  registrationSmokeEvidence,
  candidateOrigin,
  label,
  durationYears = 1,
  listingPrice,
  broadcastReleaseId,
  env = process.env,
  accounts,
  publicClient,
  sellerWalletClient,
  buyerWalletClient,
  fetcher = fetch,
  now = () => Date.now(),
}) {
  const origin = canonicalUrl(candidateOrigin, "--candidate-origin");
  let parsed;
  try { parsed = parseDeploymentManifest(structuredClone(manifest)); }
  catch { fail("explicit manifest failed canonical validation"); }
  assertManifestForCandidate(parsed, origin);
  if (broadcastReleaseId !== undefined && broadcastReleaseId !== parsed.releaseId) {
    fail(`--broadcast must exactly equal releaseId ${parsed.releaseId}`);
  }
  const broadcast = broadcastReleaseId !== undefined;
  if (broadcast && targetManifest === undefined) {
    fail("--target-intent is required for broadcast");
  }
  if (broadcast && registrationSmokeEvidence === undefined) {
    fail("--registration-smoke is required for broadcast");
  }
  let promotionTarget;
  if (targetManifest !== undefined) {
    try {
      const promotion = validatePromotionTargetPair(parsed, targetManifest);
      parsed = promotion.candidate;
      promotionTarget = promotion.target;
    } catch (error) {
      fail(error instanceof Error ? error.message : "promotion target validation failed");
    }
  }
  let registrationSmokeLifecycle;
  let registrationSmokePredecessor;
  if (registrationSmokeEvidence !== undefined) {
    try {
      const canonicalSmoke = parseCanonicalRegistrationSmokeBytes(
        registrationSmokeEvidence.reportBytes,
      );
      registrationSmokePredecessor = controllerOpenPredecessorFromMarketOpen(
        parsed,
        canonicalSmoke.report,
      );
      registrationSmokeLifecycle = validateRegistrationSmokeLifecycle({
        report: canonicalSmoke.report,
        reportSha256: canonicalSmoke.reportSha256,
        controllerOpenManifest: registrationSmokePredecessor,
        candidateOrigin: origin,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : "registration smoke lifecycle validation failed");
    }
  }
  if (!Number.isInteger(durationYears) || durationYears < 1 || durationYears > 10) fail("durationYears must be 1..10");
  if (typeof label !== "string" || label.length === 0) fail("--label is required");
  let identity;
  try { identity = deriveNameIdentity(label, parsed.namespace.suffix); }
  catch { fail("label is invalid under the pinned normalization profile"); }
  if (identity.changed) fail("funded acceptance label must already be canonically normalized");

  const accountBundle = accounts ?? accountsFromEnvironment(env);
  const seller = accountBundle.seller;
  const buyer = accountBundle.buyer;
  const sensitiveValues = [...(accountBundle.sensitiveValues ?? [])];
  if (!seller?.address || !buyer?.address || getAddress(seller.address) === getAddress(buyer.address)) {
    fail("seller and buyer accounts must be distinct");
  }
  const rpc = parsed.chain.rpcUrl;
  const transport = rateLimitedArcHttp(rpc);
  const chainClient = publicClient ?? createPublicClient({
    chain: arcTestnet,
    transport,
    batch: { multicall: { wait: 25 } },
  });
  const sellerWallet = sellerWalletClient ?? createWalletClient({ account: seller, chain: arcTestnet, transport });
  const buyerWallet = buyerWalletClient ?? createWalletClient({ account: buyer, chain: arcTestnet, transport });

  let registrationSmokeBinding;
  if (broadcast) {
    try {
      registrationSmokeBinding = await revalidateRegistrationSmokeEvidence({
        publicClient: chainClient,
        controllerOpenManifest: registrationSmokePredecessor,
        binding: registrationSmokeLifecycle,
      });
    } catch (error) {
      fail(error instanceof Error ? error.message : "registration smoke receipt revalidation failed");
    }
  } else if (registrationSmokeLifecycle) {
    registrationSmokeBinding = registrationSmokeBindingRecord(registrationSmokeLifecycle);
  }

  const readiness = await inspectReadiness({
    manifest: parsed,
    candidateOrigin: origin,
    fetcher,
    publicClient: chainClient,
    seller,
    buyer,
    identity,
    durationYears,
    listingPrice,
  });
  if (promotionTarget !== undefined) {
    try {
      assertPromotionTargetAtHead(promotionTarget, readiness.head);
    } catch (error) {
      fail(error instanceof Error ? error.message : "promotion target head validation failed");
    }
  }
  const preflight = await postJson(fetcher, new URL("/api/registration/preflight", origin), {
    rawLabel: identity.normalized,
    normalizationAccepted: true,
    durationYears,
    payer: seller.address,
  }, "registration preflight");
  if (
    preflight.normalizedLabel !== identity.normalized ||
    asBigInt(preflight.expectedAmount, "preflight amount") !== readiness.expectedAmount
  ) fail("candidate registration preflight does not match Arc quote");

  if (!broadcast) {
    const plan = buildDryRunPlan({
      manifest: parsed,
      targetManifest: promotionTarget,
      candidateOrigin: origin,
      seller,
      buyer,
      identity,
      durationYears,
      expectedAmount: readiness.expectedAmount,
      listingPrice: readiness.listingPrice,
      registrationSmokeBinding,
    });
    return assertSecretFreeReport(plan, sensitiveValues);
  }
  const settlement = parsed.settlement.erc20Address;
  const controller = requiredContract(parsed, "controller");
  const registrar = requiredContract(parsed, "baseRegistrar");
  const resolver = requiredContract(parsed, "publicResolver");
  const market = requiredContract(parsed, "marketplace");
  const transactions = [];
  const preBlock = readiness.head;
  const [controllerBalanceBefore, controllerLiabilityBefore, marketBefore] = await Promise.all([
    readAt(chainClient, settlement, erc20Abi, "balanceOf", [controller], preBlock),
    readAt(chainClient, controller, controllerInspectionAbi, "totalReferralLiability", [], preBlock),
    snapshotMarket(chainClient, parsed, identity.tokenId, seller.address, preBlock),
  ]);
  if (marketBefore.proceeds !== 0n) {
    fail("seller has pre-existing marketplace proceeds; use a clean funded seller before acceptance");
  }
  if (asBigInt(controllerBalanceBefore, "controller pre-balance") < asBigInt(controllerLiabilityBefore, "controller pre-liability")) {
    fail("controller is insolvent before funded acceptance");
  }

  const approval = await sendContract({
    id: "registrationUsdcApproval", publicClient: chainClient, walletClient: sellerWallet,
    account: seller, to: settlement, abi: erc20Abi, functionName: "approve",
    args: [controller, readiness.expectedAmount],
  });
  transactions.push(approval.transaction);
  requireEvent(approval.receipt, settlement, erc20InspectionAbi, "Approval", (args) =>
    getAddress(args.owner) === getAddress(seller.address) && getAddress(args.spender) === getAddress(controller) && args.value === readiness.expectedAmount);
  const sellerAllowance = await readAt(chainClient, settlement, erc20Abi, "allowance", [seller.address, controller], approval.receipt.blockNumber);
  expectEqual(sellerAllowance, readiness.expectedAmount, "exact registration allowance");

  const requestId = `e2e-${parsed.releaseId.slice(2, 10)}-${identity.normalized}`;
  // The recommended public API is intentionally the direct, wallet-bound
  // prepare route. The legacy challenge endpoint is compatibility-only.
  const prepared = await postJson(fetcher, new URL("/api/registration/prepare", origin), {
    rawLabel: identity.normalized,
    normalizationAccepted: true,
    durationYears,
    requester: seller.address,
    payer: seller.address,
    recipient: seller.address,
    requestId,
  }, "registration permit preparation");
  if (typeof prepared.signature === "string") sensitiveValues.push(prepared.signature);
  const registrationPlan = await validatePreparedRegistration({
    prepared, manifest: parsed, identity, seller, durationYears,
    expectedAmount: readiness.expectedAmount, nonce: readiness.nonce,
    nowSeconds: Math.floor(now() / 1_000),
  });
  const permitUsedBefore = await readAt(chainClient, controller, controllerAbi, "usedPermit", [registrationPlan.permitId], preBlock);
  if (permitUsedBefore !== false) fail("registration permit was already consumed before broadcast");

  const registration = await sendAndConfirm({
    id: "registration", publicClient: chainClient, walletClient: sellerWallet,
    account: seller, to: controller,
    send: () => sellerWallet.sendTransaction({
      account: seller,
      to: controller,
      data: registrationPlan.transaction.data,
      value: 0n,
    }),
  });
  transactions.push(registration.transaction);
  const permitEvent = requireEvent(registration.receipt, controller, controllerInspectionAbi, "PermitConsumed", (args) =>
    args.permitId.toLowerCase() === registrationPlan.permitId.toLowerCase() &&
    getAddress(args.requester) === getAddress(seller.address) && args.nonce === readiness.nonce);
  const nameEvent = requireEvent(registration.receipt, controller, controllerInspectionAbi, "NameRegistered", (args) =>
    args.label.toLowerCase() === identity.labelhash.toLowerCase() && getAddress(args.owner) === getAddress(seller.address));
  expectEqual(nameEvent.baseCost, readiness.expectedAmount, "registration event exact amount");

  const registrationState = await snapshotRegistration(
    chainClient, parsed, identity, registrationPlan.permitId, seller.address, registration.receipt.blockNumber,
  );
  const registrationAllowanceAfter = await readAt(
    chainClient, settlement, erc20Abi, "allowance", [seller.address, controller], registration.receipt.blockNumber,
  );
  expectEqual(registrationState.usedPermit, true, "permit consumption");
  expectEqual(registrationState.nonce, readiness.nonce + 1n, "registration nonce increment");
  expectEqual(registrationState.registrarOwner, getAddress(seller.address), "registrar owner after registration");
  expectEqual(registrationState.registryOwner, getAddress(seller.address), "registry owner after registration");
  expectEqual(registrationState.registryResolver, getAddress(resolver), "registry resolver after registration");
  expectEqual(registrationState.resolvedAddress, zeroAddress, "empty resolver addr after registration");
  expectEqual(registrationState.balance - asBigInt(controllerBalanceBefore, "controller pre-balance"), readiness.expectedAmount, "controller exact USDC delta");
  expectEqual(registrationState.liability, asBigInt(controllerLiabilityBefore, "controller pre-liability"), "controller referral liability");
  expectEqual(registrationAllowanceAfter, 0n, "registration allowance consumption");
  if (registrationState.balance < registrationState.liability) fail("controller is insolvent after registration");

  const sellerNftApproval = await sendContract({
    id: "sellerNftApproval", publicClient: chainClient, walletClient: sellerWallet,
    account: seller, to: registrar, abi: baseRegistrarAbi, functionName: "approve", args: [market, identity.tokenId],
  });
  transactions.push(sellerNftApproval.transaction);
  requireEvent(sellerNftApproval.receipt, registrar, registrarInspectionAbi, "Approval", (args) =>
    getAddress(args.owner) === getAddress(seller.address) && getAddress(args.approved) === getAddress(market) && args.tokenId === identity.tokenId);

  const registrationBlock = await chainClient.getBlock({ blockNumber: registration.receipt.blockNumber });
  const listingValidUntil = registrationState.expiry < registrationBlock.timestamp + 7n * 86_400n
    ? registrationState.expiry
    : registrationBlock.timestamp + 7n * 86_400n;
  if (listingValidUntil <= registrationBlock.timestamp) fail("registered name has no safe listing window");
  const firstListing = await sendContract({
    id: "firstListing", publicClient: chainClient, walletClient: sellerWallet, account: seller,
    to: market, abi: marketplaceAbi, functionName: "list",
    args: [identity.tokenId, readiness.listingPrice, listingValidUntil],
  });
  transactions.push(firstListing.transaction);
  requireEvent(firstListing.receipt, market, marketInspectionAbi, "Listed", (args) =>
    args.tokenId === identity.tokenId && getAddress(args.seller) === getAddress(seller.address) &&
    args.price === readiness.listingPrice && args.validUntil === listingValidUntil);

  const firstCancellation = await sendContract({
    id: "firstCancellation", publicClient: chainClient, walletClient: sellerWallet, account: seller,
    to: market, abi: marketplaceAbi, functionName: "cancel", args: [identity.tokenId],
  });
  transactions.push(firstCancellation.transaction);
  requireEvent(firstCancellation.receipt, market, marketInspectionAbi, "ListingCancelled", (args) =>
    args.tokenId === identity.tokenId && getAddress(args.seller) === getAddress(seller.address));
  const cancelled = await snapshotMarket(chainClient, parsed, identity.tokenId, seller.address, firstCancellation.receipt.blockNumber);
  expectEqual(cancelled.rawListing.seller, zeroAddress, "cancelled raw listing seller");

  const secondListing = await sendContract({
    id: "secondListing", publicClient: chainClient, walletClient: sellerWallet, account: seller,
    to: market, abi: marketplaceAbi, functionName: "list",
    args: [identity.tokenId, readiness.listingPrice, listingValidUntil],
  });
  transactions.push(secondListing.transaction);
  const listedState = await snapshotMarket(chainClient, parsed, identity.tokenId, seller.address, secondListing.receipt.blockNumber);
  expectEqual(listedState.liveListing.seller, getAddress(seller.address), "second listing seller");
  expectEqual(listedState.liveListing.price, readiness.listingPrice, "second listing price");

  const buyerApproval = await sendContract({
    id: "buyerUsdcApproval", publicClient: chainClient, walletClient: buyerWallet,
    account: buyer, to: settlement, abi: erc20Abi, functionName: "approve",
    args: [market, readiness.listingPrice],
  });
  transactions.push(buyerApproval.transaction);
  requireEvent(buyerApproval.receipt, settlement, erc20InspectionAbi, "Approval", (args) =>
    getAddress(args.owner) === getAddress(buyer.address) && getAddress(args.spender) === getAddress(market) && args.value === readiness.listingPrice);
  const buyerAllowance = await readAt(chainClient, settlement, erc20Abi, "allowance", [buyer.address, market], buyerApproval.receipt.blockNumber);
  expectEqual(buyerAllowance, readiness.listingPrice, "exact buyer marketplace allowance");

  const purchase = await sendContract({
    id: "purchase", publicClient: chainClient, walletClient: buyerWallet, account: buyer,
    to: market, abi: marketplaceAbi, functionName: "buy",
    args: [identity.tokenId, readiness.listingPrice, parsed.activationEvidence.marketplacePolicy.feeBps],
  });
  transactions.push(purchase.transaction);
  const purchaseEvent = requireEvent(purchase.receipt, market, marketInspectionAbi, "Purchased", (args) =>
    args.tokenId === identity.tokenId && getAddress(args.seller) === getAddress(seller.address) &&
    getAddress(args.buyer) === getAddress(buyer.address) && args.price === readiness.listingPrice);
  const expectedFee = readiness.listingPrice * BigInt(parsed.activationEvidence.marketplacePolicy.feeBps) / 10_000n;
  const expectedProceeds = readiness.listingPrice - expectedFee;
  expectEqual(purchaseEvent.fee, expectedFee, "marketplace purchase fee");
  const afterPurchase = await snapshotMarket(chainClient, parsed, identity.tokenId, seller.address, purchase.receipt.blockNumber);
  const [ownerAfterPurchase, buyerAllowanceAfter] = await Promise.all([
    readAt(chainClient, registrar, baseRegistrarAbi, "ownerOf", [identity.tokenId], purchase.receipt.blockNumber),
    readAt(chainClient, settlement, erc20Abi, "allowance", [buyer.address, market], purchase.receipt.blockNumber),
  ]);
  expectEqual(getAddress(ownerAfterPurchase), getAddress(buyer.address), "buyer owner after purchase");
  expectEqual(afterPurchase.proceeds - marketBefore.proceeds, expectedProceeds, "seller proceeds accrual");
  expectEqual(afterPurchase.liability - marketBefore.liability, expectedProceeds, "seller liability accrual");
  expectEqual(afterPurchase.balance - marketBefore.balance, readiness.listingPrice, "market exact USDC collection");
  expectEqual(buyerAllowanceAfter, 0n, "buyer marketplace allowance consumption");
  if (afterPurchase.balance < afterPurchase.liability) fail("marketplace insolvent after purchase");

  const sellerClaim = await sendContract({
    id: "sellerClaimProceeds", publicClient: chainClient, walletClient: sellerWallet, account: seller,
    to: market, abi: marketplaceAbi, functionName: "claimProceeds", args: [],
  });
  transactions.push(sellerClaim.transaction);
  const claimEvent = requireEvent(sellerClaim.receipt, market, marketInspectionAbi, "ProceedsClaimed", (args) =>
    getAddress(args.seller) === getAddress(seller.address) && args.amount === expectedProceeds);
  expectEqual(claimEvent.amount, expectedProceeds, "claimed seller proceeds");
  const afterClaim = await snapshotMarket(chainClient, parsed, identity.tokenId, seller.address, sellerClaim.receipt.blockNumber);
  expectEqual(afterClaim.proceeds, marketBefore.proceeds, "seller proceeds after claim");
  expectEqual(afterClaim.liability, marketBefore.liability, "market liability after claim");
  expectEqual(afterPurchase.balance - afterClaim.balance, expectedProceeds, "market exact claim payment");
  if (afterClaim.balance < afterClaim.liability) fail("marketplace insolvent after claim");

  const buyerNftApproval = await sendContract({
    id: "buyerNftApproval", publicClient: chainClient, walletClient: buyerWallet,
    account: buyer, to: registrar, abi: baseRegistrarAbi, functionName: "approve", args: [market, identity.tokenId],
  });
  transactions.push(buyerNftApproval.transaction);
  requireEvent(buyerNftApproval.receipt, registrar, registrarInspectionAbi, "Approval", (args) =>
    getAddress(args.owner) === getAddress(buyer.address) && getAddress(args.approved) === getAddress(market) && args.tokenId === identity.tokenId);

  const buyerRelisting = await sendContract({
    id: "buyerRelisting", publicClient: chainClient, walletClient: buyerWallet, account: buyer,
    to: market, abi: marketplaceAbi, functionName: "list",
    args: [identity.tokenId, readiness.listingPrice, listingValidUntil],
  });
  transactions.push(buyerRelisting.transaction);
  const buyerListed = await snapshotMarket(chainClient, parsed, identity.tokenId, seller.address, buyerRelisting.receipt.blockNumber);
  expectEqual(buyerListed.rawListing.seller, getAddress(buyer.address), "buyer relisting seller");

  const directTransfer = await sendContract({
    id: "buyerDirectTransfer", publicClient: chainClient, walletClient: buyerWallet, account: buyer,
    to: registrar, abi: registrarInspectionAbi, functionName: "transferFrom",
    args: [buyer.address, seller.address, identity.tokenId],
  });
  transactions.push(directTransfer.transaction);
  requireEvent(directTransfer.receipt, registrar, registrarInspectionAbi, "Transfer", (args) =>
    getAddress(args.from) === getAddress(buyer.address) && getAddress(args.to) === getAddress(seller.address) && args.tokenId === identity.tokenId);
  const stale = await snapshotMarket(chainClient, parsed, identity.tokenId, seller.address, directTransfer.receipt.blockNumber);
  expectEqual(stale.rawListing.seller, getAddress(buyer.address), "stale raw listing former seller");
  expectEqual(stale.liveListing.seller, zeroAddress, "stale public listing");

  const invalidation = await sendContract({
    id: "listingInvalidation", publicClient: chainClient, walletClient: buyerWallet, account: buyer,
    to: market, abi: marketInspectionAbi, functionName: "invalidateListing", args: [identity.tokenId],
  });
  transactions.push(invalidation.transaction);
  requireEvent(invalidation.receipt, market, marketInspectionAbi, "ListingInvalidated", (args) =>
    args.tokenId === identity.tokenId && getAddress(args.formerSeller) === getAddress(buyer.address));

  const evidenceBlockBig = await chainClient.getBlockNumber();
  const evidenceBlock = Number(evidenceBlockBig);
  const [finalRegistration, finalMarket, finalOwner, evidenceHeader] = await Promise.all([
    snapshotRegistration(chainClient, parsed, identity, registrationPlan.permitId, seller.address, evidenceBlockBig),
    snapshotMarket(chainClient, parsed, identity.tokenId, seller.address, evidenceBlockBig),
    readAt(chainClient, registrar, baseRegistrarAbi, "ownerOf", [identity.tokenId], evidenceBlockBig),
    chainClient.getBlock({ blockNumber: evidenceBlockBig }),
  ]);
  expectEqual(finalRegistration.usedPermit, true, "final permit used state");
  expectEqual(finalRegistration.nonce, readiness.nonce + 1n, "final registration nonce");
  expectEqual(getAddress(finalOwner), getAddress(seller.address), "final registrar owner");
  expectEqual(finalMarket.rawListing.seller, zeroAddress, "final raw listing");
  if (finalMarket.balance < finalMarket.liability) fail("marketplace insolvent at evidence block");

  const metadataAssertions = await verifyV2NftMetadataAcceptance({
    manifest: parsed,
    candidateOrigin: origin,
    fetcher,
    publicClient: chainClient,
    identity,
    owner: getAddress(finalOwner),
    expiry: finalRegistration.expiry,
    blockNumber: evidenceBlockBig,
  });
  const assertions = [
    passAssertion("registrationPermitConsumed", "rpc", "pre=false,post=true,event=PermitConsumed", compactPairs({ pre: permitUsedBefore, post: finalRegistration.usedPermit, eventPermitId: permitEvent.permitId })),
    passAssertion("registrationNonceIncremented", "rpc", `pre=${readiness.nonce},post=${readiness.nonce + 1n}`, compactPairs({ pre: readiness.nonce, registration: registrationState.nonce, final: finalRegistration.nonce })),
    passAssertion("registrationSettlementExact", "rpc", `controllerDelta=${readiness.expectedAmount},allowanceAfter=0,liabilityDelta=0,balance>=liability`, compactPairs({ before: controllerBalanceBefore, after: registrationState.balance, delta: registrationState.balance - asBigInt(controllerBalanceBefore, "controller balance"), allowanceAfter: registrationAllowanceAfter, liabilityBefore: controllerLiabilityBefore, liabilityAfter: registrationState.liability, solvent: registrationState.balance >= registrationState.liability })),
    passAssertion("registrarOwner", "rpc", `registration=${seller.address},final=${seller.address}`, compactPairs({ registration: registrationState.registrarOwner, final: finalOwner, expiry: finalRegistration.expiry })),
    passAssertion("registryOwner", "rpc", `registration=${seller.address},final=${seller.address}`, compactPairs({ registration: registrationState.registryOwner, final: finalRegistration.registryOwner })),
    passAssertion("resolverAddress", "rpc", `resolver=${resolver},addr=${zeroAddress}`, compactPairs({ registrationResolver: registrationState.registryResolver, finalResolver: finalRegistration.registryResolver, addr: finalRegistration.resolvedAddress })),
    passAssertion("marketplacePurchase", "receipt", `buyer=${buyer.address},price=${readiness.listingPrice},fee=${expectedFee},allowanceAfter=0`, compactPairs({ ownerAtPurchase: ownerAfterPurchase, price: purchaseEvent.price, fee: purchaseEvent.fee, allowanceAfter: buyerAllowanceAfter, listingSeller: afterPurchase.rawListing.seller })),
    passAssertion("sellerProceedsClaimed", "rpc", `accruedAndClaimed=${expectedProceeds}`, compactPairs({ before: marketBefore.proceeds, afterPurchase: afterPurchase.proceeds, afterClaim: afterClaim.proceeds, claimed: claimEvent.amount })),
    passAssertion("marketplaceLiability", "rpc", `purchaseDelta=${expectedProceeds},claimRestores=${marketBefore.liability}`, compactPairs({ before: marketBefore.liability, afterPurchase: afterPurchase.liability, afterClaim: afterClaim.liability, final: finalMarket.liability })),
    passAssertion("marketplaceSolvent", "rpc", "balance>=liability at purchase,claim,evidence", compactPairs({ purchaseBalance: afterPurchase.balance, purchaseLiability: afterPurchase.liability, claimBalance: afterClaim.balance, claimLiability: afterClaim.liability, finalBalance: finalMarket.balance, finalLiability: finalMarket.liability })),
    passAssertion("staleListingInvalidated", "rpc", `formerSeller=${buyer.address},finalSeller=${zeroAddress},owner=${seller.address}`, compactPairs({ relistedSeller: buyerListed.rawListing.seller, staleRawSeller: stale.rawListing.seller, staleLiveSeller: stale.liveListing.seller, finalRawSeller: finalMarket.rawListing.seller, finalOwner })),
    ...metadataAssertions,
  ];
  return buildFundedRunReport({
    manifest: parsed,
    // Preserve the signed/bound input shape. A promotionTargetIntent projects
    // to a deliberately non-publishable manifest with null evidence slots;
    // passing that projection back through manifest parsing would reject the
    // report only after every transaction had already completed.
    targetManifest,
    registrationSmokeBinding,
    evidenceBlock,
    generatedAt: new Date(Number(evidenceHeader.timestamp) * 1_000).toISOString(),
    transactions,
    assertions,
    sensitiveValues,
  });
}

export function parseFundedAcceptanceArgs(argv) {
  const options = {};
  const valueFlags = new Set(["--manifest", "--target-intent", "--registration-smoke", "--candidate-origin", "--candidate-basic-auth-file", "--label", "--duration-years", "--listing-price", "--broadcast", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return { help: true };
    if (!valueFlags.has(flag)) fail(`unknown argument ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`${flag} requires an explicit value`);
    index += 1;
    if (flag === "--manifest") options.manifestReference = value;
    if (flag === "--target-intent") options.targetIntentReference = value;
    if (flag === "--registration-smoke") options.registrationSmokeReference = value;
    if (flag === "--candidate-origin") options.candidateOrigin = value;
    if (flag === "--candidate-basic-auth-file") options.candidateBasicAuthFile = value;
    if (flag === "--label") options.label = value;
    if (flag === "--duration-years") options.durationYears = Number(value);
    if (flag === "--listing-price") options.listingPrice = asBigInt(value, "--listing-price");
    if (flag === "--broadcast") options.broadcastReleaseId = value;
    if (flag === "--output") options.output = value;
  }
  if (!options.manifestReference) fail("--manifest is required");
  if (!options.candidateOrigin) fail("--candidate-origin is required");
  if (!options.label) fail("--label is required");
  if (options.broadcastReleaseId !== undefined && !options.targetIntentReference) {
    fail("--target-intent is required with --broadcast");
  }
  if (options.broadcastReleaseId !== undefined && !options.registrationSmokeReference) {
    fail("--registration-smoke is required with --broadcast");
  }
  return options;
}

export const FUNDED_ACCEPTANCE_HELP = `Usage:
  node scripts/run-funded-acceptance.mjs --manifest <active-candidate.json> \\
    --candidate-origin <https://candidate.example> --label <available-label> [options]

Options:
  --duration-years <1..10>       Registration duration (default: 1)
  --listing-price <base-units>   Exact marketplace price (default: registration quote)
  --candidate-basic-auth-file <path>
                                 One-line username:password file for private ingress
  --target-intent <path-or-url>  Required for broadcast; non-publishable product-live intent
  --registration-smoke <path-or-url>
                                 Required for broadcast; canonical pre-market PASS report
  --broadcast <release-id>       Execute only when value exactly matches manifest releaseId
  --output <path>                Write deterministic JSON to this path (stdout otherwise)
  --help                         Show this help

Environment:
  PRIVATE_KEY                    Funded seller private key
  E2E_BUYER_PRIVATE_KEY          Funded, distinct buyer private key

Without --broadcast the runner is read-only and emits a DRY_RUN plan. A dry run
binds no promotion subject unless --target-intent is supplied explicitly.
`;
