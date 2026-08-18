import { ImageResponse } from "next/og";
import { notFound } from "next/navigation";
import { BRAND } from "@/lib/brand";
import { cleanLabel, isPlausibleLabel } from "@/lib/names";

export const alt = "Contour name";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage({
  params,
}: {
  params: Promise<{ label: string }>;
}) {
  let label: string;
  try {
    label = cleanLabel(decodeURIComponent((await params).label));
  } catch {
    notFound();
  }
  if (!isPlausibleLabel(label)) notFound();
  const labelLength = Array.from(label).length;

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          color: "#000b24",
          background: "#f5ecda",
          borderLeft: "34px solid #255277",
          fontFamily: "Space Grotesk, Arial, sans-serif",
        }}
      >
        <div
          style={{
            height: 86,
            padding: "0 42px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            color: "#ffffff",
            background: "#000b24",
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: 2,
          }}
        >
          <span>CONTOUR</span>
          <span style={{ color: "#acc6e9", fontSize: 18 }}>NAME IDENTITY</span>
        </div>
        <div
          style={{
            flex: 1,
            padding: "52px 42px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            borderBottom: "2px solid #000b24",
          }}
        >
          <div
            style={{
              maxWidth: 1080,
              display: "flex",
              alignItems: "baseline",
              overflow: "hidden",
              whiteSpace: "nowrap",
              fontSize: labelLength > 18 ? 76 : labelLength > 10 ? 102 : 132,
              fontWeight: 700,
              letterSpacing: -5,
            }}
          >
            <span>{label}</span>
            <span style={{ color: "#255277" }}>{BRAND.suffix}</span>
          </div>
        </div>
        <div
          style={{
            height: 86,
            padding: "0 42px",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontFamily: "IBM Plex Mono, monospace",
            fontSize: 18,
          }}
        >
          <span>REGISTER · MANAGE · SHARE</span>
          <span style={{ color: "#326796" }}>BUILT FOR ARC TESTNET</span>
        </div>
      </div>
    ),
    size,
  );
}
