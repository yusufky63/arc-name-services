import type { Metadata } from "next";
import { MarketBrowser } from "@/components/market-browser";
import { protocolCapabilities } from "@/lib/manifest";

export const metadata: Metadata = {
  title: "Fixed-price market",
  description: "Browse and buy listed Contour names at fixed USDC prices.",
};

export default function MarketPage() {
  return (
    <main id="main-content" className="market-page">
      <section className="route-hero-surface route-hero--ice">
        <div className="route-hero content-shell">
          <div className="route-hero__index">01 / MARKET</div>
          <h1>Names for sale.<br />Clear prices.</h1>
          <p>
            Review any listing and buy the name at its displayed USDC price.
          </p>
        </div>
      </section>
      <MarketBrowser
        readEnabled={protocolCapabilities.marketReads}
        purchaseEnabled={protocolCapabilities.marketplace}
      />
      <section className="market-principles-surface">
        <div className="market-principles content-shell">
          <div><span>01</span><strong>Exact price guard</strong><p>A buy reverts when listing price or protocol fee changes.</p></div>
          <div><span>02</span><strong>Active lifecycle</strong><p>Expired or transferred names cannot settle stale listings.</p></div>
          <div><span>03</span><strong>Pull proceeds</strong><p>Seller liabilities remain separate from protocol surplus.</p></div>
        </div>
      </section>
    </main>
  );
}
