"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type BrandProfileResponse = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
  coverImageUrl: string | null;
  shopifyShopDomain: string | null;
  shopifyInstalledAt: string | null;
  shopifyLastProductSyncAt: string | null;
} | null;

type ShopifyProduct = {
  id: number;
  title: string;
  handle: string;
  productUrl: string;
  images: string[];
  priceRange: {
    min: number | null;
    max: number | null;
  };
  variantIds: number[];
};

export default function BrandShopifyPage() {
  const searchParams = useSearchParams();
  const [brand, setBrand] = useState<BrandProfileResponse>(null);
  const [shopDomain, setShopDomain] = useState("");
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      setMessage(null);

      const connected = searchParams.get("connected");
      const oauthError = searchParams.get("error");

      if (connected === "1") {
        setMessage("Shopify connected successfully.");
      }

      if (oauthError) {
        setError(`Shopify connection failed: ${oauthError.replaceAll("_", " ")}`);
      }

      try {
        const brandData = await fetchJson<BrandProfileResponse>("/api/brand/profile");
        setBrand(brandData);
        if (brandData?.shopifyShopDomain) {
          setShopDomain(brandData.shopifyShopDomain);
        }
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load Shopify status."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [searchParams]);

  async function syncProducts() {
    setSyncing(true);
    setError(null);

    try {
      const productData = await fetchJson<ShopifyProduct[]>(
        "/api/brand/shopify/products",
      );
      setProducts(productData);
    } catch (syncError) {
      setError(getErrorMessage(syncError, "Failed to fetch Shopify products."));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <BrandPageShell
      title="Shopify Connect"
      description="Connect the brand Shopify store, view the current connection status, and sync products into the dashboard."
    >
      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading Shopify status...</p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Status</p>
                <p className="mt-2 text-2xl font-semibold">
                  {brand?.shopifyInstalledAt ? "Connected" : "Not connected"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Shop domain</p>
                <p className="mt-2 text-sm text-white/80">
                  {brand?.shopifyShopDomain || "Not set"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Last sync</p>
                <p className="mt-2 text-sm text-white/80">
                  {brand?.shopifyLastProductSyncAt
                    ? new Date(brand.shopifyLastProductSyncAt).toLocaleString()
                    : "Never"}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-white/70">Shopify domain</label>
              <Input
                value={shopDomain}
                onChange={(event) => setShopDomain(event.target.value)}
                placeholder="your-store.myshopify.com"
                className="border-white/10 bg-black/20 text-white"
              />
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                type="button"
                onClick={() => {
                  window.location.href = `/api/shopify/oauth/start?shop=${encodeURIComponent(
                    shopDomain,
                  )}`;
                }}
                disabled={!shopDomain.trim()}
                className="rounded-full border border-white bg-white text-black"
              >
                Connect Shopify
              </Button>

              <Button
                type="button"
                variant="outline"
                onClick={() => void syncProducts()}
                disabled={syncing || !brand?.shopifyInstalledAt}
                className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
              >
                {syncing ? "Syncing..." : "Fetch products"}
              </Button>
            </div>

            {error && <p className="text-sm text-red-300">{error}</p>}
            {message && <p className="text-sm text-emerald-300">{message}</p>}
          </div>
        )}
      </PageCard>

      {products.length > 0 && (
        <PageCard>
          <h2 className="text-xl font-semibold">Products</h2>
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {products.map((product) => (
              <div
                key={product.id}
                className="rounded-2xl border border-white/10 bg-black/20 p-4"
              >
                <h3 className="font-medium">{product.title}</h3>
                <p className="mt-2 text-sm text-white/55">
                  {product.priceRange.min !== null
                    ? `$${product.priceRange.min}${
                        product.priceRange.max !== null &&
                        product.priceRange.max !== product.priceRange.min
                          ? ` - $${product.priceRange.max}`
                          : ""
                      }`
                    : "No price range"}
                </p>
                <p className="mt-2 text-xs text-white/45">
                  {product.variantIds.length} variants
                </p>
                <a
                  href={product.productUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex text-sm text-sky-300 underline"
                >
                  Open product
                </a>
              </div>
            ))}
          </div>
        </PageCard>
      )}
    </BrandPageShell>
  );
}
