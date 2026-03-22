"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import CommonNavbar from "@/components/commonNavbar";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard, ProgressBar } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";

type UserMe = {
  id: string;
  name: string | null;
  email: string;
  points: number;
  role: string;
};

type UnlocksResponse = Array<{
  unlockId: string;
  unlockedAt: string;
  campaign: {
    id: string;
    name: string;
    description: string | null;
    brand: {
      id: string;
      name: string;
      slug: string;
      logoUrl: string | null;
    } | null;
    experiences: Array<{
      id: string;
      slug: string;
      title: string;
      description: string | null;
      coverImageUrl: string | null;
      courseCount: number;
    }>;
  };
}>;

type ProgressResponse = {
  continueWatching: Array<{
    progressId: string;
    lessonId: string;
    lastPositionSeconds: number;
    isCompleted: boolean;
    updatedAt: string;
    lesson: {
      id: string;
      title: string;
      description: string | null;
    };
    course: {
      id: string;
      title: string;
      progressPercent: number;
      completedLessons: number;
      totalLessons: number;
    };
    experience: {
      id: string;
      slug: string;
      title: string;
      coverImageUrl: string | null;
    };
    campaign: {
      id: string;
      name: string;
    } | null;
  }>;
  summary: {
    continueWatchingCount: number;
    completedLessonsCount: number;
  };
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

export function UserHomeClient() {
  const [me, setMe] = useState<UserMe | null>(null);
  const [unlocks, setUnlocks] = useState<UnlocksResponse>([]);
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const [meData, unlockData, progressData] = await Promise.all([
          fetchJson<UserMe>("/api/user/me"),
          fetchJson<UnlocksResponse>("/api/user/unlocks"),
          fetchJson<ProgressResponse>("/api/user/progress"),
        ]);

        setMe(meData);
        setUnlocks(unlockData);
        setProgress(progressData);
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load your home page."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  return (
    <div className="relative min-h-screen overflow-hidden bg-[#020015] text-white">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(1100px_600px_at_50%_10%,rgba(99,102,241,0.30),rgba(2,0,21,0)_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_520px_at_50%_55%,rgba(99,102,241,0.13),rgba(2,0,21,0)_65%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(900px_600px_at_10%_90%,rgba(236,72,153,0.10),rgba(2,0,21,0)_65%)]" />
      </div>

      <div className="relative z-10 flex min-h-screen flex-col">
        <CommonNavbar />

        <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-6 pb-12 pt-28 sm:pt-32">
          {loading ? (
            <div className="flex flex-1 items-center justify-center">
              <div className="flex flex-col items-center gap-4">
                <div className="h-12 w-12 animate-spin rounded-full border-4 border-white border-t-transparent" />
                <p className="text-white/80">Loading your home...</p>
              </div>
            </div>
          ) : error ? (
            <div className="flex flex-1 items-center justify-center">
              <PageCard className="w-full max-w-lg">
                <p className="text-red-300">{error}</p>
              </PageCard>
            </div>
          ) : (
            <>
              <section className="grid gap-4 lg:grid-cols-[1.3fr_0.7fr]">
                <PageCard>
                  <p className="text-xs uppercase tracking-[0.28em] text-white/45">
                    User Home
                  </p>
                  <h1 className="mt-3 text-4xl font-bold tracking-[-0.03em] sm:text-5xl">
                    Welcome back{me?.name ? `, ${me.name}` : ""}.
                  </h1>
                  <p className="mt-4 max-w-3xl text-sm leading-7 text-white/70">
                    Your unlocked campaigns, accessible experiences, and active
                    lessons live here.
                  </p>
                </PageCard>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                  <PageCard>
                    <p className="text-sm text-white/55">Unlocked campaigns</p>
                    <p className="mt-2 text-4xl font-semibold">{unlocks.length}</p>
                  </PageCard>
                  <PageCard>
                    <p className="text-sm text-white/55">Continue watching</p>
                    <p className="mt-2 text-4xl font-semibold">
                      {progress?.summary.continueWatchingCount || 0}
                    </p>
                  </PageCard>
                </div>
              </section>

              <section className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
                <PageCard>
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <h2 className="text-2xl font-semibold">Unlocked Campaigns</h2>
                      <p className="mt-2 text-sm text-white/65">
                        Every unlocked campaign exposes the experiences attached to
                        it.
                      </p>
                    </div>
                  </div>

                  <div className="mt-6 space-y-5">
                    {unlocks.length === 0 ? (
                      <div className="rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/65">
                        No campaigns unlocked yet. Scan a SQRATCH code to start.
                      </div>
                    ) : (
                      unlocks.map((unlock) => (
                        <div
                          key={unlock.unlockId}
                          className="rounded-3xl border border-white/10 bg-black/20 p-6"
                        >
                          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                            <div>
                              <h3 className="text-xl font-semibold">
                                {unlock.campaign.name}
                              </h3>
                              <p className="mt-2 text-sm text-white/55">
                                {unlock.campaign.brand
                                  ? `by ${unlock.campaign.brand.name}`
                                  : "Unlocked campaign"}
                              </p>
                              {unlock.campaign.description && (
                                <p className="mt-3 max-w-2xl text-sm leading-6 text-white/70">
                                  {unlock.campaign.description}
                                </p>
                              )}
                            </div>

                            <div className="text-sm text-white/50">
                              Unlocked {formatDate(unlock.unlockedAt)}
                            </div>
                          </div>

                          <div className="mt-6 grid gap-4 md:grid-cols-2">
                            {unlock.campaign.experiences.map((experience) => (
                              <div
                                key={experience.id}
                                className="rounded-3xl border border-white/10 bg-white/5 p-5"
                              >
                                <h4 className="text-lg font-semibold">
                                  {experience.title}
                                </h4>
                                {experience.description && (
                                  <p className="mt-2 text-sm leading-6 text-white/65">
                                    {experience.description}
                                  </p>
                                )}
                                <p className="mt-4 text-xs uppercase tracking-[0.24em] text-white/45">
                                  {experience.courseCount} courses
                                </p>
                                <Button
                                  asChild
                                  className="mt-5 rounded-full border border-white bg-white text-black"
                                >
                                  <Link href={`/x/${experience.slug}`}>
                                    Open Experience
                                  </Link>
                                </Button>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </PageCard>

                <PageCard>
                  <h2 className="text-2xl font-semibold">Continue Watching</h2>
                  <p className="mt-2 text-sm text-white/65">
                    Pick up where you left off across all unlocked experiences.
                  </p>

                  <div className="mt-6 space-y-4">
                    {progress?.continueWatching.length ? (
                      progress.continueWatching.map((item) => (
                        <div
                          key={item.progressId}
                          className="rounded-3xl border border-white/10 bg-black/20 p-5"
                        >
                          <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                            {item.experience.title}
                            {item.campaign?.name ? ` • ${item.campaign.name}` : ""}
                          </p>
                          <h3 className="mt-2 text-lg font-semibold">
                            {item.lesson.title}
                          </h3>
                          <p className="mt-1 text-sm text-white/55">
                            {item.course.title}
                          </p>
                          <p className="mt-3 text-sm text-white/65">
                            Resume at {item.lastPositionSeconds}s • last watched{" "}
                            {formatDate(item.updatedAt)}
                          </p>
                          <div className="mt-4">
                            <ProgressBar
                              value={item.course.progressPercent}
                              label={`${item.course.completedLessons}/${item.course.totalLessons} lessons completed`}
                            />
                          </div>
                          <Button
                            asChild
                            className="mt-5 rounded-full border border-white bg-white text-black"
                          >
                            <Link
                              href={`/x/${item.experience.slug}/lessons/${item.lessonId}`}
                            >
                              Continue Lesson
                            </Link>
                          </Button>
                        </div>
                      ))
                    ) : (
                      <div className="rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/65">
                        No in-progress lessons yet. Start a course from one of
                        your unlocked experiences.
                      </div>
                    )}
                  </div>
                </PageCard>
              </section>
            </>
          )}
        </main>
      </div>
    </div>
  );
}
