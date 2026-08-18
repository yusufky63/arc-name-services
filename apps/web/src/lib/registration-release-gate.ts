import "server-only";

import {
  createPublicClient,
  type PublicClient,
} from "viem";
import {
  requireDeployedContract,
  type DeploymentManifest,
} from "@contour/config";
import { baseRegistrarAbi, controllerAbi } from "@contour/sdk";
import { getReadableReleaseManifests } from "./manifest";

export type RegistrationReleaseState = Readonly<{
  manifest: DeploymentManifest;
  registrationsPaused: boolean;
  available: boolean | null;
}>;

export type RegistrationReleaseGate = Readonly<{
  blockNumber: bigint;
  releases: readonly RegistrationReleaseState[];
  availableEverywhere: boolean | null;
  retainedReleasesClosed: boolean;
}>;

type RegistrationGateClient = Pick<
  PublicClient,
  "getBlockNumber" | "getChainId" | "readContract"
>;

function sameRelease(
  left: DeploymentManifest,
  right: DeploymentManifest,
): boolean {
  return (
    left.releaseId !== null &&
    right.releaseId !== null &&
    left.releaseId.toLowerCase() === right.releaseId.toLowerCase()
  );
}

/**
 * Reads the canonical and every retained release at one confirmed block.
 * The canonical manifest is the only registration target; retained releases
 * are queried solely to preserve global name uniqueness and prove closure.
 */
export async function readRegistrationReleaseGate(input: {
  client: RegistrationGateClient | ReturnType<typeof createPublicClient>;
  canonical: DeploymentManifest;
  tokenId?: bigint;
}): Promise<RegistrationReleaseGate> {
  const manifests = getReadableReleaseManifests();
  if (manifests.length === 0 || !sameRelease(manifests[0]!, input.canonical)) {
    throw new Error("The registration target is not the canonical readable release.");
  }
  const [chainId, latest] = await Promise.all([
    input.client.getChainId(),
    input.client.getBlockNumber({ cacheTime: 0 }),
  ]);
  if (chainId !== input.canonical.chain.id) {
    throw new Error(
      `Arc RPC chain mismatch: expected ${input.canonical.chain.id}, received ${chainId}.`,
    );
  }
  const confirmationDepth = BigInt(
    Math.max(
      1,
      ...manifests.map((manifest) => manifest.chain.confirmations),
    ),
  );
  if (latest + 1n < confirmationDepth) {
    throw new Error("Arc RPC has not reached a confirmed registration block.");
  }
  const blockNumber = latest - confirmationDepth + 1n;
  const releases = await Promise.all(
    manifests.map(async (manifest): Promise<RegistrationReleaseState> => {
      const controller = requireDeployedContract(manifest, "controller");
      const registrar = requireDeployedContract(manifest, "baseRegistrar");
      const [registrationsPaused, available] = await Promise.all([
        input.client.readContract({
          address: controller,
          abi: controllerAbi,
          functionName: "registrationsPaused",
          blockNumber,
        }),
        input.tokenId === undefined
          ? Promise.resolve(null)
          : input.client.readContract({
              address: registrar,
              abi: baseRegistrarAbi,
              functionName: "available",
              args: [input.tokenId],
              blockNumber,
            }),
      ]);
      return { manifest, registrationsPaused, available };
    }),
  );
  return Object.freeze({
    blockNumber,
    releases: Object.freeze(releases),
    availableEverywhere:
      input.tokenId === undefined
        ? null
        : releases.every((release) => release.available === true),
    retainedReleasesClosed: releases
      .slice(1)
      .every((release) => release.registrationsPaused),
  });
}
