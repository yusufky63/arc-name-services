import { getRuntimeDiscoveryDocument } from "../../lib/manifest";
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
    return jsonResponse(getRuntimeDiscoveryDocument(), {
      headers: ARTIFACT_CACHE_HEADERS,
    });
  } catch {
    return apiError(
      503,
      "RUNTIME_DISCOVERY_UNAVAILABLE",
      "The HTTPS runtime discovery document could not be generated.",
    );
  }
}
