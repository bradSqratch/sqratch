"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
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
    status: "DRAFT",
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

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
          status: "DRAFT" | "PUBLISHED";
        }>(`/api/creator/experiences/${experienceId}`);

        setForm({
          title: data.title,
          slug: data.slug,
          description: data.description || "",
          coverImageUrl: data.coverImageUrl || "",
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

    try {
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
        body: JSON.stringify(form),
      });

      router.push(
        mode === "create"
          ? `/dashboard/creator/experiences/${result.id}/edit`
          : "/dashboard/creator/experiences",
      );
    } catch (submitError) {
      setError(getErrorMessage(submitError, "Failed to save experience."));
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

    setUploading(true);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("experienceId", experienceId);

      const result = await fetchJson<{ fileUrl: string }>(
        "/api/uploads/experience-cover",
        {
          method: "POST",
          body: formData,
        },
      );

      setForm((current) => ({
        ...current,
        coverImageUrl: result.fileUrl,
      }));
    } catch (uploadError) {
      setError(getErrorMessage(uploadError, "Failed to upload cover image."));
    } finally {
      event.target.value = "";
      setUploading(false);
    }
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

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm text-white/70">Cover image</label>
                <div className="overflow-hidden rounded-3xl border border-white/10 bg-white/5">
                  <div className="aspect-[16/9] bg-black/25">
                    {form.coverImageUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={form.coverImageUrl}
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
                        disabled={!experienceId || uploading}
                        className="hidden"
                      />
                      <Button
                        type="button"
                        variant="outline"
                        disabled={!experienceId || uploading}
                        onClick={() => fileInputRef.current?.click()}
                        className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                      >
                        {uploading ? "Uploading..." : "Upload cover image"}
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
                      onChange={(event) =>
                        setForm((current) => ({
                          ...current,
                          coverImageUrl: event.target.value,
                        }))
                      }
                      placeholder="https://..."
                      className="border-white/10 bg-black/20 text-white placeholder:text-white/35"
                    />
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
                saving || !form.title.trim() || !form.slug.trim()
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
