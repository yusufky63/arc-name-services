import type { NextConfig } from "next";
import deploymentManifest from "../../deployments/5042002.json";
import promotionAttestation from "../../deployments/5042002.promotion.json";
import { candidateReleaseEnvironmentPresent } from "./release-runtime-boundary";

const productLive = deploymentManifest.state === "active" && deploymentManifest.activationEvidence.productLive;
const expectedLiveRelease = productLive
  ? `${deploymentManifest.releaseId}:${promotionAttestation.manifestSha256}:${promotionAttestation.verifiedAtBlock}`
  : null;
const liveOptIn = productLive && process.env.PRODUCT_LIVE_RELEASE === expectedLiveRelease;
const isDevelopment = process.env.NODE_ENV !== "production";
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  `script-src 'self' 'unsafe-inline'${isDevelopment ? " 'unsafe-eval'" : ""}`,
  "connect-src 'self' https: wss:",
  "frame-src 'self' https:",
  "worker-src 'self' blob:",
  ...(!isDevelopment ? ["upgrade-insecure-requests"] : []),
].join("; ");

if (productLive) {
  if (!liveOptIn) {
    throw new Error("product-live builds require the exact PRODUCT_LIVE_RELEASE binding");
  }
  if (candidateReleaseEnvironmentPresent(process.env)) {
    throw new Error(
      "private-candidate runtime and operator credentials must be removed from product-live builds",
    );
  }
}

const nextConfig: NextConfig = {
  allowedDevOrigins: ["127.0.0.1", "localhost"],
  poweredByHeader: false,
  reactStrictMode: true,
  experimental: {
    optimizePackageImports: ["viem"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: contentSecurityPolicy },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
        ],
      },
      {
        source: "/api/image/:tokenId",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          },
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
