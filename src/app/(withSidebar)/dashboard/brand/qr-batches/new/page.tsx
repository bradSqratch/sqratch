"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type CampaignOption = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
  qrBatchesCount: number;
  experiencesCount: number;
};

export default function BrandNewQRBatchPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<CampaignOption[]>([]);
  const [campaignId, setCampaignId] = useState("");
  const [quantity, setQuantity] = useState(100);
  const [batchName, setBatchName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    async function loadCampaigns() {
      try {
        const data = await fetchJson<CampaignOption[]>("/api/brand/campaigns");
        setCampaigns(data);
        if (data[0]) {
          setCampaignId(data[0].id);
        }
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load campaigns."));
      }
    }

    void loadCampaigns();
  }, []);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    try {
      await fetchJson<{
        batch: {
          id: string;
          name: string;
          quantity: number;
        };
      }>("/api/brand/qr-batches", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          campaignId,
          quantity,
          batchName,
        }),
      });

      router.push("/dashboard/brand/qr-batches");
    } catch (submitError) {
      setError(getErrorMessage(submitError, "Failed to generate QR batch."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <BrandPageShell
      title="Create QR Batch"
      description="Generate a new QR batch for a campaign, store QR images in cloud storage, and register every code in the database."
    >
      <PageCard>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <label className="text-sm text-white/70">Campaign</label>
            <select
              value={campaignId}
              onChange={(event) => setCampaignId(event.target.value)}
              className="flex h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
            >
              {campaigns.map((campaign) => (
                <option key={campaign.id} value={campaign.id}>
                  {campaign.name}
                </option>
              ))}
            </select>
          </div>

          <div className="grid gap-5 lg:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm text-white/70">Quantity</label>
              <Input
                type="number"
                min={1}
                max={5000}
                value={quantity}
                onChange={(event) => setQuantity(Number(event.target.value || 0))}
                className="border-white/10 bg-black/20 text-white"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm text-white/70">Batch name</label>
              <Input
                value={batchName}
                onChange={(event) => setBatchName(event.target.value)}
                className="border-white/10 bg-black/20 text-white"
              />
            </div>
          </div>

          {error && <p className="text-sm text-red-300">{error}</p>}

          <Button
            type="submit"
            disabled={saving || !campaignId || quantity <= 0}
            className="rounded-full border border-white bg-white text-black"
          >
            {saving ? "Generating..." : "Generate batch"}
          </Button>
        </form>
      </PageCard>
    </BrandPageShell>
  );
}
