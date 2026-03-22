"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
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
};

function slugifyValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
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
  });
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
        }>(`/api/brand/campaigns/${campaignId}`);

        setForm({
          name: data.name,
          slug: data.slug,
          description: data.description || "",
          isActive: data.isActive,
        });
        setSlugTouched(true);
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

    try {
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
        body: JSON.stringify(form),
      });

      router.push(
        mode === "create"
          ? "/dashboard/brand/campaigns"
          : "/dashboard/brand/campaigns",
      );
    } catch (submitError) {
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
              disabled={saving || !form.name.trim() || !form.slug.trim()}
              className="rounded-full border border-white bg-white text-black"
            >
              {submitLabel}
            </Button>
          </form>
        )}
      </PageCard>
    </BrandPageShell>
  );
}
