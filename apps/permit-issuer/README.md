# Optional single-process issuer reference

This package is an optional single-process Fastify reference and operations
harness. Contour Release 1 public activation uses the same-origin stateless
issuer in `apps/web`. This package is not the canonical public issuer, and its
memory/single-process health payload intentionally does not satisfy the Release
1 promotion contract.

When run on its own, the reference creates a wallet challenge, checks the live
controller policy, creates and signs an EIP-712 registration permit, records the
submitted transaction and reconciles the final Arc receipt.

It intentionally uses process-local memory for challenge, lease, idempotency,
rate-limit and submission state. PostgreSQL is not required. Run exactly one
issuer replica so every request shares the same atomic maps and requester locks.
Restarting the process clears this coordination state; ownership and consumed
permit state remain authoritative on Arc Testnet. Expired process-local state is
removed after a bounded retry-retention window. This package therefore provides
neither multi-replica coordination nor an exclusive reservation guarantee.

The signing key is also local to the server. This testnet release intentionally
uses the same funded Arc Testnet EOA as deployer, protocol owner, treasury and
permit signer. Set `REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY` to that canonical
EOA's key in the hosting platform's encrypted server environment. Do not commit
it, expose it through a public environment variable or return it from an
endpoint. Managed KMS/HSM and remote signer endpoints are not required.

At startup the derived signer address must exactly equal
`manifest.permitIssuer.signerAddress`. Each generated signature is verified
locally against that address before it can be returned. The server also refuses
issuance unless Arc reports chain ID `5042002`, the exact controller signer and
policy version from the active manifest, and unpaused registrations.

## Endpoints

- `POST /v1/challenges` accepts the immutable intent (`requestId`, raw label,
  normalization acceptance, requester, recipient, payer, authorized executor,
  duration, resolver-data hash and optional referrer).
- `POST /v1/permits` repeats that exact intent and adds the challenge ID and
  wallet signature. A quote, nonce, allowance and availability check is repeated
  immediately before signing.
- `POST /v1/submissions` binds the issued permit to the signed Arc transaction
  and keeps it exclusive until receipt reconciliation proves its outcome.
- `GET /healthz` verifies chain, controller policy and local signer parity. Its
  `memory` / `single-process` fields identify this optional reference and are not
  Release 1 promotion evidence.

Requester, payer and authorized executor must match. Challenges are origin,
release, controller, quote and intent bound. Permits have a short configurable
TTL (15–295 seconds; 180 seconds by default). An RPC or policy mismatch fails
closed without producing a signature.

## Required environment

Copy `.env.example` and provide:

- `DEPLOYMENT_MANIFEST_PATH`
- `ARC_RPC_URL` (HTTPS)
- `REGISTRATION_CHALLENGE_ORIGIN` (HTTPS, with localhost allowed for local work)
- `REGISTRATION_PERMIT_SIGNER_PRIVATE_KEY`
- `ISSUER_SERVICE_BEARER_TOKEN`
- `INGRESS_CLIENT_KEY_HMAC_SECRET`

Each bearer/HMAC secret must contain at least 32 characters. The ingress must
send both the service bearer and fresh HMAC client binding required by
`boundary.ts`. Configure `TRUSTED_PROXY_CIDRS` only for a proxy that overwrites
forwarded-address headers.

Release-integrity gates remain mandatory. Any active manifest with an active
issuer can serve permits. A manifest promoted to product-live additionally
requires the exact
`PRODUCT_LIVE_RELEASE=<releaseId>:<manifestSha256>:<verifiedAtBlock>` binding.

## Commands

```bash
pnpm --filter @contour/permit-issuer test
pnpm --filter @contour/permit-issuer build
pnpm --filter @contour/permit-issuer start
```

Acquiring a permit is not registration success. Only the confirmed Arc receipt
establishes ownership. If a submitted transaction cannot yet be classified, the
service keeps the lease closed and continues reconciliation rather than assuming
failure.
