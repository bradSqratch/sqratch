"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type ProductRow = {
  brandCommerceProductId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  isCampaignEligible: boolean;
  isAvailable: boolean;
  assignment: { id: string; isActive: boolean; displayOrder: number } | null;
};
type Response = {
  campaign: { id: string; name: string };
  products: ProductRow[];
};
type PageMeta = { hasNextPage: boolean; nextCursor: string | null; limit: number };

export default function BrandCampaignProductsPage({ params }: { params: { id: string } }) {
  const campaignId = params.id;
  const [data, setData] = useState<Response | null>(null);
  const [meta, setMeta] = useState<PageMeta | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string, append = false) => {
    setError(null);
    try {
      const qs = new URLSearchParams();
      if (query.trim()) qs.set("q", query.trim());
      if (cursor) qs.set("cursor", cursor);
      const result = await fetchJson<Response & { meta: PageMeta }>(`/api/brand/campaigns/${campaignId}/commerce-products?${qs}`);
      setData((current) => append && current
        ? { ...result, products: [...current.products, ...result.products] }
        : result);
      setMeta(result.meta);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load campaign products."));
    }
  }, [campaignId, query]);

  useEffect(() => { void load(); }, [load]);

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
    description="Assign eligible, available brand catalog products to this campaign. Deactivation is reversible and preserves assignment history."
    actions={<Button asChild variant="outline" className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"><Link href={`/dashboard/brand/campaigns/${campaignId}/edit`}>Back to campaign</Link></Button>}
  >
    <PageCard>
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search catalog products" className="max-w-xl border-white/10 bg-black/20 text-white placeholder:text-white/35" />
      </div>
    </PageCard>
    {error && <PageCard><p className="text-sm text-red-300">{error}</p></PageCard>}
    {!data ? <PageCard><p className="text-sm text-white/65">Loading catalog...</p></PageCard> : <div className="space-y-4">
      {data.products.map((product) => {
        const canAssign = product.isCampaignEligible && product.isAvailable;
        const active = product.assignment?.isActive;
        return <PageCard key={product.brandCommerceProductId}>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex gap-4">
              {product.imageUrl && <Image src={product.imageUrl} alt="" width={64} height={64} className="h-16 w-16 rounded-lg object-cover" />}
              <div><h2 className="font-semibold text-white">{product.title}</h2>{product.description && <p className="mt-1 text-sm text-white/55">{product.description}</p>}<p className="mt-2 text-xs text-white/45">{product.isCampaignEligible ? "Campaign eligible" : "Not campaign eligible"} · {product.isAvailable ? "Available" : "Unavailable"}</p></div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {product.assignment && <label className="text-xs text-white/55">Order <Input aria-label={`Display order for ${product.title}`} type="number" min={0} max={1000000} defaultValue={product.assignment.displayOrder} onBlur={(event) => void saveOrder(product, event.target.value)} disabled={saving === product.brandCommerceProductId} className="ml-2 inline-flex h-8 w-24 border-white/10 bg-black/20 text-white" /></label>}
              <Button type="button" disabled={saving === product.brandCommerceProductId || (!product.assignment && !canAssign)} onClick={() => void assign(product)} className="rounded-full border border-white bg-white text-black">
                {saving === product.brandCommerceProductId ? "Saving..." : product.assignment ? active ? "Deactivate" : "Reactivate" : "Assign"}
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
