# Arc Testnet deployment manifest

`5042002.json` is the canonical machine-readable release record for Arc Testnet.

## Current release state

The single-owner Arc Testnet suite is **active and operational**. Deployment, receipt hydration,
runtime hash reconstruction, live wiring checks, seven-contract ArcScan source/ABI verification,
public issuer readiness, registration, and marketplace activation are complete.

- Release ID: `0x66aeb7b208fdfb6eb9f728a3d0b12d6d3b7132eb0e363b38f7c388c358edefdc`
- Deployer / owner / treasury / permit signer: `0x78de409a6306550882328E2a67160471368387FF`
- Governance model: one funded Arc Testnet EOA; no Safe, PostgreSQL, KMS or HSM dependency
- Deployment: 15/15 successful transactions
- Controller registrations: open (`registrationsPaused=false`)
- Marketplace execution: open (`paused=false`)
- ArcScan source verification: 7/7 verified; constructor arguments match the broadcast
- Permit issuer: active and serving wallet-bound registration permits
- Public application: `https://contour-arc-names.vercel.app`
- RPC transport: canonical HTTPS JSON-RPC only; WebSocket disabled

| Contract role | Address |
| --- | --- |
| Registry | `0xdD69B92f6fAE6da3825b7d126Fe058e78E7F8482` |
| Base registrar | `0x0DF136b94f99CAfcC010723b51f8D8EC10A0B907` |
| Controller | `0xFbA7618c929075728b82c69B0B2A8C8d98e4B6A3` |
| Public resolver | `0x3Ea097FFc2089a5Ae24DF46F18d621D007577f5C` |
| Reverse registrar | `0x5ecE3F5815813668307BdCe1405B5C765E526837` |
| Universal resolver | `0x3FAD66f9F3Ca165118D5b292Fa6036e273718Bf0` |
| Marketplace | `0xD63f77a01De40b3964051bA03F4158cceFf1ca46` |

The new receipt/wiring evidence bundle is under
[`evidence/5042002/contour-single-owner-v1/`](evidence/5042002/contour-single-owner-v1/).
The current ArcScan URL/hash index is
[`evidence/5042002/contour-v1/arcscan-source-verification.json`](evidence/5042002/contour-v1/arcscan-source-verification.json).
The older files below `contour-v1/arcscan/` are retained only as retired Safe-owned historical
snapshots and are not referenced by the current index.

## State transitions

1. `configured` records seven unique addresses, exact creation receipts, runtime hashes, the funded
   EOA role model and paused policy state.
2. `verified` additionally requires hash-pinned ArcScan source/ABI responses and the immutable
   activation artifacts.
3. `active` requires an unpaused controller/marketplace and a truthful stateless issuer whose health
   matches the chain, controller, release, signer and policy version.
4. Public-live additionally requires funded end-to-end registration, operations evidence and an exact
   `PRODUCT_LIVE_RELEASE` binding.

Unknown evidence stays `null`; placeholder URLs, hashes or transaction identifiers are forbidden.
The single EOA model is deliberately Testnet-only and its compromise/loss recovery path is a clean
redeployment with a new release ID.

ABI URLs must be paired with SHA-256 hashes. BENS protocol configuration, subgraph sync and hosted
ArcScan activation are separate capabilities and stay false until their own evidence passes. See
[`docs/EVIDENCE_POLICY.md`](../docs/EVIDENCE_POLICY.md) for artifact schemas and retention rules.
