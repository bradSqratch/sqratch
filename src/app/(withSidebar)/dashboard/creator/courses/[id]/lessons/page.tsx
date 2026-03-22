"use client";

import { use, useCallback, useEffect, useState } from "react";
import { CreatorPageShell } from "@/components/creator/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type Lesson = {
  id: string;
  title: string;
  description: string | null;
  sortOrder: number;
  videoSource: "YOUTUBE" | "UPLOAD";
  youtubeUrl: string | null;
  videoAssetUrl: string | null;
};

type LessonsResponse = {
  course: {
    id: string;
    title: string;
    access: "PUBLIC" | "PRIVATE";
    experience: {
      id: string;
      title: string;
      slug: string;
    };
  };
  lessons: Lesson[];
};

type LessonDraft = {
  title: string;
  description: string;
  sortOrder: number;
  videoSource: "YOUTUBE" | "UPLOAD";
  youtubeUrl: string;
  videoAssetUrl: string;
  file: File | null;
};

const emptyLessonDraft: LessonDraft = {
  title: "",
  description: "",
  sortOrder: 0,
  videoSource: "YOUTUBE",
  youtubeUrl: "",
  videoAssetUrl: "",
  file: null,
};

export default function CreatorCourseLessonsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: courseId } = use(params);
  const [data, setData] = useState<LessonsResponse | null>(null);
  const [draft, setDraft] = useState<LessonDraft>(emptyLessonDraft);
  const [saving, setSaving] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);

    try {
      const result = await fetchJson<LessonsResponse>(
        `/api/creator/lessons?courseId=${courseId}`,
      );
      setData(result);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load lessons."));
    }
  }, [courseId]);

  useEffect(() => {
    if (!courseId) {
      return;
    }

    void load();
  }, [courseId, load]);

  async function uploadVideo(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("courseId", courseId);

    const result = await fetchJson<{
      bucket: string;
      path: string;
      fileUrl: string;
    }>("/api/uploads/video", {
      method: "POST",
      body: formData,
    });

    return result.fileUrl;
  }

  async function createLesson() {
    if (!draft.title.trim()) {
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const videoAssetUrl =
        draft.videoSource === "UPLOAD" && draft.file
          ? await uploadVideo(draft.file)
          : draft.videoAssetUrl;

      await fetchJson("/api/creator/lessons", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          courseId,
          title: draft.title,
          description: draft.description,
          sortOrder: draft.sortOrder,
          videoSource: draft.videoSource,
          youtubeUrl: draft.youtubeUrl,
          videoAssetUrl,
        }),
      });

      setDraft(emptyLessonDraft);
      await load();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to create lesson."));
    } finally {
      setSaving(false);
    }
  }

  async function updateLesson(id: string, lessonDraft: LessonDraft) {
    setSavingId(id);
    setError(null);

    try {
      const videoAssetUrl =
        lessonDraft.videoSource === "UPLOAD" && lessonDraft.file
          ? await uploadVideo(lessonDraft.file)
          : lessonDraft.videoAssetUrl;

      await fetchJson("/api/creator/lessons", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          id,
          title: lessonDraft.title,
          description: lessonDraft.description,
          sortOrder: lessonDraft.sortOrder,
          videoSource: lessonDraft.videoSource,
          youtubeUrl: lessonDraft.youtubeUrl,
          videoAssetUrl,
        }),
      });

      await load();
    } catch (saveError) {
      setError(getErrorMessage(saveError, "Failed to update lesson."));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <CreatorPageShell
      title={data ? `${data.course.title} Lessons` : "Manage Lessons"}
      description="Choose between YouTube and uploaded video sources for each lesson, then update the lesson metadata inline."
    >
      <PageCard>
        <h2 className="text-xl font-semibold">Add lesson</h2>
        <p className="mt-2 text-sm text-white/60">
          Lessons are attached to this course. Create them here and control their display order inside the course.
        </p>
        <LessonEditor
          draft={draft}
          onChange={setDraft}
          submitLabel={saving ? "Creating..." : "Create lesson"}
          onSubmit={() => void createLesson()}
        />
      </PageCard>

      {error && (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      )}

      {!data ? (
        <PageCard>
          <p className="text-sm text-white/65">Loading lessons...</p>
        </PageCard>
      ) : data.lessons.length === 0 ? (
        <PageCard>
          <p className="text-sm text-white/65">No lessons created yet.</p>
        </PageCard>
      ) : (
        <div className="space-y-5">
          {data.lessons.map((lesson) => (
            <EditableLessonCard
              key={lesson.id}
              lesson={lesson}
              saving={savingId === lesson.id}
              onSave={updateLesson}
            />
          ))}
        </div>
      )}
    </CreatorPageShell>
  );
}

