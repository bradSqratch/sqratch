"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import { Gift, Package, Pencil, Power, RefreshCw } from "lucide-react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type ShopifyStatus = {
  id: string;
  name: string;
  slug: string;
  shopifyShopDomain: string | null;
  shopifyConnectionStatus: "DISCONNECTED" | "CONNECTED" | "UNINSTALLED";
  hasShopifyAccessToken: boolean;
  shopifyLastProductSyncAt: string | null;
} | null;

type ShopifyProduct = {
  id: string;
  shopifyProductGid: string;
  title: string;
  handle: string;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  priceRange: {
    min: number | null;
    max: number | null;
  };
  variantIds: string[];
};

type RewardProduct = {
  id?: string;
  shopifyProductGid: string;
  title: string | null;
  imageUrl: string | null;
  productUrl: string | null;
};

type RewardOffer = {
  id: string;
  title: string;
  description: string | null;
  isActive: boolean;
  pointsCost: number;
  discountAmountCents: number;
  currencyCode: string;
  claimStartsAt: string | null;
  claimEndsAt: string | null;
  codeValidDays: number;
  appliesTo: "ALL_PRODUCTS" | "SPECIFIC_PRODUCTS";
  minimumSubtotalCents: number | null;
  codePrefix: string | null;
  maxTotalRedemptions: number | null;
  maxRedemptionsPerUser: number | null;
  redemptionCount: number;
  computedAvailability: {
    status:
      | "CLAIMABLE"
      | "INACTIVE"
      | "NOT_STARTED"
      | "CLAIM_WINDOW_ENDED"
      | "LIMIT_REACHED"
      | "USER_LIMIT_REACHED"
      | "SHOPIFY_DISCONNECTED";
    label: string;
    claimable: boolean;
  };
  stats: {
    totalIssued: number;
    usedCount: number;
    expiredCount: number;
    failedCount: number;
  };
  products: RewardProduct[];
};

type OfferFormState = {
  title: string;
  description: string;
  isActive: boolean;
  pointsCost: string;
  discountAmount: string;
  currencyCode: string;
  claimStartsAt: string;
  claimEndsAt: string;
  codeValidDays: string;
  appliesTo: "ALL_PRODUCTS" | "SPECIFIC_PRODUCTS";
  minimumSubtotal: string;
  codePrefix: string;
  maxTotalRedemptions: string;
  maxRedemptionsPerUser: string;
  selectedProductGids: string[];
};

const defaultForm: OfferFormState = {
  title: "",
  description: "",
  isActive: false,
  pointsCost: "",
  discountAmount: "",
  currencyCode: "CAD",
  claimStartsAt: "",
  claimEndsAt: "",
  codeValidDays: "30",
  appliesTo: "ALL_PRODUCTS",
  minimumSubtotal: "",
  codePrefix: "",
  maxTotalRedemptions: "",
  maxRedemptionsPerUser: "",
  selectedProductGids: [],
};

function centsToDollars(cents: number | null) {
  if (!cents) return "";
  return (cents / 100).toFixed(2);
}

function dollarsToCents(value: string) {
  return Math.round(Number(value || 0) * 100);
}

function toInputDateTime(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}

function formatMoney(cents: number, currencyCode: string) {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: currencyCode,
  }).format(cents / 100);
}

function formatDate(value: string | null) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function getAvailabilityBadgeClass(status: RewardOffer["computedAvailability"]["status"]) {
  if (status === "CLAIMABLE") {
    return "border-emerald-300/30 bg-emerald-300/10 text-emerald-100";
  }

  if (status === "SHOPIFY_DISCONNECTED" || status === "LIMIT_REACHED") {
    return "border-amber-300/25 bg-amber-300/10 text-amber-100";
  }

  return "border-white/10 bg-white/5 text-white/60";
}

