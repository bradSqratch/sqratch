"use client";

import { useEffect, useRef, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import {
  deleteUploadedAsset,
  fetchJson,
  getErrorMessage,
} from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

type BrandProfile = {
  id?: string;
  name: string;
  slug: string;
  description: string;
  websiteUrl: string;
  logoUrl: string;
  coverImageUrl: string;
};

function slugifyValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export default function BrandProfilePage() {
  const [form, setForm] = useState<BrandProfile>({
    name: "",
    slug: "",
    description: "",
    websiteUrl: "",
    logoUrl: "",
    coverImageUrl: "",
  });
  const [exists, setExists] = useState(false);
  const [slugTouched, setSlugTouched] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logoInputRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [coverFile, setCoverFile] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const data = await fetchJson<{
          id: string;
          name: string;
          slug: string;
          description: string | null;
          websiteUrl: string | null;
          logoUrl: string | null;
          coverImageUrl: string | null;
        } | null>("/api/brand/profile");

        if (data) {
          setExists(true);
          setSlugTouched(true);
          setForm({
            id: data.id,
            name: data.name,
            slug: data.slug,
            description: data.description || "",
            websiteUrl: data.websiteUrl || "",
            logoUrl: data.logoUrl || "",
            coverImageUrl: data.coverImageUrl || "",
          });
        }
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load brand profile."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, []);

  useEffect(() => {
    return () => {
      if (logoPreview) {
        URL.revokeObjectURL(logoPreview);
      }
      if (coverPreview) {
        URL.revokeObjectURL(coverPreview);
      }
    };
  }, [coverPreview, logoPreview]);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    let uploadedLogoUrl: string | null = null;
    let uploadedCoverUrl: string | null = null;

    try {
      let logoUrl = form.logoUrl;
      let coverImageUrl = form.coverImageUrl;

      if (logoFile) {
        logoUrl = await uploadBrandAsset(logoFile, "logo");
        uploadedLogoUrl = logoUrl;
      }

      if (coverFile) {
        coverImageUrl = await uploadBrandAsset(coverFile, "cover");
        uploadedCoverUrl = coverImageUrl;
      }

      await fetchJson("/api/brand/profile", {
        method: exists ? "PATCH" : "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ...form,
          logoUrl,
          coverImageUrl,
        }),
      });
      setForm((current) => ({
        ...current,
        logoUrl,
        coverImageUrl,
      }));
      setLogoFile(null);
      setCoverFile(null);
      if (logoPreview) {
        URL.revokeObjectURL(logoPreview);
        setLogoPreview(null);
      }
      if (coverPreview) {
        URL.revokeObjectURL(coverPreview);
        setCoverPreview(null);
      }
      setExists(true);
    } catch (submitError) {
      await Promise.allSettled([
        uploadedLogoUrl ? deleteUploadedAsset(uploadedLogoUrl) : Promise.resolve(false),
        uploadedCoverUrl ? deleteUploadedAsset(uploadedCoverUrl) : Promise.resolve(false),
      ]);
      setError(getErrorMessage(submitError, "Failed to save brand profile."));
    } finally {
      setSaving(false);
    }
  }

  async function uploadBrandAsset(
    file: File,
    assetType: "logo" | "cover",
  ) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("assetType", assetType);

    const result = await fetchJson<{ fileUrl: string }>(
      "/api/uploads/brand-asset",
      {
        method: "POST",
        body: formData,
      },
    );

    return result.fileUrl;
  }

  return (
    <BrandPageShell
      title="Brand Profile"
      description="Manage the brand identity used on campaign pages, QR flows, and Shopify connections."
    >
      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading brand profile...</p>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm text-white/70">Brand name</label>
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

            <div className="grid gap-5 lg:grid-cols-2">
              <div className="space-y-2">
                <label className="text-sm text-white/70">Website</label>
                <Input
                  value={form.websiteUrl}
                  onChange={(event) =>
                    setForm((current) => ({
                      ...current,
                      websiteUrl: event.target.value,
                    }))
                  }
                  className="border-white/10 bg-black/20 text-white"
                />
              </div>
              <div className="space-y-2">
                <label className="text-sm text-white/70">Logo</label>
                <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
                  <div className="flex h-28 items-center justify-center bg-black/25">
                    {logoPreview || form.logoUrl ? (
                      <>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img
                          src={logoPreview || form.logoUrl}
                          alt={`${form.name || "Brand"} logo`}
                          className="h-16 w-16 rounded-full object-cover"
                        />
                      </>
                    ) : (
                      <span className="text-xs text-white/45">No logo</span>
                    )}
                  </div>
                  <div className="space-y-3 border-t border-white/10 p-4">
                    <input
                      ref={logoInputRef}
                      type="file"
                      accept=".png,.jpg,.jpeg,.webp"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        setLogoFile(file);
                        if (logoPreview) {
                          URL.revokeObjectURL(logoPreview);
                        }
                        setLogoPreview(URL.createObjectURL(file));
                        event.target.value = "";
                      }}
                      disabled={saving}
                      className="hidden"
                    />
                    <div className="flex flex-wrap items-center gap-3">
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => logoInputRef.current?.click()}
                        disabled={saving}
                        className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                      >
                        {logoFile ? "Logo selected" : "Upload logo"}
                      </Button>
                      <p className="text-xs text-white/45">
                        PNG, JPG, JPEG, WEBP up to 5 MB.
                      </p>
                    </div>
                    <Input
                      value={form.logoUrl}
                      onChange={(event) => {
                        if (logoPreview) {
                          URL.revokeObjectURL(logoPreview);
                          setLogoPreview(null);
                        }
                        setLogoFile(null);
                        setForm((current) => ({
                          ...current,
                          logoUrl: event.target.value,
                        }));
                      }}
                      className="border-white/10 bg-black/20 text-white"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <label className="text-sm text-white/70">Cover image</label>
              <div className="overflow-hidden rounded-2xl border border-white/10 bg-white/5">
                <div className="aspect-[16/6] bg-black/25">
                  {coverPreview || form.coverImageUrl ? (
                    <>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={coverPreview || form.coverImageUrl}
                        alt={`${form.name || "Brand"} cover`}
                        className="h-full w-full object-cover"
                      />
                    </>
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-white/45">
                      No cover image
                    </div>
                  )}
                </div>
                <div className="space-y-3 border-t border-white/10 p-4">
                  <input
                    ref={coverInputRef}
                    type="file"
                    accept=".png,.jpg,.jpeg,.webp"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (!file) return;
                      setCoverFile(file);
                      if (coverPreview) {
                        URL.revokeObjectURL(coverPreview);
                      }
                      setCoverPreview(URL.createObjectURL(file));
                      event.target.value = "";
                    }}
                    disabled={saving}
                    className="hidden"
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => coverInputRef.current?.click()}
                      disabled={saving}
                      className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                    >
                      {coverFile ? "Cover selected" : "Upload cover"}
                    </Button>
                    <p className="text-xs text-white/45">
                      PNG, JPG, JPEG, WEBP up to 5 MB.
                    </p>
                  </div>
                  <Input
                    value={form.coverImageUrl}
                    onChange={(event) => {
                      if (coverPreview) {
                        URL.revokeObjectURL(coverPreview);
                        setCoverPreview(null);
                      }
                      setCoverFile(null);
                      setForm((current) => ({
                        ...current,
                        coverImageUrl: event.target.value,
                      }));
                    }}
                    className="border-white/10 bg-black/20 text-white"
                  />
                </div>
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
                className="min-h-[160px] border-white/10 bg-black/20 text-white"
              />
            </div>

            {error && <p className="text-sm text-red-300">{error}</p>}

            <Button
              type="submit"
              disabled={saving || !form.name.trim() || !form.slug.trim()}
              className="rounded-full border border-white bg-white text-black"
            >
              {saving ? "Saving..." : exists ? "Save profile" : "Create profile"}
            </Button>
          </form>
        )}
      </PageCard>
    </BrandPageShell>
  );
}
