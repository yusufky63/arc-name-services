import type { Metadata } from "next";
import { AccountDashboard } from "@/components/account-dashboard";
import { protocolCapabilities } from "@/lib/manifest";

export const metadata: Metadata = {
  title: "My names",
  description: "View and manage your Contour names, listings, and proceeds.",
};

export default function MePage() {
  return (
    <main id="main-content" className="account-page">
      <section className="account-hero-surface">
        <div className="account-hero content-shell">
          <span>01 / MY NAMES</span>
          <h1>Your names,<br />in one place.</h1>
          <p>Review status, expiry, and listing details. Open a name to renew, transfer, set it as primary, or manage its sale.</p>
        </div>
      </section>
      {protocolCapabilities.reads ? (
        <AccountDashboard actionsEnabled={protocolCapabilities.marketplaceEscape} />
      ) : null}
    </main>
  );
}