export default function BrandRewardsPage() {
  const [brand, setBrand] = useState<ShopifyStatus>(null);
  const [offers, setOffers] = useState<RewardOffer[]>([]);
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const [form, setForm] = useState<OfferFormState>(defaultForm);
  const [editingOfferId, setEditingOfferId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [saving, setSaving] = useState(false);
  const [disablingId, setDisablingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const isConnected =
    brand?.shopifyConnectionStatus === "CONNECTED" &&
    Boolean(brand.shopifyShopDomain) &&
    brand.hasShopifyAccessToken;
  const selectedProductSet = useMemo(
    () => new Set(form.selectedProductGids),
    [form.selectedProductGids],
  );
  const offerProductsByGid = useMemo(() => {
    const map = new Map<string, RewardProduct>();

    for (const offer of offers) {
      for (const product of offer.products) {
        map.set(product.shopifyProductGid, product);
      }
    }

    return map;
  }, [offers]);

  async function loadPage() {
    setLoading(true);
    setError(null);

    try {
      const [status, offerData] = await Promise.all([
        fetchJson<ShopifyStatus>("/api/brand/shopify/status"),
        fetchJson<RewardOffer[]>("/api/brand/rewards/offers"),
      ]);
      setBrand(status);
      setOffers(offerData);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load reward offers."));
    } finally {
      setLoading(false);
    }
  }

  async function loadProducts() {
    setLoadingProducts(true);
    setError(null);

    try {
      const productData = await fetchJson<ShopifyProduct[]>(
        "/api/brand/shopify/products",
      );
      setProducts(productData);
    } catch (productError) {
      setError(
        getErrorMessage(productError, "Failed to load Shopify products."),
      );
    } finally {
      setLoadingProducts(false);
    }
  }

  useEffect(() => {
    void loadPage();
  }, []);

  useEffect(() => {
    if (isConnected && products.length === 0) {
      void loadProducts();
    }
  }, [isConnected, products.length]);

  function updateForm<K extends keyof OfferFormState>(
    key: K,
    value: OfferFormState[K],
  ) {
    setForm((current) => ({
      ...current,
      [key]: value,
      ...(key === "appliesTo" && value === "ALL_PRODUCTS"
        ? { selectedProductGids: [] }
        : {}),
    }));
  }

  function toggleProduct(product: ShopifyProduct, checked: boolean) {
    setForm((current) => {
      const next = checked
        ? Array.from(
            new Set([...current.selectedProductGids, product.shopifyProductGid]),
          )
        : current.selectedProductGids.filter(
            (gid) => gid !== product.shopifyProductGid,
          );

      return {
        ...current,
        selectedProductGids: next,
      };
    });
  }

  function editOffer(offer: RewardOffer) {
    setEditingOfferId(offer.id);
    setForm({
      title: offer.title,
      description: offer.description || "",
      isActive: offer.isActive,
      pointsCost: String(offer.pointsCost),
      discountAmount: centsToDollars(offer.discountAmountCents),
      currencyCode: offer.currencyCode,
      claimStartsAt: toInputDateTime(offer.claimStartsAt),
      claimEndsAt: toInputDateTime(offer.claimEndsAt),
      codeValidDays: String(offer.codeValidDays),
      appliesTo: offer.appliesTo,
      minimumSubtotal: centsToDollars(offer.minimumSubtotalCents),
      codePrefix: offer.codePrefix || "",
      maxTotalRedemptions: offer.maxTotalRedemptions
        ? String(offer.maxTotalRedemptions)
        : "",
      maxRedemptionsPerUser: offer.maxRedemptionsPerUser
        ? String(offer.maxRedemptionsPerUser)
        : "",
      selectedProductGids: offer.products.map(
        (product) => product.shopifyProductGid,
      ),
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function resetForm() {
    setEditingOfferId(null);
    setForm(defaultForm);
  }

  async function saveOffer() {
    setSaving(true);
    setError(null);
    setMessage(null);

    const productCatalog = new Map(
      products.map((product) => [product.shopifyProductGid, product]),
    );
    const selectedProducts = form.selectedProductGids.map((gid) => {
      const product = productCatalog.get(gid);
      const existingProduct = offerProductsByGid.get(gid);

      return {
        shopifyProductGid: gid,
        title: product?.title || existingProduct?.title || null,
        imageUrl: product?.imageUrl || existingProduct?.imageUrl || null,
        productUrl: product?.productUrl || existingProduct?.productUrl || null,
      };
    });

    try {
      await fetchJson(
        editingOfferId
          ? `/api/brand/rewards/offers/${editingOfferId}`
          : "/api/brand/rewards/offers",
        {
          method: editingOfferId ? "PUT" : "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: form.title,
            description: form.description,
            isActive: form.isActive,
            pointsCost: Number(form.pointsCost),
            discountAmountCents: dollarsToCents(form.discountAmount),
            currencyCode: form.currencyCode || "CAD",
            claimStartsAt: form.claimStartsAt || null,
            claimEndsAt: form.claimEndsAt || null,
            codeValidDays: Number(form.codeValidDays || 30),
            appliesTo: form.appliesTo,
            minimumSubtotalCents: form.minimumSubtotal
              ? dollarsToCents(form.minimumSubtotal)
              : null,
            codePrefix: form.codePrefix || null,
            maxTotalRedemptions: form.maxTotalRedemptions
              ? Number(form.maxTotalRedemptions)
              : null,
            maxRedemptionsPerUser: form.maxRedemptionsPerUser
              ? Number(form.maxRedemptionsPerUser)
              : null,
            products: selectedProducts,
          }),
        },
      );
      setMessage(editingOfferId ? "Reward offer updated." : "Reward offer created.");
      resetForm();
      await loadPage();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to save reward offer."));
    } finally {
      setSaving(false);
    }
  }

  async function disableOffer(offerId: string) {
    setDisablingId(offerId);
    setError(null);
    setMessage(null);

    try {
      await fetchJson(`/api/brand/rewards/offers/${offerId}`, {
        method: "PATCH",
      });
      setMessage("Reward offer disabled.");
      await loadPage();
    } catch (disableError) {
      setError(getErrorMessage(disableError, "Failed to disable offer."));
    } finally {
      setDisablingId(null);
    }
  }

  return (
    <BrandPageShell
      title="Rewards"
      description="Create Shopify discount offers that customers can claim with SQRATCH points."
    >
      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading rewards...</p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 md:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Shopify status</p>
                <p className="mt-2 text-2xl font-semibold">
                  {isConnected
                    ? "Connected"
                    : brand?.shopifyConnectionStatus === "UNINSTALLED"
                      ? "Uninstalled"
                      : "Not connected"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Shop domain</p>
                <p className="mt-2 text-sm text-white/80">
                  {brand?.shopifyShopDomain || "Not set"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Offers</p>
                <p className="mt-2 text-2xl font-semibold">{offers.length}</p>
              </div>
            </div>

            {!isConnected ? (
              <div className="rounded-2xl border border-amber-300/20 bg-amber-300/10 p-4 text-sm text-amber-100">
                Reconnect Shopify before creating or enabling reward offers.
              </div>
            ) : null}

            {error ? <p className="text-sm text-red-300">{error}</p> : null}
            {message ? (
              <p className="text-sm text-emerald-300">{message}</p>
            ) : null}
          </div>
        )}
      </PageCard>

      <PageCard>
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div>
            <h2 className="text-xl font-semibold">
              {editingOfferId ? "Edit reward offer" : "Create reward offer"}
            </h2>
            <p className="mt-1 text-sm text-white/55">
              Codes are single-use globally and manually copied into Shopify
              checkout. Active means enabled by Brand Admin; Claimable means
              users can currently redeem it.
            </p>
          </div>
          {editingOfferId ? (
            <Button
              type="button"
              variant="outline"
              onClick={resetForm}
              className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
            >
              Cancel edit
            </Button>
          ) : null}
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <label className="space-y-2 text-sm text-white/70">
            <span>Title</span>
            <Input
              value={form.title}
              onChange={(event) => updateForm("title", event.target.value)}
              placeholder="100 points = CAD $10 off"
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Currency</span>
            <Input
              value={form.currencyCode}
              onChange={(event) =>
                updateForm("currencyCode", event.target.value.toUpperCase())
              }
              placeholder="CAD"
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70 lg:col-span-2">
            <span>Description</span>
            <Textarea
              value={form.description}
              onChange={(event) =>
                updateForm("description", event.target.value)
              }
              placeholder="Reward details shown to users."
              className="min-h-24 border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Points cost</span>
            <Input
              type="number"
              min="1"
              value={form.pointsCost}
              onChange={(event) => updateForm("pointsCost", event.target.value)}
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Discount amount</span>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={form.discountAmount}
              onChange={(event) =>
                updateForm("discountAmount", event.target.value)
              }
              placeholder="10.00"
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Claim starts at</span>
            <Input
              type="datetime-local"
              value={form.claimStartsAt}
              onChange={(event) =>
                updateForm("claimStartsAt", event.target.value)
              }
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Claim ends at</span>
            <Input
              type="datetime-local"
              value={form.claimEndsAt}
              onChange={(event) => updateForm("claimEndsAt", event.target.value)}
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Code valid days after claim</span>
            <Input
              type="number"
              min="1"
              max="365"
              value={form.codeValidDays}
              onChange={(event) =>
                updateForm("codeValidDays", event.target.value)
              }
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Applies to</span>
            <select
              value={form.appliesTo}
              onChange={(event) =>
                updateForm(
                  "appliesTo",
                  event.target.value as OfferFormState["appliesTo"],
                )
              }
              className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
            >
              <option value="ALL_PRODUCTS">All products</option>
              <option value="SPECIFIC_PRODUCTS">Selected products</option>
            </select>
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Minimum subtotal</span>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.minimumSubtotal}
              onChange={(event) =>
                updateForm("minimumSubtotal", event.target.value)
              }
              placeholder="Optional"
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Code prefix</span>
            <Input
              value={form.codePrefix}
              onChange={(event) => updateForm("codePrefix", event.target.value)}
              placeholder="SQRATCH"
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Max total redemptions</span>
            <Input
              type="number"
              min="1"
              value={form.maxTotalRedemptions}
              onChange={(event) =>
                updateForm("maxTotalRedemptions", event.target.value)
              }
              placeholder="Optional"
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Max redemptions per user</span>
            <Input
              type="number"
              min="1"
              value={form.maxRedemptionsPerUser}
              onChange={(event) =>
                updateForm("maxRedemptionsPerUser", event.target.value)
              }
              placeholder="Optional"
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="flex items-center gap-3 rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/70 lg:col-span-2">
            <Checkbox
              checked={form.isActive}
              onCheckedChange={(checked) => updateForm("isActive", checked === true)}
              disabled={!isConnected && !form.isActive}
              className="border-white/30 data-[state=checked]:border-emerald-300 data-[state=checked]:bg-emerald-400"
            />
            Active offer
          </label>
        </div>

        {form.appliesTo === "SPECIFIC_PRODUCTS" ? (
          <div className="mt-6 rounded-3xl border border-white/10 bg-black/20 p-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h3 className="font-semibold">Selected Shopify products</h3>
                <p className="mt-1 text-sm text-white/55">
                  Select products by Shopify product GID.
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => void loadProducts()}
                disabled={loadingProducts || !isConnected}
                className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
              >
                <RefreshCw className="h-4 w-4" />
                {loadingProducts ? "Loading..." : "Refresh products"}
              </Button>
            </div>

            <div className="mt-4 grid max-h-[520px] gap-3 overflow-y-auto pr-1 lg:grid-cols-2">
              {products.length === 0 ? (
                <div className="rounded-2xl border border-dashed border-white/10 p-4 text-sm text-white/55">
                  No Shopify products loaded.
                </div>
              ) : (
                products.map((product) => (
                  <label
                    key={product.shopifyProductGid}
                    className="flex cursor-pointer gap-4 rounded-2xl border border-white/10 bg-[#111528] p-3"
                  >
                    <Checkbox
                      checked={selectedProductSet.has(product.shopifyProductGid)}
                      onCheckedChange={(checked) =>
                        toggleProduct(product, checked === true)
                      }
                      className="mt-1 border-white/30 data-[state=checked]:border-emerald-300 data-[state=checked]:bg-emerald-400"
                    />
                    {product.imageUrl ? (
                      <Image
                        src={product.imageUrl}
                        alt={product.title}
                        width={64}
                        height={64}
                        className="h-16 w-16 rounded-xl object-cover"
                      />
                    ) : (
                      <div className="flex h-16 w-16 items-center justify-center rounded-xl bg-white/8 text-white/35">
                        <Package className="h-5 w-5" />
                      </div>
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {product.title}
                      </span>
                      <span className="mt-1 block truncate text-xs text-white/45">
                        {product.shopifyProductGid}
                      </span>
                    </span>
                  </label>
                ))
              )}
            </div>
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          <Button
            type="button"
            onClick={() => void saveOffer()}
            disabled={
              saving || (!isConnected && (!editingOfferId || form.isActive))
            }
            className="rounded-full border border-white bg-white text-black hover:bg-white/90"
          >
            <Gift className="h-4 w-4" />
            {saving
              ? "Saving..."
              : editingOfferId
                ? "Save reward offer"
                : "Create reward offer"}
          </Button>
        </div>
      </PageCard>

      <PageCard>
        <h2 className="text-xl font-semibold">Reward offers</h2>
        <p className="mt-1 text-sm text-white/55">
          Disable offers when they should no longer be claimable. Active means
          enabled by Brand Admin; Claimable means users can currently redeem it.
        </p>

        <div className="mt-6 space-y-4">
          {offers.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 p-5 text-sm text-white/55">
              No reward offers created yet.
            </div>
          ) : (
            offers.map((offer) => (
              <div
                key={offer.id}
                className="rounded-3xl border border-white/10 bg-black/20 p-5"
              >
                <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
                  <div>
                    <div className="flex flex-wrap items-center gap-3">
                      <h3 className="text-xl font-semibold">{offer.title}</h3>
                      <span
                        className={`rounded-full border px-3 py-1 text-xs ${getAvailabilityBadgeClass(
                          offer.computedAvailability.status,
                        )}`}
                      >
                        {offer.computedAvailability.label}
                      </span>
                      {offer.isActive &&
                      offer.computedAvailability.status !== "CLAIMABLE" ? (
                        <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/45">
                          Active
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-2 text-sm text-white/55">
                      {offer.pointsCost} points for{" "}
                      {formatMoney(offer.discountAmountCents, offer.currencyCode)}
                    </p>
                    <p className="mt-2 text-sm text-white/45">
                      Claim by {formatDate(offer.claimEndsAt)}. Code expires{" "}
                      {offer.codeValidDays} days after claim.
                    </p>
                    <p className="mt-2 text-xs uppercase tracking-[0.18em] text-white/35">
                      {offer.appliesTo === "ALL_PRODUCTS"
                        ? "All products"
                        : `${offer.products.length} selected products`}
                    </p>
                  </div>

                  <div className="grid min-w-[280px] grid-cols-2 gap-3 text-sm">
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <p className="text-white/45">Issued</p>
                      <p className="mt-1 text-xl font-semibold">
                        {offer.stats?.totalIssued || 0}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <p className="text-white/45">Used</p>
                      <p className="mt-1 text-xl font-semibold">
                        {offer.stats?.usedCount || 0}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <p className="text-white/45">Expired</p>
                      <p className="mt-1 text-xl font-semibold">
                        {offer.stats?.expiredCount || 0}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                      <p className="text-white/45">Failed</p>
                      <p className="mt-1 text-xl font-semibold">
                        {offer.stats?.failedCount || 0}
                      </p>
                    </div>
                  </div>
                </div>

                <div className="mt-5 flex flex-wrap gap-3">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => editOffer(offer)}
                    className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                  >
                    <Pencil className="h-4 w-4" />
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="destructive"
                    onClick={() => void disableOffer(offer.id)}
                    disabled={!offer.isActive || disablingId === offer.id}
                    className="rounded-full border border-red-500/40 bg-red-500 text-white hover:bg-red-500/90"
                  >
                    <Power className="h-4 w-4" />
                    {disablingId === offer.id ? "Disabling..." : "Disable"}
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </PageCard>
    </BrandPageShell>
  );
}
