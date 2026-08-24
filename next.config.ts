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
  async headers() {
    // PHASE 16B — route-scoped ONLY, applied to exactly these two paths.
    // SQRATCH sets no global X-Frame-Options, CSP, Referrer-Policy, or
    // Cache-Control today, so every header below is purely a TIGHTENING of
    // these two new routes, never a relaxation of anything existing, and no
    // other path's response headers are affected.
    const noReferrerNoStore = [
      // Both pages carry query-string credentials (a Commerce7 account JWT on
      // /connect, a short-lived one-time link token on /link) that must never
      // leak via the Referer header on an outbound link/asset request, and
      // must never be cached (by the browser or an intermediary) where a
      // later party on the same device/network path could replay them.
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "no-store" },
    ];

    return [
      {
        // Permits the Commerce7 Admin App Extension iframe to embed this page
        // from Commerce7's admin origins and denies every other embedder —
        // this is the only route SQRATCH allows to be framed at all.
        source: "/commerce7/connect",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors https://admin.platform.commerce7.com https://dev-center.platform.commerce7.com https://*.commerce7.com;",
          },
          ...noReferrerNoStore,
        ],
      },
      {
        // /commerce7/link is a TOP-LEVEL page, never meant to be framed by
        // anyone (see its own doc comment) — 'none' both documents that intent
        // and stops it from ever being embedded, e.g. if a future change
        // linked to it from an unexpected context.
        source: "/commerce7/link",
        headers: [
          { key: "Content-Security-Policy", value: "frame-ancestors 'none';" },
          ...noReferrerNoStore,
        ],
      },
    ];
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
};

export default nextConfig;
