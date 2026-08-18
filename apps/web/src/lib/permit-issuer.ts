import "server-only";

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createPublicClient,
  getAddress,
  parseAbi,
  verifyTypedData,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  requireActivatedContract,
  type DeploymentManifest,
} from "@contour/config";
import { deriveNameIdentity } from "@contour/normalization";
import {
  controllerAbi,
  erc20Abi,
  registrationPermitDomain,
  registrationPermitTypes,
  type RegistrationPermit,
} from "@contour/sdk";
import { coalesceArcRpcRead, rateLimitedArcHttp } from "./arc-rpc";
import { arcTestnet } from "./network";
import { readRegistrationReleaseGate } from "./registration-release-gate";

const CHALLENGE_TTL_SECONDS = 120;
const DEFAULT_PERMIT_TTL_SECONDS = 180;
const MINIMUM_REMAINING_PERMIT_SECONDS = 30;

const issuerControllerAbi = parseAbi([
  "function permitSigner() view returns (address)",
  "function signerPolicyVersion() view returns (uint64)",
  "function registrationsPaused() view returns (bool)",
]);
const issuerRegistrarAbi = parseAbi([
  "function controllers(address controller) view returns (bool)",
]);

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BYTES32_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const MAX_WALLET_SIGNATURE_BYTES = 4_096;
const ISSUER_BASE_PATH = "/api/registration/issuer/";

export type RegistrationIntent = {
  requestId: string;
  rawLabel: string;
  normalizationAccepted: boolean;
  requester: Address;
  recipient: Address;
  payer: Address;
  authorizedExecutor: Address;
  durationYears: number;
  resolverDataHash: Hex;
  referrer: Address;
};

export type StatelessWalletChallenge = {
  id: string;
  message: string;
  expiresAt: string;
  requestId: string;
  requester: Address;
  normalizedLabel: string;
  fullName: string;
  expectedAmount: string;
  requestFingerprint: Hex;
  proof: Hex;
};

export type LocalIssuerHealth = {
  ok: boolean;
  productLive: boolean;
  chainId: number | null;
  controller: Address | null;
  releaseId: Hex | null;
  normalizationProfileHash: Hex;
  signerAddress: Address | null;
  configuredSignerAddress: Address | null;
  localSignerAddress: Address | null;
  signerReady: boolean;
  signerKind: "local-private-key";
  storage: "stateless";
  coordinationScope: "onchain-finality";
  durable: false;
  policyVersion: string | null;
  onchainPolicyVersion: string | null;
  registrationsPaused: boolean | null;
  registrarControllerEnabled: boolean | null;
  code?: "ISSUER_NOT_READY" | "ISSUER_DEPENDENCY_UNAVAILABLE";
};

export class LocalIssuerRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly retryAfter?: string,
  ) {
    super(message);
    this.name = "LocalIssuerRequestError";
  }
}

type PreparedIntent = ReturnType<typeof prepareIntent>;

let cachedSigner:
  | {
      privateKey: string;
      account: ReturnType<typeof privateKeyToAccount>;
    }
  | null = null;

function requireActiveIssuer(manifest: DeploymentManifest) {
  if (
    manifest.state !== "active" ||
    !manifest.permitIssuer.active ||
    !manifest.permitIssuer.signerAddress ||
    !manifest.permitIssuer.policyVersion ||
    !manifest.releaseId
  ) {
    throw new Error("the pinned release does not activate permit issuance");
  }
}

function configuredIssuerUrl(manifest: DeploymentManifest): URL {
  requireActiveIssuer(manifest);
  const issuer = new URL(manifest.permitIssuer.url!);
  if (
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    issuer.pathname !== ISSUER_BASE_PATH
  ) {
    throw new Error("the pinned issuer URL is not the canonical same-origin API base");
  }
  return issuer;
}

export function assertCanonicalIssuerBinding(
  manifest: DeploymentManifest,
  observedOrigin: string,
): string {
  const observed = assertOrigin(observedOrigin);
  const issuer = configuredIssuerUrl(manifest);
  const configuredAliases = [
    process.env.REGISTRATION_CHALLENGE_ORIGIN?.trim(),
    process.env.NEXT_PUBLIC_SITE_URL?.trim(),
  ].filter((v): v is string => Boolean(v && v.length > 0));
  const allowedOrigins = new Set([
    issuer.origin,
    ...configuredAliases.map(assertOrigin),
  ]);
  if (!allowedOrigins.has(observed)) {
    throw new LocalIssuerRequestError(
      "ISSUER_ORIGIN_MISMATCH",
      503,
      "The registration request is not served from the pinned issuer origin.",
    );
  }
  return observed;
}

