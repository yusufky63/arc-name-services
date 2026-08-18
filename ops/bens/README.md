# BENS operations

Current status: inactive. The canonical single-EOA release uses registry
`0xdD69B92f6fAE6da3825b7d126Fe058e78E7F8482` and registrar
`0x0DF136b94f99CAfcC010723b51f8D8EC10A0B907`, but `protocolConfigured`,
`subgraphSynced` and `hostedArcscanActive` are all false. Do not toggle them merely
because addresses now exist.

The checked-in file is a non-runnable template. `node render-config.mjs` parses
the canonical manifest and its matching promotion attestation through
`@contour/config`; it refuses to produce output until the release is active,
product-live, live-verified and explicitly marks the BENS protocol configured.
It emits both `config.generated.json` and a checksummed
`config.generated.binding.json` sidecar. The sidecar binds the exact public BENS
API and `/subgraphs/name/contour-arc-testnet` URLs because the upstream BENS
runtime schema has no self-URL or direct subgraph-URL fields.
In BENS terminology `native_token_contract` is the name registrar NFT, never
Arc USDC.

Set `BENS_IMAGE` to an immutable release plus `@sha256:` digest; `latest` is not
accepted operational policy. Expose port 8050 only behind TLS/authenticated
ingress. Activation evidence must include health/domain/address/batch endpoint
tests, a fatal-error-free synced subgraph and contract/BENS comparisons at one
pinned block.

`graph-node.compose.yaml` supplies the Graph Node/PostgreSQL/IPFS topology with
localhost-only APIs. Every image is a required operator-provided immutable
version plus digest; no floating tag is supplied.

The new seven-contract suite is deployed but its ArcScan source/ABI evidence must be
published and verified for this exact release. Activation still requires immutable ABI publication,
mapping fixtures, exact positive-block full replay, fatal-error/lag evidence, BENS
health/domain/address/lookup/batch tests, direct Arc RPC parity at one pinned block and
backup/restore/migration rollback. Self-hosted success
does not activate hosted ArcScan. Preserve outputs under the immutable evidence policy in
[`docs/EVIDENCE_POLICY.md`](../../docs/EVIDENCE_POLICY.md); incident handling is in
[`docs/OPERATIONS_RUNBOOK.md`](../../docs/OPERATIONS_RUNBOOK.md).
