import Link from "next/link";
import { ArrowUpRightIcon } from "@/components/icons";
import { NetworkBadge } from "@/components/network-badge";
import { SearchForm } from "@/components/search-form";
import { SectionIndex } from "@/components/section-index";
import { BRAND } from "@/lib/brand";
import { getOptionalDeploymentManifest, protocolCapabilities } from "@/lib/manifest";

const protocolSteps = [
  ["01", "Search", "Enter the name you want"],
  ["02", "Choose", "Review the term and USDC price"],
  ["03", "Register", "Connect, approve, and confirm"],
  ["04", "Use", "The name belongs to your wallet"],
] as const;

function compactAddress(value: string) {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}

export default function HomePage() {
  const deployment = getOptionalDeploymentManifest();
  const registry = deployment?.contracts.registry;
  const marketplace = deployment?.contracts.marketplace;

  return (
    <main id="main-content">
      <section className="hero">
        <div className="hero__arc" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="hero__content modular-grid">
          <h1>
            One name.
            <span>A clear coordinate</span>
            on Arc.
          </h1>
          <p className="hero__lede">
            Search a name, see the USDC price, then connect your wallet and
            register on Arc Testnet.
          </p>
          <div className="hero__search">
            <SearchForm />
          </div>
          <div className="hero__annotation">
            <span>01</span>
            <p>{BRAND.tagline}</p>
          </div>
        </div>
      </section>

      <section className="name-feature section-paper">
        <div className="section-heading modular-grid">
          <SectionIndex index="02">Your name on Arc</SectionIndex>
          <h2>One name for your wallet.</h2>
          <p>
            Check availability, ownership, address, and expiry in one place.
          </p>
        </div>
        {deployment && registry && protocolCapabilities.sourceVerified ? (
          <div className="nameplate-demo">
            <div className="nameplate-demo__meta">
              <NetworkBadge />
              <span>CONTOUR REGISTRY</span>
            </div>
            <div className="nameplate-demo__name">
              <span>Contour</span>
              <strong>Registry</strong>
            </div>
            <div className="nameplate-demo__status">
              <div>
                <span>Chain</span>
                <strong>{deployment.chain.caip2}</strong>
              </div>
              <div>
                <span>Deployed block</span>
                <strong>{registry.deploymentBlock}</strong>
              </div>
              <div>
                <span>Contract</span>
                <strong>{registry.address ? compactAddress(registry.address) : "—"}</strong>
              </div>
              {registry.sourceVerificationUrl ? (
                <a href={registry.sourceVerificationUrl} target="_blank" rel="noreferrer">
                  Open ArcScan source <ArrowUpRightIcon />
                </a>
              ) : (
                <Link href="/api/manifest">Open manifest <ArrowUpRightIcon /></Link>
              )}
            </div>
          </div>
        ) : null}
      </section>

      <section className="protocol-flow section-sand">
        <div className="section-heading modular-grid">
          <SectionIndex index="03">Simple registration</SectionIndex>
          <h2>Register in three wallet steps.</h2>
          <p>
            Connect your wallet, approve USDC if needed, and confirm registration.
          </p>
        </div>
        <div className="protocol-steps">
          {protocolSteps.map(([number, title, detail]) => (
            <div className="protocol-step" key={number}>
              <span>{number}</span>
              <strong>{title}</strong>
              <p>{detail}</p>
            </div>
          ))}
        </div>
        <div className="truth-line">
          <span>NETWORK</span>
          <strong>ARC TESTNET</strong>
          <i aria-hidden="true" />
          <span>PAYMENT</span>
          <strong>USDC</strong>
        </div>
      </section>

      <section className="market-preview section-white">
        <div className="section-heading modular-grid">
          <SectionIndex index="04">Contour market</SectionIndex>
          <h2>Buy and sell at a fixed price.</h2>
          <p>
            Browse available listings and complete purchases with USDC on Arc Testnet.
          </p>
          <Link className="text-link" href="/market">
            Open market <ArrowUpRightIcon />
          </Link>
        </div>
        {marketplace ? (
          <div className="truth-line">
            <span>MARKETPLACE</span>
            <strong>{marketplace.address ? compactAddress(marketplace.address) : "—"}</strong>
            <i aria-hidden="true" />
            <span>DEPLOYED BLOCK</span>
            <strong>{marketplace.deploymentBlock}</strong>
          </div>
        ) : null}
      </section>

      <section className="developer-callout section-deep">
        <div className="developer-callout__arc" aria-hidden="true" />
        <div className="modular-grid developer-callout__content">
          <SectionIndex index="05" inverted>Build with Contour</SectionIndex>
          <h2>
            SDK, API,
            <span>and MCP.</span>
            Ready to use.
          </h2>
          <div className="developer-callout__copy">
            <p>
              Read names, build transactions, and integrate Contour with the SDK,
              API, MCP, and public manifest.
            </p>
            <Link className="light-link" href="/developers">
              Open developer docs <ArrowUpRightIcon />
            </Link>
          </div>
          <div className="developer-metrics">
            <div><strong>07</strong><span>CONTRACTS</span></div>
            <div><strong>06</strong><span>USDC DECIMALS</span></div>
            <div><strong>04</strong><span>SDK + API + MCP + APP KIT</span></div>
          </div>
        </div>
      </section>
    </main>
  );
}