export function isSupportedWalletSignature(value: string): value is Hex {
  return (
    /^0x(?:[0-9a-fA-F]{2})+$/.test(value) &&
    (value.length - 2) / 2 <= MAX_WALLET_SIGNATURE_BYTES
  );
}

function readChallengeSecret(): string {
  const secret = process.env.REGISTRATION_CHALLENGE_SECRET?.trim() ?? "";
  if (secret.length < 32) {
    throw new Error("REGISTRATION_CHALLENGE_SECRET must contain at least 32 characters");
  }
  return secret;
}

function readPermitTtlSeconds(): number {
  const configured = process.env.REGISTRATION_PERMIT_TTL_SECONDS?.trim();
  const ttl = configured ? Number(configured) : DEFAULT_PERMIT_TTL_SECONDS;
  const minimum = CHALLENGE_TTL_SECONDS + MINIMUM_REMAINING_PERMIT_SECONDS;
  if (!Number.isInteger(ttl) || ttl < minimum || ttl > 295) {
    throw new Error(`REGISTRATION_PERMIT_TTL_SECONDS must be an integer in ${minimum}..295`);
  }
  return ttl;
}

function getLocalSigner(manifest: DeploymentManifest) {
  requireActiveIssuer(manifest);
  // Production can use the narrowly named secret, while local development may
  // fall back to the repository-root PRIVATE_KEY loaded by scripts/dev-web.mjs.
  // This module is server-only, and neither value is ever serialized to a
  // response or exposed through a NEXT_PUBLIC_* variable.
  const configuredPrivateKey =
    process.env.REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY?.trim() ||
    process.env.PRIVATE_KEY?.trim() ||
    "";
  const privateKey = /^[0-9a-fA-F]{64}$/.test(configuredPrivateKey)
    ? `0x${configuredPrivateKey}`
    : configuredPrivateKey;
  if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY or PRIVATE_KEY must be an exact 32-byte hex key");
  }
  if (!cachedSigner || cachedSigner.privateKey !== privateKey) {
    cachedSigner = {
      privateKey,
      account: privateKeyToAccount(privateKey as Hex),
    };
  }
  const expected = getAddress(manifest.permitIssuer.signerAddress!);
  if (getAddress(cachedSigner.account.address) !== expected) {
    throw new Error("registration permit signer key does not match the pinned manifest");
  }
  return cachedSigner.account;
}

export function localPermitSignerAddress(manifest: DeploymentManifest): Address {
  return getAddress(getLocalSigner(manifest).address);
}

function createArcClient(manifest: DeploymentManifest) {
  return createPublicClient({
    chain: arcTestnet,
    batch: { multicall: { wait: 25 } },
    transport: rateLimitedArcHttp(manifest.chain.rpcUrl),
  });
}

async function readIssuerPolicySnapshot(
  client: ReturnType<typeof createArcClient>,
  controller: Address,
) {
  const chainId = await client.getChainId();
  const [activeSigner, policyVersion, registrationsPaused] = await Promise.all([
    client.readContract({
      address: controller,
      abi: issuerControllerAbi,
      functionName: "permitSigner",
    }),
    client.readContract({
      address: controller,
      abi: issuerControllerAbi,
      functionName: "signerPolicyVersion",
    }),
    client.readContract({
      address: controller,
      abi: issuerControllerAbi,
      functionName: "registrationsPaused",
    }),
  ]);
  return { chainId, activeSigner, policyVersion, registrationsPaused };
}

