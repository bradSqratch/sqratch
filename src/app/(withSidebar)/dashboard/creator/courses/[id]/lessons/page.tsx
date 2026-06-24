"use client";

import {
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import {
  LessonProductLinksSection,
  type LessonProductLinkItem,
} from "@/components/creator/lesson-product-links-section";
import { CreatorPageShell } from "@/components/creator/page-shell";
import {
  deleteUploadedAsset,
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  requestLessonVideoUploadAuthorization,
  uploadFileToSignedStorage,
} from "@/lib/direct-storage-upload";
import {
  DEFAULT_MAX_VIDEO_UPLOAD_BYTES,
  hasAllowedVideoExtension,
  isAllowedVideoMimeType,
} from "@/lib/video-upload-config";

type Lesson = {
  id: string;
  title: string;
  description: string | null;
  sortOrder: number;
  videoSource: "YOUTUBE" | "UPLOAD";
  youtubeUrl: string | null;
  videoAssetUrl: string | null;
  videoStorageBucket: string | null;
  videoStoragePath: string | null;
  productLinks: LessonProductLinkItem[];
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
  videoStorageBucket: string;
  videoStoragePath: string;
  file: File | null;
};

type LessonOperation = {
  key: string;
  phase: "PREPARING" | "UPLOADING" | "SAVING" | "FAILED";
  progress: number;
};

const emptyLessonDraft: LessonDraft = {
  title: "",
  description: "",
  sortOrder: 0,
  videoSource: "YOUTUBE",
  youtubeUrl: "",
  videoAssetUrl: "",
  videoStorageBucket: "",
  videoStoragePath: "",
  file: null,
};

function formatFileSize(bytes: number) {
  return `${new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  }).format(bytes / (1024 * 1024))} MB`;
}

function getVideoFileValidationError(file: File) {
  if (!hasAllowedVideoExtension(file.name)) {
    return "Choose an MP4, MOV, WEBM, MPEG, or M4V video.";
  }

  if (!isAllowedVideoMimeType(file.type)) {
    return "The selected file has an unsupported video MIME type.";
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    return "The selected video file is empty or invalid.";
  }

  if (file.size > DEFAULT_MAX_VIDEO_UPLOAD_BYTES) {
    return "The selected video is larger than 250 MB.";
  }

  return null;
}

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
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [operation, setOperation] = useState<LessonOperation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const uploadAbortControllerRef = useRef<AbortController | null>(null);
  const submissionInFlightRef = useRef(false);

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
    if (courseId) {
      void load();
    }
  }, [courseId, load]);

  async function uploadVideo(file: File, operationKey: string) {
    const validationError = getVideoFileValidationError(file);

    if (validationError) {
      throw new Error(validationError);
    }

    setOperation({ key: operationKey, phase: "PREPARING", progress: 0 });
    const authorization = await requestLessonVideoUploadAuthorization({
      courseId,
      file,
    });
    const controller = new AbortController();
    uploadAbortControllerRef.current = controller;
    setOperation({ key: operationKey, phase: "UPLOADING", progress: 0 });

    await uploadFileToSignedStorage({
      signedUrl: authorization.signedUrl,
      file,
      signal: controller.signal,
      onProgress: (progress) =>
        setOperation({
          key: operationKey,
          phase: "UPLOADING",
          progress,
        }),
    });
    uploadAbortControllerRef.current = null;

    return authorization;
  }

  function cancelUpload() {
    uploadAbortControllerRef.current?.abort();
  }

  async function createLesson() {
    if (!draft.title.trim() || submissionInFlightRef.current) {
      return;
    }

    submissionInFlightRef.current = true;
    setSaving(true);
    setError(null);
    let uploadedVideo: { bucket: string; path: string } | null = null;

    try {
      const uploadAuthorization =
        draft.videoSource === "UPLOAD" && draft.file
          ? await uploadVideo(draft.file, "new")
          : null;
      const videoAssetUrl = draft.videoAssetUrl;
      const videoStorageBucket =
        uploadAuthorization?.bucket || draft.videoStorageBucket;
      const videoStoragePath =
        uploadAuthorization?.path || draft.videoStoragePath;

      uploadedVideo = uploadAuthorization;
      setOperation({ key: "new", phase: "SAVING", progress: 100 });

      await fetchJson("/api/creator/lessons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courseId,
          title: draft.title,
          description: draft.description,
          sortOrder: draft.sortOrder,
          videoSource: draft.videoSource,
          youtubeUrl: draft.youtubeUrl,
          videoAssetUrl,
          videoStorageBucket,
          videoStoragePath,
        }),
      });

      setDraft(emptyLessonDraft);
      setOperation(null);
      await load();
    } catch (saveError) {
      if (uploadedVideo) {
        await deleteUploadedAsset("", {
          courseId,
          bucket: uploadedVideo.bucket,
          path: uploadedVideo.path,
        });
      }
      setOperation({ key: "new", phase: "FAILED", progress: 0 });
      setError(getErrorMessage(saveError, "Failed to create lesson."));
    } finally {
      uploadAbortControllerRef.current = null;
      submissionInFlightRef.current = false;
      setSaving(false);
    }
  }

  async function updateLesson(id: string, lessonDraft: LessonDraft) {
    if (submissionInFlightRef.current) {
      return;
    }

    submissionInFlightRef.current = true;
    setSavingId(id);
    setError(null);
    let uploadedVideo: { bucket: string; path: string } | null = null;

    try {
      const uploadAuthorization =
        lessonDraft.videoSource === "UPLOAD" && lessonDraft.file
          ? await uploadVideo(lessonDraft.file, id)
          : null;
      const videoAssetUrl = lessonDraft.videoAssetUrl;
      const videoStorageBucket =
        uploadAuthorization?.bucket || lessonDraft.videoStorageBucket;
      const videoStoragePath =
        uploadAuthorization?.path || lessonDraft.videoStoragePath;

      uploadedVideo = uploadAuthorization;
      setOperation({ key: id, phase: "SAVING", progress: 100 });

      await fetchJson("/api/creator/lessons", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id,
          title: lessonDraft.title,
          description: lessonDraft.description,
          sortOrder: lessonDraft.sortOrder,
          videoSource: lessonDraft.videoSource,
          youtubeUrl: lessonDraft.youtubeUrl,
          videoAssetUrl,
          videoStorageBucket,
          videoStoragePath,
        }),
      });

      setOperation(null);
      await load();
    } catch (saveError) {
      if (uploadedVideo) {
        await deleteUploadedAsset("", {
          courseId,
          bucket: uploadedVideo.bucket,
          path: uploadedVideo.path,
        });
      }
      setOperation({ key: id, phase: "FAILED", progress: 0 });
      setError(getErrorMessage(saveError, "Failed to update lesson."));
    } finally {
      uploadAbortControllerRef.current = null;
      submissionInFlightRef.current = false;
      setSavingId(null);
    }
  }

  async function deleteLesson(lessonId: string) {
    if (submissionInFlightRef.current || saving || savingId || deletingId) {
      return;
    }

    const confirmed = window.confirm(
      "Delete this lesson? This cannot be undone.",
    );

    if (!confirmed) {
      return;
    }

    submissionInFlightRef.current = true;
    setDeletingId(lessonId);
    setError(null);

    try {
      await fetchJson("/api/creator/lessons", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: lessonId }),
      });
      await load();
      toast.success("Lesson deleted", {
        description: "The lesson was removed from this course.",
      });
    } catch (deleteError) {
      setError(getErrorMessage(deleteError, "Failed to delete lesson."));
    } finally {
      submissionInFlightRef.current = false;
      setDeletingId(null);
    }
  }

  const isMutating = saving || savingId !== null || deletingId !== null;

  return (
    <CreatorPageShell
      title={data ? `${data.course.title} Lessons` : "Manage Lessons"}
      description="Choose between YouTube and uploaded video sources for each lesson, update the lesson metadata inline, and attach Shopify products that should appear on the public lesson page."
    >
      <PageCard>
        <h2 className="text-xl font-semibold">Add lesson</h2>
        <p className="mt-2 text-sm text-white/60">
          Lessons are attached to this course. Create them here and control
          their display order inside the course.
        </p>
        <LessonEditor
          draft={draft}
          onChange={setDraft}
          submitLabel={saving ? "Creating..." : "Create lesson"}
          onSubmit={() => void createLesson()}
          operation={operation?.key === "new" ? operation : null}
          busy={isMutating}
          onCancelUpload={cancelUpload}
          onValidationError={setError}
        />
      </PageCard>

      {error ? (
        <PageCard>
          <p className="text-sm text-red-300">{error}</p>
        </PageCard>
      ) : null}

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
              deleting={deletingId === lesson.id}
              disabled={isMutating}
              operation={operation?.key === lesson.id ? operation : null}
              onSave={updateLesson}
              onDelete={deleteLesson}
              onRefresh={load}
              onCancelUpload={cancelUpload}
              onValidationError={setError}
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
  deleting,
  disabled,
  operation,
  onSave,
  onDelete,
  onRefresh,
  onCancelUpload,
  onValidationError,
}: {
  lesson: Lesson;
  saving: boolean;
  deleting: boolean;
  disabled: boolean;
  operation: LessonOperation | null;
  onSave: (id: string, lessonDraft: LessonDraft) => Promise<void>;
  onDelete: (lessonId: string) => Promise<void>;
  onRefresh: () => Promise<void>;
  onCancelUpload: () => void;
  onValidationError: (message: string | null) => void;
}) {
  const [draft, setDraft] = useState<LessonDraft>({
    title: lesson.title,
    description: lesson.description || "",
    sortOrder: lesson.sortOrder,
    videoSource: lesson.videoSource,
    youtubeUrl: lesson.youtubeUrl || "",
    videoAssetUrl: lesson.videoAssetUrl || "",
    videoStorageBucket: lesson.videoStorageBucket || "",
    videoStoragePath: lesson.videoStoragePath || "",
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
      videoStorageBucket: lesson.videoStorageBucket || "",
      videoStoragePath: lesson.videoStoragePath || "",
      file: null,
    });
  }, [lesson]);

  return (
    <PageCard>
      <div className="space-y-5">
        <LessonEditor
          draft={draft}
          onChange={setDraft}
          submitLabel={saving ? "Saving..." : "Save lesson"}
          onSubmit={() => void onSave(lesson.id, draft)}
          operation={operation}
          busy={disabled}
          onCancelUpload={onCancelUpload}
          onValidationError={onValidationError}
          secondaryAction={
            <Button
              type="button"
              variant="outline"
              onClick={() => void onDelete(lesson.id)}
              disabled={disabled}
              className="rounded-full border-red-400/45 bg-red-500/10 px-4 text-red-200 hover:border-red-300/70 hover:bg-red-500/20 hover:text-red-100 sm:px-6"
            >
              {deleting ? "Deleting..." : "Delete lesson"}
            </Button>
          }
        />
        <LessonProductLinksSection
          lessonId={lesson.id}
          linkedProducts={lesson.productLinks}
          onChanged={onRefresh}
        />
      </div>
    </PageCard>
  );
}

