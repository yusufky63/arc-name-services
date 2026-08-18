import { ManifestValidationError } from "@contour/config";
import { getAddress, isAddress } from "viem";
import {
  getDeploymentManifest,
  getReadableReleaseManifest,
} from "../../../../lib/manifest";
import { readReverseAcrossReleases } from "../../../../lib/protocol-read-model";
import { apiError, jsonResponse, OPTIONS } from "../../_shared/http";
import { protocolContext } from "../../_shared/protocol";

export { OPTIONS };
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ address: string }> },
) {
  const rawAddress = (await params).address;
  if (!isAddress(rawAddress)) {
    return apiError(400, "INVALID_ADDRESS", "Provide a valid EVM address.");
  }
  const address = getAddress(rawAddress);

  let manifest;
  try {
    manifest = getDeploymentManifest();
  } catch {
    return apiError(
      503,
      "RELEASE_MANIFEST_UNAVAILABLE",
      "The deployment manifest could not be validated.",
    );
  }
  const context = protocolContext(manifest);
  const releaseValues = new URL(request.url).searchParams.getAll("release");
  const releaseId = releaseValues[0];
  if (
    releaseValues.length > 1 ||
    (releaseId !== undefined && getReadableReleaseManifest(releaseId) === null)
  ) {
    return apiError(
      400,
      "INVALID_RELEASE_ID",
      "Release must identify one readable Contour deployment.",
      context,
    );
  }

  try {
    const result = await readReverseAcrossReleases(address, releaseId);
    return jsonResponse({ data: { address, ...result }, context });
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      return apiError(
        503,
        "READ_SURFACE_UNAVAILABLE",
        "The manifest does not contain a source-verified deployed read surface.",
        context,
      );
    }
    return apiError(
      503,
      "ARC_RPC_UNAVAILABLE",
      "Arc RPC could not complete the reverse read.",
      context,
    );
  }
}
