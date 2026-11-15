"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useBrandFetch } from "@/components/brand/brand-fetch";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type CampaignOption = {
  id: string;
  name: string;
  slug: string;
};

type Batch = {
  id: string;
  name: string;
  createdAt: string;
  quantity: number;
  canDelete: boolean;
  archivedAt?: string | null;
  campaign: {
    id: string;
    name: string;
    slug: string;
  } | null;
};

type QRCodeRow = {
  id: string;
  code: string;
  status: "NEW" | "REDEEMED";
  imageUrl: string | null;
  usedAt: string | null;
  createdAt: string;
  usedBy: string | null;
  usedByEmail: string | null;
  batch: {
    id: string;
    name: string;
  } | null;
  campaign: {
    id: string;
    name: string;
    slug: string;
  };
};

type QRBatchPageData = {
  batches: Batch[];
  campaigns: CampaignOption[];
  qrCodes: QRCodeRow[];
};

type ArchivedView = "exclude" | "only" | "include";

const ARCHIVED_VIEW_LABELS: Record<ArchivedView, string> = {
  exclude: "Active batches",
  only: "Archived batches",
  include: "All batches",
};

type EditQRForm = {
  id: string;
  code: string;
  status: "NEW" | "REDEEMED";
  imageUrl: string | null;
  usedAt: string | null;
  usedBy: string | null;
  usedByEmail: string | null;
  campaignId: string;
};

