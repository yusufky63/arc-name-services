# Arc Testnet Name Service — Contracts

Self-contained Foundry implementation of the seven-contract, no-proxy Arc Testnet name-service
suite described by the project specification. This package is deployable source, not evidence of a
live deployment. It does not claim to be an official Arc or Circle name service.

The binding release identity is **Contour Name Protocol** with planned suffix **`.contour`**. The
contracts keep the base node/suffix as deployment wiring so their bytecode can be tested before
deployment, but a release manifest using another suffix is not compliant with `PROJECT_SPEC.md`.

## Network and accounting boundary

- Target chain: Arc Testnet (`5042002`, `eip155:5042002`).
- Settlement asset at deployment: Arc application USDC
  (`0x3600000000000000000000000000000000000000`, 6 decimals).
- Every application price and liability is a 6-decimal ERC-20 base-unit amount.
- None of the seven contracts exposes `receive`, a payable application path, or a native-balance
  sweep. Treasury, referral, and seller payments use only the ERC-20 interface.
- Collections and payouts verify the contract's exact `balanceOf` delta. Fee-on-transfer or other
  non-exact behavior reverts the whole operation, including permit/nonces and liabilities.
- `address.balance` and ERC-20 `balanceOf` are never added together. Arc exposes one underlying USDC
  balance through native 18-decimal and ERC-20 6-decimal interfaces; treating them as independent
  assets would make the accounting unsafe. See the official
  [stablecoin-native model](https://docs.arc.io/arc/concepts/stablecoin-native-model) and
  [porting guidance](https://docs.arc.io/arc/tutorials/porting-contracts-to-arc).

The source pins Solidity `0.8.24` in `foundry.toml` and vendors its small interfaces/libraries. It
does not download OpenZeppelin or another runtime dependency.

## The seven contracts

1. `ArcNameRegistry` is the ENS-shaped owner/resolver/TTL source of truth. It implements the required
   getters, setters, events, and ENS-style operator approvals.
2. `ArcBaseRegistrar` is the ERC-721 lease registrar. `tokenId == uint256(labelhash)`, controllers
   alone register/renew, transfers are disabled outside ACTIVE state, and every active NFT transfer
   synchronizes registry ownership. Expired tokens remain non-transferable during grace and can be
   renewed; after the fixed 90-day grace the label can be re-registered. Only the current NFT
   registrant can renew through the controller. Every registration advances the selected resolver's
   record version and resets the registry TTL to zero before assigning the final owner, so records
   or a custom TTL from an earlier lease cannot survive.
3. `ArcRegistrarController` has no commit/reveal and no naked public registration function. Direct
   registration requires one short-lived, single-use EIP-712 `RegistrationPermit`, an exact current
   price/referral match, the authorized executor, an available label, and an exact USDC delta. It
   keeps referral credits as liabilities and exposes only surplus to treasury withdrawal.
4. `ArcPublicResolver` supports EVM/multicoin addresses, text, name, contenthash, interface records,
   record-version clearing, BENS-relevant events, and a node-checked initialization multicall.
5. `ArcReverseRegistrar` owns `<lowercase-address>.addr.reverse`. It accepts only
   `<normalized-label>.<configured-suffix>` primary names and returns a name only while the forward
   name is ACTIVE and resolves back to the account.
6. `ArcUniversalResolver` is intentionally narrower than the ENS CCIP-Read Universal Resolver. It
   provides bounded on-chain address, text, name, and forward-confirmed reverse reads. Name bytes,
   label count, key/value sizes, resolver gas, and copied return data are all capped.
7. `ArcNameMarketplace` is non-custodial fixed-price trading only. Purchases bind the expected price
   and current fee, require ACTIVE ownership and live approval, credit pull-payment proceeds, and
   protect seller liabilities from fee withdrawals. NFT ownership/approval/expiry dynamically
   invalidates a listing; anyone can persist that invalidation. Pause blocks listing/buying but not
   cancel, invalidation, or proceeds claims.

There are no proxies, auctions, offers, subdomain sales, multiple settlement assets, native sweep,
or governance token paths.

## Registration permit

EIP-712 domain:

```text
name:              Arc Registrar Controller
version:           1
chainId:           current block.chainid
verifyingContract: deployed controller
```

The exact primary type is:

```text
RegistrationPermit(
  uint256 chainId,
  address controller,
  bytes32 releaseId,
  bytes32 normalizationProfileHash,
  bytes32 normalizedLabelHash,
  bytes32 namehash,
  address requester,
  address recipient,
  address payer,
  address authorizedExecutor,
  uint256 durationYears,
  bytes32 resolverDataHash,
  address referrer,
  address settlementAsset,
  uint256 expectedAmount,
  uint256 expectedReferralBps,
  bytes32 permitId,
  uint256 nonce,
  uint256 issuedAt,
  uint256 validAfter,
  uint256 validUntil
)
```

The SDK/issuer must hash `resolverData` as `keccak256(abi.encode(bytes[]))`. The controller exposes
`hashPermit`, `domainSeparator`, `nonces(requester)`, and `usedPermit(permitId)` for parity and
issuance checks.

Registration and label-aware quoting are:

```solidity
register(
    string normalizedLabel,
    RegistrationPermit permit,
    bytes[] resolverData,
    bytes signature
) returns (uint256 tokenId, uint256 expires)

quote(string normalizedLabel, uint256 durationYears) returns (uint256 amount)
```

The controller does not claim to implement ENSIP-15 Unicode normalization on-chain. The issuer and
clients must run the exact pinned ENSIP-15 release/corpus. On-chain checks bind those normalized
bytes to the immutable profile hash, `labelhash`, `namehash`, token ID, event string, resolver data,
and signature. UTF-8 must be canonical; ASCII `.` and the ENS-equivalent separators `。` (U+3002),
`．` (U+FF0E), and `｡` (U+FF61) are rejected with control characters. Labels must be shorter than
64 UTF-8 bytes and 64 Unicode code points. Clients also re-check for dots after normalization.

The normalized Unicode code-point count—not byte length—selects the binding annual price tier:

```text
1 code point  -> 5_000_000 USDC base units
2 code points -> 2_500_000 USDC base units
3 code points -> 1_000_000 USDC base units
4+            ->   500_000 USDC base units
```

All permit domain/profile/release/party/executor/duration/resolver/asset/price/referral/ID/nonce/time/
signature/availability checks occur before payment. The permit and requester nonce mutate before
external calls as a reentrancy defense, but EVM revert atomicity restores both if payment, resolver
initialization, or registration fails. Two different permit IDs issued with the same requester
nonce cannot both succeed.

The wallet-bound controller invariant is `requester == payer == authorizedExecutor == msg.sender`.
The recipient may differ for gifting. This equality is checked on-chain as well as by the issuer, so
even a compromised permit signer cannot name an unrelated approved wallet as payer on this route.

`durationYears` is limited to 1–10 and uses 365-day contract years. Permit validity is hard-capped at
300 seconds; a `validAfter` up to five seconds before `issuedAt` fits that bounded window. Grace is
the fixed `7_776_000` seconds required by the BENS mapping. Price tiers are constants rather than
admin inputs. Initial referral BPS, release ID, normalization profile hash, suffix, treasury, signer,
and marketplace fee remain explicit deployment inputs.

Permit signer replacement is a two-step 24-hour delayed proposal/activation. The owner can revoke a
compromised signer immediately, which fail-closes new registration. `signerPolicyVersion` and events
make proposals, activations, and revocations observable. This Arc Testnet release uses one funded EOA
as deployer, protocol owner, treasury, and initial permit signer. One compromised key therefore
controls administration, treasury, and permit issuance; this is an accepted Testnet tradeoff rather
than a production custody recommendation. Referral BPS and
treasury are owner-rotatable; release/profile/asset/base node/resolver, code-point pricing, grace, and
maximum permit validity are immutable for a deployment.

## Deployment order and required ownership wiring

Use verified, non-placeholder inputs. A deployment must perform these steps atomically where
practical and record each actual deployment block in the public manifest:

1. Deploy `ArcNameRegistry` with the funded governance EOA as final root owner.
2. Compute the configured suffix `baseNode` with ENS namehash and deploy `ArcBaseRegistrar`.
3. Deploy `ArcPublicResolver` and `ArcRegistrarController`.
4. Assign the suffix subnode in the registry to `ArcBaseRegistrar`; without this, register and NFT
   transfer registry synchronization correctly revert.
5. Enable only `ArcRegistrarController` as a registrar controller.
6. Create `reverse` temporarily, compute canonical `addr.reverse`, deploy `ArcReverseRegistrar`,
   then assign `addr.reverse` to it. Its constructor rejects a non-canonical reverse node or a suffix
   whose namehash does not equal the registrar base node.
7. Deploy `ArcUniversalResolver` and `ArcNameMarketplace`.
8. Leave registration and marketplace execution paused, keep the governance EOA as the final admin,
   and confirm every two-step `pendingOwner` remains zero.
9. Verify source, constructor arguments, controller allowlist, suffix/reverse ownership, permit signer,
   treasury, price/fee/grace values, and settlement address before enabling issuance.

The checked-in `script/DeployArcNameService.s.sol` enforces Arc Testnet, the canonical 6-decimal
USDC interface, a non-zero role configuration, and one EOA shared exactly by the deployer, protocol
owner, treasury, and initial permit signer before it broadcasts. Contract accounts and every split
role configuration are rejected. The script reads only public configuration values:

```text
DEPLOYER_ADDRESS, OWNER_ADDRESS, TREASURY_ADDRESS, PERMIT_SIGNER_ADDRESS,
RELEASE_ID, REFERRAL_BPS, MARKETPLACE_FEE_BPS
```

For a fresh Foundry deployment, prefer a Foundry keystore or hardware wallet:

```bash
forge script --root contracts script/DeployArcNameService.s.sol:DeployArcNameService \
  --rpc-url https://rpc.testnet.arc.network \
  --account <foundry-keystore-account> \
  --sender "$DEPLOYER_ADDRESS" \
  --broadcast
```

The Arc Testnet operator utilities also support the deliberately simplified, gitignored root
`.env` model documented in the repository deployment guide. That local exception never permits a
private key in a CLI argument, Vercel source upload, browser variable, build log, source map or
evidence file. A key read by an operator utility is normalized in memory and never printed.

After a completed broadcast, prepare deterministic evidence offline. This command parses the saved
Foundry receipt, reads only the seven local build artifacts and the draft manifest, and writes to a
new gitignored directory. It does not read environment variables, call RPC, load a wallet, send a
transaction, or overwrite the canonical manifest:

```bash
pnpm prepare:deployment-evidence \
  --broadcast contracts/broadcast/DeployArcNameService.s.sol/5042002/run-latest.json \
  --output-dir deployments/local/5042002-prepared
```

The parser requires the exact 15-transaction deployment/wiring sequence and successful receipts. It
decodes constructor and call inputs from transaction calldata, validates the pinned Arc constants,
and reconstructs runtime bytecode by applying constructor immutables to the reviewed Foundry
artifacts. The output directory contains:

- `deployment-evidence.json`: receipt/artifact hashes, constructor wiring, runtime hashes, and the
  remaining live-verification limitations;
- `manifest.configured.json`: a schema-validated `configured` candidate that remains paused,
  unverified, issuer-inactive, and not product-live;
- `deployment.public.env`: explicitly public addresses, transaction/block evidence, and runtime
  hashes. It never contains private keys, mnemonics, credentials, or token values.

The output directory must not already exist. Preserve the original Foundry receipt independently;
the generated runtime hashes still require comparison with live Arc bytecode during promotion.

The broadcaster is bound to `DEPLOYER_ADDRESS`, so a wallet mismatch fails. The script deploys and
wires exactly seven product contracts, transfers registry root and `reverse` parent control to the
same final governance EOA, and leaves registration and the marketplace paused. Registrar, controller,
and marketplace ownership is final immediately because the broadcaster is already their constructor
owner; no acceptance transaction is required and each `pendingOwner` must be zero. The owner may
unpause only after source verification, manifest evidence, permit-signer readiness, and funded
acceptance gates pass.

### Superseded Arc Testnet Safe deployment

Release ID:
`0xcb31300ed4857f0ffdb9c3c613818182ea920d1547c58d3beb8cfdb821056bf6`

Legacy protocol and treasury Safe:
`0xF7c92493f58bBddb1Eb7B8f67AA55e5789a4FB68`

| Contract | Address |
| --- | --- |
| `ArcNameRegistry` | `0xE1d5A977A3e73f64C1A64cFebCc6E206D259e3ff` |
| `ArcBaseRegistrar` | `0x6C47Bf685914cf7469939bE255FE21702Cb0eBd7` |
| `ArcRegistrarController` | `0x3cFB9b49359C338E22Ee7C7520080C5c0D494911` |
| `ArcPublicResolver` | `0x8B007f3755e18202944C8FbF09fCE6005492881F` |
| `ArcReverseRegistrar` | `0xEb5D81D7a90cEf350245974E6ADC8502A2c241de` |
| `ArcUniversalResolver` | `0x3E8d895b1F026F989dceE868B5079DF9eB17f33e` |
| `ArcNameMarketplace` | `0x4e37a666Ca60aFF7E47d1C962D1B69a720a0846b` |

These addresses describe the earlier 2-of-3 Safe deployment and are not the single-EOA release
specified above. They remain useful only as historical address discovery and must not be promoted as
the new release. A fresh EOA-governed deployment needs its own release ID, receipts, runtime hashes,
source verification, manifest, and activation evidence.

### Post-deployment closure procedure

1. Copy the complete Foundry broadcast receipt out of the gitignored `broadcast/` directory before
   any clean command. Hash and publish it as immutable evidence without keystore material, RPC
   credentials or environment dumps.
2. Record every direct creation transaction and positive block for the seven addresses. Keep the
   namespace/controller/setup/pause/ownership transactions in the deployment receipt and constructor
   wiring evidence even though the public manifest has one creation transaction per contract.
3. ArcScan source verification and hash-pinned public source/ABI responses are complete for all
   seven roles. Independently rebuild each role and approve the seven role-keyed runtime hashes;
   do not derive CI trust roots by copying the candidate manifest.
4. Capture the exact governance address, prove it equals deployer, owner, and treasury, confirm it has
   no runtime code at the pinned block, and record the final zero `pendingOwner` state for all three
   two-step-owned contracts.
5. Publish the six non-live evidence artifacts defined by
   [`docs/EVIDENCE_POLICY.md`](../docs/EVIDENCE_POLICY.md), then run the promotion verifier at a pinned
   Arc block. A configured release remains paused while any URL/hash or independent review is absent.
6. Activate the issuer only in an isolated private-candidate rollout. Unpause through the governance
   EOA only when permit-signer health and rollback access are ready; any failed parity check requires
   an immediate re-pause before retry.

The deployment script is a multi-transaction ceremony and has no documented safe resume point. If a
broadcast is partial, preserve its receipts as an abandoned attempt, assess every emitted address,
and use a new release ID for a clean redeployment unless an independently reviewed recovery plan
proves the exact remaining sequence. Never silently merge partial and replacement deployments into
one manifest.

Hosted ArcScan/BENS support is a separate operator integration and is not implied by these contracts.
Controller/registrar/resolver events retain the plaintext normalized label and ENS/BENS-shaped
registration, renewal, transfer, resolver, and reverse semantics needed by that read model.

### Resolver state at lease boundaries

During registration the registrar temporarily owns the registry node. While that authorization is
active it calls `ArcPublicResolver.clearRecords(node)`, which increments `recordVersions` and emits
the BENS-compatible `VersionChanged` event. It then selects the resolver, applies only the new
permit-bound initialization calls, resets the registry TTL to `0`, and assigns the node to the
recipient. An arbitrary caller cannot
perform this reset because `clearRecords` retains normal registry owner/operator authorization.

Reset, payment, permit consumption, ERC-721 replacement, resolver initialization, and final owner
assignment occur in one transaction. If any initialization call fails, the version increment and all
other changes revert; the prior lease's records remain intact until a complete replacement succeeds.

## Test suite

Run:

```bash
forge fmt --root contracts --check
forge build --root contracts
forge test --root contracts --threads 1
```

The serialized test command above is the release-documentation command; a checked-in source tree is
not deployment evidence, and this README does not freeze a test count that can become stale.

Covered cases include registry authorization/interface state, ERC-721 ownership/expiry/grace and
registry synchronization, valid EIP-712 registration, copied-calldata executor binding, wallet
party equality, compromised-signer rejection for an unrelated approved payer, permit
replay, double-issued nonce rejection, domain/party/signature/deadline binding, stale price/referral
guards before payment, resolver node confinement, exact-delta rollback, payer/seller blocklist
rollback, referral and seller solvency, forward-confirmed reverse resolution, bounded reads, fixed
purchase guards, pull payments, stale transfer invalidation, and cancel/claim liveness while paused.
The suite also covers Unicode code-point price tiers, alternate Unicode dot rejection, 63-byte label boundaries, the controller's
300-second `validUntil - validAfter` hard window, current-registrant renewal, 24-hour signer
activation, and immediate signer revocation. The issuer caps `validUntil - issuedAt` at 295 seconds
so its optional five-second `validAfter` skew still fits that controller window.
The re-registration regression fills addr, text, name, contenthash, and interface records, proves an
unauthorized reset fails, proves a failed replacement rolls its reset back, and proves a successful
replacement advances `VersionChanged` state and exposes none of the prior owner's records.
It also sets a non-zero TTL before expiry and proves a successful replacement resets that TTL to
zero, while a failed replacement rolls the TTL reset back with the rest of the transaction.

The offline mock intentionally models fee-on-transfer and blocklist failures. It cannot prove Arc's
native/ERC-20 shared-balance system behavior. Source verification is complete, but a funded live Arc
Testnet acceptance run against the official USDC address plus BENS replay and operations evidence
remain mandatory release gates; they must not be marked complete from these unit tests alone.
