import type { Metadata } from "next";
import Script from "next/script";
import EmbeddedShellClient from "./embedded-shell-client";

const shopifyApiKey =
  process.env.NEXT_PUBLIC_SHOPIFY_API_KEY || process.env.SHOPIFY_API_KEY || "";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "SQRATCH Shopify",
  other: shopifyApiKey
    ? {
        "shopify-api-key": shopifyApiKey,
      }
    : {},
};

type ShopifyShellSearchParams = Promise<{
  shop?: string | string[];
}>;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export default async function ShopifyShellPage({
  searchParams,
}: {
  searchParams: ShopifyShellSearchParams;
}) {
  const params = await searchParams;
  // rawShop is passed to the client ONLY as an input to /api/shopify/oauth/start
  // for the non-embedded / custom-distribution fallback.
  // It is NEVER used to look up or display connection state.
  const rawShop = firstParam(params.shop) ?? "";

  // Server-read env — passed as a prop so the client component never reads
  // server-only environment variables directly.
  const distribution =
    (process.env.SHOPIFY_APP_DISTRIBUTION as "public" | "custom" | undefined) ??
    "public";

  return (
    <main className="min-h-screen bg-[#050714] px-5 py-8 text-white">
      {shopifyApiKey ? (
        <Script
          src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
          strategy="afterInteractive"
        />
      ) : null}

      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl items-center">
        <div className="w-full overflow-hidden rounded-4xl border border-white/10 bg-[#111722]/95 shadow-2xl shadow-black/40">
          <div className="border-b border-white/10 bg-linear-to-r from-[#111827] via-[#0b1020] to-[#172338] px-7 py-6">
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-[#b7a6e8]">
              SQRATCH
            </p>
            <h1 className="mt-3 text-3xl font-semibold tracking-tight">
              Shopify app setup
            </h1>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-white/65">
              This embedded app is a lightweight setup shell. The full product
              experience stays in the SQRATCH Brand dashboard.
            </p>
          </div>

          <EmbeddedShellClient
            shopifyApiKey={shopifyApiKey}
            distribution={distribution}
            rawShop={rawShop}
          />
        </div>
      </section>
    </main>
  );
}
