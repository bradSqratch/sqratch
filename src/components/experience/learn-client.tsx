"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { ExperienceShell, LoadingView, ErrorView, PageCard, ProgressBar } from "@/components/experience/experience-shell";
import { useExperience } from "@/components/experience/use-experience";
import { Button } from "@/components/ui/button";

type ProgressResponse = {
  lessonProgress: Array<{
    lessonId: string;
    isCompleted: boolean;
    lastPositionSeconds: number;
    updatedAt: string;
  }>;
  courseProgress: Array<{
    courseId: string;
    totalLessons: number;
    completedLessons: number;
    progressPercent: number;
  }>;
};

export function ExperienceLearnClient({
  experienceSlug,
}: {
  experienceSlug: string;
}) {
  const { data, loading, error } = useExperience(experienceSlug);
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [progressError, setProgressError] = useState<string | null>(null);

  useEffect(() => {
    if (!data) {
      return;
    }

    fetchJson<ProgressResponse>(
      `/api/progress/lesson?experienceSlug=${data.slug}`,
    )
      .then(setProgress)
      .catch((error) =>
        setProgressError(getErrorMessage(error, "Failed to load progress.")),
      );
  }, [data]);

  if (loading) {
    return <LoadingView label="Loading courses..." />;
  }

  if (error || !data) {
    return <ErrorView message={error || "Experience not found."} />;
  }

  const progressByCourse = new Map(
    (progress?.courseProgress || []).map((item) => [item.courseId, item]),
  );

  return (
    <ExperienceShell
      experience={data}
      activeTab="learn"
      actions={
        <div className="rounded-3xl border border-white/10 bg-black/20 p-5">
          <p className="text-sm text-white/55">Visible lessons</p>
          <p className="mt-2 text-3xl font-semibold">
            {data.courseSummary.visibleLessonCount}
          </p>
        </div>
      }
    >
      <PageCard>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-2xl font-semibold text-[#988dbf]">Courses</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
              Public courses are open now. Private courses appear here once your
              account is logged in and the linked campaign is unlocked.
            </p>
          </div>
          {progressError && <p className="text-sm text-amber-300">{progressError}</p>}
        </div>

        <div className="mt-8 grid gap-5 md:grid-cols-2">
          {data.courses.map((course) => {
            const tracked = progressByCourse.get(course.id);

            return (
              <div
                key={course.id}
                className="rounded-3xl border border-white/10 bg-black/20 p-6"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-xl font-semibold text-[#988dbf]">{course.title}</h3>
                    {course.description && (
                      <p className="mt-2 text-sm leading-6 text-white/70">
                        {course.description}
                      </p>
                    )}
                  </div>
                  <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                    {course.access}
                  </span>
                </div>

                <div className="mt-6 space-y-4">
                  <p className="text-sm text-white/55">
                    {course.lessonCount} lessons
                  </p>
                  <ProgressBar
                    value={tracked?.progressPercent || 0}
                    label={
                      tracked
                        ? `${tracked.completedLessons}/${tracked.totalLessons} lessons completed`
                        : "No progress yet"
                    }
                  />
                </div>

                <Button
                  asChild
                  className="mt-6 rounded-full border border-[#c73484] bg-[#c73484] text-[#e5e6ea] hover:bg-[#b72f78] hover:text-[#e5e6ea]"
                >
                  <Link href={`/x/${data.slug}/courses/${course.id}`}>
                    Open Course
                  </Link>
                </Button>
              </div>
            );
          })}
        </div>

        {data.courses.length === 0 && (
          <div className="mt-8 rounded-3xl border border-white/10 bg-black/20 p-6 text-sm text-white/65">
            No courses are visible in this experience yet.
          </div>
        )}
      </PageCard>
    </ExperienceShell>
  );
}
