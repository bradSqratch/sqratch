"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { ExperienceShell, GatePanel, LoadingView, ErrorView, PageCard, ProgressBar } from "@/components/experience/experience-shell";
import type { ExperienceShellData } from "@/components/experience/use-experience";
import { Button } from "@/components/ui/button";

type CourseResponse = {
  experience: ExperienceShellData;
  course: {
    id: string;
    title: string;
    description: string | null;
    access: "PUBLIC" | "PRIVATE";
    lessons: Array<{
      id: string;
      title: string;
      description: string | null;
      sortOrder: number;
    }>;
  };
  canAccess: boolean;
  canInteract: boolean;
  canAccessPrivate: boolean;
};

type CourseProgressResponse = {
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

export function ExperienceCourseClient({
  experienceSlug,
  courseSlug,
}: {
  experienceSlug: string;
  courseSlug: string;
}) {
  const [data, setData] = useState<CourseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<CourseProgressResponse | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const result = await fetchJson<CourseResponse>(
          `/api/public/experience/${experienceSlug}/courses/${courseSlug}`,
        );
        setData(result);

        const progressResult = await fetchJson<CourseProgressResponse>(
          `/api/progress/lesson?courseId=${courseSlug}`,
        );
        setProgress(progressResult);
      } catch (error) {
        setError(getErrorMessage(error, "Failed to load course."));
      } finally {
        setLoading(false);
      }
    }

    load();
  }, [experienceSlug, courseSlug]);

  if (loading) {
    return <LoadingView label="Loading course..." />;
  }

  if (error || !data) {
    return <ErrorView message={error || "Course not found."} />;
  }

  const lessonProgressMap = new Map(
    (progress?.lessonProgress || []).map((item) => [item.lessonId, item]),
  );
  const courseProgress = progress?.courseProgress[0];

  return (
    <ExperienceShell
      experience={data.experience}
      activeTab="learn"
      actions={
        <div className="space-y-3 rounded-3xl border border-white/10 bg-black/20 p-5">
          <p className="text-sm text-white/55">Course progress</p>
          <p className="text-3xl font-semibold">
            {courseProgress?.progressPercent || 0}%
          </p>
          <ProgressBar
            value={courseProgress?.progressPercent || 0}
            label={
              courseProgress
                ? `${courseProgress.completedLessons}/${courseProgress.totalLessons} lessons completed`
                : "No progress yet"
            }
          />
        </div>
      }
    >
      {!data.canAccess ? (
        <GatePanel
          experience={data.experience}
          title="This Course Is Locked"
          description="Private courses require a logged-in account and an unlocked campaign before lessons become available."
        />
      ) : (
        <PageCard>
          <div className="space-y-3">
            <div className="flex items-center gap-3">
              <h2 className="text-2xl font-semibold">{data.course.title}</h2>
              <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/65">
                {data.course.access}
              </span>
            </div>

            {data.course.description && (
              <p className="max-w-3xl text-sm leading-6 text-white/70">
                {data.course.description}
              </p>
            )}
          </div>

          <div className="mt-8 space-y-4">
            {data.course.lessons.map((lesson, index) => {
              const lessonProgress = lessonProgressMap.get(lesson.id);

              return (
                <div
                  key={lesson.id}
                  className="flex flex-col gap-4 rounded-3xl border border-white/10 bg-black/20 p-5 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-white/45">
                      Lesson {index + 1}
                    </p>
                    <h3 className="mt-2 text-lg font-semibold">{lesson.title}</h3>
                    {lesson.description && (
                      <p className="mt-2 max-w-2xl text-sm leading-6 text-white/70">
                        {lesson.description}
                      </p>
                    )}
                    <p className="mt-3 text-sm text-white/55">
                      {lessonProgress?.isCompleted
                        ? "Completed"
                        : lessonProgress?.lastPositionSeconds
                          ? `Last watched at ${lessonProgress.lastPositionSeconds}s`
                          : "Not started"}
                    </p>
                  </div>

                  <Button
                    asChild
                    className="rounded-full border border-white bg-white text-black"
                  >
                    <Link href={`/x/${data.experience.slug}/lessons/${lesson.id}`}>
                      Open Lesson
                    </Link>
                  </Button>
                </div>
              );
            })}
          </div>
        </PageCard>
      )}
    </ExperienceShell>
  );
}
