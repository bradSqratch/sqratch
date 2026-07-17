"use client";

import { useEffect, useState } from "react";

type BrandOption = {
  id: string;
  name: string;
  slug: string;
  membershipRole: "ADMIN" | "MANAGER" | "VIEWER";
};

export function BrandSelector() {
  const [brands, setBrands] = useState<BrandOption[]>([]);
  const [activeBrandId, setActiveBrandId] = useState("");
  const [selectionRequired, setSelectionRequired] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/brand/context", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return null;
        const json = (await response.json()) as {
          data?: {
            brands?: BrandOption[];
            activeBrandId?: string | null;
            selectionRequired?: boolean;
          };
        };
        if (!cancelled) {
          setBrands(json.data?.brands || []);
          setActiveBrandId(json.data?.activeBrandId || "");
          setSelectionRequired(Boolean(json.data?.selectionRequired));
        }
        return json;
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  if (brands.length <= 1 && !selectionRequired) return null;

  async function switchBrand(brandId: string) {
    if (!brandId || brandId === activeBrandId) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/brand/context", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ brandId }),
      });
      if (!response.ok) throw new Error("Brand selection failed");
      window.location.reload();
    } catch {
      setError("Could not switch brands. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3">
      <label htmlFor="active-brand" className="text-sm font-medium text-white/70">
        Active brand
      </label>
      <select
        id="active-brand"
        value={activeBrandId}
        disabled={saving}
        onChange={(event) => void switchBrand(event.target.value)}
        className="min-w-48 rounded-xl border border-white/15 bg-black/20 px-3 py-2 text-sm text-white outline-none focus:border-white/40"
      >
        <option value="" disabled>
          Select a brand
        </option>
        {brands.map((brand) => (
          <option key={brand.id} value={brand.id}>
            {brand.name}
          </option>
        ))}
      </select>
      {selectionRequired ? (
        <span className="text-xs text-amber-200">Choose a brand to continue.</span>
      ) : null}
      {error ? <span className="text-xs text-red-200">{error}</span> : null}
    </div>
  );
}