function formatDateTime(value: string | null) {
  if (!value) {
    return "—";
  }

  return new Date(value).toLocaleString(undefined, {
    month: "numeric",
    day: "numeric",
    year: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function BrandQRBatchesPage() {
  const brandFetch = useBrandFetch();
  const [data, setData] = useState<QRBatchPageData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState("all");
  const [selectedBatchId, setSelectedBatchId] = useState("all");
  const [editForm, setEditForm] = useState<EditQRForm | null>(null);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [deletingBatchId, setDeletingBatchId] = useState<string | null>(null);
  const [archivingBatchId, setArchivingBatchId] = useState<string | null>(null);
  const [archivedView, setArchivedView] = useState<ArchivedView>("exclude");
  const listUrl = `/api/brand/qr-batches?archived=${archivedView}`;

  useEffect(() => {
    // Switching views quickly must never let a slow earlier response replace
    // the current view's rows: a response is applied only while its effect
    // is still the latest.
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);

      try {
        const response = await fetchJson<QRBatchPageData>(listUrl);
        if (!cancelled) setData(response);
      } catch (loadError) {
        if (!cancelled) setError(getErrorMessage(loadError, "Failed to load QR batches."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [listUrl]);

  const visibleBatches = useMemo(() => {
    const batches = data?.batches || [];

    if (selectedCampaignId === "all") {
      return batches;
    }

    return batches.filter((batch) => batch.campaign?.id === selectedCampaignId);
  }, [data?.batches, selectedCampaignId]);

  const visibleQrCodes = useMemo(() => {
    const qrCodes = data?.qrCodes || [];

    return qrCodes.filter((qrCode) => {
      if (
        selectedCampaignId !== "all" &&
        qrCode.campaign.id !== selectedCampaignId
      ) {
        return false;
      }

      if (selectedBatchId !== "all" && qrCode.batch?.id !== selectedBatchId) {
        return false;
      }

      return true;
    });
  }, [data?.qrCodes, selectedBatchId, selectedCampaignId]);

  const batchOptions = useMemo(() => {
    const batches = data?.batches || [];

    return batches.filter((batch) =>
      selectedCampaignId === "all"
        ? true
        : batch.campaign?.id === selectedCampaignId,
    );
  }, [data?.batches, selectedCampaignId]);

  async function reloadData() {
    try {
      const response = await fetchJson<QRBatchPageData>(listUrl);
      setData(response);
    } catch (loadError) {
      setActionError(getErrorMessage(loadError, "Failed to refresh QR batches."));
    }
  }

  async function handleSaveQrCode() {
    if (!editForm) {
      return;
    }

    setSavingId(editForm.id);
    setActionError(null);

    try {
      await brandFetch(`/api/brand/qr-codes/${editForm.id}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          campaignId: editForm.campaignId,
        }),
      });
      setEditForm(null);
      await reloadData();
    } catch (saveError) {
      await reloadData();
      setActionError(getErrorMessage(saveError, "Failed to update QR code."));
    } finally {
      setSavingId(null);
    }
  }

  async function handleDeleteQrCode(qrCodeId: string) {
    const confirmed = window.confirm(
      "Are you sure you want to delete this QR code?",
    );

    if (!confirmed) {
      return;
    }

    setSavingId(qrCodeId);
    setActionError(null);

    try {
      await brandFetch(`/api/brand/qr-codes/${qrCodeId}`, {
        method: "DELETE",
      });
      if (editForm?.id === qrCodeId) {
        setEditForm(null);
      }
      await reloadData();
    } catch (deleteError) {
      await reloadData();
      setActionError(getErrorMessage(deleteError, "Failed to delete QR code."));
    } finally {
      setSavingId(null);
    }
  }

  async function handleSetArchived(batchId: string, archive: boolean) {
    setArchivingBatchId(batchId);
    setActionError(null);

    try {
      await brandFetch(`/api/brand/qr-batches/${batchId}/${archive ? "archive" : "unarchive"}`, {
        method: "POST",
      });
      if (selectedBatchId === batchId && archivedView !== "include") {
        setSelectedBatchId("all");
      }
      await reloadData();
    } catch (archiveError) {
      await reloadData();
      setActionError(
        getErrorMessage(archiveError, archive ? "Failed to archive batch." : "Failed to restore batch."),
      );
    } finally {
      setArchivingBatchId(null);
    }
  }

  async function handleDeleteBatch(batchId: string) {
    const confirmed = window.confirm(
      "Are you sure you want to delete this batch and all QR codes in it?",
    );

    if (!confirmed) {
      return;
    }

    setDeletingBatchId(batchId);
    setActionError(null);

    try {
      await brandFetch(`/api/brand/qr-batches/${batchId}`, {
        method: "DELETE",
      });

      if (selectedBatchId === batchId) {
        setSelectedBatchId("all");
      }

      setData((current) => current ? { ...current,
        batches: current.batches.filter((batch) => batch.id !== batchId),
        qrCodes: current.qrCodes.filter((code) => code.batch?.id !== batchId),
      } : current);
    } catch (deleteError) {
      await reloadData();
      setActionError(getErrorMessage(deleteError, "Failed to delete batch."));
    } finally {
      setDeletingBatchId(null);
    }
  }

  return (
    <BrandPageShell
      title="QR Batches"
      description="Track generated batches and review the QR codes created for each campaign."
      actions={
        <Button
          asChild
          className="rounded-full border border-edge bg-primary text-primary-foreground"
        >
          <Link href="/dashboard/brand/qr-batches/new">Create new batch</Link>
        </Button>
      }
    >
      {loading ? (
        <PageCard>
          <p className="text-sm text-copy-65">Loading QR batches...</p>
        </PageCard>
      ) : error ? (
        <PageCard>
          <p className="text-sm text-red-700 dark:text-red-300">{error}</p>
        </PageCard>
      ) : !data ? (
        <PageCard>
          <p className="text-sm text-copy-65">No QR data found.</p>
        </PageCard>
      ) : (
        <div className="space-y-6">
          {actionError && !editForm && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{actionError}</p>}
          <PageCard>
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-copy-60">
                Archiving only hides a batch from this list. Its printed QR links, scans, rewards and exports keep working.
              </p>
              <label className="flex items-center gap-3 text-sm text-copy-70">
                <span>Show</span>
                <select
                  value={archivedView}
                  onChange={(event) => {
                    setArchivedView(event.target.value as ArchivedView);
                    setSelectedBatchId("all");
                  }}
                  className="h-10 min-w-[180px] rounded-xl border border-edge/10 bg-inset/20 px-3 text-sm text-ink"
                >
                  {(Object.keys(ARCHIVED_VIEW_LABELS) as ArchivedView[]).map((view) => (
                    <option key={view} value={view}>
                      {ARCHIVED_VIEW_LABELS[view]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="text-copy-55">
                  <tr>
                    <th className="pb-3">Batch</th>
                    <th className="pb-3">Campaign</th>
                    <th className="pb-3">Created</th>
                    <th className="pb-3">Qty</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge/10">
                  {visibleBatches.map((batch) => (
                    <tr
                      key={batch.id}
                      className="cursor-pointer transition hover:bg-white/[0.03]"
                      onClick={() => setSelectedBatchId(batch.id)}
                    >
                      <td className="py-3">
                        {batch.name}
                        {batch.archivedAt ? (
                          <span className="ml-2 rounded-full border border-edge/20 px-2 py-0.5 text-xs text-copy-65">
                            Archived
                          </span>
                        ) : null}
                      </td>
                      <td className="py-3">{batch.campaign?.name || "Unknown"}</td>
                      <td className="py-3">{formatDateTime(batch.createdAt)}</td>
                      <td className="py-3">{batch.quantity}</td>
                      <td className="py-3">
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="h-8 rounded-xl border-edge/20 bg-glass-10 px-4 text-ink hover:bg-glass-20"
                            onClick={(event) => {
                              event.stopPropagation();
                              window.location.href = `/api/brand/qr-batches/${batch.id}/export`;
                            }}
                          >
                            Export CSV
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            disabled={archivingBatchId === batch.id}
                            className="h-8 rounded-xl border-edge/20 bg-glass-10 px-4 text-ink hover:bg-glass-20"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleSetArchived(batch.id, !batch.archivedAt);
                            }}
                          >
                            {archivingBatchId === batch.id
                              ? "Saving..."
                              : batch.archivedAt
                                ? "Unarchive"
                                : "Archive"}
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            disabled={!batch.canDelete || deletingBatchId === batch.id}
                            aria-describedby={!batch.canDelete ? `batch-delete-reason-${batch.id}` : undefined}
                            className="h-8 rounded-xl bg-[#C85A63] px-5 text-white hover:bg-[#b94b54]"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeleteBatch(batch.id);
                            }}
                          >
                            {deletingBatchId === batch.id
                              ? "Deleting..."
                              : "Delete Batch"}
                          </Button>
                        </div>
                        {!batch.canDelete && <p id={`batch-delete-reason-${batch.id}`} className="mt-1 text-xs text-copy-65">Cannot delete — QR codes have already been used or distributed. Archive this batch to hide it from the list; its printed links keep working.</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {visibleBatches.length === 0 && (
                <p className="pt-4 text-sm text-copy-60">
                  {archivedView === "only"
                    ? "No archived batches."
                    : "No batches match the selected filters."}
                </p>
              )}
            </div>
          </PageCard>

          <PageCard>
            <div className="flex flex-col gap-4 border-b border-edge/10 pb-5 lg:flex-row lg:items-center lg:justify-between">
              <div className="space-y-1">
                <h2 className="text-2xl font-semibold">QR Code List</h2>
                <p className="text-sm text-copy-60">
                  Filter QR codes by campaign or batch and review their current
                  redemption status.
                </p>
              </div>

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                <label className="flex items-center gap-3 text-sm text-copy-70">
                  <span>Campaign</span>
                  <select
                    value={selectedCampaignId}
                    onChange={(event) => {
                      setSelectedCampaignId(event.target.value);
                      setSelectedBatchId("all");
                    }}
                    className="h-10 min-w-[220px] rounded-xl border border-edge/10 bg-inset/20 px-3 text-sm text-ink"
                  >
                    <option value="all">All campaigns</option>
                    {data.campaigns.map((campaign) => (
                      <option key={campaign.id} value={campaign.id}>
                        {campaign.name}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex items-center gap-3 text-sm text-copy-70">
                  <span>Batch</span>
                  <select
                    value={selectedBatchId}
                    onChange={(event) => setSelectedBatchId(event.target.value)}
                    className="h-10 min-w-[220px] rounded-xl border border-edge/10 bg-inset/20 px-3 text-sm text-ink"
                  >
                    <option value="all">All batches</option>
                    {batchOptions.map((batch) => (
                      <option key={batch.id} value={batch.id}>
                        {batch.name}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>

            <div className="mt-6 overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="text-copy-55">
                  <tr>
                    <th className="pb-3">Code</th>
                    <th className="pb-3">Batch</th>
                    <th className="pb-3">Campaign</th>
                    <th className="pb-3">Status</th>
                    <th className="pb-3">Used By</th>
                    <th className="pb-3">Used At</th>
                    <th className="pb-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-edge/10">
                  {visibleQrCodes.map((qrCode) => (
                    <tr key={qrCode.id}>
                      <td className="py-3 font-medium text-copy-90">
                        {qrCode.code}
                      </td>
                      <td className="py-3">{qrCode.batch?.name || "—"}</td>
                      <td className="py-3">{qrCode.campaign.name}</td>
                      <td className="py-3">{qrCode.status}</td>
                      <td className="py-3">{qrCode.usedBy || "—"}</td>
                      <td className="py-3">{formatDateTime(qrCode.usedAt)}</td>
                      <td className="py-3">
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="h-8 rounded-xl border-[#35507D] bg-transparent px-5 text-ink hover:bg-white/[0.06] hover:text-ink"
                            onClick={() =>
                              setEditForm({
                                id: qrCode.id,
                                code: qrCode.code,
                                status: qrCode.status,
                                imageUrl: qrCode.imageUrl,
                                usedAt: qrCode.usedAt,
                                usedBy: qrCode.usedBy,
                                usedByEmail: qrCode.usedByEmail,
                                campaignId: qrCode.campaign.id,
                              })
                            }
                          >
                            Edit
                          </Button>
                          <Button
                            type="button"
                            variant="destructive"
                            disabled={savingId === qrCode.id}
                            className="h-8 rounded-xl bg-[#C85A63] px-5 text-white hover:bg-[#b94b54]"
                            onClick={() => void handleDeleteQrCode(qrCode.id)}
                          >
                            {savingId === qrCode.id ? "Deleting..." : "Delete"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              {visibleQrCodes.length === 0 && (
                <p className="pt-4 text-sm text-copy-60">
                  No QR codes match the selected filters.
                </p>
              )}
            </div>
          </PageCard>
        </div>
      )}

      <Dialog
        open={Boolean(editForm)}
        onOpenChange={(open) => !open && setEditForm(null)}
      >
        <DialogContent className="border-edge/10 bg-card dark:bg-[#050814] text-ink sm:max-w-[520px]">
          <DialogHeader>
            <DialogTitle className="text-3xl font-semibold">
              Edit QR Code
            </DialogTitle>
            <DialogDescription className="text-copy-60">
              Update the QR code details.
            </DialogDescription>
          </DialogHeader>

          {actionError && <p role="alert" className="text-sm text-red-700 dark:text-red-300">{actionError}</p>}
          {editForm && (
            <div className="space-y-4">
              <div className="flex justify-center">
                {editForm.imageUrl ? (
                  <div className="rounded-xl bg-white p-3 shadow-[0_10px_30px_rgba(255,255,255,0.08)]">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={editForm.imageUrl}
                      alt={editForm.code}
                      className="h-40 w-40 rounded-md bg-white object-contain"
                    />
                  </div>
                ) : (
                  <div className="flex h-40 w-40 items-center justify-center rounded-md border border-edge/10 bg-white text-sm text-black/55">
                    No image
                  </div>
                )}
              </div>

              <div className="space-y-2">
                <label className="text-sm text-copy-80">QR Code</label>
                <Input
                  value={editForm.code}
                  disabled
                  className="border-edge/10 bg-inset/20 text-ink"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-copy-80">Status</label>
                <Input value={editForm.status} disabled className="border-edge/10 bg-inset/20 text-ink" />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-copy-80">Used By</label>
                <Input
                  value={editForm.usedBy || "Not applicable"}
                  disabled
                  className="border-edge/10 bg-inset/20 text-ink"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-copy-80">Used At</label>
                <Input
                  value={editForm.usedAt ? formatDateTime(editForm.usedAt) : "—"}
                  disabled
                  className="border-edge/10 bg-inset/20 text-ink"
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm text-copy-80">Campaign</label>
                <select
                  value={editForm.campaignId}
                  onChange={(event) =>
                    setEditForm((current) =>
                      current
                        ? {
                            ...current,
                            campaignId: event.target.value,
                          }
                        : current,
                    )
                  }
                  className="flex h-10 w-full rounded-md border border-edge/10 bg-inset/20 px-3 text-sm text-ink"
                >
                  {data?.campaigns.map((campaign) => (
                    <option key={campaign.id} value={campaign.id}>
                      {campaign.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              disabled={!editForm || savingId === editForm.id}
              className="w-full rounded-xl border border-edge bg-primary text-primary-foreground"
              onClick={() => void handleSaveQrCode()}
            >
              {editForm && savingId === editForm.id
                ? "Saving..."
                : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </BrandPageShell>
  );
}