function LessonEditor({
  draft,
  onChange,
  submitLabel,
  onSubmit,
  operation,
  busy,
  onCancelUpload,
  onValidationError,
  secondaryAction,
}: {
  draft: LessonDraft;
  onChange: (draft: LessonDraft) => void;
  submitLabel: string;
  onSubmit: () => void;
  operation: LessonOperation | null;
  busy: boolean;
  onCancelUpload: () => void;
  onValidationError: (message: string | null) => void;
  secondaryAction?: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-2">
          <p className="text-sm text-white/70">Lesson title</p>
          <Input
            value={draft.title}
            disabled={busy}
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
            disabled={busy}
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
        disabled={busy}
        onChange={(event) =>
          onChange({ ...draft, description: event.target.value })
        }
        placeholder="Lesson description"
        className="min-h-[120px] border-white/10 bg-black/20 text-white placeholder:text-white/35"
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <select
          value={draft.videoSource}
          disabled={busy}
          onChange={(event) =>
            onChange({
              ...draft,
              videoSource: event.target.value as "YOUTUBE" | "UPLOAD",
              youtubeUrl:
                event.target.value === "YOUTUBE" ? draft.youtubeUrl : "",
              videoAssetUrl:
                event.target.value === "UPLOAD" ? draft.videoAssetUrl : "",
              videoStorageBucket:
                event.target.value === "UPLOAD"
                  ? draft.videoStorageBucket
                  : "",
              videoStoragePath:
                event.target.value === "UPLOAD" ? draft.videoStoragePath : "",
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
            disabled={busy}
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
              disabled={busy}
              accept=".mp4,.mov,.webm,.mpeg,.mpg,.m4v,video/mp4,video/webm,video/quicktime,video/mpeg,video/x-m4v"
              onChange={(event) => {
                const file = event.target.files?.[0] || null;
                const validationError = file
                  ? getVideoFileValidationError(file)
                  : null;

                if (validationError) {
                  onValidationError(validationError);
                  onChange({ ...draft, file: null });
                  event.target.value = "";
                  return;
                }

                onValidationError(null);
                onChange({ ...draft, file });
              }}
              className="border-white/10 bg-black/20 text-white file:mr-4 file:rounded-full file:border-0 file:bg-white file:px-4 file:py-2 file:text-black"
            />
            <p className="text-xs text-white/45">
              MP4, MOV, WEBM, MPEG, M4V up to 250 MB.
            </p>
            {draft.file ? (
              <p className="text-sm text-white/65">
                Selected: {draft.file.name} ({formatFileSize(draft.file.size)})
              </p>
            ) : null}
          </div>
        )}
      </div>

      {draft.videoSource === "UPLOAD" && draft.videoAssetUrl ? (
        <div className="space-y-2">
          <p className="text-sm text-white/55">Uploaded video preview</p>
          <video
            className="max-h-80 w-full rounded-2xl border border-white/10 bg-black object-contain"
            src={draft.videoAssetUrl}
            controls
            playsInline
            preload="metadata"
          />
        </div>
      ) : null}

      {operation ? (
        <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
          <div className="flex items-center justify-between gap-4 text-sm">
            <span className="text-white/70">
              {operation.phase === "PREPARING"
                ? "Preparing upload"
                : operation.phase === "UPLOADING"
                  ? `Uploading video ${operation.progress}%`
                  : operation.phase === "SAVING"
                    ? "Saving lesson"
                    : "Upload or save failed"}
            </span>
            {operation.phase === "UPLOADING" ? (
              <Button
                type="button"
                variant="outline"
                onClick={onCancelUpload}
                className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
              >
                Cancel upload
              </Button>
            ) : null}
          </div>
          {operation.phase === "UPLOADING" ? (
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-[#c73484] transition-[width]"
                style={{ width: `${operation.progress}%` }}
              />
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex w-full items-center justify-between gap-3">
        <Button
          type="button"
          onClick={onSubmit}
          disabled={
            busy ||
            !draft.title.trim() ||
            (draft.videoSource === "YOUTUBE" && !draft.youtubeUrl.trim()) ||
            (draft.videoSource === "UPLOAD" &&
              !draft.videoAssetUrl.trim() &&
              !draft.file)
          }
          className="rounded-full border border-white bg-white px-4 text-black sm:px-6"
        >
          {submitLabel}
        </Button>
        {secondaryAction}
      </div>
    </div>
  );
}
