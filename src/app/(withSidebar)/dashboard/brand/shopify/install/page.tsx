"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { LoadingState } from "@/components/ui/loading-state";
import { getDefaultShopifyInstallBrandId } from "@/lib/shopify-install-selection";

type InstallData = {
  shop: string;
  activeBrandId: string | null;
  brands: Array<{
    id: string;
    name: string;
    slug: string;
  }>;
};

export default function ShopifyInstallPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const installId = searchParams.get("install") || "";
  const [data, setData] = useState<InstallData | null>(null);
  const [selectedBrandId, setSelectedBrandId] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      if (!installId) {
        setError("Missing Shopify install session.");
        setLoading(false);
        return;
      }

      try {
        const result = await fetchJson<InstallData>(
          `/api/shopify/installations/${installId}`,
        );
        setData(result);
        setSelectedBrandId(
          getDefaultShopifyInstallBrandId(result.brands, result.activeBrandId),
        );
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load Shopify install."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [installId]);

  async function linkInstall() {
    if (!installId || !selectedBrandId) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const result = await fetchJson<{ redirectTo: string }>(
        `/api/shopify/installations/${installId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ brandId: selectedBrandId }),
        },
      );

      router.push(result.redirectTo);
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to link Shopify install."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <BrandPageShell
      title="Connect Shopify"
      description="Choose the SQRATCH brand that owns this Shopify store."
    >
      <PageCard>
        {loading ? (
          <LoadingState label="Loading Shopify install..." />
        ) : (
          <div className="space-y-5">
            <div>
              <p className="text-sm text-white/55">Shopify store</p>
              <p className="mt-1 text-lg font-semibold">{data?.shop}</p>
            </div>

            {data?.brands.length ? (
              <div className="space-y-2">
                <label className="text-sm text-white/70">Brand</label>
                <select
                  value={selectedBrandId}
                  onChange={(event) => setSelectedBrandId(event.target.value)}
                  className="flex h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
                >
                  {data.brands.map((brand) => (
                    <option key={brand.id} value={brand.id}>
                      {brand.name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {error ? <p className="text-sm text-red-300">{error}</p> : null}

            {!data?.brands.length ? (
              <p className="text-sm text-white/65">
                No eligible brand was found for your account. Brand access is
                granted through the SQRATCH approval workflow — contact your
                SQRATCH administrator before connecting this Shopify store.
              </p>
            ) : (
              <Button
                type="button"
                onClick={() => void linkInstall()}
                disabled={saving || !selectedBrandId}
                className="rounded-full border border-white bg-white text-black"
              >
                {saving ? "Connecting..." : "Connect Shopify"}
              </Button>
            )}
          </div>
        )}
      </PageCard>
    </BrandPageShell>
  );
}
