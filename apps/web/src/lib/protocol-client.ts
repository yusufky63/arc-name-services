import { createPublicClient } from "viem";
import {
  ARC_TESTNET,
  deploymentManifestDigest,
  type DeploymentManifest,
} from "@contour/config";
import { ArcNameClient } from "@contour/sdk";
import { rateLimitedArcHttp, resolveCanonicalArcRpcUrl } from "./arc-rpc";

type SharedProtocolClient = {
  manifestSha256: string;
  publicClient: ReturnType<typeof createPublicClient>;
  names: ArcNameClient;
};

const sharedProtocolClients = new Map<string, SharedProtocolClient>();

/** Lazily reuses the canonical RPC transport and SDK client for server-rendered
 * pages and API routes. This also preserves a successful chain assertion across
 * warm name reads instead of paying an extra RPC round for every search. */
export function getSharedProtocolClient(
  manifest: DeploymentManifest,
): SharedProtocolClient {
  const manifestSha256 = deploymentManifestDigest(manifest);
  const cached = sharedProtocolClients.get(manifestSha256);
  if (cached) return cached;
  const publicClient = createPublicClient({
    batch: { multicall: { wait: 25 } },
    chain: ARC_TESTNET,
    transport: rateLimitedArcHttp(
      resolveCanonicalArcRpcUrl(process.env.ARC_RPC_URL, manifest.chain.rpcUrl),
    ),
  });
  const sharedProtocolClient = {
    manifestSha256,
    publicClient,
    names: new ArcNameClient(publicClient, manifest),
  };
  sharedProtocolClients.set(manifestSha256, sharedProtocolClient);
  return sharedProtocolClient;
}
