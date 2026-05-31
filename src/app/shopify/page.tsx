import type { Metadata } from "next";
import Link from "next/link";
import Script from "next/script";
import { Button } from "@/components/ui/button";
import prisma from "@/lib/prisma";
import { isValidShopDomain } from "@/lib/shopify";

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
  const rawShop = firstParam(params.shop);
  const shop = String(rawShop || "").trim().toLowerCase();
  const validShop = isValidShopDomain(shop);
  const linkedBrand = validShop
    ? await prisma.brand.findFirst({
        where: {
          shopifyShopDomain: shop,
        },
        select: {
          shopifyConnectionStatus: true,
        },
      })
    : null;
  const isConnected = linkedBrand?.shopifyConnectionStatus === "CONNECTED";
  const continueHref = isConnected
    ? "/dashboard/brand/shopify"
    : validShop
      ? `/api/shopify/oauth/start?shop=${encodeURIComponent(shop)}`
      : "/dashboard/brand/shopify";

  return (
    <main className="min-h-screen bg-[#050714] px-5 py-8 text-white">
      {shopifyApiKey ? (
        <Script
          src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
          strategy="afterInteractive"
        />
      ) : null}

      <section className="mx-auto flex min-h-[calc(100vh-4rem)] max-w-3xl items-center">
        <div className="w-full overflow-hidden rounded-[2rem] border border-white/10 bg-[#111722]/95 shadow-2xl shadow-black/40">
          <div className="border-b border-white/10 bg-gradient-to-r from-[#111827] via-[#0b1020] to-[#172338] px-7 py-6">
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

          <div className="space-y-6 px-7 py-7">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-white/45">
                  Shopify store
                </p>
                <p className="mt-2 text-sm text-white/85">
                  {validShop ? shop : "No valid shop context detected"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-xs uppercase tracking-[0.2em] text-white/45">
                  SQRATCH link
                </p>
                <p className="mt-2 text-sm text-white/85">
                  {isConnected
                    ? "Connected to a SQRATCH Brand"
                    : linkedBrand
                      ? "Previously linked to a SQRATCH Brand"
                      : "Not connected"}
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-[#b7a6e8]/20 bg-[#b7a6e8]/10 p-5 text-sm leading-6 text-white/75">
              Link this Shopify store to a SQRATCH Brand account so Brand
              Admins can display Shopify products inside SQRATCH experiences.
              SQRATCH only requests product read access.
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                asChild
                className="rounded-full border border-white bg-white px-5 text-black hover:bg-white/90"
              >
                <Link href={continueHref}>
                  {isConnected
                    ? "Open SQRATCH Shopify dashboard"
                    : "Continue to SQRATCH linking"}
                </Link>
              </Button>
              <Button
                asChild
                variant="outline"
                className="rounded-full border-white/15 bg-transparent px-5 text-white hover:bg-white/10"
              >
                <Link href="/dashboard/brand/shopify">Brand dashboard</Link>
              </Button>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
