/**
 * reward-reconciliation.ts
 *
 * Exactly-once reconciliation for CommerceRewardRedemption rows stuck in
 * POINTS_DEBITED status. This happens when a crash occurs between the
 * serializable TX commit (debit) and the subsequent ISSUED update (which
 * sets externalDiscountId).
 *
 * EXACTLY-ONCE guarantee:
 *   The composite unique `@@unique([commerceRewardRedemptionId, reason])` on
 *   PointTransaction (name: "uq_point_tx_redemption_reason") prevents two
 *   ledger rows for the same (redemption, reason) pair. On a P2002 violation
 *   during the refund path, a refund row already exists → swallow and set
 *   REFUNDED without incrementing points again.
 *
 *   NOTE on NULL semantics: because commerceRewardRedemptionId is nullable,
 *   Postgres treats NULL as distinct from every other NULL, so existing
 *   QR/BONUS rows (commerceRewardRedemptionId = NULL) are entirely unaffected
 *   by this index. Only rows where commerceRewardRedemptionId IS NOT NULL
 *   participate in the uniqueness constraint.
 *
 * SECURITY: tokens are never logged.
 */

import { CommerceProvider, Prisma } from "@prisma/client";
import { refundShopifyRewardPoints } from "@/lib/points";
import {
  assertTransition,
  CommerceRewardRedemptionStatus,
} from "@/lib/reward-redemption-state";
import { getValidAccessToken } from "@/lib/shopify-token-manager";
import { isConnectionUsable, resolveCommerceConnectionForExternalAccount } from "@/lib/commerce/connection-service";
import { defaultCommerceAdapterRegistry } from "@/lib/commerce/default-registry";
import { CommerceProviderApiError } from "@/lib/commerce/errors";

// ---------------------------------------------------------------------------
// Dependency-injection interfaces (for unit testing without a real DB)
// ---------------------------------------------------------------------------

export type ReconciliationRow = {
  id: string;
  userId: string;
  brandId: string;
  provider: CommerceProvider;
  code: string;
  status: CommerceRewardRedemptionStatus;
  pointsCost: number;
  externalAccountId: string;
  externalDiscountId: string | null;
  issuedAt: Date | null;
  expiresAt: Date | null;
  reconcileAttempts: number;
  needsManualReview: boolean;
  reconcileLockedUntil: Date | null;
  createdAt: Date;
};

export type ReconciliationDeps = {
  /** Selects up to `limit` candidate rows. */
  selectCandidates(opts: {
    limit: number;
    minAgeMs: number;
    now: Date;
  }): Promise<ReconciliationRow[]>;

  /**
   * CAS claim: increment attempts + set lock if still POINTS_DEBITED and lock
   * is not held by someone else. Returns count === 1 if claimed.
   */
  claimRow(opts: {
    id: string;
    lockUntil: Date;
    now: Date;
  }): Promise<{ count: number }>;

  /** Releases the lock (sets reconcileLockedUntil = null). */
  releaseLock(id: string): Promise<void>;

  /**
   * Updates reconcile metadata (lastReconcileReason, needsManualReview, etc.)
   * without touching status. Used for AMBIGUOUS outcomes.
   */
  updateReconcileMetadata(
    id: string,
    data: {
      lastReconcileReason?: string;
      needsManualReview?: boolean;
      reconcileLockedUntil?: Date | null;
    },
  ): Promise<void>;

  /**
   * Completes a row to ISSUED in a single DB operation.
   * Sets status, externalDiscountId (if provided), issuedAt, expiresAt,
   * externalDiscountStatus, and clears reconcileLockedUntil.
   */
  completeToIssued(
    id: string,
    data: {
      externalDiscountId?: string;
      externalDiscountStatus?: string | null;
      issuedAt?: Date;
      expiresAt?: Date | null;
      lastReconcileReason?: string;
    },
  ): Promise<void>;

  /**
   * Refunds a row in a single atomic transaction:
   *   1. Re-read row for validation (bail if not POINTS_DEBITED).
   *   2. Create PointTransaction (COMMERCE_REWARD_REFUND) — throws P2002 if exists.
   *   3. If created: increment user points + set status = REFUNDED.
   *   4. If P2002: set status = REFUNDED without incrementing (idempotent).
   * Returns 'refunded' | 'already_refunded' | 'skipped'.
   */
  refundRow(row: ReconciliationRow): Promise<"refunded" | "already_refunded" | "skipped">;

  /** Resolves an exact provider/account connection before any credential use. */
  resolveConnection(row: ReconciliationRow): Promise<{ id: string } | null>;
  /** Resolves the credential only for that exact connection. */
  getToken(
    brandId: string,
    connectionId: string,
    provider: CommerceProvider,
  ): Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }>;

  /** Looks up the discount by node ID (if known). */
  lookupByNodeId(opts: {
    provider: CommerceProvider;
    connectionId: string;
    accessToken: string;
    discountNodeId: string;
  }): Promise<
    | { ok: true; exists: true; status: string | null; endsAt: Date | null; asyncUsageCount: number; discountNodeId: string }
    | { ok: true; exists: false }
    | { ok: false; status: number; error: string }
  >;

  /** Looks up the discount by code string. */
  lookupByCode(opts: {
    provider: CommerceProvider;
    connectionId: string;
    accessToken: string;
    code: string;
  }): Promise<
    | { ok: true; exists: true; discountNodeId: string; status: string | null; endsAt: Date | null; asyncUsageCount: number }
    | { ok: true; exists: false }
    | { ok: false; status: number; error: string }
  >;
};

