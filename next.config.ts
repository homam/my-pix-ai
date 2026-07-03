import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Self-contained server build for container deploys (App Runner/Docker).
  // Harmless on Vercel, which ignores it.
  output: "standalone",
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "**.astria.ai" },
      { protocol: "https", hostname: "**.r2.cloudflarestorage.com" },
      { protocol: "https", hostname: "**.r2.dev" },
    ],
  },
};

export default nextConfig;
