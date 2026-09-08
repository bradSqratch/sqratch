"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  parseCampaignProductEnvelope,
  type CampaignProductEnvelope,
  type CampaignProductRow,
} from "@/app/(withSidebar)/dashboard/brand/commerce/commerce-response-validation";

/**
 * Owned by `parseCampaignProductEnvelope`, which validates the payload at
 * runtime. Aliased rather than re-declared so the rendered shape and the
 * validated shape cannot drift.
 */
type ProductRow = CampaignProductRow;
type Response = Pick<CampaignProductEnvelope, "campaign" | "products">;
type PageMeta = CampaignProductEnvelope["meta"];

/**
 * Short enough that the list still feels live while typing, long enough that a
 * normal search term costs ONE catalog query instead of one per character.
 */
const SEARCH_DEBOUNCE_MS = 300;

function getVisibilityExplanation(product: ProductRow): string {
  if (!product.hasPublicStorefrontUrl) {
    return "Not currently public on the merchant storefront; it will not render publicly until provider publication is confirmed.";
  }
  if (!product.isAvailable) {
    return "Product is unavailable in the catalog and will not render publicly.";
  }
  const assignmentActive = product.assignment?.isActive;
  if (assignmentActive && !product.isVisibleInShop) {
    return "Visible through this campaign assignment only.";
  }
  if (product.assignment && !assignmentActive && product.isVisibleInShop) {
    return "Campaign assignment inactive. This product can still appear through the Brand storefront.";
  }
  if (assignmentActive && product.isVisibleInShop) {
    return "Active in this campaign and visible in the Brand storefront.";
  }
  if (!product.assignment && product.isVisibleInShop) {
    return "Not assigned to this campaign. Visible through the Brand storefront.";
  }
  return "Not assigned to this campaign and hidden from Brand storefront.";
}

