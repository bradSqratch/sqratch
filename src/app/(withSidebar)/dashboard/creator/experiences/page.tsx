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
  coverImageUrl: string | null;
  status: "DRAFT" | "PUBLISHED";
  createdAt: string;
  updatedAt: string;
  counts: {
    courses: number;
    posts: number;
    questions: number;
  };
};

export default function CreatorExperiencesPage() {
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
        setError(
          getErrorMessage(loadError, "Failed to load creator experiences."),
        );
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  return (
    <CreatorPageShell
      title="Experiences"
      description="Manage the experiences you own, jump into course and lesson management, and open the public posts/Q&A surfaces from a single list."
      actions={
        <Button
          asChild
          className="rounded-full border border-edge bg-primary text-primary-foreground"
        >
          <Link href="/dashboard/creator/experiences/new">Create new</Link>
        </Button>
      }
    >
      {loading ? (
        <PageCard>
          <p className="text-sm text-copy-65">Loading experiences...</p>
        </PageCard>
      ) : error ? (
        <PageCard>
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </PageCard>
      ) : experiences.length === 0 ? (
        <PageCard>
          <p className="text-sm text-copy-65">
            You have not created any experiences yet.
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
                    <span className="rounded-full border border-edge/10 px-3 py-1 text-xs text-copy-60">
                      {experience.status}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-copy-55">/{experience.slug}</p>
                </div>
              </div>

              {experience.description && (
                <p className="mt-4 text-sm leading-6 text-copy-70 line-clamp-4">
                  {experience.description}
                </p>
              )}

              <div className="mt-6 grid gap-3 sm:grid-cols-3">
                <div className="rounded-2xl border border-edge/10 bg-inset/20 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-copy-45">
                    Courses
                  </p>
                  <p className="mt-2 text-2xl font-semibold">
                    {experience.counts.courses}
                  </p>
                </div>
                <div className="rounded-2xl border border-edge/10 bg-inset/20 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-copy-45">
                    Posts
                  </p>
                  <p className="mt-2 text-2xl font-semibold">
                    {experience.counts.posts}
                  </p>
                </div>
                <div className="rounded-2xl border border-edge/10 bg-inset/20 p-4">
                  <p className="text-xs uppercase tracking-[0.24em] text-copy-45">
                    Q&amp;A
                  </p>
                  <p className="mt-2 text-2xl font-semibold">
                    {experience.counts.questions}
                  </p>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <Button
                  asChild
                  className="rounded-full border border-edge bg-primary text-primary-foreground"
                >
                  <Link href={`/dashboard/creator/experiences/${experience.id}/edit`}>
                    Edit
                  </Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="rounded-full border-edge/20 bg-transparent text-ink hover:bg-glass-10"
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
                  className="rounded-full border-edge/20 bg-transparent text-ink hover:bg-glass-10"
                >
                  <Link href={`/dashboard/creator/experiences/${experience.id}/posts`}>
                    Manage posts
                  </Link>
                </Button>
                <Button
                  asChild
                  variant="outline"
                  className="rounded-full border-edge/20 bg-transparent text-ink hover:bg-glass-10"
                >
                  <Link
                    href={`/dashboard/creator/qa?experienceId=${experience.id}`}
                  >
                    Manage Q&amp;A
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
