"use client";

import { useEffect, useEffectEvent, useState } from "react";
import { CreatorPageShell } from "@/components/creator/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";

type AnalyticsResponse = {
  filters: {
    experienceId: string | null;
    dateFrom: string | null;
    dateTo: string | null;
  };
  experiences: Array<{
    id: string;
    title: string;
    slug: string;
  }>;
  totals: {
    views: number;
    lessonStarts: number;
    lessonCompletions: number;
    questions: number;
    completedLessonsFromProgress: number;
  };
  byExperience: Array<{
    id: string;
    title: string;
    slug: string;
    views: number;
    lessonStarts: number;
    lessonCompletions: number;
    questions: number;
  }>;
};

export default function CreatorAnalyticsPage() {
  const [filters, setFilters] = useState({
    experienceId: "",
    dateFrom: "",
    dateTo: "",
  });
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useEffectEvent(async () => {
    setError(null);

    try {
      const query = new URLSearchParams();

      if (filters.experienceId) {
        query.set("experienceId", filters.experienceId);
      }
      if (filters.dateFrom) {
        query.set("dateFrom", filters.dateFrom);
      }
      if (filters.dateTo) {
        query.set("dateTo", filters.dateTo);
      }

      const result = await fetchJson<AnalyticsResponse>(
        `/api/creator/analytics?${query.toString()}`,
      );
      setData(result);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load analytics."));
    }
  });

  useEffect(() => {
    void load();
  }, [filters, load]);

  return (
    <CreatorPageShell
      title="Creator Analytics"
      description="Track experience views, lesson starts and completions, and Q&A volume across your owned experiences."
    >
      <PageCard>
        <div className="grid gap-4 lg:grid-cols-3">
          <select
            value={filters.experienceId}
            onChange={(event) =>
              setFilters((current) => ({
                ...current,
                experienceId: event.target.value,
              }))
            }
            className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          >
            <option value="">All experiences</option>
            {data?.experiences.map((experience) => (
              <option key={experience.id} value={experience.id}>
                {experience.title}
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
            <MetricCard label="Views" value={data.totals.views} />
            <MetricCard label="Lesson starts" value={data.totals.lessonStarts} />
            <MetricCard
              label="Lesson completions"
              value={data.totals.lessonCompletions}
            />
            <MetricCard label="Questions" value={data.totals.questions} />
            <MetricCard
              label="Completed lessons"
              value={data.totals.completedLessonsFromProgress}
            />
          </div>

          <PageCard>
            <h2 className="text-xl font-semibold">By experience</h2>
            <div className="mt-5 overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="text-white/55">
                  <tr>
                    <th className="pb-3">Experience</th>
                    <th className="pb-3">Views</th>
                    <th className="pb-3">Starts</th>
                    <th className="pb-3">Completions</th>
                    <th className="pb-3">Questions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10">
                  {data.byExperience.map((row) => (
                    <tr key={row.id}>
                      <td className="py-3">
                        <div>
                          <p className="font-medium">{row.title}</p>
                          <p className="text-xs text-white/45">/{row.slug}</p>
                        </div>
                      </td>
                      <td className="py-3">{row.views}</td>
                      <td className="py-3">{row.lessonStarts}</td>
                      <td className="py-3">{row.lessonCompletions}</td>
                      <td className="py-3">{row.questions}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </PageCard>
        </>
      )}
    </CreatorPageShell>
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
