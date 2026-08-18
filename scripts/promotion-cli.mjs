import { lookup } from "node:dns/promises";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createPublicClient } from "viem";
import { arcTestnet } from "viem/chains";
import {
  ARC_TESTNET_RPC_URL,
  createPromotionAttestation,
  parseDeploymentManifest,
  verifyDeploymentPromotion,
} from "../packages/config/dist/index.js";
import {
  ARC_PROMOTION_RPC_RETRY_OPTIONS,
  rateLimitedArcHttp,
} from "./lib/arc-rpc-transport.mjs";

function commaList(value) {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function addressList(name) {
  const values = commaList(process.env[name]);
  if (values.some((value) => !/^0x[0-9a-fA-F]{40}$/.test(value))) {
    throw new Error(`${name} must be a comma-separated address allowlist`);
  }
  return values;
}

function contractHashMap() {
  const entries = commaList(process.env.PROMOTION_APPROVED_CONTRACT_RUNTIME_HASHES);
  const result = {};
  const allowed = new Set([
    "registry", "baseRegistrar", "controller", "publicResolver",
    "reverseRegistrar", "universalResolver", "marketplace",
  ]);
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    const key = entry.slice(0, separator);
    const value = entry.slice(separator + 1);
    if (!allowed.has(key) || Object.hasOwn(result, key) || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
      throw new Error("PROMOTION_APPROVED_CONTRACT_RUNTIME_HASHES must be unique contractKey=bytes32 entries");
    }
    result[key] = value;
  }
  return result;
}

function candidateIngressAuthorization() {
  const username = process.env.PROMOTION_CANDIDATE_INGRESS_USERNAME?.trim() ?? "";
  const password = process.env.PROMOTION_CANDIDATE_INGRESS_PASSWORD?.trim() ?? "";
  if (!username && !password) return undefined;
  if (!username || !password) {
    throw new Error("PROMOTION_CANDIDATE_INGRESS credentials must be configured together");
  }
  if (username.length > 256 || !/^[\u0021-\u007e]+$/.test(username) || username.includes(":")) {
    throw new Error("PROMOTION_CANDIDATE_INGRESS_USERNAME is invalid");
  }
  if (password.length < 32 || password.length > 3_800 || !/^[\u0020-\u007e]+$/.test(password)) {
    throw new Error("PROMOTION_CANDIDATE_INGRESS_PASSWORD must be a bounded secret of at least 32 characters");
  }
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function authenticatedCandidateSourceEnabled() {
  const value = process.env.PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE?.trim() ?? "";
  if (!["", "false", "true"].includes(value)) {
    throw new Error("PROMOTION_AUTHENTICATED_CANDIDATE_SOURCE must be true or false");
  }
  return value === "true";
}

export function parsePromotionCliArguments(argv) {
  const positional = [];
  let candidateOrigin;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--candidate-origin") {
      if (candidateOrigin !== undefined) {
        throw new Error("--candidate-origin may be supplied only once");
      }
      candidateOrigin = argv[index + 1];
      if (!candidateOrigin || candidateOrigin.startsWith("--")) {
        throw new Error("--candidate-origin requires an exact HTTPS origin");
      }
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) {
      throw new Error(`unknown promotion verification option: ${argument}`);
    }
    positional.push(argument);
  }
  if (positional.length > 2) {
    throw new Error("promotion verification accepts at most a manifest and attestation path");
  }
  return {
    manifestArgument: positional[0],
    attestationArgument: positional[1],
    candidateOrigin,
  };
}

export function promotionVerifierOptions(manifest, { candidateOrigin } = {}) {
  if (manifest?.chain?.rpcUrl !== ARC_TESTNET_RPC_URL) {
    throw new Error("promotion manifest Arc RPC is not canonical");
  }
  const configuredRpcUrl = process.env.ARC_RPC_URL?.trim();
  if (configuredRpcUrl && configuredRpcUrl !== ARC_TESTNET_RPC_URL) {
    throw new Error(`ARC_RPC_URL must exactly equal ${ARC_TESTNET_RPC_URL}`);
  }
  const rpcUrl = ARC_TESTNET_RPC_URL;
  const issuerHealthAuthorization = candidateIngressAuthorization();
  const allowAuthenticatedPrivateCandidateSource = authenticatedCandidateSourceEnabled();
  if (allowAuthenticatedPrivateCandidateSource && !issuerHealthAuthorization) {
    throw new Error("authenticated candidate-source promotion requires operator ingress credentials");
  }
  return {
    ...(rpcUrl ? { rpcUrl } : {}),
    ...(rpcUrl ? {
      publicClient: createPublicClient({
        chain: arcTestnet,
        batch: { multicall: { wait: 25 } },
        transport: rateLimitedArcHttp(rpcUrl, ARC_PROMOTION_RPC_RETRY_OPTIONS),
      }),
    } : {}),
    allowedFetchHosts: commaList(process.env.PROMOTION_ALLOWED_FETCH_HOSTS),
    approvedContractRuntimeCodeHashes: contractHashMap(),
    approvedReviewerAddresses: addressList("PROMOTION_REVIEWER_ADDRESSES"),
    ...(issuerHealthAuthorization ? { issuerHealthAuthorization } : {}),
    ...(candidateOrigin ? { privateCandidateOrigin: candidateOrigin } : {}),
    ...(allowAuthenticatedPrivateCandidateSource ? { allowAuthenticatedPrivateCandidateSource: true } : {}),
    resolveHostname: async (hostname) =>
      (await lookup(hostname, { all: true, verbatim: true })).map((entry) => entry.address),
  };
}

export function defaultAttestationPath(manifestPath) {
  return manifestPath.replace(/\.json$/i, ".promotion.json");
}

export async function verifyAndWritePromotion(
  manifestValue,
  attestationPath,
  { candidateOrigin } = {},
) {
  const manifest = parseDeploymentManifest(manifestValue);
  const report = await verifyDeploymentPromotion(
    manifest,
    promotionVerifierOptions(manifest, { candidateOrigin }),
  );
  const attestation = createPromotionAttestation(manifest, report.latestBlock);
  await writeFile(resolve(attestationPath), `${JSON.stringify(attestation, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return { report, attestation };
}

export async function writeInactivePromotion(manifestValue, attestationPath) {
  const manifest = parseDeploymentManifest(manifestValue);
  const attestation = createPromotionAttestation(manifest, null);
  await writeFile(resolve(attestationPath), `${JSON.stringify(attestation, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return attestation;
}
