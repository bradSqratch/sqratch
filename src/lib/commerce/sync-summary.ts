import type { CommerceProductSyncRunStatus } from "@prisma/client";
import prisma from "@/lib/prisma";

/**
 * What a brand sees as "last completed sync" and "last attempt".
 *
 * Both come from `CommerceProductSyncRun`, which is written only by the real
 * persisted catalog sync. `CommerceConnection.lastProductSyncAt` is not used
 * for display: it is stamped by several paths, and a read-only product preview
 * used to stamp it too, so it can be later than the last real sync.
 *
 * "Completed" means a run that finished with status SUCCEEDED. A PARTIAL run
 * (timed out or hit a page limit) and a FAILED run are attempts, not
 * completions. A RUNNING run is shown as an attempt in progress.
 */
export type SyncAttemptSummary = {
  status: CommerceProductSyncRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
};

export type SyncSummary = {
  lastCompletedSyncAt: Date | null;
  lastAttempt: SyncAttemptSummary | null;
};

export const EMPTY_SYNC_SUMMARY: SyncSummary = { lastCompletedSyncAt: null, lastAttempt: null };

type Db = Pick<typeof prisma, "commerceProductSyncRun">;

export async function loadSyncSummaries(
  brandId: string,
  connectionIds: string[],
  db: Db = prisma,
): Promise<Map<string, SyncSummary>> {
  const result = new Map<string, SyncSummary>(connectionIds.map((id) => [id, { ...EMPTY_SYNC_SUMMARY }]));
  if (connectionIds.length === 0) return result;

  // One indexed lookup per connection (index on connectionId, startedAt) rather
  // than a `distinct` scan that could read a connection's whole run history.
  await Promise.all(
    connectionIds.map(async (connectionId) => {
      const where = { brandId, connectionId };
      const [attempt, completion] = await Promise.all([
        db.commerceProductSyncRun.findFirst({
          where,
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          select: { status: true, startedAt: true, finishedAt: true },
        }),
        db.commerceProductSyncRun.findFirst({
          where: { ...where, status: "SUCCEEDED" },
          orderBy: [{ startedAt: "desc" }, { id: "desc" }],
          select: { startedAt: true, finishedAt: true },
        }),
      ]);
      const summary = result.get(connectionId)!;
      if (attempt) summary.lastAttempt = { status: attempt.status, startedAt: attempt.startedAt, finishedAt: attempt.finishedAt };
      if (completion) summary.lastCompletedSyncAt = completion.finishedAt ?? completion.startedAt;
    }),
  );
  return result;
}

export function serializeSyncSummary(summary: SyncSummary | undefined) {
  const value = summary ?? EMPTY_SYNC_SUMMARY;
  return {
    lastCompletedSyncAt: value.lastCompletedSyncAt,
    lastSyncAttempt: value.lastAttempt
      ? {
          status: value.lastAttempt.status,
          startedAt: value.lastAttempt.startedAt,
          finishedAt: value.lastAttempt.finishedAt,
        }
      : null,
  };
}
