import type { Metadata, Viewport } from "next";
import "@fontsource-variable/space-grotesk";
import "@fontsource-variable/dm-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { SiteFooter } from "@/components/site-footer";
import { Providers } from "@/components/providers";
import { BRAND } from "@/lib/brand";
import { getOptionalDeploymentManifest } from "@/lib/manifest";

export const metadata: Metadata = {
  metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3002"),
  title: {
    default: `${BRAND.name} — Names for Arc Testnet`,
    template: `%s — ${BRAND.name}`,
  },
  description:
    "Search, register, and use Contour names with USDC on Arc Testnet.",
  openGraph: {
    title: `${BRAND.name} — Names for Arc Testnet`,
    description: BRAND.tagline,
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#000b24",
  colorScheme: "light dark",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const governanceAccount =
    getOptionalDeploymentManifest()?.activationEvidence.governance.account ?? null;

  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body>
        <Providers>
          <a className="skip-link" href="#main-content">Skip to content</a>
          <SiteHeader governanceAccount={governanceAccount} />
          {children}
          <SiteFooter />
        </Providers>
      </body>
    </html>
  );
}