export default function BrandCampaignProductsPage({ params }: { params: { id: string } }) {
  const campaignId = params.id;
  const [data, setData] = useState<Response | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  // Discards a superseded response. Typing in the search box fires overlapping
  // requests, and without this a SLOW earlier response could land after a fast
  // later one and repopulate the list with results for a query the operator
  // has already replaced.
  const requestSeq = useRef(0);

  const load = useCallback(async (cursor?: string, append = false) => {
    const seq = ++requestSeq.current;
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (query.trim()) qs.set("q", query.trim());
      if (cursor) qs.set("cursor", cursor);

      // A PLAIN `fetch`, deliberately NOT `fetchJson`. This endpoint answers
      // `{ data, meta }` with `meta` OUTSIDE `data`, and `fetchJson` returns
      // only `json.data` — which silently dropped `meta` entirely, leaving
      // `meta?.hasNextPage` permanently falsy so "Load more products" never
      // rendered and pages past the first were unreachable. See
      // `parseCampaignProductEnvelope`.
      const response = await fetch(
        `/api/brand/campaigns/${encodeURIComponent(campaignId)}/commerce-products?${qs}`,
        { credentials: "include" },
      );
      const body: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const message = (body as { error?: string } | null)?.error;
        throw new Error(message || "Failed to load campaign products.");
      }

      const parsed = parseCampaignProductEnvelope(body);
      if (!parsed) {
        throw new Error("Failed to load campaign products.");
      }

      if (seq !== requestSeq.current) return; // superseded

      setData((current) => append && current
        ? { campaign: parsed.campaign, products: [...current.products, ...parsed.products] }
        : { campaign: parsed.campaign, products: parsed.products });
      setMeta(parsed.meta);
    } catch (loadError) {
      if (seq !== requestSeq.current) return; // superseded
      setError(getErrorMessage(loadError, "Failed to load campaign products."));
    }
  }, [campaignId, query]);

  // DEBOUNCED. `load`'s identity changes with `query`, so before this every
  // keystroke fired its own request — typing "cabernet" issued eight catalog
  // queries, each a `contains` scan over the brand's products. The trailing
  // edge is what the operator actually meant; `requestSeq` still discards any
  // in-flight response the debounce did not prevent.
  //
  // An EMPTY query waits for nothing. That is the first paint and the
  // just-cleared-the-box case, where a delay would only make the page feel
  // slower without collapsing any keystrokes.
  useEffect(() => {
    if (!query.trim()) {
      void load();
      return;
    }
    const timer = setTimeout(() => {
      void load();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `load` already closes over `query`; it is the dependency that matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);

  async function assign(product: ProductRow) {
    setSaving(product.brandCommerceProductId);
    setError(null);
    try {
      if (product.assignment) {
        await fetchJson(`/api/brand/campaigns/${campaignId}/commerce-products`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ assignmentId: product.assignment.id, isActive: !product.assignment.isActive }),
        });
      } else {
        await fetchJson(`/api/brand/campaigns/${campaignId}/commerce-products`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ brandCommerceProductId: product.brandCommerceProductId, displayOrder: 0 }),
        });
      }
      await load();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to update campaign product."));
    } finally { setSaving(null); }
  }

  async function saveOrder(product: ProductRow, value: string) {
    if (!product.assignment) return;
    const displayOrder = Number(value);
    if (!Number.isInteger(displayOrder) || displayOrder < 0 || displayOrder > 1_000_000) {
      setError("Display order must be a whole number from 0 to 1000000.");
      return;
    }
    setSaving(product.brandCommerceProductId);
    setError(null);
    try {
      await fetchJson(`/api/brand/campaigns/${campaignId}/commerce-products`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assignmentId: product.assignment.id, displayOrder }),
      });
      await load();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to save display order."));
    } finally { setSaving(null); }
  }

  return <BrandPageShell
    title={data ? `${data.campaign.name} Products` : "Campaign Products"}
    description="Assign eligible, available brand catalog products to this campaign. Campaign assignment and generic Brand storefront visibility operate independently."
    actions={<Button asChild variant="outline" className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"><Link href={`/dashboard/brand/campaigns/${campaignId}/edit`}>Back to campaign</Link></Button>}
  >
    <PageCard>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        {/* A placeholder is not an accessible name — it disappears on input
            and several screen readers ignore it. The display-order input in
            this same file already carries an aria-label; this matches it. */}
        <Input aria-label="Search catalog products" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search catalog products" className="max-w-xl border-white/10 bg-black/20 text-white placeholder:text-white/35" />
      </div>
    </PageCard>
    {error && <PageCard><p className="text-sm text-red-300">{error}</p></PageCard>}
    {!data ? <PageCard><p className="text-sm text-white/65">Loading catalog...</p></PageCard> : <div className="space-y-4">
      {data.products.map((product) => {
        const canAssign = product.isCampaignEligible && product.isAvailable;
        const active = product.assignment?.isActive;
        const explanation = getVisibilityExplanation(product);
        return <PageCard key={product.brandCommerceProductId}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex gap-4">
              {/* `object-contain` inside a fixed canvas — provider product
                  images vary in aspect ratio and `object-cover` cropped tall
                  bottle shots. Matches the Brand catalog thumbnail. */}
              {product.imageUrl && <Image src={product.imageUrl} alt="" width={64} height={64} className="h-16 w-16 rounded-lg bg-white/5 object-contain p-1" />}
              <div className="space-y-2">
                <h2 className="font-semibold text-white">{product.title}</h2>
                {product.description && <p className="text-sm text-white/55">{product.description}</p>}
                <div className="flex flex-wrap items-center gap-2 pt-1 text-xs">
                  <span className={`rounded-full px-2.5 py-0.5 border ${active ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-300" : product.assignment ? "border-amber-400/30 bg-amber-500/10 text-amber-300" : "border-white/10 bg-white/5 text-white/50"}`}>
                    {active ? "Campaign active" : product.assignment ? "Campaign inactive" : "Not assigned"}
                  </span>
                  <span className={`rounded-full px-2.5 py-0.5 border ${product.isVisibleInShop ? "border-sky-400/30 bg-sky-500/10 text-sky-300" : "border-white/10 bg-white/5 text-white/45"}`}>
                    {product.isVisibleInShop ? "Storefront visible" : "Storefront hidden"}
                  </span>
                  <span className={`rounded-full px-2.5 py-0.5 border ${product.isCampaignEligible ? "border-white/20 bg-white/5 text-white/70" : "border-red-400/20 bg-red-500/10 text-red-300"}`}>
                    {product.isCampaignEligible ? "Campaign eligible" : "Not eligible"}
                  </span>
                  <span className={`rounded-full px-2.5 py-0.5 border ${product.isAvailable ? "border-white/20 bg-white/5 text-white/70" : "border-red-400/20 bg-red-500/10 text-red-300"}`}>
                    {product.isAvailable ? "Catalog available" : "Unavailable"}
                  </span>
                  {!product.hasPublicStorefrontUrl && (
                    <span className="rounded-full border border-amber-400/30 bg-amber-500/10 px-2.5 py-0.5 text-amber-300">
                      Unpublished online
                    </span>
                  )}
                </div>
                <p className="text-xs text-white/50">{explanation}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {product.assignment && <label className="text-xs text-white/55">Order <Input aria-label={`Display order for ${product.title}`} type="number" min={0} max={1000000} defaultValue={product.assignment.displayOrder} onBlur={(event) => void saveOrder(product, event.target.value)} disabled={saving === product.brandCommerceProductId} className="ml-2 inline-flex h-8 w-24 border-white/10 bg-black/20 text-white" /></label>}
              <Button type="button" disabled={saving === product.brandCommerceProductId || (!product.assignment && !canAssign)} onClick={() => void assign(product)} className="rounded-full border border-white bg-white text-black">
                {saving === product.brandCommerceProductId ? "Saving..." : product.assignment ? (active ? "Deactivate campaign assignment" : "Reactivate campaign assignment") : "Assign to campaign"}
              </Button>
            </div>
          </div>
        </PageCard>;
      })}
      {data.products.length === 0 && <PageCard><p className="text-sm text-white/65">No persisted brand catalog products match this search.</p></PageCard>}
      {meta?.hasNextPage && meta.nextCursor && <div className="flex justify-center"><Button type="button" variant="outline" disabled={saving === "more"} onClick={() => { setSaving("more"); void load(meta.nextCursor ?? undefined, true).finally(() => setSaving(null)); }} className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10">{saving === "more" ? "Loading..." : "Load more products"}</Button></div>}
    </div>}
  </BrandPageShell>;
}
