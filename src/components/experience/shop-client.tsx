"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Image from "next/image";
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

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

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
  const [pageSize, setPageSize] =
    useState<(typeof PAGE_SIZE_OPTIONS)[number]>(25);
  const [currentPage, setCurrentPage] = useState(1);

  const loadProducts = useCallback(async () => {
    setShopLoading(true);
    setShopError(null);

    try {
      const result = await fetchJson<ShopResponse>(
        `/api/public/experience/${experienceSlug}/products`,
      );
      setShopData(result);
      setCurrentPage(1);
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

  useEffect(() => {
    setCurrentPage(1);
  }, [pageSize]);

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

  const productCount = shopData?.products.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(productCount / pageSize));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const pageStartIndex = productCount
    ? (safeCurrentPage - 1) * pageSize
    : 0;
  const pageEndIndex = Math.min(pageStartIndex + pageSize, productCount);
  const visibleProducts = useMemo(
    () => shopData?.products.slice(pageStartIndex, pageEndIndex) ?? [],
    [pageEndIndex, pageStartIndex, shopData?.products],
  );
  const showPaginationControls = productCount > pageSize;

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
      ) : !shopData ? (
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

          <ShopifyShopRewardCard experienceSlug={experienceSlug} />

          {productCount === 0 ? (
            <PageCard>
              <div className="space-y-3">
                <h2 className="text-2xl font-semibold text-[#988dbf]">Shop</h2>
                <p className="max-w-2xl text-sm leading-6 text-white/70">
                  No products have been linked to this experience yet.
                </p>
              </div>
            </PageCard>
          ) : (
            <>
              {showPaginationControls && (
                <div className="flex flex-col gap-3 rounded-3xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/65 sm:flex-row sm:items-center sm:justify-between">
                  <p>
                    Showing {pageStartIndex + 1}&ndash;{pageEndIndex} of{" "}
                    {productCount} products
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <label className="flex items-center gap-2 text-white/60">
                      <span>Page size</span>
                      <select
                        value={pageSize}
                        onChange={(event) =>
                          setPageSize(
                            Number(event.target.value) as typeof pageSize,
                          )
                        }
                        className="rounded-full border border-white/10 bg-black/30 px-3 py-2 text-white outline-none transition focus:border-[#988dbf]"
                      >
                        {PAGE_SIZE_OPTIONS.map((option) => (
                          <option key={option} value={option} className="bg-[#120f1f]">
                            {option}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          setCurrentPage((page) => Math.max(1, page - 1))
                        }
                        disabled={safeCurrentPage === 1}
                        className="rounded-full border-white/15 bg-transparent text-white/75 hover:bg-white/10 hover:text-white"
                      >
                        Previous
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() =>
                          setCurrentPage((page) => Math.min(totalPages, page + 1))
                        }
                        disabled={safeCurrentPage === totalPages}
                        className="rounded-full border-white/15 bg-transparent text-white/75 hover:bg-white/10 hover:text-white"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
                {visibleProducts.map((product) => (
                  <PageCard key={product.id} className="h-full">
                    <div className="flex h-full flex-col">
                      <div className="relative overflow-hidden rounded-3xl border border-white/10 bg-black/20">
                        {product.imageUrl ? (
                          <Image
                            src={product.imageUrl}
                            alt={product.title}
                            width={400}
                            height={300}
                            unoptimized
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
            </>
          )}
        </div>
      )}
    </ExperienceShell>
  );
}
