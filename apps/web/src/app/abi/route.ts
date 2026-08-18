import { getDeploymentManifest } from "../../lib/manifest";
import {
  apiError,
  ARTIFACT_CACHE_HEADERS,
  jsonResponse,
  OPTIONS,
} from "../api/_shared/http";
import { ABI_KEYS, protocolContext } from "../api/_shared/protocol";

export { OPTIONS };

export function GET() {
  try {
    const manifest = getDeploymentManifest();
    return jsonResponse(
      {
        abiScope: "sdk-surface",
        data: ABI_KEYS.map((key) => ({
          key,
          url: `/abi/${key}.json`,
          address: key === "erc20"
            ? manifest.settlement.erc20Address
            : manifest.contracts[key].address,
        })),
        context: protocolContext(manifest),
      },
      { headers: ARTIFACT_CACHE_HEADERS },
    );
  } catch {
    return apiError(
      503,
      "ABI_INDEX_UNAVAILABLE",
      "The ABI index could not be generated from the deployment manifest.",
    );
  }
}
