"use client";

import { useEffect, useState } from "react";
import { AdminPageShell } from "@/components/admin/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type BrandOption = {
  id: string;
  name: string;
  slug: string;
};

type CampaignListItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  brand: BrandOption | null;
  counts: {
    qrBatches: number;
    experiences: number;
    unlocks: number;
  };
};

type CampaignsResponse = {
  campaigns: CampaignListItem[];
  brands: BrandOption[];
};

type CampaignDraft = {
  name: string;
  slug: string;
  description: string;
  brandId: string;
  isActive: boolean;
};

function slugifyValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export default function AdminCampaignsPage() {
  const [data, setData] = useState<CampaignsResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<string, CampaignDraft>>({});
  const [createForm, setCreateForm] = useState<CampaignDraft>({
    name: "",
    slug: "",
    description: "",
    brandId: "",
    isActive: true,
  });
  const [createSlugTouched, setCreateSlugTouched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    void loadCampaigns();
  }, []);

  async function loadCampaigns() {
    setLoading(true);
    setError(null);

    try {
      const result = await fetchJson<CampaignsResponse>("/api/admin/campaigns");
      setData(result);
      setDrafts(
        Object.fromEntries(
          result.campaigns.map((campaign) => [
            campaign.id,
            {
              name: campaign.name,
              slug: campaign.slug,
              description: campaign.description || "",
              brandId: campaign.brand?.id || "",
              isActive: campaign.isActive,
            },
          ]),
        ),
      );
      setCreateForm((current) => ({
        ...current,
        brandId: result.brands.some((brand) => brand.id === current.brandId)
          ? current.brandId
          : "",
      }));
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load campaigns."));
    } finally {
      setLoading(false);
    }
  }

  async function createCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setError(null);

    try {
      await fetchJson("/api/admin/campaigns", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(createForm),
      });
      setCreateForm({
        name: "",
        slug: "",
        description: "",
        brandId: "",
        isActive: true,
      });
      setCreateSlugTouched(false);
      await loadCampaigns();
    } catch (createError) {
      setError(getErrorMessage(createError, "Failed to create campaign."));
    } finally {
      setCreating(false);
    }
  }

  async function saveCampaign(campaignId: string) {
    const draft = drafts[campaignId];
    if (!draft) {
      return;
    }

    setSavingId(campaignId);
    setError(null);

    try {
      await fetchJson(`/api/admin/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(draft),
      });
      await loadCampaigns();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to update campaign."));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <AdminPageShell
      title="Campaigns"
      description="Create campaigns on behalf of any brand, reassign ownership, and inspect QR, unlock, and experience counts from one admin control plane."
    >
      {error && (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      )}

      <PageCard>
        <form onSubmit={createCampaign} className="space-y-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-xl font-semibold">Create Campaign</h2>
            <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/55">
              Admin-managed
            </span>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <div className="space-y-2">
              <label className="text-sm text-white/70">Brand</label>
              <select
                value={createForm.brandId}
                onChange={(event) =>
                  setCreateForm((current) => ({
                    ...current,
                    brandId: event.target.value,
                  }))
                }
                className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none"
              >
                {data?.brands.map((brand) => (
                  <option key={brand.id} value={brand.id} className="text-black">
                    {brand.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <label className="text-sm text-white/70">Name</label>
              <Input
                value={createForm.name}
                onChange={(event) => {
                  const name = event.target.value;
                  setCreateForm((current) => ({
                    ...current,
                    name,
                    slug: createSlugTouched
                      ? current.slug
                      : slugifyValue(name),
                  }));
                }}
                className="border-white/10 bg-black/20 text-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-white/70">Slug</label>
              <Input
                value={createForm.slug}
                onChange={(event) => {
                  setCreateSlugTouched(true);
                  setCreateForm((current) => ({
                    ...current,
                    slug: slugifyValue(event.target.value),
                  }));
                }}
                className="border-white/10 bg-black/20 text-white"
              />
            </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm text-white/70">Description</label>
            <Textarea
              value={createForm.description}
              onChange={(event) =>
                setCreateForm((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              className="min-h-[120px] border-white/10 bg-black/20 text-white"
            />
          </div>

          <label className="flex items-center gap-3 text-sm text-white/70">
            <input
              type="checkbox"
              checked={createForm.isActive}
              onChange={(event) =>
                setCreateForm((current) => ({
                  ...current,
                  isActive: event.target.checked,
                }))
              }
              className="h-4 w-4"
            />
            Campaign is active
          </label>

          <Button
            type="submit"
            disabled={
              creating ||
              !createForm.name.trim() ||
              !createForm.slug.trim() ||
              !createForm.brandId
            }
            className="rounded-full border border-white bg-white text-black"
          >
            {creating ? "Creating..." : "Create campaign"}
          </Button>
        </form>
      </PageCard>

      {loading ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading campaigns...</p>
        </PageCard>
      ) : !data || data.campaigns.length === 0 ? (
        <PageCard>
          <p className="text-sm text-white/65">No campaigns found.</p>
        </PageCard>
      ) : (
        <div className="space-y-5">
          {data.campaigns.map((campaign) => {
            const draft = drafts[campaign.id];
            if (!draft) {
              return null;
            }

            return (
              <PageCard key={campaign.id}>
                <div className="space-y-5">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <div className="flex flex-wrap items-center gap-3">
                        <h2 className="text-2xl font-semibold">
                          {campaign.name}
                        </h2>
                        <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                          {campaign.isActive ? "Active" : "Inactive"}
                        </span>
                      </div>
                      <p className="mt-1 text-sm text-white/55">
                        /{campaign.slug}
                      </p>
                    </div>

                    <div className="grid gap-3 sm:grid-cols-3">
                      <Metric label="QR batches" value={campaign.counts.qrBatches} />
                      <Metric
                        label="Experiences"
                        value={campaign.counts.experiences}
                      />
                      <Metric label="Unlocks" value={campaign.counts.unlocks} />
                    </div>
                  </div>

                  <div className="grid gap-4 lg:grid-cols-3">
                    <div className="space-y-2">
                      <label className="text-sm text-white/70">Brand</label>
                      <select
                        value={draft.brandId}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [campaign.id]: {
                              ...draft,
                              brandId: event.target.value,
                            },
                          }))
                        }
                        className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none"
                      >
                        {data.brands.map((brand) => (
                          <option
                            key={brand.id}
                            value={brand.id}
                            className="text-black"
                          >
                            {brand.name}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm text-white/70">Name</label>
                      <Input
                        value={draft.name}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [campaign.id]: {
                              ...draft,
                              name: event.target.value,
                            },
                          }))
                        }
                        className="border-white/10 bg-black/20 text-white"
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm text-white/70">Slug</label>
                      <Input
                        value={draft.slug}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [campaign.id]: {
                              ...draft,
                              slug: slugifyValue(event.target.value),
                            },
                          }))
                        }
                        className="border-white/10 bg-black/20 text-white"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm text-white/70">Description</label>
                    <Textarea
                      value={draft.description}
                      onChange={(event) =>
                        setDrafts((current) => ({
                          ...current,
                          [campaign.id]: {
                            ...draft,
                            description: event.target.value,
                          },
                        }))
                      }
                      className="min-h-[120px] border-white/10 bg-black/20 text-white"
                    />
                  </div>

                  <div className="flex flex-wrap items-center gap-4">
                    <label className="flex items-center gap-3 text-sm text-white/70">
                      <input
                        type="checkbox"
                        checked={draft.isActive}
                        onChange={(event) =>
                          setDrafts((current) => ({
                            ...current,
                            [campaign.id]: {
                              ...draft,
                              isActive: event.target.checked,
                            },
                          }))
                        }
                        className="h-4 w-4"
                      />
                      Campaign is active
                    </label>

                    <Button
                      type="button"
                      disabled={savingId === campaign.id}
                      onClick={() => void saveCampaign(campaign.id)}
                      className="rounded-full border border-white bg-white text-black"
                    >
                      {savingId === campaign.id ? "Saving..." : "Save changes"}
                    </Button>
                  </div>
                </div>
              </PageCard>
            );
          })}
        </div>
      )}
    </AdminPageShell>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
      <p className="text-xs uppercase tracking-[0.24em] text-white/45">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold">{value}</p>
    </div>
  );
}
