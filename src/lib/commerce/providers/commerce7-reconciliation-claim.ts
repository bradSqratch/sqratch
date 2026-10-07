import { randomUUID } from "node:crypto";
import { CommerceProvider } from "@prisma/client";
import { lockCommerceConnectionForTransaction } from "../connection-row-lock";
import { CommerceConnectionNotFoundError, CommerceConnectionNotReadyError, CommerceConnectionMismatchError } from "../errors";

export class Commerce7ReconciliationBusyError extends Error {
  readonly code = "RECONCILIATION_BUSY";
  constructor() { super("Reconciliation is already running for this connection."); }
}

export type ReconciliationOwner = { brandId: string; connectionId: string };
export type ReconciliationClaimStore = {
  acquire(owner: ReconciliationOwner, runId: string): Promise<boolean>;
  release(owner: ReconciliationOwner, runId: string): Promise<void>;
};

const store: ReconciliationClaimStore = {
  async acquire(owner, runId) {
    const { default: prisma } = await import("@/lib/prisma");
    return prisma.$transaction(async (tx) => {
      await lockCommerceConnectionForTransaction(tx, owner.connectionId);
      const connection = await tx.commerceConnection.findUnique({ where: { id: owner.connectionId } });
      if (!connection || connection.brandId !== owner.brandId) throw new CommerceConnectionNotFoundError(owner.connectionId);
      if (connection.provider !== CommerceProvider.COMMERCE7) throw new CommerceConnectionMismatchError(owner.connectionId, CommerceProvider.COMMERCE7, connection.provider);
      if (connection.status !== "CONNECTED") throw new CommerceConnectionNotReadyError(connection.id, connection.provider, connection.status);
      const state = await tx.commerceOrderReconciliationState.findUnique({ where: { connectionId: owner.connectionId } });
      if (state?.activeRunId) return false;
      const now = new Date();
      await tx.commerceOrderReconciliationState.upsert({
        where: { connectionId: owner.connectionId },
        create: { connectionId: owner.connectionId, brandId: owner.brandId, activeRunId: runId, activeRunStartedAt: now, lastAttemptedAt: now },
        update: { activeRunId: runId, activeRunStartedAt: now, lastAttemptedAt: now },
      });
      return true;
    });
  },
  async release(owner, runId) {
    const { default: prisma } = await import("@/lib/prisma");
    await prisma.commerceOrderReconciliationState.updateMany({
      where: { connectionId: owner.connectionId, brandId: owner.brandId, activeRunId: runId },
      data: { activeRunId: null, activeRunStartedAt: null },
    });
  },
};

/** The durable claim survives process death; it is never stolen based on age.
 * No transaction/row lock is held during HTTP. Release is owner-conditional.
 */
export async function withCommerce7ReconciliationClaim<T>(
  owner: ReconciliationOwner,
  run: () => Promise<T>,
  deps: ReconciliationClaimStore = store,
): Promise<T> {
  const runId = randomUUID();
  if (!await deps.acquire(owner, runId)) throw new Commerce7ReconciliationBusyError();
  try { return await run(); }
  finally { await deps.release(owner, runId); }
}
