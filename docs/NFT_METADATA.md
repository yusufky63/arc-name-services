# NFT metadata and image routes

Contour exposes release-aware metadata for registered `.contour` names:

- `GET /api/metadata/{tokenId}` returns ERC-721 compatible JSON.
- `GET /api/image/{tokenId}` returns the deterministic 1200 × 630 SVG referenced
  by that JSON.

The production base URI is exactly:

```text
https://contour-arc.vercel.app/api/metadata/
```

## Canonical V2

The canonical V2 base registrar implements ERC-165, ERC-721 and ERC-721
Metadata. For an existing token, its on-chain
`tokenURI(tokenId)` is the production base URI followed by the canonical
base-10 token ID. This lets wallets and marketplaces discover the JSON and SVG
without a Contour-specific integration.

The registrar owner can update the base URI, but the production manifest,
deployment verification and promotion gate require the exact URI above. A
different URI cannot be presented as the verified public-live V2 release.

## Retained V1 compatibility

The retained V1 registrar does not implement ERC-721 Metadata and has no
`tokenURI`. Existing V1 names are not reminted, wrapped or automatically moved
to V2. Their companion JSON and SVG remain available through the same
application routes.

Every Contour UI, API, SDK or MCP reference that can address a retained token
also carries its exact release ID. For direct V1 metadata access, pass:

```text
?release={v1-release-id}
```

The query is also accepted for V2. If it is omitted, the server resolves
canonical V2 first and then the retained V1 release. Consumers should still
persist and send the release ID because token IDs are scoped to a registrar and
must not be used as a cross-release identity.

New registrations are issued only on canonical V2. V1 registration is paused,
while V1 reads, renewal, transfer, resolver management, listing, purchase,
cancellation and proceeds claims remain available on the original contracts.

## Request validation

`tokenId` must be a canonical base-10 `uint256`: `0`, or a positive integer
without leading zeroes. `release` must be one exact readable 32-byte release ID.
The routes return:

- `400` for an invalid token ID, label hint or release ID;
- `404` when no verified registered label exists on the selected release;
- `503` when the confirmed Arc read cannot be completed.

The optional `?label={canonicalLabel}` hint helps immediately after minting,
before event indexing catches up. It is accepted only when ENSIP-15
normalization leaves it unchanged and its labelhash exactly equals `tokenId`.
Ownership, expiry and lifecycle are still read from the selected registrar at
one confirmed block.

## Verified data model

The server resolves the token ID from a registrar `NameRegistered` event or a
hash-matched canonical hint, then pins owner, expiry, active/grace state and
block timestamp reads to one confirmed Arc block. Metadata includes:

- name, description, absolute image URL and release-aware name-page URL;
- namespace, network, label length, lifecycle and expiry traits;
- release ID, registrar version, chain ID, registrar address, token ID, owner,
  lifecycle and source block.

The SVG uses only that snapshot, escapes XML text and makes no outbound image or
font request. Successful responses use short public caching; error responses
are not cached.

## Examples

```bash
# Canonical V2 tokenURI-compatible request
curl "https://contour-arc.vercel.app/api/metadata/{tokenId}"

# Explicit release-safe request (recommended for saved links and retained V1)
curl "https://contour-arc.vercel.app/api/metadata/{tokenId}?release={releaseId}"
curl "https://contour-arc.vercel.app/api/image/{tokenId}?release={releaseId}"
```

The exact response schemas and status codes are published at
`/api/openapi.json`. Public release and endpoint state is published at
`/status`.
