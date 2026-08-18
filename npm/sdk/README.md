# contour-sdk

TypeScript SDK for the Contour Name Protocol deployment on Arc Testnet. It validates
deployment manifests, performs source-verified contract reads, normalizes single labels
with the pinned ENSIP-15 profile, and prepares unsigned transaction plans.

The SDK never stores a wallet or private key, signs a payload, or broadcasts a
transaction.

## Install

```bash
npm install contour-sdk viem
```

Node.js 20.9 through 24 is supported. The package is ESM-only.

## Read a name

```ts
import { createPublicClient, http } from "viem";
import {
  ARC_TESTNET,
  ArcNameClient,
  fetchDeploymentManifest,
} from "contour-sdk";

const manifest = await fetchDeploymentManifest(
  "https://contour-arc.vercel.app/deployment-manifest.json",
  {
    expectedManifestSha256:
      "0xdb158256477ccb0b45c3970460a7fded040e213a81c47e5104cce2b540914007",
    expectedReleaseId:
      "0x66aeb7b208fdfb6eb9f728a3d0b12d6d3b7132eb0e363b38f7c388c358edefdc",
  },
);

const rpc = createPublicClient({
  chain: ARC_TESTNET,
  transport: http(manifest.chain.rpcUrl),
});

const names = new ArcNameClient(rpc, manifest);
const record = await names.name("atlas");
const quote = await names.quote("atlas", 1n);
```

Pin the manifest digest from a reviewed release record; never trust a digest copied
from the same response being validated. Use the manifest's exact canonical HTTPS Arc RPC,
`https://rpc.testnet.arc.network`; do not add a fallback host or WebSocket transport.

Transaction helpers return `{ to, data, value }` plans only. A connected wallet must
simulate, sign, broadcast, wait for confirmations, and verify the resulting contract
state.

## Additional exports

The root entry exports the SDK, chain/manifest configuration, and normalization APIs.
They are also available from `contour-sdk/config` and
`contour-sdk/normalization`.

This package targets Arc Testnet and should not be treated as a mainnet deployment.
