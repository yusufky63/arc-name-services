# Contour name-service MCP

The stdio MCP exposes the source-verified canonical and legacy release manifests as
`contour://manifest`, exact label normalization, explicit-release Arc RPC reads,
issuer-v1 request templates, and unsigned transaction plans. It never receives a
private key, signs, broadcasts, or makes the prepared issuer HTTP requests for the
caller.

## Build and connect

```bash
pnpm install --frozen-lockfile
pnpm --filter @contour/mcp build
```

Configure a stdio-capable MCP client with absolute paths:

```json
{
  "mcpServers": {
    "contour-names": {
      "command": "node",
      "args": ["C:/absolute/path/arc-name-services/packages/mcp/dist/server.js"],
      "env": {
        "MCP_MANIFEST_PATH": "C:/absolute/path/arc-name-services/deployments/5042002.json",
        "MCP_LEGACY_MANIFEST_PATHS": "[\"C:/absolute/path/arc-name-services/deployments/5042002.legacy.json\"]",
        "ARC_RPC_URL": "https://rpc.testnet.arc.network"
      }
    },
    "arc-docs": { "url": "https://docs.arc.io/mcp" }
  }
}
```

`contour-names` is the repository-local stdio application MCP. `arc-docs` is Arc's
separate official documentation MCP; `https://docs.arc.io/mcp` is the canonical endpoint
and <https://docs.arc.io/ai/mcp> is its setup guide. The services have different trust and
tool boundaries.

`MCP_MANIFEST_PATH` is always the canonical manifest. When it is V2 and publishes
`legacyReleases`, `MCP_LEGACY_MANIFEST_PATHS` must be a JSON array containing the full
manifest for every referenced legacy release. Startup validates each release ID,
verification block, contract address/runtime hash, and pause policy. A missing,
unreferenced, duplicated, or mismatched legacy manifest fails closed.

The stdio tool list is exactly: `normalize_label`, `get_name`, `reverse_lookup`,
`prepare_issuer_request`, `prepare_approval`, `prepare_renewal`,
`prepare_market_token_approval`, `prepare_market_token_approval_revoke`,
`prepare_market_usdc_approval`, `prepare_market_listing`, `prepare_market_buy`,
`prepare_market_cancel`, `prepare_claim_proceeds`, `prepare_claim_referral`,
`prepare_transfer`, and `prepare_market_invalidate`. Every stdio tool advertises an
`outputSchema`; successful calls return the same JSON as both text content and
`structuredContent`, with bigints serialized as decimal strings.

Every tool except `normalize_label` requires an exact bytes32 `releaseId`. Read and
unsigned-plan tools resolve only that loaded release and reject omitted or unknown IDs.
`prepare_issuer_request` additionally requires the canonical V2 release ID; it never
prepares a new registration against legacy V1.

| Tool | Input | Output |
| --- | --- | --- |
| `normalize_label` | `rawLabel` | `normalized`, `changed`, label/profile/corpus hashes |
| `get_name` | `releaseId`, `label` | release ID, name, node, token ID, owner/registrant/resolver/address, content hash, expiry, availability |
| `reverse_lookup` | `releaseId`, EVM `account` | release ID, nullable `name`, `forwardConfirmed` |
| `prepare_issuer_request` | canonical V2 `releaseId`, `rawLabel`, explicit `normalizationAccepted`, `requester`, `recipient`, 1-10 `durationYears`, bytes32 `resolverDataHash`, safe `requestId`, optional `referrer` (only zero is active) | release ID, separate issuer `v1/challenges` and `v1/permits` POST templates plus a warning |
| `prepare_approval` | `releaseId`, positive decimal `amountBaseUnits` | release-bound registration-controller USDC `approval` plan |
| `prepare_renewal` | `releaseId`, normalized label, 1-10 years, positive expected amount | unsigned `renew` plan |
| `prepare_market_token_approval` | `releaseId`, uint256 decimal token ID | token-specific marketplace NFT `approval` plan |
| `prepare_market_token_approval_revoke` | `releaseId`, uint256 decimal token ID | token-specific NFT approval-clear plan; available while paused |
| `prepare_market_usdc_approval` | `releaseId`, positive decimal `amountBaseUnits` | exact marketplace USDC `approval` plan |
| `prepare_market_listing` | `releaseId`, decimal token ID, positive price and `validUntil` | unsigned `market` plan |
| `prepare_market_buy` | `releaseId`, decimal token ID, positive expected price, fee guard from 0-1000 bps | unsigned `market` plan |
| `prepare_market_cancel` | `releaseId`, uint256 decimal token ID | listing-cancellation plan; available while paused |
| `prepare_claim_proceeds` | `releaseId` | seller-liability claim plan; available while paused |
| `prepare_claim_referral` | `releaseId` | registration referral-credit claim plan |
| `prepare_transfer` | `releaseId`, non-zero, distinct EVM `from`/`to` and uint256 decimal token ID | unsigned safe registrar-token `transfer` plan |
| `prepare_market_invalidate` | `releaseId`, uint256 decimal token ID | permissionless stale-listing cleanup plan; available while paused |

Unsigned plans have the exact shape `kind`, `chainId` (`5042002`), `releaseId`, `to`,
`data`, `value` (`"0"`), and `description`. Addresses use `0x` plus 40 hex characters,
bytes32 values use `0x` plus 64 hex characters, and request IDs match
`[A-Za-z0-9._:-]{8,128}`. Integer inputs use canonical decimal strings without signs
or leading zeroes and are bounded to their ABI widths (`uint256`, or `uint64` for
listing deadlines). Transfer addresses must be valid, non-zero, and distinct.

The hosted Streamable HTTP endpoint at
`https://contour-arc.vercel.app/api/mcp` is a separate, larger surface. Its exact
tool list is `normalize_label`, `get_name`, `reverse_lookup`, `get_account_names`,
`get_market`, `prepare_registration_request`, `prepare_permit_request`,
`prepare_approval`, `prepare_renewal`, `prepare_market_token_approval`,
`prepare_market_token_approval_revoke`, `prepare_market_usdc_approval`,
`prepare_market_listing`, `prepare_market_buy`, `prepare_market_cancel`,
`prepare_claim_proceeds`, `prepare_claim_referral`, `prepare_transfer`, and
`prepare_market_invalidate`; its resource is `contour://runtime`.

The two hosted registration helper names have identical schemas. They accept
`rawLabel`, `normalizationAccepted` (default `false`), `account`, `durationYears`, and
an optional `requestId`, then return a same-origin POST template for
`/api/registration/prepare`. `prepare_permit_request` is only a compatibility alias; it
does not expose the stdio issuer-v1 templates. Conversely, stdio
`prepare_issuer_request` requires the complete issuer intent and returns the two-step
challenge/permit templates without executing them. Hosted `get_account_names` and
`get_market` return complex structured snapshots without a formal `outputSchema`; the
other seventeen hosted tools advertise output schemas. Do not infer hosted tools or input
schemas from this stdio package, or vice versa.

Read tools work against the source-verified deployed contracts. Transaction plans remain
unsigned and preserve the manifest's execution gates. The connected wallet owns
simulation, signing, broadcast, confirmation, and receipt verification.
