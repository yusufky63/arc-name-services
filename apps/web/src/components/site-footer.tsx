import Link from "next/link";
import { BRAND } from "@/lib/brand";
import { ARC_TESTNET } from "@/lib/network";
import { Wordmark } from "./wordmark";

export function SiteFooter() {
  return (
    <footer className="site-footer">
      <div className="site-footer__top modular-grid content-shell">
        <div className="site-footer__brand">
          <Wordmark inverted />
          <p>{BRAND.tagline}</p>
        </div>
        <div className="site-footer__links">
          <span>Product</span>
          <Link href="/">Search</Link>
          <Link href="/market">Market</Link>
          <Link href="/me">My names</Link>
          <Link href="/status">Status</Link>
        </div>
        <div className="site-footer__links">
          <span>Developer</span>
          <Link href="/developers">Developers</Link>
          <Link href="/api/manifest">Manifest</Link>
          <Link href="/api/openapi.json">OpenAPI</Link>
          <Link href="/api/mcp">MCP</Link>
        </div>
        <div className="site-footer__network">
          <code>ARC TESTNET · CHAIN {ARC_TESTNET.id}</code>
          <code>CONTOUR · BUILT ON ARC NETWORK</code>
        </div>
      </div>
      <div className="site-footer__bottom">
        <div className="site-footer__bottom-inner content-shell">
          <span>© {new Date().getFullYear()} Contour Labs</span>
        </div>
      </div>
    </footer>
  );
}
