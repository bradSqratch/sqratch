"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteUploadedAsset,
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";
import { CreatorPageShell } from "@/components/creator/page-shell";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type ExperienceFormData = {
  title: string;
  slug: string;
  description: string;
  coverImageUrl: string;
  whyVideoSource: "" | "YOUTUBE" | "UPLOAD";
  whyYoutubeUrl: string;
  whyVideoAssetUrl: string;
  status: "DRAFT" | "PUBLISHED";
};

function slugifyValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function uploadExperienceVideoDirect(options: {
  file: File;
  experienceSlug: string;
  experienceId?: string;
}) {
  const signResponse = await fetch("/api/uploads/experience-video", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      fileName: options.file.name,
      fileType: options.file.type,
      fileSize: options.file.size,
      experienceSlug: options.experienceSlug,
      experienceId: options.experienceId,
    }),
  });

  const signJson = await signResponse.json().catch(() => null);

  if (!signResponse.ok) {
    throw new Error(
      signJson?.error || "Failed to prepare experience video upload.",
    );
  }

  const signedUrl = String(signJson?.data?.signedUrl || "");
  const fileUrl = String(signJson?.data?.fileUrl || "");

  if (!signedUrl || !fileUrl) {
    throw new Error("Failed to prepare experience video upload.");
  }

  const uploadBody = new FormData();
  uploadBody.append("cacheControl", "3600");
  uploadBody.append("", options.file);

  const uploadResponse = await fetch(signedUrl, {
    method: "PUT",
    headers: {
      "x-upsert": "true",
    },
    body: uploadBody,
  });

  const uploadJson = await uploadResponse.json().catch(() => null);

  if (!uploadResponse.ok) {
    throw new Error(
      uploadJson?.error ||
        uploadJson?.message ||
        "Failed to upload experience video.",
    );
  }

  return fileUrl;
}

