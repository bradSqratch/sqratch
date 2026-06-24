"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { CreatorPageShell } from "@/components/creator/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Course = {
  id: string;
  title: string;
  description: string | null;
  access: "PUBLIC" | "PRIVATE";
  sortOrder: number;
  lessons: Array<{
    id: string;
    title: string;
    description: string | null;
    videoSource: "YOUTUBE" | "UPLOAD";
  }>;
};

type CoursesResponse = {
  experience: {
    id: string;
    title: string;
    slug: string;
  };
  courses: Course[];
};

const emptyCourse = {
  title: "",
  description: "",
  access: "PUBLIC" as "PUBLIC" | "PRIVATE",
  sortOrder: 0,
};

export default function CreatorExperienceCoursesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: experienceId } = use(params);
  const [data, setData] = useState<CoursesResponse | null>(null);
  const [newCourse, setNewCourse] = useState(emptyCourse);
  const [savingNew, setSavingNew] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);

    try {
      const result = await fetchJson<CoursesResponse>(
        `/api/creator/courses?experienceId=${experienceId}`,
      );
      setData(result);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load courses."));
    }
  }, [experienceId]);

  useEffect(() => {
    if (!experienceId) {
      return;
    }

    void load();
  }, [experienceId, load]);

  async function createCourse() {
    if (!newCourse.title.trim() || savingNew || savingId || deletingId) {
      return;
    }

    setSavingNew(true);
    setError(null);

    try {
      await fetchJson("/api/creator/courses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          experienceId,
          ...newCourse,
        }),
      });
      setNewCourse(emptyCourse);
      await load();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to create course."));
    } finally {
      setSavingNew(false);
    }
  }

  async function saveCourse(course: Course) {
    if (savingNew || savingId || deletingId) {
      return;
    }

    setSavingId(course.id);
    setError(null);

    try {
      await fetchJson("/api/creator/courses", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(course),
      });
      await load();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to update course."));
    } finally {
      setSavingId(null);
    }
  }

  async function deleteCourse(courseId: string) {
    if (savingNew || savingId || deletingId) {
      return;
    }

    const confirmed = window.confirm(
      "Delete this course? This will also delete all lessons inside it. This cannot be undone.",
    );

    if (!confirmed) {
      return;
    }

    setDeletingId(courseId);
    setError(null);

    try {
      await fetchJson("/api/creator/courses", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: courseId }),
      });
      await load();
      toast.success("Course deleted", {
        description: "The course and its lessons were removed.",
      });
    } catch (deleteError) {
      setError(getErrorMessage(deleteError, "Failed to delete course."));
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <CreatorPageShell
      title={data ? `${data.experience.title} Courses` : "Manage Courses"}
      description="Create and update the courses under this experience, control whether they are public or private, and jump into lesson management."
      actions={
        data ? (
          <Button
            asChild
            variant="outline"
            className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
          >
            <Link href={`/dashboard/creator/experiences/${experienceId}/edit`}>
              Edit experience
            </Link>
          </Button>
        ) : null
      }
    >
      <PageCard>
        <h2 className="text-xl font-semibold">Create course</h2>
        <p className="mt-2 text-sm text-white/60">
          Create the course first, then use <span className="font-medium text-white">Manage lessons</span> on that course card to add lessons.
        </p>
        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm text-white/70">Course title</p>
            <Input
              value={newCourse.title}
              onChange={(event) =>
                setNewCourse((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
              placeholder="Course title"
              className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
            />
          </div>
          <div className="space-y-2">
            <p className="text-sm text-white/70">Display order</p>
            <Input
              type="number"
              value={newCourse.sortOrder}
              onChange={(event) =>
                setNewCourse((current) => ({
                  ...current,
                  sortOrder: Number(event.target.value || 0),
                }))
              }
              placeholder="Display order"
              className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
            />
            <p className="text-xs text-white/45">Lower numbers appear first.</p>
          </div>
        </div>
        <Textarea
          value={newCourse.description}
          onChange={(event) =>
            setNewCourse((current) => ({
              ...current,
              description: event.target.value,
            }))
          }
          placeholder="Course description"
          className="mt-4 min-h-[140px] border-white/10 bg-black/20 text-white placeholder:text-white/35"
        />
        <div className="mt-4 flex flex-wrap gap-4">
          <select
            value={newCourse.access}
            onChange={(event) =>
              setNewCourse((current) => ({
                ...current,
                access: event.target.value as "PUBLIC" | "PRIVATE",
              }))
            }
            className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          >
            <option value="PUBLIC">Public</option>
            <option value="PRIVATE">Private</option>
          </select>
          <Button
            type="button"
            onClick={() => void createCourse()}
            disabled={
              savingNew ||
              savingId !== null ||
              deletingId !== null ||
              !newCourse.title.trim()
            }
            className="rounded-full border border-white bg-white text-black"
          >
            {savingNew ? "Creating..." : "Create course"}
          </Button>
        </div>
      </PageCard>

      {error && (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      )}

      {!data ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading courses...</p>
        </PageCard>
      ) : data.courses.length === 0 ? (
        <PageCard>
          <p className="text-sm text-white/65">
            No courses yet. Create a course above, then open Manage lessons on that course to add lessons.
          </p>
        </PageCard>
      ) : (
        <div className="space-y-5">
          {data.courses.map((course) => (
            <EditableCourseCard
              key={course.id}
              course={course}
              saving={savingId === course.id}
              deleting={deletingId === course.id}
              disabled={savingNew || savingId !== null || deletingId !== null}
              onSave={saveCourse}
              onDelete={deleteCourse}
            />
          ))}
        </div>
      )}
    </CreatorPageShell>
  );
}

function EditableCourseCard({
  course,
  saving,
  deleting,
  disabled,
  onSave,
  onDelete,
}: {
  course: Course;
  saving: boolean;
  deleting: boolean;
  disabled: boolean;
  onSave: (course: Course) => Promise<void>;
  onDelete: (courseId: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(course);

  useEffect(() => {
    setDraft(course);
  }, [course]);

  const lessonManagementHref = `/dashboard/creator/courses/${course.id}/lessons`;

  return (
    <PageCard>
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm text-white/70">Course title</p>
          <Input
            value={draft.title}
            onChange={(event) =>
              setDraft((current) => ({ ...current, title: event.target.value }))
            }
            className="border-white/10 bg-black/20 text-white"
          />
        </div>
        <div className="space-y-2">
          <p className="text-sm text-white/70">Display order</p>
          <Input
            type="number"
            value={draft.sortOrder}
            onChange={(event) =>
              setDraft((current) => ({
                ...current,
                sortOrder: Number(event.target.value || 0),
              }))
            }
            className="border-white/10 bg-black/20 text-white"
          />
          <p className="text-xs text-white/45">Lower numbers appear first.</p>
        </div>
      </div>
      <Textarea
        value={draft.description || ""}
        onChange={(event) =>
          setDraft((current) => ({
            ...current,
            description: event.target.value,
          }))
        }
        className="mt-4 min-h-[120px] border-white/10 bg-black/20 text-white"
      />
      <div className="mt-4 flex flex-wrap items-center gap-4">
        <select
          value={draft.access}
          onChange={(event) =>
            setDraft((current) => ({
              ...current,
              access: event.target.value as "PUBLIC" | "PRIVATE",
            }))
          }
          className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
        >
          <option value="PUBLIC">Public</option>
          <option value="PRIVATE">Private</option>
        </select>
        <Button
          type="button"
          onClick={() => void onSave(draft)}
          disabled={disabled || !draft.title.trim()}
          className="rounded-full border border-white bg-white text-black"
        >
          {saving ? "Saving..." : "Save course"}
        </Button>
        <Button
          asChild={!disabled}
          disabled={disabled}
          variant="outline"
          className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
        >
          {disabled ? (
            <span>Manage lessons</span>
          ) : (
            <Link href={lessonManagementHref}>Manage lessons</Link>
          )}
        </Button>
        <div className="mt-2 w-full border-t border-red-300/20 pt-4 sm:mt-0 sm:w-auto sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
          <Button
            type="button"
            variant="outline"
            onClick={() => void onDelete(course.id)}
            disabled={disabled}
            className="rounded-full border-red-400/45 bg-red-500/10 text-red-200 hover:border-red-300/70 hover:bg-red-500/20 hover:text-red-100"
          >
            {deleting ? "Deleting..." : "Delete course"}
          </Button>
        </div>
      </div>

      <div className="mt-6 grid gap-3 md:grid-cols-2">
        {course.lessons.length === 0 ? (
          <div className="rounded-2xl border border-white/10 bg-black/20 p-4 text-sm text-white/60">
            No lessons in this course yet.
          </div>
        ) : (
          course.lessons.map((lesson) => (
            <div
              key={lesson.id}
              className="rounded-2xl border border-white/10 bg-black/20 p-4"
            >
              <h3 className="font-medium">{lesson.title}</h3>
              <p className="mt-2 text-sm text-white/55">{lesson.videoSource}</p>
            </div>
          ))
        )}
      </div>
    </PageCard>
  );
}
