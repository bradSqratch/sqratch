"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import {
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/**
 * One CANONICAL lesson product attachment, mirroring
 * `CreatorLessonProductItem` in
 * `src/lib/commerce/campaign-product-curation.ts` (declared locally, like every
 * other response type in this file, rather than imported).
 *
 * `id` is the opaque CampaignLessonProduct id — the only identifier the API
 * returns. There is deliberately no shop domain, provider id, or catalog id
 * here: display data is derived server-side from the brand's own synced
 * catalog, so there is also no "stale snapshot" state left to annotate.
 */
export type LessonProductLinkItem = {
  id: string;
  lessonId: string;
  productUrl: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  priceText: string | null;
  currency: string | null;
  brandId: string | null;
  displayOrder?: number;
  campaign?: {
    id: string;
    name: string;
    brandName: string | null;
  } | null;
  createdAt: string;
};

type AvailableLessonProduct = {
  id: string;
  /** A SQRATCH catalog id, never a provider product id — and the only product
   * value ever sent when attaching. */
  catalogProductId: string;
  title: string;
  handle: string;
  productUrl: string;
  images: string[];
  imageUrl: string | null;
  priceRange: {
    min: number | null;
    max: number | null;
  };
  priceText: string | null;
  currency: string;
  variantIds: string[];
};

/** One eligible campaign context offered by the explicit selector. Mirrors
 * `CampaignSelectorOption` in `src/lib/commerce/campaign-product-curation.ts`
 * (not imported directly — this file consumes only the JSON response shape,
 * consistent with how the rest of this file's response types are declared). */
type CampaignSelectorOption = {
  id: string;
  name: string;
  brandId: string;
  brandName: string | null;
};

type CampaignCurationPickerState = {
  enabled: boolean;
  campaignId?: string;
  requiresCampaignSelection: boolean;
  campaigns: CampaignSelectorOption[];
};

type AvailableLessonProductsResponse = {
  brand: {
    id: string;
    name: string;
    slug: string;
  } | null;
  candidateBrandCount: number;
  connected: boolean;
  items: AvailableLessonProduct[];
  curation?: CampaignCurationPickerState;
};

