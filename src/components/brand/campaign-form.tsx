"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import {
  deleteUploadedAsset,
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";
import { BrandPageShell } from "@/components/brand/page-shell";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type CampaignForm = {
  name: string;
  slug: string;
  description: string;
  isActive: boolean;
  whyVideoSource: "" | "YOUTUBE" | "UPLOAD";
  whyYoutubeUrl: string;
  whyVideoAssetUrl: string;
};

function slugifyValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function uploadCampaignVideoDirect(options: {
  file: File;
  campaignSlug: string;
  campaignId?: string;
}) {
  const signResponse = await fetch("/api/uploads/campaign-video", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    credentials: "include",
    body: JSON.stringify({
      fileName: options.file.name,
      fileType: options.file.type,
      fileSize: options.file.size,
      campaignSlug: options.campaignSlug,
      campaignId: options.campaignId,
    }),
  });

  const signJson = await signResponse.json().catch(() => null);

  if (!signResponse.ok) {
    throw new Error(signJson?.error || "Failed to prepare campaign video upload.");
  }

  const signedUrl = String(signJson?.data?.signedUrl || "");
  const fileUrl = String(signJson?.data?.fileUrl || "");

  if (!signedUrl || !fileUrl) {
    throw new Error("Failed to prepare campaign video upload.");
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
        "Failed to upload campaign video.",
    );
  }

  return fileUrl;
}

