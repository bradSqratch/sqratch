"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { CreatorPageShell } from "@/components/creator/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";

type ExperienceListItem = {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  status: "DRAFT" | "PUBLISHED";
  counts: {
    courses: number;
    posts: number;
    questions: number;
  };
};

export default function CreatorCoursesIndexPage() {
  const [experiences, setExperiences] = useState<ExperienceListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<ExperienceListItem[]>(
          "/api/creator/experiences",
        );
        setExperiences(data);
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load creator courses."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  return (
    <CreatorPageShell
      title="Courses"
      description="Courses are attached to a specific experience. Choose an experience below to create courses, edit visibility, and manage lessons."
    >
      {loading ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading experiences...</p>
        </PageCard>
      ) : error ? (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      ) : experiences.length === 0 ? (
        <PageCard>
          <p className="text-sm text-white/65">
            You need to create an experience first before adding courses.
          </p>
        </PageCard>
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {experiences.map((experience) => (
            <PageCard key={experience.id}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-3">
                    <h2 className="text-2xl font-semibold">{experience.title}</h2>
                    <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/60">
                      {experience.status}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-white/55">/{experience.slug}</p>
                </div>
                <div className="rounded-2xl border border-white/10 bg-black/20 px-4 py-3 text-center">
                  <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                    Courses
                  </p>
                  <p className="mt-2 text-2xl font-semibold">
                    {experience.counts.courses}
                  </p>
                </div>
              </div>

              {experience.description && (
                <p className="mt-4 text-sm leading-6 text-white/70">
                  {experience.description}
                </p>
              )}

              <div className="mt-6 flex flex-wrap gap-3">
                <Button
                  asChild
                  className="rounded-full border border-white bg-white text-black"
                >
                  <Link
                    href={`/dashboard/creator/experiences/${experience.id}/courses`}
                  >
                    Manage courses
                  </Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                >
                  <Link href={`/dashboard/creator/experiences/${experience.id}/edit`}>
                    Edit experience
                  </Link>
                </Button>
              </div>
            </PageCard>
          ))}
        </div>
      )}
    </CreatorPageShell>
  );
}
