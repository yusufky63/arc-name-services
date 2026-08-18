import type { Metadata } from "next";
import Link from "next/link";
import {
  CONTRACT_KEYS,
  deploymentManifestDigest,
} from "@contour/config";
import { ArrowUpRightIcon } from "@/components/icons";
import { BRAND } from "@/lib/brand";
import { getDeploymentManifest } from "@/lib/manifest";

export const metadata: Metadata = {
  title: "Developers",
  description: "Public SDK, HTTP, MCP, ABI, and repository-local React integration for Contour on Arc Testnet.",
};

const mcpTools = [
  ["normalize_label", "Apply the pinned ENSIP-15 single-label profile."],
  ["get_name", "Read owner, registrant, resolver, address, and lifecycle from Arc."],
  ["reverse_lookup", "Read a forward-confirmed primary name."],
  ["get_account_names", "Read the same verified snapshot used by My Names."],
  ["get_market", "Read verified live listings and marketplace policy."],
  ["prepare_registration_request", "Build a wallet-bound request for the live registration API."],
  ["prepare_permit_request", "Exact schema alias for the /api/registration/prepare request."],
  ["prepare_approval", "Prepare the backwards-compatible registration-controller USDC approval."],
  ["prepare_renewal", "Prepare an unsigned renewal plan."],
  ["prepare_market_token_approval", "Approve one name NFT for the pinned marketplace."],
  ["prepare_market_token_approval_revoke", "Clear one name NFT's token-specific marketplace approval."],
  ["prepare_market_usdc_approval", "Approve an exact USDC amount for a marketplace purchase."],
  ["prepare_market_listing", "Prepare an unsigned fixed-price listing plan."],
  ["prepare_market_buy", "Prepare an unsigned price- and fee-guarded purchase plan."],
  ["prepare_market_cancel", "Cancel a listing, including while the market is paused."],
  ["prepare_claim_proceeds", "Claim seller proceeds, including while the market is paused."],
  ["prepare_claim_referral", "Claim registration referral credits."],
  ["prepare_transfer", "Safely transfer one active name NFT."],
  ["prepare_market_invalidate", "Permissionlessly clear one stale raw listing."],
] as const;

const upstreamResources = [
  ["ARC DOCS MCP", "https://docs.arc.io/ai/mcp", "Connect to the official hosted Arc documentation MCP at https://docs.arc.io/mcp."],
  ["CIRCLE APP KIT", "https://docs.arc.io/app-kit", "Official SDK for bridge, swap, send, and unified-balance workflows on Arc."],
  ["APP KIT INSTALL", "https://docs.arc.io/app-kit/tutorials/installation", "Install @circle-fin/app-kit with the official Viem, Ethers, Solana, or Circle Wallets adapter."],
  ["CIRCLE x402 SDK", "https://developers.circle.com/gateway/nanopayments/references/sdk", "Official @circle-fin/x402-batching buyer and seller SDK reference."],
] as const;

