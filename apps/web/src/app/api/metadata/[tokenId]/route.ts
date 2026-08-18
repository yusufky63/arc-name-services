import {
  buildNameNftMetadata,
  canonicalSiteUrl,
  InvalidNftLabelHintError,
  InvalidNftReleaseIdError,
  nftLabelHintFromRequestUrl,
  nftReleaseIdFromRequestUrl,
  parseNftTokenId,
} from "@/lib/nft-metadata";
import { readNftSnapshot } from "@/lib/protocol-read-model";
import { apiError, jsonResponse, OPTIONS } from "../../_shared/http";

export { OPTIONS };
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ tokenId: string }> },
) {
  const rawTokenId = (await params).tokenId;
  const tokenId = parseNftTokenId(rawTokenId);
  if (tokenId === null) {
    return apiError(
      400,
      "INVALID_TOKEN_ID",
      "Token ID must be a canonical uint256 decimal string.",
    );
  }

  try {
    const labelHint = nftLabelHintFromRequestUrl(request.url);
    const releaseId = nftReleaseIdFromRequestUrl(request.url);
    const snapshot = await readNftSnapshot(tokenId, labelHint, releaseId);
    if (!snapshot) {
      return apiError(
        404,
        "TOKEN_NOT_FOUND",
        "No registered Contour name exists for this token ID.",
      );
    }
    return jsonResponse(
      buildNameNftMetadata(snapshot, canonicalSiteUrl(request.url)),
      {
        headers: {
          "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
          "x-content-type-options": "nosniff",
        },
      },
    );
  } catch (error) {
    if (error instanceof InvalidNftLabelHintError) {
      return apiError(400, "INVALID_LABEL_HINT", error.message);
    }
    if (error instanceof InvalidNftReleaseIdError) {
      return apiError(400, "INVALID_RELEASE_ID", error.message);
    }
    return apiError(
      503,
      "NFT_METADATA_UNAVAILABLE",
      "Arc could not complete the verified NFT metadata read.",
    );
  }
}