export function LessonProductLinksSection({
  lessonId,
  linkedProducts,
  onChanged,
}: {
  lessonId: string;
  linkedProducts: LessonProductLinkItem[];
  onChanged: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [available, setAvailable] =
    useState<AvailableLessonProductsResponse | null>(null);
  const [loadingAvailable, setLoadingAvailable] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [campaignId, setCampaignId] = useState<string>("");
  /** The campaign the creator explicitly chose from the 2+-context selector.
   * Remembered client-side for the attach payload and for the "Change
   * campaign" affordance. */
  const [selectedCampaign, setSelectedCampaign] =
    useState<CampaignSelectorOption | null>(null);
  /** Best-effort brandId -> brand name cache, accumulated from
   * available-products responses already fetched for this dialog (never a
   * new API call). Used only to label already-attached products; a brand
   * that hasn't appeared in a response yet simply renders without a label. */
  const [brandNamesById, setBrandNamesById] = useState<Record<string, string>>(
    {},
  );
  const [selectedUrls, setSelectedUrls] = useState<string[]>([]);
  const [linking, setLinking] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const linkedUrlSet = useMemo(
    () => new Set(linkedProducts.map((item) => item.productUrl)),
    [linkedProducts],
  );

  const filteredProducts = useMemo(() => {
    if (!available) {
      return [];
    }

    const normalizedQuery = query.trim().toLowerCase();

    return available.items.filter((product) => {
      if (!normalizedQuery) {
        return true;
      }

      return (
        product.title.toLowerCase().includes(normalizedQuery) ||
        product.productUrl.toLowerCase().includes(normalizedQuery)
      );
    });
  }, [available, query]);

  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedUrls([]);
      setCampaignId("");
      setSelectedCampaign(null);
      setPickerError(null);
      return;
    }

    async function loadAvailableProducts() {
      setLoadingAvailable(true);
      setPickerError(null);

      try {
        const requestedCampaignId = campaignId.trim();
        const result = await fetchJson<AvailableLessonProductsResponse>(
          `/api/creator/lessons/${lessonId}/available-products${
            requestedCampaignId
              ? `?campaignId=${encodeURIComponent(requestedCampaignId)}`
              : ""
          }`,
        );
        setAvailable(result);
        // Opportunistically learn brand names from this response for the
        // already-attached list's labels — no extra request, just reusing
        // data this call already returned.
        setBrandNamesById((current) => {
          const learned: Record<string, string> = {};
          if (result.brand) {
            learned[result.brand.id] = result.brand.name;
          }
          for (const campaign of result.curation?.campaigns || []) {
            if (campaign.brandName) {
              learned[campaign.brandId] = campaign.brandName;
            }
          }
          return Object.keys(learned).length > 0
            ? { ...current, ...learned }
            : current;
        });
      } catch (error) {
        setPickerError(
          getErrorMessage(error, "Failed to load available products."),
        );
      } finally {
        setLoadingAvailable(false);
      }
    }

    void loadAvailableProducts();
  }, [campaignId, lessonId, open]);

  function selectCampaignContext(campaign: CampaignSelectorOption) {
    setSelectedCampaign(campaign);
    setCampaignId(campaign.id);
    setSelectedUrls([]);
    setQuery("");
  }

  function clearCampaignSelection() {
    setSelectedCampaign(null);
    setCampaignId("");
    setSelectedUrls([]);
    setPickerError(null);
  }

  function toggleSelection(productUrl: string, checked: boolean) {
    setSelectedUrls((current) => {
      if (checked) {
        return current.includes(productUrl) ? current : [...current, productUrl];
      }

      return current.filter((value) => value !== productUrl);
    });
  }

  async function linkSelectedProducts() {
    if (!available || selectedUrls.length === 0) {
      return;
    }

    setLinking(true);
    setActionError(null);

    try {
      const selectedProducts = available.items.filter((product) =>
        selectedUrls.includes(product.productUrl),
      );
      // A resolved context echoes its campaignId back on the response; when the
      // Experience was ambiguous, the explicitly-picked `selectedCampaign` is
      // the remaining source of truth. Neither is set for an unambiguous (0/1
      // context) Experience, so `campaignId` is correctly omitted there.
      const resolvedCampaignId =
        available.curation?.campaignId || selectedCampaign?.id || null;

      // The attach payload carries ONLY the internal catalog id (and the
      // campaign it is being attached under). Product title/URL/price/brand are
      // never sent: the server re-derives all of them from the authorized
      // catalog row, and would ignore them anyway.
      for (const product of selectedProducts) {
        await fetchJson(`/api/creator/lessons/${lessonId}/products`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            catalogProductId: product.catalogProductId,
            ...(resolvedCampaignId ? { campaignId: resolvedCampaignId } : {}),
          }),
        });
      }

      await onChanged();
      setOpen(false);
    } catch (error) {
      setActionError(
        getErrorMessage(error, "Failed to link lesson products."),
      );
    } finally {
      setLinking(false);
    }
  }

  async function removeProduct(productLinkId: string) {
    setRemovingId(productLinkId);
    setActionError(null);

    try {
      await fetchJson(
        `/api/creator/lessons/${lessonId}/products/${productLinkId}`,
        {
          method: "DELETE",
        },
      );
      await onChanged();
    } catch (error) {
      setActionError(
        getErrorMessage(error, "Failed to remove lesson product."),
      );
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <>
      <div className="rounded-3xl border border-white/10 bg-black/20 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h3 className="text-lg font-semibold">Related Products</h3>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/60">
              Link products to this lesson so they can appear directly on the
              public lesson page.
            </p>
          </div>
          <Button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-full border border-white bg-white text-black"
          >
            Add product
          </Button>
        </div>

        {actionError && (
          <p className="mt-4 text-sm text-red-300">{actionError}</p>
        )}

        {linkedProducts.length === 0 ? (
          <div className="mt-5 rounded-3xl border border-dashed border-white/10 bg-black/10 p-5 text-sm text-white/55">
            No products are linked to this lesson yet.
          </div>
        ) : (
          <div className="mt-5 grid gap-4 xl:grid-cols-2">
            {linkedProducts.map((product) => {
              // Attribution labels come from the canonical attachment's own
              // campaign scope; the brand-name cache is only a fallback for a
              // brand this dialog has already seen. No campaign is ever
              // guessed from ordering.
              const campaignLabel = product.campaign?.name || null;
              const brandLabel = product.campaign?.brandName ||
                (product.brandId ? brandNamesById[product.brandId] || null : null);

              return (
                <div
                  key={product.id}
                  className="rounded-3xl border border-white/10 bg-[#111528] p-4"
                >
                  <div className="flex items-start gap-4">
                    {product.imageUrl ? (
                      <Image
                        src={product.imageUrl}
                        alt={product.title || "Lesson product"}
                        width={80}
                        height={80}
                        className="h-20 w-20 rounded-2xl object-cover"
                      />
                    ) : (
                      <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-white/8 text-xs text-white/45">
                        No image
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-base font-medium">
                          {product.title || "Linked product"}
                        </p>
                      </div>
                      <p className="mt-1 text-sm text-white/55">
                        {product.priceText || "Price available in store"}
                      </p>
                      {(campaignLabel || brandLabel) && (
                        <p className="mt-2 flex flex-wrap items-center gap-1.5">
                          {campaignLabel && (
                            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.14em] text-white/50">
                              {campaignLabel}
                            </span>
                          )}
                          {brandLabel && (
                            <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.14em] text-white/50">
                              {brandLabel}
                            </span>
                          )}
                        </p>
                      )}
                      <a
                        href={product.productUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-3 inline-flex text-sm text-sky-300 underline"
                      >
                        Open product
                      </a>
                    </div>

                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => void removeProduct(product.id)}
                      disabled={removingId === product.id}
                      className="rounded-full border-white/15 bg-transparent text-white hover:bg-white/10"
                    >
                      {removingId === product.id ? "Removing..." : "Remove"}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl border-white/10 bg-[#0d1021] text-white">
          <DialogHeader>
            <DialogTitle>Attach products</DialogTitle>
            <DialogDescription className="text-white/55">
              Choose products from the connected lesson brand storefront and add
              them to this lesson.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {!available?.curation?.requiresCampaignSelection && (
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search products"
                className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
            )}

            {loadingAvailable ? (
              <div className="rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/60">
                Loading products...
              </div>
            ) : pickerError ? (
              <div className="space-y-3 rounded-3xl border border-red-400/25 bg-red-500/10 p-6 text-sm text-red-200">
                <p>{pickerError}</p>
                {selectedCampaign && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={clearCampaignSelection}
                    className="rounded-full border-red-300/30 bg-transparent text-red-100 hover:bg-red-500/10"
                  >
                    Choose a different campaign
                  </Button>
                )}
              </div>
            ) : available?.curation?.requiresCampaignSelection ? (
              // 2+ eligible campaign contexts and none chosen yet. No product
              // list or attach UI is shown until the creator picks one — this
              // is what replaces the removed silent "first connected brand by
              // campaign order" fallback.
              <div className="space-y-3 rounded-3xl border border-white/10 bg-black/20 p-6">
                <p className="text-sm text-white/60">
                  This lesson is sponsored by multiple campaigns. Select which
                  one you&apos;re attaching a product for.
                </p>
                <div className="space-y-2">
                  {available.curation.campaigns.map((campaign) => (
                    <button
                      key={campaign.id}
                      type="button"
                      onClick={() => selectCampaignContext(campaign)}
                      className="flex w-full items-center justify-between gap-3 rounded-2xl border border-white/10 bg-[#111528] px-4 py-3 text-left text-sm transition hover:border-white/25"
                    >
                      <span className="text-white/80">
                        <span className="font-medium text-white">
                          {campaign.name}
                        </span>
                        {" — "}
                        {campaign.brandName || "Unknown brand"}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ) : !available?.connected ? (
              <div className="rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/60">
                {available?.brand
                  ? `${available.brand.name} does not have a connected store yet.`
                  : "This lesson does not resolve to a campaign brand with a connected store yet."}
              </div>
            ) : available.items.length === 0 ? (
              <div className="rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/60">
                No approved active products are assigned to this campaign.
              </div>
            ) : (
              <div className="space-y-3">
                {available.brand && (
                  <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/60">
                    {selectedCampaign ? (
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <span>
                          Attaching under{" "}
                          <span className="font-medium text-white">
                            {selectedCampaign.name}
                          </span>
                          {" — "}
                          {selectedCampaign.brandName || available.brand.name}
                        </span>
                        <button
                          type="button"
                          onClick={clearCampaignSelection}
                          className="text-xs text-sky-300 underline"
                        >
                          Change campaign
                        </button>
                      </div>
                    ) : (
                      <>
                        Using products from{" "}
                        <span className="font-medium text-white">
                          {available.brand.name}
                        </span>
                        .
                      </>
                    )}
                  </div>
                )}

                <div className="grid max-h-[420px] gap-3 overflow-y-auto pr-1 md:grid-cols-2">
                  {filteredProducts.map((product) => {
                    const alreadyLinked = linkedUrlSet.has(product.productUrl);
                    const checked = selectedUrls.includes(product.productUrl);

                    return (
                      <label
                        key={product.id}
                        className={`flex cursor-pointer gap-4 rounded-3xl border p-4 transition ${
                          alreadyLinked
                            ? "border-emerald-400/25 bg-emerald-500/10"
                            : "border-white/10 bg-black/20 hover:border-white/20"
                        }`}
                      >
                        <Checkbox
                          checked={alreadyLinked || checked}
                          disabled={alreadyLinked || linking}
                          onCheckedChange={(value) =>
                            toggleSelection(product.productUrl, value === true)
                          }
                          className="mt-1 border-white/20 data-[state=checked]:border-white data-[state=checked]:bg-white data-[state=checked]:text-black"
                        />

                        {product.imageUrl ? (
                          <Image
                            src={product.imageUrl}
                            alt={product.title}
                            width={80}
                            height={80}
                            className="h-20 w-20 rounded-2xl object-cover"
                          />
                        ) : (
                          <div className="flex h-20 w-20 items-center justify-center rounded-2xl bg-white/8 text-xs text-white/45">
                            No image
                          </div>
                        )}

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-3">
                            <p className="truncate font-medium">{product.title}</p>
                            {alreadyLinked && (
                              <span className="rounded-full border border-emerald-300/25 px-3 py-1 text-[11px] uppercase tracking-[0.18em] text-emerald-200">
                                Linked
                              </span>
                            )}
                          </div>
                          <p className="mt-2 text-sm text-white/55">
                            {product.priceText || "Price available in store"}
                          </p>
                          <p className="mt-2 truncate text-xs text-white/40">
                            {product.productUrl}
                          </p>
                        </div>
                      </label>
                    );
                  })}
                </div>

                {filteredProducts.length === 0 && (
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/60">
                    No products match your search.
                  </div>
                )}
              </div>
            )}

            {actionError && (
              <p className="text-sm text-red-300">{actionError}</p>
            )}

            <div className="flex flex-wrap justify-end gap-3">
              <Button
                type="button"
                variant="outline"
                onClick={() => setOpen(false)}
                className="rounded-full border-white/15 bg-transparent text-white hover:bg-white/10"
              >
                Cancel
              </Button>
              <Button
                type="button"
                onClick={() => void linkSelectedProducts()}
                disabled={
                  linking ||
                  selectedUrls.length === 0 ||
                  !available?.connected
                }
                className="rounded-full border border-white bg-white text-black"
              >
                {linking ? "Adding..." : `Add ${selectedUrls.length || ""} product${selectedUrls.length === 1 ? "" : "s"}`.trim()}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
