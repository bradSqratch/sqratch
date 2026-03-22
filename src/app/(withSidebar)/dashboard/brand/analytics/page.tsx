"use client";

import { useEffect, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";

type AnalyticsResponse = {
  campaigns: Array<{
    id: string;
    name: string;
    slug: string;
  }>;
  totals: {
    scans: number;
    unlocks: number;
    lessonStarts: number;
    lessonCompletions: number;
    shopClicks: number;
  };
  byCampaign: Array<{
    id: string;
    name: string;
    slug: string;
    scans: number;
    unlocks: number;
    lessonStarts: number;
    lessonCompletions: number;
    shopClicks: number;
  }>;
};

export default function BrandAnalyticsPage() {
  const [filters, setFilters] = useState({
    campaignId: "",
    dateFrom: "",
    dateTo: "",
  });
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setError(null);

      try {
        const query = new URLSearchParams();
        if (filters.campaignId) query.set("campaignId", filters.campaignId);
        if (filters.dateFrom) query.set("dateFrom", filters.dateFrom);
        if (filters.dateTo) query.set("dateTo", filters.dateTo);

        const result = await fetchJson<AnalyticsResponse>(
          `/api/brand/analytics?${query.toString()}`,
        );
        setData(result);
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load brand analytics."));
      }
    }

    void load();
  }, [filters]);

  return (
    <BrandPageShell
      title="Brand Analytics"
      description="Track scans, unlocks, lesson engagement, and shop clicks across brand-owned campaigns."
    >
      <PageCard>
        <div className="grid gap-4 lg:grid-cols-3">
          <select
            value={filters.campaignId}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                campaignId: event.target.value,
              }))
            }
            className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          >
            <option value="">All campaigns</option>
            {data?.campaigns.map((campaign) => (
              <option key={campaign.id} value={campaign.id}>
                {campaign.name}
              </option>
            ))}
          </select>

          <input
            type="date"
            value={filters.dateFrom}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                dateFrom: event.target.value,
              }))
            }
            className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          />

          <input
            type="date"
            value={filters.dateTo}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                dateTo: event.target.value,
              }))
            }
            className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          />
        </div>
      </PageCard>

      {error && (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      )}

      {!data ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading analytics...</p>
        </PageCard>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <MetricCard label="Scans" value={data.totals.scans} />
            <MetricCard label="Unlocks" value={data.totals.unlocks} />
            <MetricCard label="Lesson starts" value={data.totals.lessonStarts} />
            <MetricCard
              label="Lesson completions"
              value={data.totals.lessonCompletions}
            />
            <MetricCard label="Shop clicks" value={data.totals.shopClicks} />
          </div>

          <PageCard>
            <h2 className="text-xl font-semibold">By campaign</h2>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[760px] text-left text-sm">
                <thead className="text-white/55">
                  <tr>
                    <th className="pb-3">Campaign</th>
                    <th className="pb-3">Scans</th>
                    <th className="pb-3">Unlocks</th>
                    <th className="pb-3">Starts</th>
                    <th className="pb-3">Completions</th>
                    <th className="pb-3">Shop clicks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {data.byCampaign.map((row) => (
                    <tr key={row.id}>
                      <td className="py-3">
                        <div>
                          <p className="font-medium">{row.name}</p>
                          <p className="text-xs text-white/45">/{row.slug}</p>
                        </div>
                      </td>
                      <td className="py-3">{row.scans}</td>
                      <td className="py-3">{row.unlocks}</td>
                      <td className="py-3">{row.lessonStarts}</td>
                      <td className="py-3">{row.lessonCompletions}</td>
                      <td className="py-3">{row.shopClicks}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PageCard>
        </>
      )}
    </BrandPageShell>
  );
}

function MetricCard({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <PageCard>
      <p className="text-sm text-white/55">{label}</p>
      <p className="mt-2 text-4xl font-semibold">{value}</p>
    </PageCard>
  );
}
