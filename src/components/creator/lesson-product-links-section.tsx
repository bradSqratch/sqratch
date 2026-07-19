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

export type LessonProductLinkItem = {
  id: string;
  lessonId: string;
  productUrl: string;
  title: string | null;
  imageUrl: string | null;
  priceText: string | null;
  currency: string | null;
  brandId: string | null;
  createdAt: string;
  /** True when this link's product no longer belongs to the currently
   * connected Shopify store and needs to be re-linked. */
  needsRelinking?: boolean;
};

type AvailableLessonProduct = {
  id: string;
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

type AvailableLessonProductsResponse = {
  brand: {
    id: string;
    name: string;
    slug: string;
  } | null;
  candidateBrandCount: number;
  connected: boolean;
  items: AvailableLessonProduct[];
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
      setPickerError(null);
      return;
    }

    async function loadAvailableProducts() {
      setLoadingAvailable(true);
      setPickerError(null);

      try {
        const result = await fetchJson<AvailableLessonProductsResponse>(
          `/api/creator/lessons/${lessonId}/available-products`,
        );
        setAvailable(result);
      } catch (error) {
        setPickerError(
          getErrorMessage(error, "Failed to load available Shopify products."),
        );
      } finally {
        setLoadingAvailable(false);
      }
    }

    void loadAvailableProducts();
  }, [lessonId, open]);

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

      for (const product of selectedProducts) {
        await fetchJson(`/api/creator/lessons/${lessonId}/products`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            product,
            brandId: available.brand?.id || null,
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
              Link Shopify products to this lesson so they can appear directly
              on the public lesson page.
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
            {linkedProducts.map((product) => (
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
                      {product.needsRelinking ? (
                        <span className="rounded-full border border-amber-300/25 bg-amber-300/10 px-2 py-0.5 text-[11px] uppercase tracking-[0.14em] text-amber-100">
                          Needs relinking
                        </span>
                      ) : null}
                    </div>
                    {product.needsRelinking ? (
                      <p className="mt-1 text-xs text-amber-200/80">
                        This product belongs to a previous or unknown Shopify
                        store and is hidden from the public lesson page.
                        Remove it and add a current product to fix.
                      </p>
                    ) : null}
                    <p className="mt-1 text-sm text-white/55">
                      {product.priceText || "Price available on Shopify"}
                    </p>
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
            ))}
          </div>
        )}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-5xl border-white/10 bg-[#0d1021] text-white">
          <DialogHeader>
            <DialogTitle>Attach Shopify products</DialogTitle>
            <DialogDescription className="text-white/55">
              Choose products from the connected lesson brand storefront and add
              them to this lesson.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search products"
              className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
            />

            {loadingAvailable ? (
              <div className="rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/60">
                Loading Shopify products...
              </div>
            ) : pickerError ? (
              <div className="rounded-3xl border border-red-400/25 bg-red-500/10 p-6 text-sm text-red-200">
                {pickerError}
              </div>
            ) : !available?.connected ? (
              <div className="rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/60">
                {available?.brand
                  ? `${available.brand.name} does not have a connected Shopify store yet.`
                  : "This lesson does not resolve to a campaign brand with a connected Shopify store yet."}
              </div>
            ) : available.items.length === 0 ? (
              <div className="rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/60">
                No Shopify products were returned for the selected brand.
              </div>
            ) : (
              <div className="space-y-3">
                {available.brand && (
                  <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-sm text-white/60">
                    Using products from <span className="font-medium text-white">{available.brand.name}</span>.
                    {available.candidateBrandCount > 1 &&
                      " This experience is attached to multiple campaign brands, so the picker uses the first connected brand by campaign order."}
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
                            {product.priceText || "Price available on Shopify"}
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
