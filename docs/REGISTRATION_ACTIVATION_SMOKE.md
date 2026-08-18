# Registration activation smoke

Run this gate after the controller-open candidate is deployed and verified, and
before the marketplace is opened. The runner refuses any RPC other than
`https://rpc.testnet.arc.network`, requires registrations to be open, and
requires the marketplace to remain paused both before and after registration.

The checked-in canonical `deployments/5042002.json` can represent different release stages
over time. For this gate, use the exact controller-open private-candidate manifest that is
currently deployed and verified. The read-only check is:

```powershell
pnpm smoke:registration `
  --manifest <controller-open-candidate.json> `
  --candidate-origin <https://private-candidate-host> `
  --candidate-basic-auth-file .local-keystores/candidate-basic-auth.txt `
  --label <available-canonically-normalized-label> `
  --duration-years 1
```

It performs the full candidate/RPC/code/readiness/quote/funding preflight but sends no
transaction. Its schema `1.0.0` result is `artifact: "registrationActivationSmoke"`,
`mode: "DRY_RUN"`, `verdict: "NOT_EXECUTED"`; it is a plan, not PASS evidence.

The broadcast runner uses the same single-step `/api/registration/prepare` request as the
public OpenAPI surface, web registration flow, and hosted MCP helper. The separate
`/api/registration/challenge` route is compatibility-only and is not part of this gate.

After that check passes, the exact pre-market broadcast shape is:

```powershell
pnpm smoke:registration `
  --manifest <controller-open-candidate.json> `
  --candidate-origin <https://private-candidate-host> `
  --candidate-basic-auth-file .local-keystores/candidate-basic-auth.txt `
  --label <same-available-canonically-normalized-label> `
  --duration-years 1 `
  --broadcast <exact-manifest-release-id> `
  --confirm-registrant <address-derived-from-E2E_BUYER_PRIVATE_KEY> `
  --output .local-keystores/registration-activation-smoke.json
```

Broadcast sends the controller registration and, only when the current allowance is below the
exact quote, an exact USDC approval first. It then requires all eleven
registration/settlement/ownership/resolver/expiry/issuer reconciliation
assertions to pass while marketplace pause remains true. Only then does it write schema `1.0.0`,
`mode: "BROADCAST"`, `verdict: "PASS"`. This focused pre-market gate is not the later
`fundedEndToEnd` public-live report and does not use `promotionTargetIntent`.

`smoke:registration` loads `E2E_BUYER_PRIVATE_KEY` from the ignored
`.local-keystores/release-activation.env` file. The report contains only public
addresses, transaction receipts, state assertions, the candidate origin, and
the exact manifest hash. It never contains the private key, challenge proof, or
wallet/permit signatures.

The Basic-auth credential is read from its ignored file and is attached only to
requests whose origin exactly equals `--candidate-origin`; the scoped fetcher
rejects redirects or calls to a different origin before sending credentials.
The output is created with exclusive-write semantics, so an existing evidence
file is never overwritten.

`--broadcast` must exactly equal the candidate manifest release ID; `--confirm-registrant`
must exactly match the address derived from the buyer key; and `--output` is mandatory in
broadcast mode. The key accepts either 64 hex characters or `0x` plus 64 hex characters and
is normalized only in memory. A failed/partial broadcast is not automatically retried: inspect
the approval/registration receipts and chain state before choosing a new label or output path.

Before opening the marketplace, revalidate the saved PASS report against the exact
controller-open manifest and current Arc chain state. Dry-run syntax:

```powershell
pnpm admin:activation `
  --manifest <controller-open-candidate.json> `
  --action market-open `
  --registration-smoke .local-keystores/registration-activation-smoke.json `
  --candidate-origin <https://private-candidate-host>
```

Broadcast syntax:

```powershell
pnpm admin:activation `
  --manifest <controller-open-candidate.json> `
  --action market-open `
  --registration-smoke .local-keystores/registration-activation-smoke.json `
  --candidate-origin <https://private-candidate-host> `
  --broadcast `
  --confirm-release <exact-manifest-release-id>
```

After that transaction is confirmed, stage its later verified block while binding the same
immutable PASS report:

```powershell
pnpm stage:release `
  --input <controller-open-candidate.json> `
  --output <market-open-candidate.json> `
  --phase market-open `
  --verified-at-block <confirmed-market-open-block> `
  --registration-smoke .local-keystores/registration-activation-smoke.json
```
