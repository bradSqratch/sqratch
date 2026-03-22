"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";

type CampaignListItem = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  qrBatchesCount: number;
  experiencesCount: number;
};

export default function BrandCampaignsPage() {
  const [campaigns, setCampaigns] = useState<CampaignListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<CampaignListItem[]>("/api/brand/campaigns");
        setCampaigns(data);
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load campaigns."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  return (
    <BrandPageShell
      title="Campaigns"
      description="Manage brand-owned campaigns, edit their public details, and attach creator experiences to each sponsorship."
      actions={
        <Button
          asChild
          className="rounded-full border border-white bg-white text-black"
        >
          <Link href="/dashboard/brand/campaigns/new">Create campaign</Link>
        </Button>
      }
    >
      {loading ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading campaigns...</p>
        </PageCard>
      ) : error ? (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      ) : campaigns.length === 0 ? (
        <PageCard>
          <p className="text-sm text-white/65">No campaigns yet.</p>
        </PageCard>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {campaigns.map((campaign) => (
            <PageCard key={campaign.id}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-2xl font-semibold">{campaign.name}</h2>
                  <p className="mt-1 text-sm text-white/55">/{campaign.slug}</p>
                </div>
                <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                  {campaign.isActive ? "Active" : "Inactive"}
                </span>
              </div>
              {campaign.description && (
                <p className="mt-4 text-sm leading-6 text-white/70">
                  {campaign.description}
                </p>
              )}
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                    QR batches
                  </p>
                  <p className="mt-2 text-2xl font-semibold">
                    {campaign.qrBatchesCount}
                  </p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                    Experiences
                  </p>
                  <p className="mt-2 text-2xl font-semibold">
                    {campaign.experiencesCount}
                  </p>
                </div>
              </div>
              <div className="mt-6 flex flex-wrap gap-3">
                <Button
                  asChild
                  className="rounded-full border border-white bg-white text-black"
                >
                  <Link href={`/dashboard/brand/campaigns/${campaign.id}/edit`}>
                    Edit
                  </Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                >
                  <Link
                    href={`/dashboard/brand/campaigns/${campaign.id}/experiences`}
                  >
                    Attach experiences
                  </Link>
                </Button>
              </div>
            </PageCard>
          ))}
        </div>
      )}
    </BrandPageShell>
  );
}
