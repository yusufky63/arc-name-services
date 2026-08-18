import {
  deploymentManifestDigest,
  parseDeploymentManifest,
  type DeploymentManifest,
} from "@contour/config";
import { isHex, type Hex } from "viem";

const MAX_MANIFEST_BYTES = 256 * 1024;

export interface FetchDeploymentManifestOptions {
  /** Trusted out-of-band digest, never copied from the response itself. */
  expectedManifestSha256: Hex;
  /** Optional additional release pin. Use null when deliberately fetching a draft. */
  expectedReleaseId?: Hex | null;
  signal?: AbortSignal;
}

async function readBoundedManifest(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[0-9]+$/.test(declared) || Number(declared) > MAX_MANIFEST_BYTES)) {
    throw new Error("manifest response is too large");
  }
  if (!response.body) throw new Error("manifest response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_MANIFEST_BYTES) {
      await reader.cancel("manifest response exceeded limit");
      throw new Error("manifest response is too large");
    }
    chunks.push(value);
  }
  if (length === 0) throw new Error("manifest response is empty");
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("manifest response is invalid JSON");
  }
}

export async function fetchDeploymentManifest(
  url: string,
  options: FetchDeploymentManifestOptions,
): Promise<DeploymentManifest> {
  const parsed = new URL(url);
  const localHttp = parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname.toLowerCase());
  if ((parsed.protocol !== "https:" && !localHttp) || parsed.username || parsed.password || parsed.hash) {
    throw new Error("manifest discovery requires HTTPS (localhost excepted)");
  }
  if (
    !isHex(options.expectedManifestSha256, { strict: true }) ||
    options.expectedManifestSha256.length !== 66
  ) {
    throw new Error("expected manifest SHA-256 must be a trusted bytes32 pin");
  }
  const response = await fetch(parsed, {
    headers: { accept: "application/json" },
    redirect: "error",
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (!response.ok) throw new Error(`manifest request failed with ${response.status}`);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) throw new Error("manifest response is not JSON");
  const manifest = parseDeploymentManifest(await readBoundedManifest(response));
  if (deploymentManifestDigest(manifest).toLowerCase() !== options.expectedManifestSha256.toLowerCase()) {
    throw new Error("manifest digest does not match the trusted pin");
  }
  if (options.expectedReleaseId !== undefined && manifest.releaseId !== options.expectedReleaseId) {
    throw new Error("manifest release does not match the trusted pin");
  }
  return manifest;
}
