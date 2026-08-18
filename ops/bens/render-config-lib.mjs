import { createHash } from "node:crypto";
import { isIP } from "node:net";
import {
  assertProductLivePromotionAttestation,
  parseDeploymentManifest,
} from "../../packages/config/dist/index.js";

function fail(message) {
  throw new Error(`BENS config render refused: ${message}`);
}

function isPrivateIp(hostname) {
  const value = hostname.replace(/^\[|\]$/g, "");
  const version = isIP(value);
  if (version === 4) {
    const [a, b] = value.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168);
  }
  if (version === 6) {
    const normalized = value.toLowerCase();
    return normalized === "::" || normalized === "::1" ||
      normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb");
  }
  return false;
}

export function requirePublicRuntimeUrl(value, field) {
  if (typeof value !== "string") fail(`${field} is required`);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} must be a valid public HTTPS URL`);
  }
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
    hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") ||
    isPrivateIp(hostname)
  ) {
    fail(`${field} must be a public HTTPS URL without credentials, query or fragment`);
  }
  return url;
}

export function requireBoundSubgraphName(subgraphUrl, suffix) {
  let path;
  try {
    path = decodeURIComponent(subgraphUrl.pathname).replace(/\/+$/, "");
  } catch {
    fail("bens.subgraphUrl path must be valid UTF-8");
  }
  const segments = path.split("/").filter(Boolean);
  const expected = `${suffix}-arc-testnet`;
  const tail = segments.slice(-3);
  if (tail[0] !== "subgraphs" || tail[1] !== "name" || tail[2] !== expected) {
    fail(`bens.subgraphUrl must end with /subgraphs/name/${expected}`);
  }
  return expected;
}

export function renderBensArtifacts(manifestValue, attestationValue, template) {
  const manifest = parseDeploymentManifest(manifestValue);
  assertProductLivePromotionAttestation(attestationValue, manifest);
  if (!manifest.bens.protocolConfigured) fail("bens.protocolConfigured is not true");

  const apiUrl = requirePublicRuntimeUrl(manifest.bens.apiUrl, "bens.apiUrl");
  const subgraphUrl = requirePublicRuntimeUrl(manifest.bens.subgraphUrl, "bens.subgraphUrl");
  const subgraphName = requireBoundSubgraphName(subgraphUrl, manifest.namespace.suffix);
  const registryAddress = manifest.contracts.registry.address;
  const baseRegistrarAddress = manifest.contracts.baseRegistrar.address;
  if (!manifest.namespace.suffix || !registryAddress || !baseRegistrarAddress || !manifest.releaseId) {
    fail("active namespace, registry, registrar and release bindings are required");
  }

  let configText = template;
  for (const [key, value] of Object.entries({
    suffix: manifest.namespace.suffix,
    subgraphName,
    registryAddress,
    baseRegistrarAddress,
  })) {
    configText = configText.replaceAll(`{{${key}}}`, value);
  }
  if (/{{[^}]+}}/.test(configText)) fail("config template contains unresolved values");

  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    fail("rendered BENS config is not valid JSON");
  }
  const protocol = config?.subgraphs_reader?.protocols?.contour;
  if (
    protocol?.network_id !== manifest.chain.id || protocol?.subgraph_name !== subgraphName ||
    protocol?.tld_list?.length !== 1 || protocol.tld_list[0] !== manifest.namespace.suffix ||
    protocol?.specific?.registry_contract !== registryAddress ||
    protocol?.specific?.native_token_contract !== baseRegistrarAddress
  ) {
    fail("rendered BENS config does not preserve the manifest bindings");
  }

  const normalizedConfigText = `${JSON.stringify(config, null, 2)}\n`;
  const configSha256 = `0x${createHash("sha256").update(normalizedConfigText).digest("hex")}`;
  const attestation = attestationValue;
  const binding = {
    schemaVersion: "1.0.0",
    kind: "contour-bens-runtime-binding",
    chainId: manifest.chain.id,
    releaseId: manifest.releaseId,
    manifestSha256: attestation.manifestSha256,
    productLive: true,
    liveVerified: true,
    verifiedAtBlock: manifest.activationEvidence.verifiedAtBlock,
    checkedAtBlock: attestation.checkedAtBlock,
    configSha256,
    bens: {
      apiUrl: manifest.bens.apiUrl,
      subgraphUrl: manifest.bens.subgraphUrl,
      subgraphName,
    },
  };
  // The official BENS service schema has no self-URL or direct subgraph-URL
  // fields. Preserve those exact manifest claims in a checksummed sidecar
  // instead of injecting unknown keys into the runtime config.
  return {
    configText: normalizedConfigText,
    bindingText: `${JSON.stringify(binding, null, 2)}\n`,
  };
}
