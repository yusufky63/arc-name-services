import { ManifestValidationError } from "@contour/config";
import { NormalizationError, normalizeLabel } from "@contour/normalization";
import {
  getDeploymentManifest,
  getReadableReleaseManifest,
} from "../../../../lib/manifest";
import {
  CrossReleaseNameConflictError,
  readNameAcrossReleases,
} from "../../../../lib/protocol-read-model";
import { apiError, jsonResponse, OPTIONS } from "../../_shared/http";
import {
  protocolContext,
  serializeNameRecord,
} from "../../_shared/protocol";

export { OPTIONS };
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ label: string }> },
) {
  const rawLabel = (await params).label;
  if (rawLabel.length === 0 || rawLabel.length > 256) {
    return apiError(400, "INVALID_LABEL", "Provide one label of at most 256 characters.");
  }

  let normalized: ReturnType<typeof normalizeLabel>;
  try {
    normalized = normalizeLabel(rawLabel);
  } catch (error) {
    const code = error instanceof NormalizationError ? error.code : "INVALID_LABEL";
    return apiError(400, code, "The label is not valid under the pinned ENSIP-15 profile.");
  }

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
    const record = await readNameAcrossReleases(
      normalized.normalized,
      releaseId,
    );
    return jsonResponse({
      data: {
        ...serializeNameRecord(record),
        releaseKey: record.releaseKey,
        input: {
          rawLabel,
          normalizedLabel: normalized.normalized,
          normalizationChanged: normalized.changed,
        },
      },
      context,
    });
  } catch (error) {
    if (error instanceof CrossReleaseNameConflictError) {
      return apiError(
        409,
        "CROSS_RELEASE_NAME_CONFLICT",
        "The name is protected by more than one retained release.",
        context,
      );
    }
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
      "Arc RPC could not complete the name read.",
      context,
    );
  }
}
