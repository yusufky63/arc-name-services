import { getDeploymentManifest } from "../../../lib/manifest";
import {
  apiError,
  ARTIFACT_CACHE_HEADERS,
  jsonResponse,
  OPTIONS,
} from "../../api/_shared/http";
import { abiArtifact, parseAbiKey } from "../../api/_shared/protocol";

export { OPTIONS };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ contract: string }> },
) {
  const key = parseAbiKey((await params).contract);
  if (!key) {
    return apiError(
      404,
      "ABI_NOT_FOUND",
      "No public ABI exists for that contract key.",
    );
  }
  try {
    return jsonResponse(abiArtifact(key, getDeploymentManifest()), {
      headers: ARTIFACT_CACHE_HEADERS,
    });
  } catch {
    return apiError(
      503,
      "ABI_UNAVAILABLE",
      "The ABI artifact could not be generated from the deployment manifest.",
      null,
      { key },
    );
  }
}
