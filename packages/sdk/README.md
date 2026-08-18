# Contour TypeScript SDK

The SDK reads the source-verified Contour deployment through Arc Testnet RPC and
prepares unsigned, exact-guarded transactions. It never stores a wallet or private
key, signs a payload, or broadcasts a transaction.

## Install from npm

The public package bundles the SDK's manifest configuration and normalization APIs so
it does not depend on private workspace packages:

```bash
npm install contour-sdk viem
```

Node.js 20.9 through 24 is supported. The package is ESM-only.

## Use it from this workspace

```bash
pnpm install --frozen-lockfile
pnpm --filter @contour/sdk build
```

Inside this monorepo, add `"@contour/sdk": "workspace:*"` to another package. Public
consumers should import the registry package instead:

```ts
import { createPublicClient, http } from "viem";
import {
  ARC_TESTNET,
  ArcNameClient,
  fetchDeploymentManifest,
} from "contour-sdk";

const manifest = await fetchDeploymentManifest(
  "https://your-contour-host.example/deployment-manifest.json",
  {
    // Pin this from a reviewed release record, never from the response itself.
    expectedManifestSha256: "0x<64-hex-release-digest>",
    expectedReleaseId: "0x<64-hex-release-id>",
  },
);

const rpc = createPublicClient({
  chain: ARC_TESTNET,
  transport: http(manifest.chain.rpcUrl),
});

const names = new ArcNameClient(rpc, manifest);
const record = await names.name("atlas");
const reverse = await names.reverse("0x1234567890123456789012345678901234567890");
const quote = await names.quote("atlas", 1n);
```

Use an authenticated RPC for production traffic. Remote manifest discovery validates
the schema, release ID, and a trusted out-of-band SHA-256 digest before returning data.
RPC failures remain errors and are never converted into “available” or “not found”.

Transaction helpers return `{ to, data, value }` plans only. A connected wallet must
simulate, sign, broadcast, wait for the required confirmations, and verify the final
contract state.

## Canonical V2 and legacy V1 releases

An `ArcNameClient` is permanently bound to the exact `DeploymentManifest` passed to
its constructor. Create one client per release and select the client explicitly; the
SDK never redirects a V1 token or listing to canonical V2 contract addresses.
`name`, `nameWithQuote`, `reverse`, and `listing` identify their source release with
`releaseId`. Every unsigned transaction plan also includes `releaseId`, so wallets can
verify that the displayed release is the one whose `to` address and calldata they will
sign.

All transaction helpers require an explicit `DeploymentManifest`. Use canonical V2
only for `prepareRegistrationPlan`. Existing V1 names can use their V1 manifest for
renewal, profile, transfer, marketplace cancellation, purchase, and claims while that
release's policy permits the action.

To compare canonical and legacy state at one Arc block, pin both clients:

```ts
const blockNumber = await rpc.getBlockNumber();
const [canonicalRecord, legacyRecord] = await Promise.all([
  canonicalClient.name("atlas", { blockNumber }),
  legacyClient.name("atlas", { blockNumber }),
]);
```

The same optional `{ blockNumber }` argument is supported by `nameWithQuote` and
`reverse`, including custom-resolver fallback reads.
