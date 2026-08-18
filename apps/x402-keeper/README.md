# x402 keeper

This package contains the durable order state machine and PostgreSQL CAS store
for paid agent registration. It pins Circle's
`@circle-fin/x402-batching@3.2.0` and restricts discovery to `exact`,
`eip155:5042002` and Arc's application USDC address.

The keeper is deliberately fail-closed. `X402_ENABLED=false` and an emergency
pause are the shipped defaults, while the public deployment manifest has
`x402.active=false`. Activation requires a managed transaction signer, an
authenticated agent-permit endpoint, a refund/reconciliation adapter and a
funded E2E run. No raw private-key mode exists.

The inactive workflow skeleton enforces that payment authorization is not
settlement, registration receipt and token ID proof precede settlement, and
response loss/idempotency use unique request, payment and permit identifiers.
That ordering is registration-first and can leave an irreversible free name if
settlement later fails; it is a documented risk model, not an activation-ready
payment implementation. Operators must encrypt payment payloads at rest and
restrict DB access because authorizations are sensitive.

`server.ts` is an activation sentinel: it exits unless the feature flag is
explicitly enabled, then still refuses activation until the selected managed
signer, agent-permit and refund adapters are wired around `KeeperWorkflow`.
It mounts no HTTP listener or 503 route in either shipped branch. Do not replace
those boundaries with environment keys. This operational surface remains inactive
in the manifest until an accepted settlement/compensation policy, the adapters,
and funded failure tests exist.
