"use client";

import { useEffect, useState } from "react";
import { AdminPageShell } from "@/components/admin/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";

type BrandListItem = {
  id: string;
  name: string;
  slug: string;
  bio: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
  isActive: boolean;
  shopifyShopDomain: string | null;
  shopifyInstalledAt: string | null;
  createdAt: string;
  members: Array<{
    id: string;
    role: "ADMIN" | "MANAGER" | "VIEWER";
    user: {
      id: string;
      name: string | null;
      email: string;
      role: "USER" | "CREATOR" | "BRAND_ADMIN" | "ADMIN" | "EXTERNAL";
      isActive: boolean;
    };
  }>;
  campaigns: Array<{
    id: string;
    name: string;
    slug: string;
    isActive: boolean;
  }>;
};

export default function AdminBrandsPage() {
  const [brands, setBrands] = useState<BrandListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<BrandListItem[]>("/api/admin/brands");
        setBrands(data);
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load brands."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  return (
    <AdminPageShell
      title="Brands"
      description="Audit every brand account, its members, and the campaigns attached to it without switching roles."
    >
      {loading ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading brands...</p>
        </PageCard>
      ) : error ? (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      ) : brands.length === 0 ? (
        <PageCard>
          <p className="text-sm text-white/65">No brands found.</p>
        </PageCard>
      ) : (
        <div className="space-y-5">
          {brands.map((brand) => (
            <PageCard key={brand.id}>
              <div className="flex flex-col gap-6 xl:flex-row xl:items-start xl:justify-between">
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-2xl font-semibold">{brand.name}</h2>
                    <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                      {brand.isActive ? "Active" : "Inactive"}
                    </span>
                    {brand.shopifyShopDomain && (
                      <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
                        Shopify connected
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-white/55">/{brand.slug}</p>
                  {brand.bio && (
                    <p className="max-w-3xl text-sm leading-6 text-white/70">
                      {brand.bio}
                    </p>
                  )}
                  <div className="space-y-1 text-sm text-white/55">
                    {brand.websiteUrl && <p>Website: {brand.websiteUrl}</p>}
                    {brand.shopifyShopDomain && (
                      <p>Shop: {brand.shopifyShopDomain}</p>
                    )}
                    <p>
                      Created {new Date(brand.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>

                <div className="grid gap-5 xl:min-w-[420px] xl:grid-cols-2">
                  <div className="rounded-3xl border border-white/10 bg-black/20 p-5">
                    <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                      Members
                    </p>
                    <div className="mt-4 space-y-3">
                      {brand.members.length === 0 ? (
                        <p className="text-sm text-white/55">No members.</p>
                      ) : (
                        brand.members.map((member) => (
                          <div
                            key={member.id}
                            className="rounded-2xl border border-white/10 px-4 py-3"
                          >
                            <p className="text-sm font-medium">
                              {member.user.name || member.user.email}
                            </p>
                            <p className="mt-1 text-xs text-white/55">
                              {member.user.email}
                            </p>
                            <p className="mt-2 text-xs text-white/55">
                              {member.role} • {member.user.role} •{" "}
                              {member.user.isActive ? "Active" : "Disabled"}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="rounded-3xl border border-white/10 bg-black/20 p-5">
                    <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                      Campaigns
                    </p>
                    <div className="mt-4 space-y-3">
                      {brand.campaigns.length === 0 ? (
                        <p className="text-sm text-white/55">No campaigns.</p>
                      ) : (
                        brand.campaigns.map((campaign) => (
                          <div
                            key={campaign.id}
                            className="rounded-2xl border border-white/10 px-4 py-3"
                          >
                            <p className="text-sm font-medium">
                              {campaign.name}
                            </p>
                            <p className="mt-1 text-xs text-white/55">
                              /{campaign.slug}
                            </p>
                            <p className="mt-2 text-xs text-white/55">
                              {campaign.isActive ? "Active" : "Inactive"}
                            </p>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </PageCard>
          ))}
        </div>
      )}
    </AdminPageShell>
  );
}
