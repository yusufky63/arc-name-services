# Blockscout / ArcScan handoff

Current status: no BENS/hosted-ArcScan handoff has been activated. The core contract suite
is active on Arc Testnet and all seven contracts are source-verified: ArcScan v2 returns
`is_verified=true` plus ABI for each. Immutable handoff/promotion artifacts, subgraph
sync/BENS parity and hosted ArcScan operator confirmation are still missing.
`hostedArcscanActive=false` is therefore normative.

The protocol template contains `null`, not sample addresses or block zero.
`render-protocol.mjs` creates the operator handoff only from a complete Arc
deployment manifest.

Self-hosted Blockscout must use a v6-or-newer immutable image tag and digest.
Enable `MICROSERVICE_BENS_ENABLED` only after BENS acceptance passes, then point
the frontend name-service host at the same TLS endpoint. Hosted ArcScan is
outside this repository's control: keep `hostedArcscanActive=false` until the
Blockscout/ArcScan operator confirms activation with search smoke evidence.

An address or transaction page is not source verification. The operator packet must use
the canonical addresses/positive blocks from `deployments/5042002.json`, immutable
ArcScan API snapshots from
`https://testnet.arcscan.app/api/v2/smart-contracts/{address}` plus SHA-256 pairs,
Graph/BENS image digests, sync/fatal-error snapshots and name↔address fixtures. See
[`docs/BLOCKSCOUT_BENS.md`](../../docs/BLOCKSCOUT_BENS.md) and
[`docs/EVIDENCE_POLICY.md`](../../docs/EVIDENCE_POLICY.md).
