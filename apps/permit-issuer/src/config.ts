import { readFile } from "node:fs/promises";
import { getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { deploymentManifestDigest, parseDeploymentManifest } from "@contour/config";
import { canonicalArcRpcUrl } from "./arc-rpc.js";

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, key: string, min: number, max: number): number {
  const parsed = Number(required(env, key));
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${key} must be an integer in ${min}..${max}`);
  return parsed;
}

function optionalInteger(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number, max: number): number {
  if (!env[key]?.trim()) return fallback;
  return integer(env, key, min, max);
}

export function requiredServiceSecret(env: NodeJS.ProcessEnv, key: string): string {
  const value = required(env, key);
  if (value.length < 32) throw new Error(`${key} must contain at least 32 characters`);
  return value;
}

export function localSignerPrivateKey(env: NodeJS.ProcessEnv, key = "REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY"): Hex {
  const value = required(env, key);
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error(`${key} must be an exact 32-byte 0x-prefixed private key`);
  }
  try {
    privateKeyToAccount(value as Hex);
  } catch {
    throw new Error(`${key} is not a valid secp256k1 private key`);
  }
  return value as Hex;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const manifest = parseDeploymentManifest(JSON.parse(await readFile(required(env, "DEPLOYMENT_MANIFEST_PATH"), "utf8")));
  if (manifest.state !== "active" || !manifest.permitIssuer.active || !manifest.permitIssuer.signerAddress) {
    throw new Error("manifest does not activate permit issuance; refusing to start");
  }
  const productLive = manifest.activationEvidence.productLive;
  const productLiveRelease = env.PRODUCT_LIVE_RELEASE?.trim() ?? "";
  if (productLive) {
    const [releaseId, digest, checkedAtBlock, ...extra] = productLiveRelease.split(":");
    if (
      extra.length !== 0 || releaseId !== manifest.releaseId ||
      digest?.toLowerCase() !== deploymentManifestDigest(manifest).toLowerCase() ||
      checkedAtBlock !== manifest.activationEvidence.verifiedAtBlock!.toString()
    ) {
      throw new Error("PRODUCT_LIVE_RELEASE must bind the exact release, manifest digest and verification block");
    }
  }
  const rpcUrl = canonicalArcRpcUrl(required(env, "ARC_RPC_URL"));
  const challengeOrigin = new URL(required(env, "REGISTRATION_CHALLENGE_ORIGIN"));
  const localhostOrigin = challengeOrigin.hostname === "localhost" && challengeOrigin.protocol === "http:";
  if (challengeOrigin.protocol !== "https:" && !localhostOrigin) {
    throw new Error("REGISTRATION_CHALLENGE_ORIGIN must use HTTPS (localhost is the only exception)");
  }
  const issuerServiceBearerToken = requiredServiceSecret(env, "ISSUER_SERVICE_BEARER_TOKEN");
  const ingressClientKeyHmacSecret = requiredServiceSecret(env, "INGRESS_CLIENT_KEY_HMAC_SECRET");
  const signerPrivateKey = localSignerPrivateKey(env);
  const signerAddress = getAddress(manifest.permitIssuer.signerAddress);
  if (getAddress(privateKeyToAccount(signerPrivateKey).address) !== signerAddress) {
    throw new Error("REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY does not match the manifest signer address");
  }
  return {
    manifest,
    productLive,
    rpcUrl,
    challengeOrigin: challengeOrigin.origin,
    issuerServiceBearerToken,
    ingressClientKeyHmacSecret,
    challengeRateWindowSeconds: optionalInteger(env, "CHALLENGE_RATE_WINDOW_SECONDS", 60, 10, 3_600),
    challengeWalletLimit: optionalInteger(env, "CHALLENGE_RATE_LIMIT_PER_WALLET", 10, 1, 10_000),
    challengeClientLimit: optionalInteger(env, "CHALLENGE_RATE_LIMIT_PER_CLIENT", 60, 1, 100_000),
    trustedProxyCidrs: env.TRUSTED_PROXY_CIDRS?.split(",").map((value) => value.trim()).filter(Boolean) ?? [],
    signerPrivateKey,
    signerAddress,
    ttlSeconds: integer(env, "REGISTRATION_PERMIT_TTL_SECONDS", 15, 295),
    port: env.PORT ? integer(env, "PORT", 1, 65_535) : 8081,
  };
}