export default function DevelopersPage() {
  const manifest = getDeploymentManifest();
  const manifestSha256 = deploymentManifestDigest(manifest);
  const suffix = manifest.namespace.suffix ?? "contour";
  const origin = (
    process.env.NEXT_PUBLIC_SITE_URL ??
    "https://contour-arc.vercel.app"
  ).replace(/\/$/, "");
  const sdkExample = `import {
  ARC_TESTNET,
  ArcNameClient,
  fetchDeploymentManifest,
} from "contour-sdk";
import { createPublicClient, http } from "viem";

const manifest = await fetchDeploymentManifest(
  "${origin}/deployment-manifest.json",
  {
    expectedManifestSha256: "${manifestSha256}",
    expectedReleaseId: "${manifest.releaseId}",
  },
);

const rpc = createPublicClient({
  chain: ARC_TESTNET,
  transport: http(manifest.chain.rpcUrl),
});

const contour = new ArcNameClient(rpc, manifest);
const record = await contour.name("atlas");
const primary = await contour.reverse("0x78de409a6306550882328E2a67160471368387FF");`;
  const reactExample = `"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ArcNameProvider, useArcName } from "@contour/react";
import type { ArcNameClient } from "contour-sdk";

export function ContourProviders({ client, children }: {
  client: ArcNameClient;
  children: ReactNode;
}) {
  const [queries] = useState(() => new QueryClient());
  return <QueryClientProvider client={queries}>
    <ArcNameProvider client={client}>{children}</ArcNameProvider>
  </QueryClientProvider>;
}

export function NameAddress() {
  const { data, isPending } = useArcName("atlas");
  return <span>{isPending ? "Reading..." : data?.resolvedAddress ?? "Not set"}</span>;
}`;
  const mcpConfig = `{
  "mcpServers": {
    "contour-names": {
      "url": "${origin}/api/mcp"
    },
    "arc-docs": {
      "url": "https://docs.arc.io/mcp"
    }
  }
}`;

  return (
    <main id="main-content" className="developers-page">
      <section className="developers-hero-surface">
        <div className="developers-hero content-shell">
          <span>DEVELOPER SURFACE / {manifest.schemaVersion}</span>
          <h1>Build with direct<br />Arc reads.</h1>
          <p>
            Discover the deployment, call source-verified contracts, use the
            live HTTP API, or connect an agent directly to the hosted MCP.
          </p>
          <div className="developers-hero__actions">
            <Link href="/deployment-manifest.json">Open manifest <ArrowUpRightIcon /></Link>
            <Link href="/runtime-manifest.json">Runtime discovery <ArrowUpRightIcon /></Link>
            <Link href="/api/openapi.json">OpenAPI <ArrowUpRightIcon /></Link>
            <Link href="/api/mcp">MCP endpoint <ArrowUpRightIcon /></Link>
          </div>
        </div>
      </section>

      <section className="developer-network-strip-surface">
        <div className="developer-network-strip content-shell">
          <div><span>CHAIN ID</span><strong>{manifest.chain.id}</strong></div>
          <div><span>CAIP-2</span><strong>{manifest.chain.caip2}</strong></div>
          <div><span>NAMESPACE</span><strong>.{suffix}</strong></div>
          <div><span>RELEASE ID</span><strong>{manifest.releaseId?.slice(0, 10).toUpperCase() ?? "PINNED"}</strong></div>
        </div>
      </section>

      <section className="developer-docs-section" id="discovery">
        <div className="content-shell">
          <div className="developer-docs-heading">
            <span>01 / DISCOVERY</span>
            <h2>Signed evidence. HTTPS runtime.</h2>
            <p>
              Use the immutable manifest to pin the release and the runtime
              discovery document for live HTTPS endpoints.
            </p>
          </div>
          <div className="developer-resource-grid">
            {([
              ["SIGNED MANIFEST", "/deployment-manifest.json", "Canonical deployment metadata and promotion identity."],
              ["SIGNED ALIAS", "/.well-known/chain-name-service.json", "Stable canonical manifest path."],
              ["SERVICE STATUS", "/status", "Live registration, marketplace, permit issuer, and hosted MCP readiness checks."],
              ["RUNTIME DISCOVERY", "/runtime-manifest.json", "WSS-free endpoints and manifest-declared capabilities. Check its readiness URLs before execution."],
              ["OPENAPI 3.1", "/api/openapi.json", "Recommended public HTTP routes; internal and compatibility routes are excluded."],
              ["HOSTED MCP", "/api/mcp", "Streamable HTTP MCP endpoint."],
              ["ABI INDEX", "/abi", "Curated SDK ABI surfaces for supported protocol and settlement workflows."],
              ["LLMS.TXT", "/llms.txt", "Compact agent integration map."],
            ] as const).map(([title, href, copy]) => (
              <Link href={href} key={href} className="developer-resource-card">
                <span>{title}</span><code>{href}</code><p>{copy}</p><strong>OPEN <ArrowUpRightIcon /></strong>
              </Link>
            ))}
          </div>
          <dl className="developer-release-facts">
            <div><dt>Manifest SHA-256</dt><dd><code>{manifestSha256}</code></dd></div>
            <div><dt>Release ID</dt><dd><code>{manifest.releaseId}</code></dd></div>
            <div><dt>RPC</dt><dd><code>{manifest.chain.rpcUrl}</code></dd></div>
            <div><dt>USDC</dt><dd><code>{manifest.settlement.erc20Address}</code></dd></div>
          </dl>
        </div>
      </section>

      <section className="developer-docs-section developer-docs-section--inverse" id="http-api">
        <div className="content-shell">
          <div className="developer-docs-heading">
            <span>02 / HTTP API</span>
            <h2>Read names and collectible media without a wallet library.</h2>
            <p>
              OpenAPI covers the recommended public routes below. Response envelopes and
              CORS/cache headers vary by route; internal verification, issuer-v1,
              compatibility, manifest, and MCP transport routes are intentionally excluded.
              {" "}
              The canonical V1 registrar does not implement ERC-721 Metadata or <code>tokenURI</code>. Contour provides application-hosted companion metadata and deterministic image endpoints for registered names.
            </p>
          </div>
          <div className="developer-endpoint-list">
            <div><span>GET</span><code>/api/name/{'{label}'}</code><p>Registry, registrar, resolver, expiry, and availability.</p></div>
            <div><span>GET</span><code>/api/reverse/{'{address}'}</code><p>Forward-confirmed primary name.</p></div>
            <div><span>GET</span><code>/api/metadata/{'{tokenId}'}</code><p>Companion metadata derived from a verified registered-name snapshot.</p></div>
            <div><span>GET</span><code>/api/image/{'{tokenId}'}</code><p>Deterministic 1200 × 630 Contour name identity visual.</p></div>
            <div><span>GET</span><code>/api/account?owner={'{address}'}</code><p>Owned names, credits, proceeds, and listings.</p></div>
            <div><span>GET</span><code>/api/market</code><p>Live fixed-price listings and market state.</p></div>
            <div><span>GET</span><code>/api/registration/readiness</code><p>Registration contract, signer, controller, and pause readiness.</p></div>
            <div><span>GET</span><code>/api/marketplace/readiness</code><p>Marketplace contract, settlement, fee, and pause readiness.</p></div>
            <div><span>POST</span><code>/api/registration/preflight</code><p>Approval requirement and wallet transaction plan.</p></div>
            <div><span>POST</span><code>/api/registration/prepare</code><p>Wallet-bound registration permit and calldata.</p></div>
          </div>
          <pre><code>{`curl "${origin}/api/name/atlas"\n\ncurl "${origin}/api/reverse/0x78de409a6306550882328E2a67160471368387FF"`}</code></pre>
        </div>
      </section>

      <section className="developer-docs-section" id="sdk">
        <div className="content-shell">
          <div className="developer-docs-heading">
            <span>03 / PUBLIC SDK + WORKSPACE REACT</span>
            <h2>Install the public ESM SDK.</h2>
            <p>
              External consumers install <code>contour-sdk</code> with <code>viem</code> on
              Node.js <code>&gt;=20.9 &lt;25</code>. <code>@contour/react</code> remains a repository-only
              workspace package and is not included in the public npm release.
            </p>
          </div>
          <pre><code>npm install contour-sdk viem</code></pre>
          <div className="developer-code-grid">
            <div><span>SDK / TYPESCRIPT</span><pre><code>{sdkExample}</code></pre></div>
            <div><span>REACT / TANSTACK QUERY</span><pre><code>{reactExample}</code></pre></div>
          </div>
        </div>
      </section>

      <section className="developer-docs-section developer-docs-section--inverse" id="mcp">
        <div className="content-shell">
          <div className="developer-docs-heading">
            <span>04 / MCP</span>
            <h2>Connect directly over HTTPS.</h2>
            <p>
              Add the hosted Streamable HTTP endpoint to any MCP client. No clone,
              local build, absolute path, or environment variable is required.
            </p>
          </div>
          <pre><code>{mcpConfig}</code></pre>
          <div className="developer-tool-list">
            {mcpTools.map(([name, description]) => (
              <div key={name}><code>{name}</code><p>{description}</p></div>
            ))}
          </div>
          <p className="developer-note">
            Resource: <code>contour://runtime</code>. The Contour MCP never holds a private key,
            signs, or broadcasts. Reads and unsigned plans use only the canonical Arc HTTPS RPC.
            Both hosted registration helper names accept <code>rawLabel</code>, explicit normalization
            acceptance, <code>account</code>, 1-10 years, and an optional request ID, then return an
            unexecuted <code>/api/registration/prepare</code> POST template.
            The hosted endpoint needs no npm package; <code>@contour/mcp</code> is a separate,
            workspace-only stdio server whose <code>contour://manifest</code> resource and
            <code>prepare_issuer_request</code> challenge/permit templates are a distinct contract.
          </p>
        </div>
      </section>

      <section className="developer-docs-section" id="contracts">
        <div className="content-shell">
          <div className="developer-docs-heading">
            <span>05 / CONTRACTS + ABI</span>
            <h2>Seven source-verified deployments.</h2>
          </div>
          <div className="contract-list">
            {CONTRACT_KEYS.map((key, index) => (
              <Link href={`/abi/${key}.json`} key={key}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <strong>{key}</strong>
                <code>{manifest.contracts[key].address}</code>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <section className="developer-docs-section developer-upstream-section" id="upstream">
        <div className="content-shell">
          <div className="developer-docs-heading">
            <span>06 / ARC + CIRCLE</span>
            <h2>Use the official upstream SDKs.</h2>
            <p>Use Arc Docs MCP, Circle App Kit, or Circle&apos;s x402 SDK alongside the Contour HTTP and MCP surfaces.</p>
          </div>
          <div className="developer-resource-grid">
            {upstreamResources.map(([title, href, copy]) => (
              <a href={href} key={href} target="_blank" rel="noreferrer" className="developer-resource-card">
                <span>{title}</span><code>{href}</code><p>{copy}</p><strong>OFFICIAL DOCS <ArrowUpRightIcon /></strong>
              </a>
            ))}
          </div>
        </div>
      </section>

      <section className="developer-docs-section developer-docs-section--inverse" id="x402">
        <div className="content-shell">
          <div className="developer-docs-heading">
            <span>07 / AGENTIC x402 &amp; DIRECT WALLET PERMITS</span>
            <h2>Machine-to-machine Circle x402 payments &amp; direct permits.</h2>
            <p>
              Autonomous AI agents on Arc can acquire names using Circle x402 (HTTP 402 Payment Required)
              nanopayments or direct EIP-712 registration permits without human wallet intervention.
            </p>
          </div>
          <pre><code>{`// --- Flow A: Circle x402 Nanopayment ---
// 1. Agent requests registration with x402 payment method
const challenge = await fetch("${origin}/api/registration/prepare", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    rawLabel: "agent-01",
    normalizationAccepted: true,
    durationYears: 1,
    account: agentAddress,
    paymentMethod: "x402",
    requestId: crypto.randomUUID(),
  }),
});
// 2. Server responds with HTTP 402 + PAYMENT-REQUIRED header (Gateway Domain: 26, USDC)
const requirements = challenge.headers.get("PAYMENT-REQUIRED");

// 3. Agent authorizes payment via @circle-fin/x402-batching
const authorization = await exactPaymentClient.authorizePayment(requirements);

// 4. Agent delivers PAYMENT-SIGNATURE to receive the verified registration transaction
const response = await fetch("${origin}/api/registration/prepare", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "PAYMENT-SIGNATURE": authorization,
  },
  body: JSON.stringify({
    rawLabel: "agent-01",
    normalizationAccepted: true,
    durationYears: 1,
    account: agentAddress,
    requestId: crypto.randomUUID(),
  }),
});
const { registrationTransaction, permit, signature } = await response.json();`}</code></pre>
          <div className="developer-tool-list">
            <div>
              <code>Circle Gateway Domain: 26</code>
              <p>Canonical Arc Testnet gateway domain for batched nanopayment settlement.</p>
            </div>
            <div>
              <code>USDC Asset: 0x3600...0000</code>
              <p>Arc native USDC ERC-20 contract for 6-decimal sub-cent micropayments.</p>
            </div>
            <div>
              <code>ERC-8004 Agent Identity</code>
              <p>Bind on-chain agent registration and reputation directly to a verified .contour name.</p>
            </div>
          </div>
          <p className="developer-disclaimer">{BRAND.disclaimer}</p>
        </div>
      </section>
    </main>
  );
}
