import type { Metadata } from "next";
import { OperationsDashboard } from "@/components/operations-dashboard";
import { getRuntimeDiscoveryDocument } from "@/lib/manifest";

export const metadata: Metadata = {
  title: "Service status",
  description:
    "Public readiness and network operational status for Contour Name Protocol.",
};

export default function StatusPage() {
  const discovery = getRuntimeDiscoveryDocument();
  const rel = discovery.release;

  return (
    <main id="main-content" className="admin-page">
      <section className="admin-hero-surface">
        <div className="admin-hero content-shell">
          <span>CONTOUR / PROTOCOL STATUS</span>
          <h1>
            Network Health &amp;
            <br />
            Service Status
          </h1>
          <p>
            Real-time health monitoring and operational status for Contour Name
            Protocol on Arc Network.
          </p>
          <div
            className="admin-hero-badges"
            style={{
              marginTop: "1.25rem",
              display: "flex",
              gap: "0.5rem",
              flexWrap: "wrap",
            }}
          >
            <span className="badge">
              Registration: {rel.registrationReady ? "READY" : "PAUSED"}
            </span>
            <span className="badge">
              Marketplace: {rel.marketplaceReady ? "READY" : "PAUSED"}
            </span>
            <span className="badge">
              Permit Issuer: {rel.permitIssuerReady ? "READY" : "UNAVAILABLE"}
            </span>
            <span className="badge">
              Hosted MCP: {rel.mcpReady ? "READY" : "UNAVAILABLE"}
            </span>
            <span className="badge">
              Circle x402: {rel.x402Ready ? "READY" : "INACTIVE"}
            </span>
          </div>
        </div>
      </section>

      <OperationsDashboard />
    </main>
  );
}
