import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminWorkspace, type AdminTab } from "@/components/admin-workspace";
import { getReadableReleases } from "@/lib/manifest";

export const metadata: Metadata = {
  title: "Administration",
  description: "Live Contour protocol authority, activity, and owner-authorized Arc Testnet controls.",
  robots: { index: false, follow: false },
};

type AdminPageProps = {
  searchParams: Promise<{
    tab?: string | string[];
    release?: string | string[];
  }>;
};

export default async function AdminPage({ searchParams }: AdminPageProps) {
  const requested = await searchParams;
  const requestedTab = requested.tab;
  const initialTab: AdminTab = requestedTab === "activity" || requestedTab === "controls"
    ? requestedTab
    : "overview";
  const releases = getReadableReleases();
  const canonical = releases.find((release) => release.canonical);
  if (!canonical?.manifest.releaseId) {
    throw new Error("The canonical admin release is unavailable.");
  }
  const requestedRelease = requested.release;
  if (Array.isArray(requestedRelease)) notFound();
  const selected = requestedRelease
    ? releases.find(
      (release) =>
        release.manifest.releaseId?.toLowerCase() ===
        requestedRelease.toLowerCase(),
    )
    : canonical;
  if (!selected?.manifest.releaseId) notFound();
  return (
    <main id="main-content" className="admin-page">
      <AdminWorkspace
        initialTab={initialTab}
        initialReleaseId={selected.manifest.releaseId}
      />
    </main>
  );
}
