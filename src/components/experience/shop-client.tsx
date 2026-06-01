"use client";

import { useCallback, useEffect, useState } from "react";
import {
  ErrorView,
  ExperienceShell,
  LoadingView,
  PageCard,
} from "@/components/experience/experience-shell";
import {
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";
import { useExperience } from "@/components/experience/use-experience";
import { ShopifyShopRewardCard } from "@/components/rewards/shopify-shop-reward-card";
import { Button } from "@/components/ui/button";

type ShopResponse = {
  experience: {
    id: string;
    slug: string;
    title: string;
  };
  campaign: {
    id: string;
    name: string;
    brand: {
      id: string;
      name: string;
      slug: string;
    } | null;
  } | null;
  products: Array<{
    id: string;
    productId: string;
    productLinkId: string | null;
    title: string;
    imageUrl: string | null;
    priceText: string | null;
    productUrl: string;
    brand: {
      id: string;
      name: string;
      slug: string;
    } | null;
    source: "LINKED" | "CAMPAIGN";
  }>;
};

export function ExperienceShopClient({
  experienceSlug,
}: {
  experienceSlug: string;
}) {
  const { data, loading, error } = useExperience(experienceSlug);
  const [shopData, setShopData] = useState<ShopResponse | null>(null);
  const [shopLoading, setShopLoading] = useState(false);
  const [shopError, setShopError] = useState<string | null>(null);
  const [clickingId, setClickingId] = useState<string | null>(null);

  const loadProducts = useCallback(async () => {
    setShopLoading(true);
    setShopError(null);

    try {
      const result = await fetchJson<ShopResponse>(
        `/api/public/experience/${experienceSlug}/products`,
      );
      setShopData(result);
    } catch (loadError) {
      setShopError(getErrorMessage(loadError, "Failed to load shop products."));
    } finally {
      setShopLoading(false);
    }
  }, [experienceSlug]);

  useEffect(() => {
    if (!data) {
      return;
    }

    void loadProducts();
  }, [data, loadProducts]);

  function handleOpenProduct(product: ShopResponse["products"][number]) {
    setClickingId(product.id);
    window.open(product.productUrl, "_blank", "noopener,noreferrer");

    fetch(`/api/public/experience/${experienceSlug}/products`, {
      method: "POST",
      credentials: "include",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        productId: product.productId,
        productLinkId: product.productLinkId,
        productUrl: product.productUrl,
      }),
    }).finally(() => {
      setClickingId((current) => (current === product.id ? null : current));
    });
  }

  const shopBrandId =
    shopData?.campaign?.brand?.id ||
    shopData?.products.find((product) => product.brand?.id)?.brand?.id ||
    null;

  if (loading) {
    return <LoadingView label="Loading shop..." />;
  }

  if (error || !data) {
    return <ErrorView message={error || "Experience not found."} />;
  }

  return (
    <ExperienceShell
      experience={data}
      activeTab="shop"
      actions={
        <div className="rounded-3xl border border-white/10 bg-black/20 p-5">
          <p className="text-sm text-white/55">Shop items</p>
          <p className="mt-2 text-3xl font-semibold">
            {shopData?.products.length ?? 0}
          </p>
          <p className="mt-2 text-sm text-white/55">
            Opens the brand&apos;s Shopify storefront in a new tab
          </p>
        </div>
      }
    >
      {shopLoading ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading products...</p>
        </PageCard>
      ) : shopError ? (
        <PageCard>
          <p className="text-sm text-red-300">{shopError}</p>
        </PageCard>
      ) : !shopData || shopData.products.length === 0 ? (
        <PageCard>
          <div className="space-y-3">
            <h2 className="text-2xl font-semibold text-[#988dbf]">Shop</h2>
            <p className="max-w-2xl text-sm leading-6 text-white/70">
              No products have been linked to this experience yet.
            </p>
          </div>
        </PageCard>
      ) : (
        <div className="space-y-6">
          <PageCard>
            <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
              <div>
                <h2 className="text-2xl font-semibold text-[#988dbf]">Shop</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
                  These products are linked to this experience or pulled from
                  the connected campaign brand storefront.
                </p>
              </div>
              {shopData.campaign && (
                <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/65">
                  Campaign: {shopData.campaign.name}
                </div>
              )}
            </div>
          </PageCard>

          <ShopifyShopRewardCard brandId={shopBrandId} />

          <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
            {shopData.products.map((product) => (
              <PageCard key={product.id} className="h-full">
                <div className="flex h-full flex-col">
                  <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-black/20">
                    {product.imageUrl ? (
                      <img
                        src={product.imageUrl}
                        alt={product.title}
                        className="aspect-[4/3] w-full object-cover"
                      />
                    ) : (
                      <div className="flex aspect-[4/3] items-center justify-center bg-[linear-gradient(135deg,rgba(96,165,250,0.18),rgba(34,197,94,0.10),rgba(2,0,21,0.45))] text-sm text-white/45">
                        No image
                      </div>
                    )}
                  </div>

                  <div className="mt-5 flex flex-1 flex-col">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/60">
                        {product.source === "LINKED"
                          ? "Experience linked"
                          : "Campaign storefront"}
                      </span>
                      {product.brand && (
                        <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/60">
                          {product.brand.name}
                        </span>
                      )}
                    </div>

                    <h3 className="mt-4 text-xl font-semibold text-[#988dbf]">
                      {product.title}
                    </h3>
                    <p className="mt-2 text-sm text-white/55">
                      {product.priceText || "Price available on Shopify"}
                    </p>

                    <div className="mt-6">
                      <Button
                        type="button"
                        onClick={() => handleOpenProduct(product)}
                        disabled={clickingId === product.id}
                        className="w-full rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
                      >
                        {clickingId === product.id
                          ? "Opening..."
                          : "View on Shopify"}
                      </Button>
                    </div>
                  </div>
                </div>
              </PageCard>
            ))}
          </div>
        </div>
      )}
    </ExperienceShell>
  );
}
