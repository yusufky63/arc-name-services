# Arc BENS subgraph

Current status: the seven-contract Arc Testnet suite and canonical manifest are `active`,
but `activationEvidence.productLive` and every BENS capability remain false. This subgraph
has not been activated, deployed or synced.
All seven contracts are source-verified on ArcScan and its v2 API returns their ABIs.
Verifier-compatible immutable ABI publication, mapping fixtures, Graph Node replay, BENS
parity and hosted ArcScan operator activation remain incomplete; all BENS manifest flags
stay false.

The schema preserves BENS's owner/registrant/resolver distinctions and records
registration cost, expiry and token ID. Controller plaintext is accepted only
when its UTF-8 labelhash and base-node namehash both match, preventing hash
placeholder drift. ASCII `.` plus `。`, `．`, and `｡` are rejected, and the mapping
pins the canonical normalization corpus hash. USDC transfer events are not indexed,
so Arc's native and ERC-20 views cannot be double-counted here.

Resolver switches, zero-address records, version resets, TTL resets and ERC-721 burns
clear stale derived state. A successful re-registration emits the resolver
`VersionChanged` reset and registry `NewTTL(..., 0)` before the new owner is final.
`NameChanged` is indexed only as an event candidate: this
subgraph never labels reverse data verified. Consumers must call
`ArcReverseRegistrar.name(account)` (or reproduce its exact ACTIVE,
single-label and forward-address checks) before displaying a primary name.

`npm run build` validates the inactive scaffold and then performs real Graph
codegen plus a WASM build from an address-less, compile-only render of the
production template. `npm run build:activated` renders `subgraph.yaml`, runs
the same codegen/compiler path, and proceeds only after the release
manifest has a suffix/base node plus real contract addresses and positive
deployment blocks. The activated renderer also validates the exact promotion
attestation and requires a live-verified, product-live manifest; raw manifest JSON
cannot bypass this gate. No `startBlock: 0` or sample address is accepted.

Configured data-source inputs are:

| Source | Address | Start block |
| --- | --- | --- |
| Registry | `0xdD69B92f6fAE6da3825b7d126Fe058e78E7F8482` | `52188612` |
| Base registrar | `0x0DF136b94f99CAfcC010723b51f8D8EC10A0B907` | `52188614` |
| Controller | `0xFbA7618c929075728b82c69B0B2A8C8d98e4B6A3` | `52188614` |
| Public resolver | `0x3Ea097FFc2089a5Ae24DF46F18d621D007577f5C` | `52188614` |

These values are indexing inputs, not a BENS activation signal. `npm run build:activated`
is expected to fail while the release is `active + productLive:false` and BENS flags are false; do not bypass
that gate by hand-writing `subgraph.yaml`.

Before deployment, synchronize the mapping grace-period fixture with the
registrar constant and add Matchstick fixtures for register, renew, ERC-721
transfer, resolver, text and reverse events. Hosted ArcScan visibility remains
false until Graph Node sync, BENS API parity and operator activation are proven.
Evidence must include immutable image/commit/ABI hashes, exact-block replay logs,
fatal-error and lag snapshots, name/address/batch endpoint fixtures, direct-RPC parity at
one pinned block, and backup/restore rollback. See
[`docs/BLOCKSCOUT_BENS.md`](../../docs/BLOCKSCOUT_BENS.md) and
[`docs/EVIDENCE_POLICY.md`](../../docs/EVIDENCE_POLICY.md).