export function BrandCampaignForm({
  mode,
  campaignId,
}: {
  mode: "create" | "edit";
  campaignId?: string;
}) {
  const router = useRouter();
  const [form, setForm] = useState<CampaignForm>({
    name: "",
    slug: "",
    description: "",
    isActive: true,
    whyVideoSource: "",
    whyYoutubeUrl: "",
    whyVideoAssetUrl: "",
  });
  const [pendingVideoFile, setPendingVideoFile] = useState<File | null>(null);
  const [slugTouched, setSlugTouched] = useState(false);
  const [loading, setLoading] = useState(mode === "edit");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "edit" || !campaignId) {
      return;
    }

    async function load() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<{
          id: string;
          name: string;
          slug: string;
          description: string | null;
          isActive: boolean;
          whyVideoSource: "YOUTUBE" | "UPLOAD" | null;
          whyYoutubeUrl: string | null;
          whyVideoUploadUrl: string | null;
        }>(`/api/brand/campaigns/${campaignId}`);

        setForm({
          name: data.name,
          slug: data.slug,
          description: data.description || "",
          isActive: data.isActive,
          whyVideoSource: data.whyVideoSource || "",
          whyYoutubeUrl: data.whyYoutubeUrl || "",
          whyVideoAssetUrl: data.whyVideoUploadUrl || "",
        });
        setSlugTouched(data.slug !== slugifyValue(data.name));
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load campaign."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [campaignId, mode]);

  const submitLabel = useMemo(
    () =>
      saving
        ? mode === "create"
          ? "Creating..."
          : "Saving..."
        : mode === "create"
          ? "Create Campaign"
          : "Save Changes",
    [mode, saving],
  );

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    let whyVideoAssetUrl = form.whyVideoAssetUrl.trim();
    let uploadedWhyVideoAssetUrl: string | null = null;

    try {
      if (form.whyVideoSource === "YOUTUBE" && !form.whyYoutubeUrl.trim()) {
        throw new Error("A YouTube URL is required for campaign videos.");
      }

      if (form.whyVideoSource === "UPLOAD") {
        if (pendingVideoFile) {
          whyVideoAssetUrl = await uploadCampaignVideoDirect({
            file: pendingVideoFile,
            campaignSlug: form.slug,
            campaignId,
          });
          uploadedWhyVideoAssetUrl = whyVideoAssetUrl;
        }

        if (!whyVideoAssetUrl) {
          throw new Error("An uploaded campaign video file is required.");
        }
      }

      const url =
        mode === "create"
          ? "/api/brand/campaigns"
          : `/api/brand/campaigns/${campaignId}`;
      const method = mode === "create" ? "POST" : "PATCH";

      await fetchJson<{ id: string }>(url, {
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

      setPendingVideoFile(null);

      router.push(
        mode === "create"
          ? "/dashboard/brand/campaigns"
          : "/dashboard/brand/campaigns",
      );
    } catch (submitError) {
      if (uploadedWhyVideoAssetUrl) {
        await deleteUploadedAsset(uploadedWhyVideoAssetUrl);
      }

      setError(getErrorMessage(submitError, "Failed to save campaign."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <BrandPageShell
      title={mode === "create" ? "Create Campaign" : "Edit Campaign"}
      description="Set the campaign identity used by public links, brand reporting, and QR batches."
      actions={
        <Button
          asChild
          variant="outline"
          className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
        >
          <Link href="/dashboard/brand/campaigns">Back to campaigns</Link>
        </Button>
      }
    >
      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading campaign...</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm text-white/70">Name</label>
                <Input
                  value={form.name}
                  onChange={(event) => {
                    const name = event.target.value;
                    setForm((current) => ({
                      ...current,
                      name,
                      slug: slugTouched ? current.slug : slugifyValue(name),
                    }));
                  }}
                  className="border-white/10 bg-black/20 text-white"
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
                  className="border-white/10 bg-black/20 text-white"
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
                className="min-h-[150px] border-white/10 bg-black/20 text-white"
              />
            </div>

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm text-white/70">Campaign video source</label>
                <select
                  value={form.whyVideoSource}
                  onChange={(event) => {
                    setPendingVideoFile(null);
                    return (
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
                    }))
                    );
                  }}
                  className="flex h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white outline-none"
                >
                  <option value="" disabled className="bg-[#111527]">
                    Select source
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
                  className="border-white/10 bg-black/20 text-white"
                  placeholder="https://www.youtube.com/watch?v=..."
                />
              </div>
            ) : null}

            {form.whyVideoSource === "UPLOAD" ? (
              <div className="space-y-3">
                <div className="space-y-2">
                  <label className="text-sm text-white/70">Campaign video file</label>
                  <Input
                    type="file"
                    accept=".mp4,.mov,.webm,.m4v,video/mp4,video/quicktime,video/webm,video/x-m4v"
                    onChange={(event) =>
                      setPendingVideoFile(event.target.files?.[0] || null)
                    }
                    className="border-white/10 bg-black/20 text-white file:mr-4 file:rounded-full file:border-0 file:bg-white file:px-4 file:py-2 file:text-black"
                  />
                </div>

                <p className="text-sm text-white/55">
                  MP4, MOV, WEBM, M4V up to 250 MB. The file uploads only after
                  you click Save Changes.
                </p>

                {pendingVideoFile ? (
                  <p className="text-sm text-white/65">
                    Pending file: {pendingVideoFile.name}
                  </p>
                ) : null}

                {form.whyVideoAssetUrl ? (
                  <p className="text-sm text-white/55">
                    Current asset: {form.whyVideoAssetUrl}
                  </p>
                ) : null}
              </div>
            ) : null}

            <label className="flex items-center gap-3 text-sm text-white/70">
              <input
                type="checkbox"
                checked={form.isActive}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    isActive: event.target.checked,
                  }))
                }
              />
              Campaign is active
            </label>

            {error && <p className="text-sm text-red-300">{error}</p>}

            <Button
              type="submit"
              disabled={
                saving ||
                !form.name.trim() ||
                !form.slug.trim() ||
                (mode === "create" && !form.whyVideoSource) ||
                (form.whyVideoSource === "YOUTUBE" &&
                  !form.whyYoutubeUrl.trim()) ||
                (form.whyVideoSource === "UPLOAD" &&
                  !form.whyVideoAssetUrl.trim() &&
                  !pendingVideoFile)
              }
              className="rounded-full border border-white bg-white text-black"
            >
              {saving ? (
                <span className="flex items-center gap-2">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
                  {submitLabel}
                </span>
              ) : (
                submitLabel
              )}
            </Button>
          </form>
        )}
      </PageCard>
    </BrandPageShell>
  );
}
