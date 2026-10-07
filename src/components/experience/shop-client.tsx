"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Image from "next/image";
import {
  ErrorView,
  ExperienceShell,
  LoadingView,
  PageCard,
} from "@/components/experience/experience-shell";
import { getErrorMessage } from "@/components/experience/client-utils";
import { useExperience } from "@/components/experience/use-experience";
import { Commerce7RewardsClient } from "@/components/rewards/commerce7-rewards-client";
import { ShopifyShopRewardCard } from "@/components/rewards/shopify-shop-reward-card";
import { Button } from "@/components/ui/button";
import {
  isSafeClickPathSegment,
  parsePublicShopEnvelope,
  type PublicShopResponse,
} from "@/lib/commerce/public-commerce-response";

/**
 * The response shape is owned by `parsePublicShopEnvelope`/
 * `parsePublicShopResponse`, which are what actually prove a payload matches
 * at runtime. Aliasing rather than re-declaring keeps the rendered shape and
 * the validated shape from drifting — a re-declared copy would still compile
 * after the validator tightened.
 */
type ShopResponse = PublicShopResponse;
type ShopProduct = ShopResponse["products"][number];

export function ExperienceShopClient({
  experienceSlug,
}: {
  experienceSlug: string;
}) {
  const { data, loading, error } = useExperience(experienceSlug);

  // `experience`/`campaign` are stable across pages (the server returns them
  // identically on every page); only `products` accumulates.
  const [shopMeta, setShopMeta] = useState<Pick<ShopResponse, "experience" | "campaign"> | null>(
    null,
  );
  const [products, setProducts] = useState<ShopProduct[]>([]);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  const [shopLoading, setShopLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [shopError, setShopError] = useState<string | null>(null);
  const [clickingId, setClickingId] = useState<string | null>(null);
  const [failedImageIds, setFailedImageIds] = useState<Set<string>>(
    () => new Set(),
  );

  // Discards a superseded response — e.g. a slow first-page request that
  // resolves after a second render already started a fresh load.
  const requestSeq = useRef(0);

  const fetchPage = useCallback(
    async (cursor: string | null) => {
      const seq = ++requestSeq.current;
      const isFirstPage = cursor === null;
      if (isFirstPage) {
        setShopLoading(true);
      } else {
        setLoadingMore(true);
      }
      setShopError(null);

      try {
        // A PLAIN `fetch`, deliberately NOT `fetchJson`. This endpoint
        // answers `{ data, meta }` with `meta` OUTSIDE `data`, and
        // `fetchJson` returns only `json.data` — which would silently drop
        // `meta` entirely, exactly as it once did for the Brand campaign
        // products page's "Load more" control. See `parsePublicShopEnvelope`.
        const response = await fetch(
          `/api/public/experience/${encodeURIComponent(experienceSlug)}/products${
            cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""
          }`,
          { credentials: "include" },
        );
        const body: unknown = await response.json().catch(() => null);

        if (!response.ok) {
          const message = (body as { error?: string } | null)?.error;
          throw new Error(message || "Failed to load shop products.");
        }

        // Validated at RUNTIME, not merely cast. `fetchJson`'s final
        // statement is `as T` — a compile-time claim only — and a body
        // missing `products` previously reached the render and threw on
        // `shopData?.products.length`, a white screen for a public shopper.
        const parsed = parsePublicShopEnvelope(body);

        if (seq !== requestSeq.current) {
          return; // superseded by a newer request
        }

        if (!parsed) {
          // Deliberately NOT an empty catalog: a genuinely empty shop parses
          // to `products: []` and renders the empty state below. `null`
          // means the payload itself was malformed, which is an error.
          if (isFirstPage) {
            setShopMeta(null);
            setProducts([]);
          }
          setShopError("Failed to load shop products.");
          return;
        }

        setShopMeta({ experience: parsed.data.experience, campaign: parsed.data.campaign });
        setProducts((current) =>
          isFirstPage ? parsed.data.products : [...current, ...parsed.data.products],
        );
        setHasNextPage(parsed.meta.hasNextPage);
        setNextCursor(parsed.meta.nextCursor);
        if (isFirstPage) {
          setFailedImageIds(new Set());
        }
      } catch (loadError) {
        if (seq !== requestSeq.current) {
          return; // superseded
        }
        setShopError(getErrorMessage(loadError, "Failed to load shop products."));
      } finally {
        if (seq === requestSeq.current) {
          setShopLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [experienceSlug],
  );

  useEffect(() => {
    if (!data) {
      return;
    }

    void fetchPage(null);
    // Only the FIRST page should reload when the Experience context changes;
    // `fetchPage`'s own identity is stable across renders (memoized on
    // `experienceSlug` alone), so this does not re-fire on every keystroke
    // or state update.
  }, [data, fetchPage]);

  function handleLoadMore() {
    if (!hasNextPage || !nextCursor || loadingMore) {
      return;
    }
    void fetchPage(nextCursor);
  }

  function handleOpenProduct(product: ShopProduct) {
    // Every public shop product is a persisted canonical catalog product, so it
    // always carries one of these two opaque server-side click ids: a
    // campaign-scoped assignment id, or a brand-storefront catalog id. A
    // campaign-scoped card uses its assignment id so a direct Experience union
    // never has to choose a campaign in the browser.
    //
    // There is deliberately NO raw-`productUrl` fallback. Opening the merchant
    // URL directly would bypass the public-storefront gate (a product with no
    // reachable storefront URL 404s), the campaign-scope check, and click
    // attribution. If neither id is present the item is not a canonical catalog
    // product and is simply not clickable.
    //
    // Both ids are interpolated into a URL PATH, so each is re-checked against
    // the path-safe alphabet at the point of use. `parsePublicShopResponse`
    // already rejects a card carrying an unsafe id, so this can only fire if a
    // future caller renders an unvalidated card — it fails closed (not
    // clickable) rather than addressing an unintended endpoint.
    const target = isSafeClickPathSegment(product.campaignAssignmentId)
      ? `/api/public/experience/${encodeURIComponent(experienceSlug)}/products/click/campaign/${product.campaignAssignmentId}`
      : isSafeClickPathSegment(product.campaignProductId)
        ? `/api/public/experience/${encodeURIComponent(experienceSlug)}/products/click/catalog/${product.campaignProductId}`
        : null;

    if (!target) {
      return;
    }

    setClickingId(product.id);
    // The server-side click hop is the sole commerce click evidence.
    window.open(target, "_blank", "noopener,noreferrer");
    setClickingId((current) => (current === product.id ? null : current));
  }

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
          <p className="text-sm text-white/55">Shop items loaded</p>
          <p className="mt-2 text-3xl font-semibold">{products.length}</p>
          <p className="mt-2 text-sm text-white/55">
            Opens the merchant storefront in a new tab.
          </p>
        </div>
      }
    >
      {shopLoading ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading products...</p>
        </PageCard>
      ) : shopError && products.length === 0 ? (
        <PageCard>
          <p className="text-sm text-red-300">{shopError}</p>
        </PageCard>
      ) : !shopMeta ? (
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
                  {shopMeta.campaign
                    ? "These products are linked to this experience, selected for this campaign, or available from its brand storefront."
                    : "These products are linked to this experience or available from its linked campaign brands and storefronts."}
                </p>
              </div>
              {shopMeta.campaign && (
                <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/65">
                  Campaign: {shopMeta.campaign.name}
                </div>
              )}
            </div>
          </PageCard>

          <ShopifyShopRewardCard experienceSlug={experienceSlug} />
          <Commerce7RewardsClient experienceSlug={experienceSlug} campaignId={shopMeta.campaign?.id} />

          {products.length === 0 ? (
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
              <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {products.map((product) => (
                  <PageCard
                    key={product.id}
                    className="flex flex-col justify-between overflow-hidden"
                  >
                    <div>
                      <div className="overflow-hidden rounded-3xl border border-white/10">
                        {product.imageUrl && !failedImageIds.has(product.id) ? (
                          <Image
                            src={product.imageUrl}
                            alt={product.title}
                            width={640}
                            height={480}
                            unoptimized
                            onError={() => {
                              setFailedImageIds((current) => {
                                if (current.has(product.id)) return current;
                                const next = new Set(current);
                                next.add(product.id);
                                return next;
                              });
                            }}
                            /* Provider product images (Commerce7 wine bottle
                               shots especially) legitimately vary in aspect
                               ratio. `object-cover` CROPPED them — a tall
                               bottle lost its top and base inside this 4/3
                               canvas. `object-contain` keeps the fixed card
                               footprint every row depends on while showing
                               the entire source image, matching the Brand
                               catalog thumbnail fix. */
                            className="aspect-[4/3] w-full bg-white/5 object-contain p-2"
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
                            {product.source === "CAMPAIGN_PRODUCT"
                              ? "Campaign product"
                              : "Brand storefront"}
                          </span>
                          {product.brand && (
                            <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/60">
                              {product.brand.name}
                            </span>
                          )}
                          {product.productCampaign && (
                            <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/60">
                              Campaign: {product.productCampaign.name}
                            </span>
                          )}
                        </div>

                        <h3 className="mt-4 text-xl font-semibold text-[#988dbf]">
                          {product.title}
                        </h3>
                        {product.description && (
                          <p className="mt-2 text-sm leading-6 text-white/65">
                            {product.description}
                          </p>
                        )}
                        <p className="mt-2 text-sm text-white/55">
                          {product.priceText || "Price available in store"}
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
                              : "View product"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </PageCard>
                ))}
              </div>

              {shopError && (
                <PageCard>
                  <p className="text-sm text-red-300">{shopError}</p>
                </PageCard>
              )}

              {hasNextPage && (
                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={loadingMore}
                    onClick={handleLoadMore}
                    className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                  >
                    {loadingMore ? "Loading..." : "Load more products"}
                  </Button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </ExperienceShell>
  );
}
