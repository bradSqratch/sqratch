"use client";

import { useEffect, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SponsorshipResponse = {
  campaign: {
    id: string;
    name: string;
    slug: string;
    description: string | null;
    isActive: boolean;
    brandId: string | null;
  };
  experiences: Array<{
    id: string;
    title: string;
    slug: string;
    description: string | null;
    status: "PUBLISHED" | "DRAFT";
    attached: boolean;
    sortOrder: number | null;
  }>;
};

export default function BrandCampaignExperiencesPage({
  params,
}: {
  params: { id: string };
}) {
  const campaignId = params.id;
  const [query, setQuery] = useState("");
  const [data, setData] = useState<SponsorshipResponse | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadExperiences(
    currentCampaignId: string,
    currentQuery: string,
  ) {
    setError(null);

    try {
      const qs = new URLSearchParams();
      if (currentQuery.trim()) {
        qs.set("q", currentQuery.trim());
      }

      const result = await fetchJson<SponsorshipResponse>(
        `/api/brand/campaigns/${currentCampaignId}/attach-experience?${qs.toString()}`,
      );
      setData(result);
    } catch (loadError) {
      setError(
        getErrorMessage(loadError, "Failed to load campaign experiences."),
      );
    }
  }

  useEffect(() => {
    void loadExperiences(campaignId, query);
  }, [campaignId, query]);

  async function toggleExperience(experienceId: string, attach: boolean) {
    setSavingId(experienceId);
    setError(null);

    try {
      await fetchJson(`/api/brand/campaigns/${campaignId}/attach-experience`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          experienceId,
          attach,
        }),
      });
      await loadExperiences(campaignId, query);
    } catch (saveError) {
      setError(
        getErrorMessage(saveError, "Failed to update campaign sponsorships."),
      );
    } finally {
      setSavingId(null);
    }
  }

  return (
    <BrandPageShell
      title={data ? `${data.campaign.name} Sponsorships` : "Attach Experiences"}
      description="Search existing creator experiences and attach or detach them from this campaign. An experience can belong to multiple campaigns."
    >
      <PageCard>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search experiences by title or slug"
          className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
        />
      </PageCard>

      {error && (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      )}

      {!data ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading experiences...</p>
        </PageCard>
      ) : (
        <div className="space-y-5">
          {data.experiences.map((experience) => (
            <PageCard key={experience.id}>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-xl font-semibold">{experience.title}</h2>
                    <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                      {experience.status}
                    </span>
                    {experience.attached && (
                      <span className="rounded-full border border-emerald-400/20 bg-emerald-500/10 px-3 py-1 text-xs text-emerald-200">
                        Attached
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-sm text-white/55">/{experience.slug}</p>
                  {experience.description && (
                    <p className="mt-3 text-sm leading-6 text-white/70">
                      {experience.description}
                    </p>
                  )}
                </div>

                <Button
                  type="button"
                  onClick={() =>
                    void toggleExperience(experience.id, !experience.attached)
                  }
                  disabled={savingId === experience.id}
                  variant={experience.attached ? "destructive" : undefined}
                  className={
                    experience.attached
                      ? "rounded-full border border-red-500/40 bg-red-500 text-white hover:bg-red-500/90"
                      : "rounded-full border border-white bg-white text-black"
                  }
                >
                  {savingId === experience.id
                    ? "Saving..."
                    : experience.attached
                      ? "Detach"
                      : "Attach"}
                </Button>
              </div>
            </PageCard>
          ))}
        </div>
      )}
    </BrandPageShell>
  );
}
