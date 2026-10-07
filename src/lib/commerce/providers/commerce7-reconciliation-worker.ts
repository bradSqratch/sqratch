import { CommerceProvider } from "@prisma/client";
import { runCatchUpStep } from "./commerce7-order-reconciliation";
import { Commerce7ReconciliationBusyError, type ReconciliationOwner } from "./commerce7-reconciliation-claim";

// One existing bounded chunk per invocation. Candidate selection rotates by
// last attempt, so a failing/busy connection cannot monopolize the worker.
export const COMMERCE7_WORKER_CONNECTION_LIMIT = 1;
export type Commerce7ReconciliationWorkerDeps = {
  listCandidates(limit: number): Promise<ReconciliationOwner[]>;
  catchUp: typeof runCatchUpStep;
};

const defaults: Commerce7ReconciliationWorkerDeps = {
  async listCandidates(limit) {
    const { default: prisma } = await import("@/lib/prisma");
    return (await prisma.commerceConnection.findMany({
      where: {
        provider: CommerceProvider.COMMERCE7, status: "CONNECTED",
        OR: [{ orderReconciliationState: { is: null } }, { orderReconciliationState: { is: { activeRunId: null } } }],
      },
      select: { id: true, brandId: true },
      orderBy: [{ orderReconciliationState: { lastAttemptedAt: { sort: "asc", nulls: "first" } } }, { id: "asc" }],
      take: limit,
    })).map((row) => ({ connectionId: row.id, brandId: row.brandId }));
  },
  catchUp: runCatchUpStep,
};

export async function runCommerce7ReconciliationWorker(overrides: Partial<Commerce7ReconciliationWorkerDeps> = {}) {
  const deps = { ...defaults, ...overrides };
  const candidates = await deps.listCandidates(COMMERCE7_WORKER_CONNECTION_LIMIT);
  const counts = { attempted: 0, progressed: 0, upToDate: 0, busy: 0, failed: 0, ordersFetched: 0, ordersProcessed: 0 };
  for (const owner of candidates.slice(0, COMMERCE7_WORKER_CONNECTION_LIMIT)) {
    counts.attempted++;
    try {
      const result = await deps.catchUp(owner);
      counts.ordersFetched += result.ordersFetched;
      counts.ordersProcessed += result.ordersProcessed;
      if (result.status === "FAILED") counts.failed++;
      else if (result.reachedTarget) counts.upToDate++;
      else counts.progressed++;
    } catch (error) {
      if (error instanceof Commerce7ReconciliationBusyError) counts.busy++;
      else counts.failed++;
    }
  }
  return counts;
}
