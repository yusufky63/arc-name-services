import { getDeploymentManifest } from "../../lib/manifest";
import {
  apiError,
  ARTIFACT_CACHE_HEADERS,
  jsonResponse,
  OPTIONS,
} from "../api/_shared/http";

export { OPTIONS };
export const dynamic = "force-dynamic";

export function GET() {
  try {
    return jsonResponse(getDeploymentManifest(), {
      headers: ARTIFACT_CACHE_HEADERS,
    });
  } catch {
    return apiError(
      503,
      "RELEASE_MANIFEST_UNAVAILABLE",
      "The deployment manifest could not be validated.",
    );
  }
}
