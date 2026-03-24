import type { NextConfig } from "next";

function getRemotePatterns() {
  const patterns: NonNullable<NextConfig["images"]>["remotePatterns"] = [
    {
      protocol: "https",
      hostname: "cdn.shopify.com",
    },
    {
      protocol: "https",
      hostname: "**.supabase.co",
    },
    {
      protocol: "https",
      hostname: "sqratch.com",
    },
  ];

  const candidates = [
    process.env.SUPABASE_STORAGE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_URL,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      const url = new URL(candidate);
      patterns.push({
        protocol: url.protocol.replace(":", "") as "http" | "https",
        hostname: url.hostname,
      });
    } catch {
      // Ignore invalid env values. Static patterns above cover the common hosts.
    }
  }

  return patterns;
}

const nextConfig: NextConfig = {
  images: {
    remotePatterns: getRemotePatterns(),
    unoptimized: process.env.NODE_ENV !== "production",
  },
  webpack: (config) => {
    config.resolve.fallback = {
      ...config.resolve.fallback,
      fs: false,
      net: false,
      tls: false,
    };
    return config;
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