export function CreatorExperienceForm({
  mode,
  experienceId,
}: {
  mode: "create" | "edit";
  experienceId?: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState<ExperienceFormData>({
    title: "",
    slug: "",
    description: "",
    coverImageUrl: "",
    whyVideoSource: "",
    whyYoutubeUrl: "",
    whyVideoAssetUrl: "",
    status: "DRAFT",
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [pendingCoverFile, setPendingCoverFile] = useState<File | null>(null);
  const [pendingWhyVideoFile, setPendingWhyVideoFile] = useState<File | null>(
    null,
  );
  const [coverPreview, setCoverPreview] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "edit" || !experienceId) {
      return;
    }

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<{
          id: string;
          title: string;
          slug: string;
          description: string | null;
          coverImageUrl: string | null;
          whyVideoSource: "YOUTUBE" | "UPLOAD" | null;
          whyYoutubeUrl: string | null;
          whyVideoUploadUrl: string | null;
          status: "DRAFT" | "PUBLISHED";
        }>(`/api/creator/experiences/${experienceId}`);

        setForm({
          title: data.title,
          slug: data.slug,
          description: data.description || "",
          coverImageUrl: data.coverImageUrl || "",
          whyVideoSource: data.whyVideoSource || "",
          whyYoutubeUrl: data.whyYoutubeUrl || "",
          whyVideoAssetUrl: data.whyVideoUploadUrl || "",
          status: data.status,
        });
        setSlugTouched(true);
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load experience."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [experienceId, mode]);

  useEffect(() => {
    return () => {
      if (coverPreview) {
        URL.revokeObjectURL(coverPreview);
      }
    };
  }, [coverPreview]);

  const submitLabel = useMemo(
    () =>
      saving
        ? mode === "create"
          ? "Creating..."
          : "Saving..."
        : mode === "create"
          ? "Create Experience"
          : "Save Changes",
    [mode, saving],
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    let detailsSaved = false;
    let whyVideoAssetUrl = form.whyVideoAssetUrl.trim();
    let uploadedWhyVideoAssetUrl: string | null = null;

    try {
      if (form.whyVideoSource === "YOUTUBE" && !form.whyYoutubeUrl.trim()) {
        throw new Error("A YouTube URL is required for WHY videos.");
      }

      if (form.whyVideoSource === "UPLOAD") {
        if (pendingWhyVideoFile) {
          whyVideoAssetUrl = await uploadExperienceVideoDirect({
            file: pendingWhyVideoFile,
            experienceSlug: form.slug,
            experienceId,
          });
          uploadedWhyVideoAssetUrl = whyVideoAssetUrl;
        }

        if (!whyVideoAssetUrl) {
          throw new Error("An uploaded WHY video file is required.");
        }
      }

      const url =
        mode === "create"
          ? "/api/creator/experiences"
          : `/api/creator/experiences/${experienceId}`;
      const method = mode === "create" ? "POST" : "PATCH";

      const result = await fetchJson<{ id: string }>(url, {
        method,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...form,
          whyVideoSource: form.whyVideoSource || null,
          whyYoutubeUrl:
            form.whyVideoSource === "YOUTUBE" ? form.whyYoutubeUrl.trim() : "",
          whyVideoAssetUrl:
            form.whyVideoSource === "UPLOAD" ? whyVideoAssetUrl : "",
        }),
      });
      detailsSaved = true;

      const targetExperienceId =
        mode === "create" ? result.id : experienceId || result.id;

      if (pendingCoverFile && targetExperienceId) {
        const coverFormData = new FormData();
        coverFormData.append("file", pendingCoverFile);

        const coverResult = await fetchJson<{ fileUrl: string }>(
          `/api/creator/experiences/${targetExperienceId}/cover`,
          {
            method: "POST",
            body: coverFormData,
          },
        );

        setForm((current) => ({
          ...current,
          coverImageUrl: coverResult.fileUrl,
        }));
        setPendingCoverFile(null);
        if (coverPreview) {
          URL.revokeObjectURL(coverPreview);
          setCoverPreview(null);
        }
      }

      setPendingWhyVideoFile(null);

      router.push(
        mode === "create"
          ? `/dashboard/creator/experiences/${result.id}/edit`
          : "/dashboard/creator/experiences",
      );
    } catch (submitError) {
      if (uploadedWhyVideoAssetUrl && !detailsSaved) {
        await deleteUploadedAsset(uploadedWhyVideoAssetUrl);
      }

      setError(
        detailsSaved
          ? getErrorMessage(
              submitError,
              "Experience details were saved, but the media update failed.",
            )
          : getErrorMessage(submitError, "Failed to save experience."),
      );
    } finally {
      setSaving(false);
    }
  }

  async function handleCoverImageSelect(
    event: React.ChangeEvent<HTMLInputElement>,
  ) {
    const file = event.target.files?.[0];

    if (!file || !experienceId) {
      return;
    }

    if (coverPreview) {
      URL.revokeObjectURL(coverPreview);
    }

    setPendingCoverFile(file);
    setCoverPreview(URL.createObjectURL(file));
    setError(null);
    event.target.value = "";
  }

  return (
    <CreatorPageShell
      title={mode === "create" ? "Create Experience" : "Edit Experience"}
      description="Define the public identity of the experience, the slug used in routes, and whether the experience is still a draft or already published."
      actions={
        <Button
          asChild
          variant="outline"
          className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
        >
          <Link href="/dashboard/creator/experiences">Back to experiences</Link>
        </Button>
      }
    >
      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading experience...</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm text-white/70">Title</label>
                <Input
                  value={form.title}
                  onChange={(event) => {
                    const title = event.target.value;
                    setForm((current) => ({
                      ...current,
                      title,
                      slug: slugTouched ? current.slug : slugifyValue(title),
                    }));
                  }}
                  placeholder="Experience title"
                  className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-white/70">Slug</label>
                <Input
                  value={form.slug}
                  onChange={(event) => {
                    setSlugTouched(true);
                    setForm((current) => ({
                      ...current,
                      slug: slugifyValue(event.target.value),
                    }));
                  }}
                  placeholder="experience-slug"
                  className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
                />
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-white/70">Description</label>
              <Textarea
                value={form.description}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    description: event.target.value,
                  }))
                }
                placeholder="Describe the experience"
                className="min-h-[160px] border-white/10 bg-black/20 text-white placeholder:text-white/35"
              />
            </div>

            <div className="space-y-3 rounded-3xl border border-white/10 bg-black/10 p-4">
              <div className="grid gap-5 lg:grid-cols-2">
                <div className="space-y-2">
                  <label className="text-sm text-white/70">
                    WHY video source
                  </label>
                  <select
                    value={form.whyVideoSource}
                    onChange={(event) => {
                      setPendingWhyVideoFile(null);
                      setForm((current) => ({
                        ...current,
                        whyVideoSource: event.target.value as
                          | ""
                          | "YOUTUBE"
                          | "UPLOAD",
                        whyYoutubeUrl:
                          event.target.value === "YOUTUBE"
                            ? current.whyYoutubeUrl
                            : "",
                        whyVideoAssetUrl:
                          event.target.value === "UPLOAD"
                            ? current.whyVideoAssetUrl
                            : "",
                      }));
                    }}
                    className="flex h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
                  >
                    <option value="" className="bg-[#111527]">
                      No WHY video
                    </option>
                    <option value="YOUTUBE" className="bg-[#111527]">
                      YouTube
                    </option>
                    <option value="UPLOAD" className="bg-[#111527]">
                      Upload from device
                    </option>
                  </select>
                </div>
              </div>

              {form.whyVideoSource === "YOUTUBE" ? (
                <div className="space-y-2">
                  <label className="text-sm text-white/70">YouTube URL</label>
                  <Input
                    value={form.whyYoutubeUrl}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        whyYoutubeUrl: event.target.value,
                      }))
                    }
                    className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
                    placeholder="https://www.youtube.com/watch?v=..."
                  />
                </div>
              ) : null}

              {form.whyVideoSource === "UPLOAD" ? (
                <div className="space-y-3">
                  <div className="space-y-2">
                    <label className="text-sm text-white/70">
                      WHY video file
                    </label>
                    <Input
                      type="file"
                      accept=".mp4,.mov,.webm,.m4v,video/mp4,video/quicktime,video/webm,video/x-m4v"
                      onChange={(event) =>
                        setPendingWhyVideoFile(event.target.files?.[0] || null)
                      }
                      className="border-white/10 bg-black/20 text-white file:mr-4 file:rounded-full file:border-0 file:bg-white file:px-4 file:py-2 file:text-black"
                    />
                  </div>

                  <p className="text-sm text-white/55">
                    MP4, MOV, WEBM, M4V up to 250 MB. The file uploads only
                    after you click Save Changes.
                  </p>

                  {pendingWhyVideoFile ? (
                    <p className="text-sm text-white/65">
                      Pending file: {pendingWhyVideoFile.name}
                    </p>
                  ) : null}

                  {form.whyVideoAssetUrl ? (
                    <p className="break-all text-sm text-white/55">
                      Current asset: {form.whyVideoAssetUrl}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm text-white/70">Cover image</label>
                <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/5">
                  <div className="aspect-[16/9] bg-black/25">
                    {coverPreview || form.coverImageUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={coverPreview || form.coverImageUrl}
                          alt={form.title || "Experience cover preview"}
                          className="h-full w-full object-cover"
                        />
                      </>
                    ) : (
                      <div className="flex h-full items-center justify-center text-sm text-white/40">
                        No cover image uploaded
                      </div>
                    )}
                  </div>
                  <div className="space-y-3 border-t border-white/10 p-4">
                    <div className="flex flex-wrap items-center gap-3">
                      <input
                        ref={fileInputRef}
                        type="file"
                        accept=".png,.jpg,.jpeg,.webp"
                        onChange={handleCoverImageSelect}
                        disabled={!experienceId || saving}
                        className="hidden"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!experienceId || saving}
                        onClick={() => fileInputRef.current?.click()}
                        className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                      >
                        {pendingCoverFile ? "Cover selected" : "Upload cover image"}
                      </Button>
                      {!experienceId ? (
                        <p className="text-xs text-white/45">
                          Save the experience first to enable uploads.
                        </p>
                      ) : (
                        <p className="text-xs text-white/45">
                          PNG, JPG, JPEG, WEBP up to 5 MB.
                        </p>
                      )}
                    </div>

                    <Input
                      value={form.coverImageUrl}
                      onChange={(event) => {
                        if (coverPreview) {
                          URL.revokeObjectURL(coverPreview);
                          setCoverPreview(null);
                        }
                        setPendingCoverFile(null);
                        setForm((current) => ({
                          ...current,
                          coverImageUrl: event.target.value,
                        }));
                      }}
                      placeholder="https://..."
                      className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
                    />
                    {pendingCoverFile && (
                      <p className="text-xs text-white/45">
                        Pending file: {pendingCoverFile.name}. Save changes to upload and apply it.
                      </p>
                    )}
                  </div>
                </div>
              </div>

              <div className="space-y-2">
                <label className="text-sm text-white/70">Status</label>
                <select
                  value={form.status}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      status: event.target.value as "DRAFT" | "PUBLISHED",
                    }))
                  }
                  className="flex h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
                >
                  <option value="DRAFT">Draft</option>
                  <option value="PUBLISHED">Published</option>
                </select>
              </div>
            </div>

            {error && <p className="text-sm text-red-300">{error}</p>}

            <Button
              type="submit"
              disabled={
                saving ||
                !form.title.trim() ||
                !form.slug.trim() ||
                (form.whyVideoSource === "YOUTUBE" &&
                  !form.whyYoutubeUrl.trim()) ||
                (form.whyVideoSource === "UPLOAD" &&
                  !form.whyVideoAssetUrl.trim() &&
                  !pendingWhyVideoFile)
              }
              className="rounded-full border border-white bg-white text-black"
            >
              {submitLabel}
            </Button>
          </form>
        )}
      </PageCard>
    </CreatorPageShell>
  );
}