// ---------------------------------------------------------------------------
// Decision types (pure, testable)
// ---------------------------------------------------------------------------

export type ReconciliationDecision =
  | { action: "COMPLETE_ISSUED"; discountNodeId?: string; status: string | null; endsAt: Date | null; asyncUsageCount: number }
  | { action: "REFUND"; reason: string }
  | { action: "RETAIN"; reason: string; markManualReview?: boolean };

/**
 * Pure function — given the Shopify lookup result and attempt count,
 * returns the decision for this row. No side effects.
 */
export function makeReconciliationDecision(
  lookupResult:
    | { ok: true; exists: true; discountNodeId: string; status: string | null; endsAt: Date | null; asyncUsageCount: number }
    | { ok: true; exists: false }
    | { ok: false; status: number; error: string },
  reconcileAttempts: number,
  maxAttempts: number,
): ReconciliationDecision {
  if (lookupResult.ok && lookupResult.exists) {
    return {
      action: "COMPLETE_ISSUED",
      discountNodeId: lookupResult.discountNodeId,
      status: lookupResult.status,
      endsAt: lookupResult.endsAt,
      asyncUsageCount: lookupResult.asyncUsageCount,
    };
  }

  if (lookupResult.ok && !lookupResult.exists) {
    return { action: "REFUND", reason: "reconciled: discount not found on Shopify" };
  }

  // Ambiguous (HTTP/network/timeout error)
  const sanitizedReason = `reconcile attempt failed (http ${lookupResult.status}): ${lookupResult.error.slice(0, 200)}`;
  const markManualReview = reconcileAttempts >= maxAttempts;
  return { action: "RETAIN", reason: sanitizedReason, markManualReview };
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export type ReconciliationSummary = {
  processed: number;
  issued: number;
  refunded: number;
  retained: number;
  manualReview: number;
  skipped: number;
};

// ---------------------------------------------------------------------------
// Core reconciliation function (with injectable deps for testing)
// ---------------------------------------------------------------------------

export async function reconcileStuckRedemptionsWithDeps(
  deps: ReconciliationDeps,
  opts: {
    limit?: number;
    minAgeMs?: number;
    maxAttempts?: number;
  } = {},
): Promise<ReconciliationSummary> {
  const limit = opts.limit ?? 20;
  const minAgeMs = opts.minAgeMs ?? 5 * 60 * 1000;
  const maxAttempts = opts.maxAttempts ?? 5;

  const now = new Date();
  const summary: ReconciliationSummary = {
    processed: 0,
    issued: 0,
    refunded: 0,
    retained: 0,
    manualReview: 0,
    skipped: 0,
  };

  const candidates = await deps.selectCandidates({ limit, minAgeMs, now });

  for (const row of candidates) {
    summary.processed++;

    // --- CAS claim ---
    const lockUntil = new Date(now.getTime() + 2 * 60 * 1000);
    const claimed = await deps.claimRow({ id: row.id, lockUntil, now });
    if (claimed.count !== 1) {
      summary.skipped++;
      continue;
    }

    // --- Token ---
    const connection = await deps.resolveConnection(row);
    if (!connection) {
      await deps.updateReconcileMetadata(row.id, {
        lastReconcileReason: "historical provider account is not currently connected",
        reconcileLockedUntil: null,
      });
      summary.retained++;
      continue;
    }
    const tokenResult = await deps.getToken(row.brandId, connection.id, row.provider);
    if (!tokenResult.ok) {
      const reason = "shop disconnected / token unavailable";
      await deps.updateReconcileMetadata(row.id, {
        lastReconcileReason: reason,
        reconcileLockedUntil: null,
      });
      summary.retained++;
      continue;
    }

    // --- Shopify lookup ---
    let lookupResult:
      | { ok: true; exists: true; discountNodeId: string; status: string | null; endsAt: Date | null; asyncUsageCount: number }
      | { ok: true; exists: false }
      | { ok: false; status: number; error: string };

    if (row.externalDiscountId) {
      // Prefer node ID lookup (stronger / more direct)
      const byNodeId = await deps.lookupByNodeId({
        provider: row.provider,
        connectionId: connection.id,
        accessToken: tokenResult.accessToken,
        discountNodeId: row.externalDiscountId,
      });
      if (byNodeId.ok && byNodeId.exists) {
        lookupResult = {
          ok: true,
          exists: true,
          discountNodeId: row.externalDiscountId,
          status: byNodeId.status,
          endsAt: byNodeId.endsAt,
          asyncUsageCount: byNodeId.asyncUsageCount,
        };
      } else {
        lookupResult = byNodeId as typeof lookupResult;
      }
    } else {
      lookupResult = await deps.lookupByCode({
        provider: row.provider,
        connectionId: connection.id,
        accessToken: tokenResult.accessToken,
        code: row.code,
      });
    }

    // --- Decision ---
    const decision = makeReconciliationDecision(lookupResult, row.reconcileAttempts, maxAttempts);

    if (decision.action === "COMPLETE_ISSUED") {
      assertTransition(CommerceRewardRedemptionStatus.POINTS_DEBITED, CommerceRewardRedemptionStatus.ISSUED);
      await deps.completeToIssued(row.id, {
        externalDiscountId: decision.discountNodeId,
        externalDiscountStatus: decision.status,
        issuedAt: row.issuedAt ?? now,
        expiresAt: decision.endsAt,
        lastReconcileReason: "reconciled: discount found on Shopify",
      });
      summary.issued++;
      continue;
    }

    if (decision.action === "REFUND") {
      assertTransition(CommerceRewardRedemptionStatus.POINTS_DEBITED, CommerceRewardRedemptionStatus.REFUNDED);
      const outcome = await deps.refundRow(row);
      if (outcome === "refunded" || outcome === "already_refunded") {
        summary.refunded++;
      } else {
        // skipped = row was no longer POINTS_DEBITED when we tried to refund
        summary.skipped++;
      }
      continue;
    }

    // RETAIN
    await deps.updateReconcileMetadata(row.id, {
      lastReconcileReason: decision.reason,
      needsManualReview: decision.markManualReview === true ? true : undefined,
      reconcileLockedUntil: null,
    });
    summary.retained++;
    if (decision.markManualReview) {
      summary.manualReview++;
    }
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Production implementation using real Prisma + Shopify
// ---------------------------------------------------------------------------

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

function buildProductionDeps(): ReconciliationDeps {
  return {
    async selectCandidates({ limit, minAgeMs, now }) {
      const prisma = await getPrisma();
      const ageThreshold = new Date(now.getTime() - minAgeMs);
      return prisma.commerceRewardRedemption.findMany({
        where: {
          status: CommerceRewardRedemptionStatus.POINTS_DEBITED,
          needsManualReview: false,
          createdAt: { lt: ageThreshold },
          OR: [
            { reconcileLockedUntil: null },
            { reconcileLockedUntil: { lt: now } },
          ],
        },
        orderBy: { createdAt: "asc" },
        take: limit,
        select: {
          id: true,
          userId: true,
          brandId: true,
          provider: true,
          code: true,
          status: true,
          pointsCost: true,
          externalAccountId: true,
          externalDiscountId: true,
          issuedAt: true,
          expiresAt: true,
          reconcileAttempts: true,
          needsManualReview: true,
          reconcileLockedUntil: true,
          createdAt: true,
        },
      });
    },

    async claimRow({ id, lockUntil, now }) {
      const prisma = await getPrisma();
      return prisma.commerceRewardRedemption.updateMany({
        where: {
          id,
          status: CommerceRewardRedemptionStatus.POINTS_DEBITED,
          needsManualReview: false,
          OR: [
            { reconcileLockedUntil: null },
            { reconcileLockedUntil: { lt: now } },
          ],
        },
        data: {
          reconcileLockedUntil: lockUntil,
          reconcileAttempts: { increment: 1 },
        },
      });
    },

    async releaseLock(id) {
      const prisma = await getPrisma();
      await prisma.commerceRewardRedemption.update({
        where: { id },
        data: { reconcileLockedUntil: null },
      });
    },

    async updateReconcileMetadata(id, data) {
      const prisma = await getPrisma();
      await prisma.commerceRewardRedemption.update({
        where: { id },
        data: {
          lastReconcileReason: data.lastReconcileReason,
          needsManualReview: data.needsManualReview ?? undefined,
          reconcileLockedUntil: data.reconcileLockedUntil,
        },
      });
    },

    async completeToIssued(id, data) {
      const prisma = await getPrisma();
      await prisma.commerceRewardRedemption.update({
        where: { id },
        data: {
          status: CommerceRewardRedemptionStatus.ISSUED,
          externalDiscountId: data.externalDiscountId ?? undefined,
          externalDiscountStatus: data.externalDiscountStatus,
          issuedAt: data.issuedAt,
          expiresAt: data.expiresAt,
          lastReconcileReason: data.lastReconcileReason,
          reconcileLockedUntil: null,
        },
      });
    },

    async refundRow(row) {
      const prisma = await getPrisma();
      try {
        return await prisma.$transaction(async (tx) => {
          // Re-read for validation
          const current = await tx.commerceRewardRedemption.findUnique({
            where: { id: row.id },
            select: { status: true },
          });
          if (current?.status !== CommerceRewardRedemptionStatus.POINTS_DEBITED) {
            return "skipped" as const;
          }

          // Central refund helper: restores spendable points, raises lifetime
          // refunded (never lifetime earned), and writes the positive
          // COMMERCE_REWARD_REFUND ledger row — all inside this TX. Exactly-once
          // is preserved by the ledger's unique constraints:
          //   * A refund row already carrying an idempotencyKey → helper returns
          //     applied:false (no double increment); flip status idempotently here.
          //   * A historical refund row without an idempotencyKey → helper's create
          //     hits P2002 and throws, aborting this TX; handled by the OUTSIDE
          //     catch below, which flips status without incrementing again.
          const refund = await refundShopifyRewardPoints({
            userId: row.userId,
            points: row.pointsCost,
            commerceRewardRedemptionId: row.id,
            db: tx,
          });

          const settledReason = refund.applied
            ? "reconciled: discount not found"
            : "reconciled: discount not found (idempotent)";

          await tx.commerceRewardRedemption.update({
            where: { id: row.id },
            data: {
              status: CommerceRewardRedemptionStatus.REFUNDED,
              errorMessage: settledReason,
              lastReconcileReason: settledReason,
              reconcileLockedUntil: null,
            },
          });

          return refund.applied ? ("refunded" as const) : ("already_refunded" as const);
        });
      } catch (err: unknown) {
        // P2002 = unique constraint violation on uq_point_tx_redemption_reason.
        // The TX above was fully rolled back by Postgres. A refund ledger row already
        // exists, so perform the idempotent status flip in a FRESH operation — no
        // point increment.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === "P2002"
        ) {
          await prisma.commerceRewardRedemption.updateMany({
            where: {
              id: row.id,
              status: CommerceRewardRedemptionStatus.POINTS_DEBITED,
            },
            data: {
              status: CommerceRewardRedemptionStatus.REFUNDED,
              errorMessage: "reconciled: discount not found (idempotent)",
              lastReconcileReason: "reconciled: discount not found (idempotent refund)",
              reconcileLockedUntil: null,
            },
          });
          return "already_refunded" as const;
        }
        return "skipped" as const;
      }
    },

    async resolveConnection(row) {
      const connection = await resolveCommerceConnectionForExternalAccount({
        brandId: row.brandId,
        provider: row.provider,
        externalAccountId: row.externalAccountId,
      });
      return connection && connection.id && isConnectionUsable(connection)
        ? { id: connection.id }
        : null;
    },

    async getToken(brandId, connectionId, provider) {
      if (provider !== CommerceProvider.SHOPIFY) {
        return { ok: false as const, reason: "provider credential unavailable" };
      }
      const result = await getValidAccessToken(brandId, { connectionId });
      if (!result.ok) {
        return { ok: false, reason: result.reason };
      }
      return { ok: true, accessToken: result.accessToken };
    },

    async lookupByNodeId({ provider, connectionId, accessToken, discountNodeId }) {
      try {
        const adapter = defaultCommerceAdapterRegistry.get(provider);
        const result = await adapter.getDiscount?.(connectionId, {
          externalDiscountId: discountNodeId,
        }, { preResolvedAccessToken: accessToken });
        if (!result) {
          return { ok: false as const, status: 501, error: "discount lookup unsupported" };
        }
        return result.exists
          ? {
              ok: true as const,
              exists: true as const,
              discountNodeId: result.externalDiscountId,
              status: result.externalStatus,
              endsAt: result.expiresAt,
              asyncUsageCount: result.usageCount,
            }
          : { ok: true as const, exists: false as const };
      } catch (error) {
        return {
          ok: false as const,
          status: error instanceof CommerceProviderApiError ? error.httpStatus ?? 502 : 502,
          error: "provider discount lookup failed",
        };
      }
    },

    async lookupByCode({ provider, connectionId, accessToken, code }) {
      try {
        const adapter = defaultCommerceAdapterRegistry.get(provider);
        const result = await adapter.getDiscount?.(
          connectionId,
          { code },
          { preResolvedAccessToken: accessToken },
        );
        if (!result) {
          return { ok: false as const, status: 501, error: "discount lookup unsupported" };
        }
        return result.exists
          ? {
              ok: true as const,
              exists: true as const,
              discountNodeId: result.externalDiscountId,
              status: result.externalStatus,
              endsAt: result.expiresAt,
              asyncUsageCount: result.usageCount,
            }
          : { ok: true as const, exists: false as const };
      } catch (error) {
        return {
          ok: false as const,
          status: error instanceof CommerceProviderApiError ? error.httpStatus ?? 502 : 502,
          error: "provider discount lookup failed",
        };
      }
    },
  };
}

/**
 * Reconciles stuck POINTS_DEBITED redemptions using the real DB and Shopify API.
 * Safe to call concurrently — CAS locking prevents double-processing.
 */
export async function reconcileStuckRedemptions(
  opts: {
    limit?: number;
    minAgeMs?: number;
    maxAttempts?: number;
  } = {},
): Promise<ReconciliationSummary> {
  return reconcileStuckRedemptionsWithDeps(buildProductionDeps(), opts);
}