function prepareIntent(manifest: DeploymentManifest, input: RegistrationIntent) {
  requireActiveIssuer(manifest);
  if (input.requestId.length < 8 || input.requestId.length > 128) {
    throw new Error("requestId is outside policy");
  }
  if (!BYTES32_PATTERN.test(input.resolverDataHash)) {
    throw new Error("resolverDataHash must be bytes32");
  }
  if (!Number.isInteger(input.durationYears) || input.durationYears < 1 || input.durationYears > 10) {
    throw new Error("durationYears is outside policy");
  }
  const requester = getAddress(input.requester);
  const recipient = getAddress(input.recipient);
  const payer = getAddress(input.payer);
  const authorizedExecutor = getAddress(input.authorizedExecutor);
  const referrer = getAddress(input.referrer);
  if ([requester, recipient, payer, authorizedExecutor].some((value) => value === zeroAddress)) {
    throw new Error("registration parties must be non-zero");
  }
  if (
    requester !== recipient ||
    requester !== payer ||
    requester !== authorizedExecutor ||
    referrer !== zeroAddress
  ) {
    throw new Error("wallet-bound registration parties are invalid");
  }
  const suffix = manifest.namespace.suffix;
  if (!suffix) throw new Error("the pinned namespace is incomplete");
  const identity = deriveNameIdentity(input.rawLabel, suffix);
  if (identity.changed && !input.normalizationAccepted) {
    throw new Error("explicit ENSIP-15 normalization acceptance is required");
  }
  return {
    requestId: input.requestId,
    identity,
    requester,
    recipient,
    payer,
    authorizedExecutor,
    durationYears: input.durationYears,
    resolverDataHash: input.resolverDataHash,
    referrer,
    suffix,
    controller: requireActivatedContract(manifest, "controller"),
    releaseId: manifest.releaseId!,
  };
}

