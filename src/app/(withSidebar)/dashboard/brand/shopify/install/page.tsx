"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type InstallData = {
  shop: string;
  canCreateBrand: boolean;
  brands: Array<{
    id: string;
    name: string;
    slug: string;
    shopifyShopDomain: string | null;
    shopifyConnectionStatus: string;
  }>;
};

function slugifyValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export default function ShopifyInstallPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const installId = searchParams.get("install") || "";
  const [data, setData] = useState<InstallData | null>(null);
  const [selectedBrandId, setSelectedBrandId] = useState("");
  const [brandName, setBrandName] = useState("");
  const [brandSlug, setBrandSlug] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
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
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load Shopify install."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [installId]);

  async function linkInstall() {
    if (!installId) {
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
          body: JSON.stringify(
            selectedBrandId
              ? { brandId: selectedBrandId }
              : {
                  createBrand: {
                    name: brandName,
                    slug: brandSlug,
                    websiteUrl,
                  },
                },
          ),
        },
      );

      router.push(result.redirectTo);
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to link Shopify install."));
    } finally {
      setSaving(false);
    }
  }

  const canCreate = Boolean(data?.canCreateBrand);
  const creatingBrand = !selectedBrandId;

  return (
    <BrandPageShell
      title="Connect Shopify"
      description="Choose the SQRATCH brand that owns this Shopify store."
    >
      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading Shopify install...</p>
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
                  {canCreate ? <option value="">Create new brand</option> : null}
                </select>
              </div>
            ) : null}

            {creatingBrand && canCreate ? (
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm text-white/70">Brand name</label>
                  <Input
                    value={brandName}
                    onChange={(event) => {
                      const name = event.target.value;
                      setBrandName(name);
                      setBrandSlug((current) =>
                        slugTouched ? current : slugifyValue(name),
                      );
                    }}
                    className="border-white/10 bg-black/20 text-white"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm text-white/70">Brand slug</label>
                  <Input
                    value={brandSlug}
                    onChange={(event) => {
                      setSlugTouched(true);
                      setBrandSlug(slugifyValue(event.target.value));
                    }}
                    className="border-white/10 bg-black/20 text-white"
                  />
                </div>
                <div className="space-y-2 lg:col-span-2">
                  <label className="text-sm text-white/70">Website URL</label>
                  <Input
                    value={websiteUrl}
                    onChange={(event) => setWebsiteUrl(event.target.value)}
                    className="border-white/10 bg-black/20 text-white"
                  />
                </div>
              </div>
            ) : null}

            {error ? <p className="text-sm text-red-300">{error}</p> : null}

            {!data?.brands.length && !canCreate ? (
              <p className="text-sm text-white/65">
                No brands are available for your account yet. Contact your
                SQRATCH administrator to be granted brand access before
                connecting this Shopify store.
              </p>
            ) : (
              <Button
                type="button"
                onClick={() => void linkInstall()}
                disabled={
                  saving ||
                  (!selectedBrandId &&
                    (!canCreate || !brandName.trim() || !brandSlug.trim()))
                }
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