function EditableLessonCard({
  lesson,
  saving,
  onSave,
}: {
  lesson: Lesson;
  saving: boolean;
  onSave: (id: string, lessonDraft: LessonDraft) => Promise<void>;
}) {
  const [draft, setDraft] = useState<LessonDraft>({
    title: lesson.title,
    description: lesson.description || "",
    sortOrder: lesson.sortOrder,
    videoSource: lesson.videoSource,
    youtubeUrl: lesson.youtubeUrl || "",
    videoAssetUrl: lesson.videoAssetUrl || "",
    file: null,
  });

  useEffect(() => {
    setDraft({
      title: lesson.title,
      description: lesson.description || "",
      sortOrder: lesson.sortOrder,
      videoSource: lesson.videoSource,
      youtubeUrl: lesson.youtubeUrl || "",
      videoAssetUrl: lesson.videoAssetUrl || "",
      file: null,
    });
  }, [lesson]);

  return (
    <PageCard>
      <LessonEditor
        draft={draft}
        onChange={setDraft}
        submitLabel={saving ? "Saving..." : "Save lesson"}
        onSubmit={() => void onSave(lesson.id, draft)}
      />
    </PageCard>
  );
}

function LessonEditor({
  draft,
  onChange,
  submitLabel,
  onSubmit,
}: {
  draft: LessonDraft;
  onChange: (draft: LessonDraft) => void;
  submitLabel: string;
  onSubmit: () => void;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm text-white/70">Lesson title</p>
          <Input
            value={draft.title}
            onChange={(event) =>
              onChange({ ...draft, title: event.target.value })
            }
            placeholder="Lesson title"
            className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
          />
        </div>
        <div className="space-y-2">
          <p className="text-sm text-white/70">Display order</p>
          <Input
            type="number"
            value={draft.sortOrder}
            onChange={(event) =>
              onChange({
                ...draft,
                sortOrder: Number(event.target.value || 0),
              })
            }
            placeholder="Display order"
            className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
          />
          <p className="text-xs text-white/45">Lower numbers appear first.</p>
        </div>
      </div>

      <Textarea
        value={draft.description}
        onChange={(event) =>
          onChange({ ...draft, description: event.target.value })
        }
        placeholder="Lesson description"
        className="min-h-[120px] border-white/10 bg-black/20 text-white placeholder:text-white/35"
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <select
          value={draft.videoSource}
          onChange={(event) =>
            onChange({
              ...draft,
              videoSource: event.target.value as "YOUTUBE" | "UPLOAD",
              youtubeUrl:
                event.target.value === "YOUTUBE" ? draft.youtubeUrl : "",
              videoAssetUrl:
                event.target.value === "UPLOAD" ? draft.videoAssetUrl : "",
              file: null,
            })
          }
          className="flex h-10 rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
        >
          <option value="YOUTUBE">YouTube</option>
          <option value="UPLOAD">Uploaded video</option>
        </select>

        {draft.videoSource === "YOUTUBE" ? (
          <Input
            value={draft.youtubeUrl}
            onChange={(event) =>
              onChange({ ...draft, youtubeUrl: event.target.value })
            }
            placeholder="https://youtube.com/watch?v=..."
            className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
          />
        ) : (
          <div className="space-y-2">
            <Input
              type="file"
              accept=".mp4,.mov,.webm,.m4v"
              onChange={(event) =>
                onChange({
                  ...draft,
                  file: event.target.files?.[0] || null,
                })
              }
              className="border-white/10 bg-black/20 text-white file:mr-4 file:rounded-full file:border-0 file:bg-white file:px-4 file:py-2 file:text-black"
            />
            <p className="text-xs text-white/45">MP4, MOV, WEBM, M4V up to 250 MB.</p>
          </div>
        )}
      </div>

      {draft.videoSource === "UPLOAD" && draft.videoAssetUrl && (
        <p className="text-sm text-white/55">Current asset: {draft.videoAssetUrl}</p>
      )}

      <Button
        type="button"
        onClick={onSubmit}
        disabled={
          !draft.title.trim() ||
          (draft.videoSource === "YOUTUBE" && !draft.youtubeUrl.trim()) ||
          (draft.videoSource === "UPLOAD" &&
            !draft.videoAssetUrl.trim() &&
            !draft.file)
        }
        className="rounded-full border border-white bg-white text-black"
      >
        {submitLabel}
      </Button>
    </div>
  );
}