function fingerprintForOrigin(
  manifest: DeploymentManifest,
  prepared: PreparedIntent,
  expectedAmount: bigint,
  origin: string,
): Hex {
  const canonical = {
    requestId: prepared.requestId,
    normalizedLabel: prepared.identity.normalized,
    labelHash: prepared.identity.labelhash,
    namehash: prepared.identity.namehash,
    requester: prepared.requester,
    recipient: prepared.recipient,
    payer: prepared.payer,
    authorizedExecutor: prepared.authorizedExecutor,
    durationYears: prepared.durationYears,
    resolverDataHash: prepared.resolverDataHash,
    referrer: prepared.referrer,
    chainId: manifest.chain.id,
    controller: prepared.controller,
    releaseId: prepared.releaseId,
    normalizationProfileHash: manifest.normalization.profileHash,
    settlementAsset: manifest.settlement.erc20Address,
    expectedAmount: expectedAmount.toString(),
    expectedReferralBps: "0",
    origin,
  };
  return `0x${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

function challengeMessage(input: {
  manifest: DeploymentManifest;
  prepared: PreparedIntent;
  origin: string;
  expectedAmount: bigint;
  requestFingerprint: Hex;
  nonce: Hex;
  issuedAt: number;
  expiresAt: number;
}) {
  const origin = new URL(input.origin);
  return [
    "Contour Name Protocol registration intent",
    `Domain: ${origin.hostname}`,
    `Origin: ${origin.origin}`,
    `Chain ID: ${input.manifest.chain.id}`,
    `Controller: ${input.prepared.controller}`,
    `Release ID: ${input.prepared.releaseId}`,
    `Request ID: ${input.prepared.requestId}`,
    `Name: ${input.prepared.identity.name}`,
    `Requester: ${input.prepared.requester}`,
    `Recipient: ${input.prepared.recipient}`,
    `Payer: ${input.prepared.payer}`,
    `Authorized executor: ${input.prepared.authorizedExecutor}`,
    `Duration: ${input.prepared.durationYears} year(s)`,
    `Exact amount: ${input.expectedAmount} USDC base units`,
    `Resolver data hash: ${input.prepared.resolverDataHash}`,
    `Referrer: ${input.prepared.referrer}`,
    "Expected referral BPS: 0",
    `Intent fingerprint: ${input.requestFingerprint}`,
    `Challenge: ${input.nonce}`,
    `Issued at: ${input.issuedAt}`,
    `Expires at: ${input.expiresAt}`,
  ].join("\n");
}

export function createRegistrationChallengeProof(id: string, message: string): Hex {
  return `0x${createHmac("sha256", readChallengeSecret())
    .update(`contour-registration-challenge/v1\n${id}\n${message}`)
    .digest("hex")}`;
}

export function verifyRegistrationChallengeProof(
  id: string,
  message: string,
  actual: string,
): boolean {
  if (!BYTES32_PATTERN.test(actual)) return false;
  const expected = createRegistrationChallengeProof(id, message);
  return timingSafeEqual(Buffer.from(actual.slice(2), "hex"), Buffer.from(expected.slice(2), "hex"));
}

function readChallengeClock(message: string) {
  const lines = message.split("\n");
  if (lines.length !== 21) throw new Error("challenge message has an invalid shape");
  const nonceMatch = /^Challenge: (0x[0-9a-fA-F]{64})$/.exec(lines[18] ?? "");
  const issuedMatch = /^Issued at: ([0-9]{10})$/.exec(lines[19] ?? "");
  const expiresMatch = /^Expires at: ([0-9]{10})$/.exec(lines[20] ?? "");
  if (!nonceMatch || !issuedMatch || !expiresMatch) {
    throw new Error("challenge clock is invalid");
  }
  const issuedAt = Number(issuedMatch[1]);
  const expiresAt = Number(expiresMatch[1]);
  if (!Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt)) {
    throw new Error("challenge clock is outside policy");
  }
  return { nonce: nonceMatch[1] as Hex, issuedAt, expiresAt };
}

export function validateRegistrationChallengeEnvelope(input: {
  id: string;
  message: string;
  proof: string;
  now?: number;
}) {
  if (
    !UUID_PATTERN.test(input.id) ||
    input.message.length === 0 ||
    input.message.length > 4_096 ||
    !BYTES32_PATTERN.test(input.proof)
  ) {
    throw new LocalIssuerRequestError("INVALID_CHALLENGE", 400, "The wallet challenge is invalid.");
  }
  if (!verifyRegistrationChallengeProof(input.id, input.message, input.proof)) {
    throw new LocalIssuerRequestError(
      "INVALID_CHALLENGE",
      422,
      "The wallet challenge proof is invalid.",
    );
  }
  const clock = readChallengeClock(input.message);
  const now = input.now ?? Math.floor(Date.now() / 1_000);
  if (
    clock.issuedAt > now + 5 ||
    clock.expiresAt !== clock.issuedAt + CHALLENGE_TTL_SECONDS ||
    clock.expiresAt <= now
  ) {
    throw new LocalIssuerRequestError(
      "CHALLENGE_EXPIRED",
      409,
      "The wallet challenge expired. Start a fresh registration request.",
    );
  }
  return { ...clock, now };
}

function permitIdFor(input: {
  challengeId: string;
  requestFingerprint: Hex;
  requester: Address;
  nonce: bigint;
}): Hex {
  return `0x${createHmac("sha256", readChallengeSecret())
    .update(
      [
        "contour-registration-permit-id/v1",
        input.challengeId,
        input.requestFingerprint,
        input.requester,
        input.nonce.toString(),
      ].join("\n"),
    )
    .digest("hex")}`;
}

function assertOrigin(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("registration challenge origin must be credential-free HTTPS outside localhost");
  }
  return url.origin;
}

export function registrationChallengeOrigin(
  observedOrigin: string,
  manifest?: DeploymentManifest,
): string {
  const observed = assertOrigin(observedOrigin);
  const observedUrl = new URL(observed);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(observedUrl.hostname);
  if (
    manifest &&
    process.env.NODE_ENV === "development" &&
    process.env.REGISTRATION_ALLOW_LOOPBACK_CANONICAL_ORIGIN === "true" &&
    loopback
  ) {
    // Local development still signs the exact origin pinned by the canonical
    // manifest. The bridge is unavailable in production and only the root
    // `pnpm dev` launcher opts into it for loopback requests.
    return assertOrigin(configuredIssuerUrl(manifest).origin);
  }
  const configured =
    process.env.REGISTRATION_CHALLENGE_ORIGIN?.trim() ||
    process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (!configured) return observed;
  const canonical = assertOrigin(configured);
  if (canonical !== observed) throw new Error("request origin does not match the configured release origin");
  return canonical;
}

async function assertArcIssuerPolicy(
  manifest: DeploymentManifest,
  controller: Address,
) {
  const client = createArcClient(manifest);
  const registrar = requireActivatedContract(manifest, "baseRegistrar");
  const [
    { chainId, activeSigner, policyVersion, registrationsPaused },
    registrarControllerEnabled,
  ] = await Promise.all([
    readIssuerPolicySnapshot(client, controller),
    client.readContract({
      address: registrar,
      abi: issuerRegistrarAbi,
      functionName: "controllers",
      args: [controller],
    }),
  ]);
  const configuredSigner = getAddress(manifest.permitIssuer.signerAddress!);
  if (
    chainId !== manifest.chain.id ||
    getAddress(activeSigner) !== configuredSigner ||
    policyVersion.toString() !== manifest.permitIssuer.policyVersion ||
    registrationsPaused ||
    !registrarControllerEnabled
  ) {
    throw new LocalIssuerRequestError(
      "ISSUER_NOT_READY",
      503,
      "The Arc registration policy is not ready.",
    );
  }
  return client;
}

async function assertRegistrationReleaseGate(
  client: ReturnType<typeof createArcClient>,
  manifest: DeploymentManifest,
  tokenId?: bigint,
) {
  const gate = await readRegistrationReleaseGate({
    client,
    canonical: manifest,
    ...(tokenId === undefined ? {} : { tokenId }),
  });
  if (gate.releases[0]?.registrationsPaused) {
    throw new LocalIssuerRequestError(
      "ISSUER_NOT_READY",
      503,
      "New registrations are paused on the canonical release.",
    );
  }
  if (!gate.retainedReleasesClosed) {
    throw new LocalIssuerRequestError(
      "ISSUER_NOT_READY",
      503,
      "A retained release still accepts registrations.",
    );
  }
  if (gate.availableEverywhere === false) {
    throw new LocalIssuerRequestError(
      "NAME_UNAVAILABLE",
      409,
      "The name is unavailable on a current or retained release.",
    );
  }
  return gate;
}

export async function createRegistrationChallenge(input: {
  manifest: DeploymentManifest;
  intent: RegistrationIntent;
  origin: string;
}): Promise<StatelessWalletChallenge> {
  assertCanonicalIssuerBinding(input.manifest, input.origin);
  const prepared = prepareIntent(input.manifest, input.intent);
  getLocalSigner(input.manifest);
  const client = await assertArcIssuerPolicy(input.manifest, prepared.controller);
  await assertRegistrationReleaseGate(
    client,
    input.manifest,
    prepared.identity.tokenId,
  );
  const expectedAmount = await client.readContract({
    address: prepared.controller,
    abi: controllerAbi,
    functionName: "quote",
    args: [prepared.identity.normalized, BigInt(prepared.durationYears)],
  });
  if (expectedAmount <= 0n) throw new Error("controller returned a non-positive quote");
  const requestFingerprint = fingerprintForOrigin(
    input.manifest,
    prepared,
    expectedAmount,
    input.origin,
  );
  const issuedAt = Math.floor(Date.now() / 1_000);
  const expiresAt = issuedAt + CHALLENGE_TTL_SECONDS;
  const id = randomUUID();
  const message = challengeMessage({
    manifest: input.manifest,
    prepared,
    origin: input.origin,
    expectedAmount,
    requestFingerprint,
    nonce: `0x${randomBytes(32).toString("hex")}`,
    issuedAt,
    expiresAt,
  });
  return {
    id,
    message,
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
    requestId: prepared.requestId,
    requester: prepared.requester,
    normalizedLabel: prepared.identity.normalized,
    fullName: prepared.identity.name,
    expectedAmount: expectedAmount.toString(),
    requestFingerprint,
    proof: createRegistrationChallengeProof(id, message),
  };
}

function directPermitIdFor(input: {
  requestId: string;
  issuedAt: number;
  requestFingerprint: Hex;
  requester: Address;
  nonce: bigint;
}): Hex {
  return `0x${createHash("sha256")
    .update(
      [
        "contour-registration-direct-permit-id/v1",
        input.requestId,
        input.issuedAt.toString(),
        input.requestFingerprint,
        input.requester,
        input.nonce.toString(),
      ].join("\n"),
    )
    .digest("hex")}`;
}

/** Issues a wallet-bound permit directly from current Arc state. The permit
 * can only be executed by the payer/requester and remains protected by the
 * controller nonce, single-use permit ID, allowance and EIP-712 signer policy. */
export async function issueDirectRegistrationPermit(input: {
  manifest: DeploymentManifest;
  intent: RegistrationIntent;
  origin: string;
}): Promise<{ normalizedLabel: string; permit: RegistrationPermit; signature: Hex }> {
  assertCanonicalIssuerBinding(input.manifest, input.origin);
  const prepared = prepareIntent(input.manifest, input.intent);
  const signer = getLocalSigner(input.manifest);
  const client = createArcClient(input.manifest);
  const registrar = requireActivatedContract(input.manifest, "baseRegistrar");
  await assertRegistrationReleaseGate(
    client,
    input.manifest,
    prepared.identity.tokenId,
  );
  const [
    chainId,
    activeSigner,
    policyVersion,
    registrationsPaused,
    registrarControllerEnabled,
    expectedAmount,
    nonce,
    allowance,
  ] = await Promise.all([
    client.getChainId(),
    client.readContract({
      address: prepared.controller,
      abi: issuerControllerAbi,
      functionName: "permitSigner",
    }),
    client.readContract({
      address: prepared.controller,
      abi: issuerControllerAbi,
      functionName: "signerPolicyVersion",
    }),
    client.readContract({
      address: prepared.controller,
      abi: issuerControllerAbi,
      functionName: "registrationsPaused",
    }),
    client.readContract({
      address: registrar,
      abi: issuerRegistrarAbi,
      functionName: "controllers",
      args: [prepared.controller],
    }),
    client.readContract({
      address: prepared.controller,
      abi: controllerAbi,
      functionName: "quote",
      args: [prepared.identity.normalized, BigInt(prepared.durationYears)],
    }),
    client.readContract({
      address: prepared.controller,
      abi: controllerAbi,
      functionName: "nonces",
      args: [prepared.requester],
    }),
    client.readContract({
      address: input.manifest.settlement.erc20Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [prepared.payer, prepared.controller],
    }),
  ]);
  if (
    chainId !== input.manifest.chain.id ||
    getAddress(activeSigner) !== getAddress(input.manifest.permitIssuer.signerAddress!) ||
    policyVersion.toString() !== input.manifest.permitIssuer.policyVersion ||
    registrationsPaused ||
    !registrarControllerEnabled
  ) {
    throw new LocalIssuerRequestError(
      "ISSUER_NOT_READY",
      503,
      "The Arc registration policy is not ready.",
    );
  }
  if (expectedAmount <= 0n) throw new Error("controller returned a non-positive quote");
  if (allowance < expectedAmount) {
    throw new LocalIssuerRequestError(
      "USDC_AUTHORIZATION_REQUIRED",
      409,
      "USDC authorization is required before a permit can be issued.",
    );
  }

  const issuedAt = Math.floor(Date.now() / 1_000);
  const requestFingerprint = fingerprintForOrigin(
    input.manifest,
    prepared,
    expectedAmount,
    input.origin,
  );
  const permit: RegistrationPermit = {
    chainId: BigInt(input.manifest.chain.id),
    controller: prepared.controller,
    releaseId: prepared.releaseId,
    normalizationProfileHash: input.manifest.normalization.profileHash,
    normalizedLabelHash: prepared.identity.labelhash,
    namehash: prepared.identity.namehash,
    requester: prepared.requester,
    recipient: prepared.recipient,
    payer: prepared.payer,
    authorizedExecutor: prepared.authorizedExecutor,
    durationYears: BigInt(prepared.durationYears),
    resolverDataHash: prepared.resolverDataHash,
    referrer: prepared.referrer,
    settlementAsset: input.manifest.settlement.erc20Address,
    expectedAmount,
    expectedReferralBps: 0n,
    permitId: directPermitIdFor({
      requestId: prepared.requestId,
      issuedAt,
      requestFingerprint,
      requester: prepared.requester,
      nonce,
    }),
    nonce,
    issuedAt: BigInt(issuedAt),
    validAfter: BigInt(issuedAt - 5),
    validUntil: BigInt(issuedAt + readPermitTtlSeconds()),
  };
  const signature = await signer.signTypedData({
    domain: registrationPermitDomain(permit.controller),
    types: registrationPermitTypes,
    primaryType: "RegistrationPermit",
    message: permit,
  });
  const signatureValid = await verifyTypedData({
    address: getAddress(input.manifest.permitIssuer.signerAddress!),
    domain: registrationPermitDomain(permit.controller),
    types: registrationPermitTypes,
    primaryType: "RegistrationPermit",
    message: permit,
    signature,
  });
  if (!signatureValid) throw new Error("local signer produced an invalid EIP-712 signature");
  return { normalizedLabel: prepared.identity.normalized, permit, signature };
}

export async function issueRegistrationPermit(input: {
  manifest: DeploymentManifest;
  intent: RegistrationIntent;
  origin: string;
  challengeId: string;
  challengeMessage: string;
  challengeProof: Hex;
  challengeSignature: Hex;
}): Promise<{ normalizedLabel: string; permit: RegistrationPermit; signature: Hex }> {
  assertCanonicalIssuerBinding(input.manifest, input.origin);
  if (!isSupportedWalletSignature(input.challengeSignature)) {
    throw new LocalIssuerRequestError("INVALID_CHALLENGE", 400, "The wallet challenge is invalid.");
  }
  const { now, ...clock } = validateRegistrationChallengeEnvelope({
    id: input.challengeId,
    message: input.challengeMessage,
    proof: input.challengeProof,
  });

  const prepared = prepareIntent(input.manifest, input.intent);
  const signer = getLocalSigner(input.manifest);
  const client = await assertArcIssuerPolicy(input.manifest, prepared.controller);
  await assertRegistrationReleaseGate(
    client,
    input.manifest,
    prepared.identity.tokenId,
  );
  const [expectedAmount, nonce, allowance] = await Promise.all([
    client.readContract({
      address: prepared.controller,
      abi: controllerAbi,
      functionName: "quote",
      args: [prepared.identity.normalized, BigInt(prepared.durationYears)],
    }),
    client.readContract({
      address: prepared.controller,
      abi: controllerAbi,
      functionName: "nonces",
      args: [prepared.requester],
    }),
    client.readContract({
      address: input.manifest.settlement.erc20Address,
      abi: erc20Abi,
      functionName: "allowance",
      args: [prepared.payer, prepared.controller],
    }),
  ]);
  if (expectedAmount <= 0n) throw new Error("controller returned a non-positive quote");
  const requestFingerprint = fingerprintForOrigin(
    input.manifest,
    prepared,
    expectedAmount,
    input.origin,
  );
  const expectedMessage = challengeMessage({
    manifest: input.manifest,
    prepared,
    origin: input.origin,
    expectedAmount,
    requestFingerprint,
    nonce: clock.nonce,
    issuedAt: clock.issuedAt,
    expiresAt: clock.expiresAt,
  });
  if (input.challengeMessage !== expectedMessage) {
    throw new LocalIssuerRequestError(
      "INTENT_STALE",
      409,
      "The signed registration intent no longer matches Arc state.",
    );
  }
  const walletSignatureValid = await client.verifyMessage({
    address: prepared.requester,
    message: input.challengeMessage,
    signature: input.challengeSignature,
  });
  if (!walletSignatureValid) {
    throw new LocalIssuerRequestError(
      "INVALID_CHALLENGE_SIGNATURE",
      422,
      "The wallet challenge signature is invalid.",
    );
  }
  if (allowance < expectedAmount) {
    throw new LocalIssuerRequestError(
      "USDC_AUTHORIZATION_REQUIRED",
      409,
      "USDC authorization is required before a permit can be issued.",
    );
  }

  const permitTtl = readPermitTtlSeconds();
  const validUntil = clock.issuedAt + permitTtl;
  if (validUntil - now < MINIMUM_REMAINING_PERMIT_SECONDS) {
    throw new LocalIssuerRequestError(
      "CHALLENGE_EXPIRED",
      409,
      "The permit window is too close to expiry. Start a fresh registration request.",
    );
  }
  const permit: RegistrationPermit = {
    chainId: BigInt(input.manifest.chain.id),
    controller: prepared.controller,
    releaseId: prepared.releaseId,
    normalizationProfileHash: input.manifest.normalization.profileHash,
    normalizedLabelHash: prepared.identity.labelhash,
    namehash: prepared.identity.namehash,
    requester: prepared.requester,
    recipient: prepared.recipient,
    payer: prepared.payer,
    authorizedExecutor: prepared.authorizedExecutor,
    durationYears: BigInt(prepared.durationYears),
    resolverDataHash: prepared.resolverDataHash,
    referrer: prepared.referrer,
    settlementAsset: input.manifest.settlement.erc20Address,
    expectedAmount,
    expectedReferralBps: 0n,
    permitId: permitIdFor({
      challengeId: input.challengeId,
      requestFingerprint,
      requester: prepared.requester,
      nonce,
    }),
    nonce,
    issuedAt: BigInt(clock.issuedAt),
    validAfter: BigInt(clock.issuedAt - 5),
    validUntil: BigInt(validUntil),
  };
  const signature = await signer.signTypedData({
    domain: registrationPermitDomain(permit.controller),
    types: registrationPermitTypes,
    primaryType: "RegistrationPermit",
    message: permit,
  });
  const signatureValid = await verifyTypedData({
    address: getAddress(input.manifest.permitIssuer.signerAddress!),
    domain: registrationPermitDomain(permit.controller),
    types: registrationPermitTypes,
    primaryType: "RegistrationPermit",
    message: permit,
    signature,
  });
  if (!signatureValid) throw new Error("local signer produced an invalid EIP-712 signature");
  return { normalizedLabel: prepared.identity.normalized, permit, signature };
}

async function readLocalIssuerHealthUncoalesced(
  manifest: DeploymentManifest,
): Promise<{ status: 200 | 503; body: LocalIssuerHealth }> {
  const controller = manifest.contracts.controller.address;
  const configuredSigner = manifest.permitIssuer.signerAddress
    ? getAddress(manifest.permitIssuer.signerAddress)
    : null;
  const base = {
    productLive: manifest.activationEvidence.productLive,
    controller,
    releaseId: manifest.releaseId,
    normalizationProfileHash: manifest.normalization.profileHash,
    configuredSignerAddress: configuredSigner,
    signerKind: "local-private-key" as const,
    storage: "stateless" as const,
    coordinationScope: "onchain-finality" as const,
    durable: false as const,
    policyVersion: manifest.permitIssuer.policyVersion,
  };
  try {
    requireActiveIssuer(manifest);
    configuredIssuerUrl(manifest);
    if (!controller || !configuredSigner) throw new Error("issuer metadata is incomplete");
    const localSignerAddress = localPermitSignerAddress(manifest);
    const client = createArcClient(manifest);
    const registrar = requireActivatedContract(manifest, "baseRegistrar");
    const releaseGate = await readRegistrationReleaseGate({
      client,
      canonical: manifest,
    });
    const [
      {
        chainId,
        activeSigner: signerAddress,
        policyVersion: onchainPolicyVersion,
        registrationsPaused,
      },
      registrarControllerEnabled,
    ] = await Promise.all([
      readIssuerPolicySnapshot(client, controller),
      client.readContract({
        address: registrar,
        abi: issuerRegistrarAbi,
        functionName: "controllers",
        args: [controller],
      }),
    ]);
    const normalizedSignerAddress = getAddress(signerAddress);
    const signerReady =
      localSignerAddress === configuredSigner && normalizedSignerAddress === configuredSigner;
    const ready =
      chainId === manifest.chain.id &&
      signerReady &&
      onchainPolicyVersion.toString() === manifest.permitIssuer.policyVersion &&
      !registrationsPaused &&
      registrarControllerEnabled &&
      !releaseGate.releases[0]?.registrationsPaused &&
      releaseGate.retainedReleasesClosed;
    const body: LocalIssuerHealth = {
      ok: ready,
      ...base,
      chainId,
      signerAddress: normalizedSignerAddress,
      localSignerAddress,
      signerReady,
      onchainPolicyVersion: onchainPolicyVersion.toString(),
      registrationsPaused,
      registrarControllerEnabled,
      ...(ready ? {} : { code: "ISSUER_NOT_READY" as const }),
    };
    return { status: ready ? 200 : 503, body };
  } catch {
    return {
      status: 503,
      body: {
        ok: false,
        ...base,
        chainId: null,
        signerAddress: null,
        localSignerAddress: null,
        signerReady: false,
        onchainPolicyVersion: null,
        registrationsPaused: null,
        registrarControllerEnabled: null,
        code: "ISSUER_DEPENDENCY_UNAVAILABLE",
      },
    };
  }
}

export function readLocalIssuerHealth(
  manifest: DeploymentManifest,
): Promise<{ status: 200 | 503; body: LocalIssuerHealth }> {
  const key = [
    "issuer-health",
    manifest.chain.rpcUrl,
    manifest.releaseId,
    manifest.activationEvidence.verifiedAtBlock,
    manifest.activationEvidence.controllerPolicy.registrationsPaused,
    manifest.permitIssuer.signerAddress,
    manifest.permitIssuer.policyVersion,
  ].join(":");
  return coalesceArcRpcRead(key, () => readLocalIssuerHealthUncoalesced(manifest));
}
