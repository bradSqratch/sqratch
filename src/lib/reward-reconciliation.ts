/**
 * reward-reconciliation.ts
 *
 * Exactly-once reconciliation for ShopifyRewardRedemption rows stuck in
 * POINTS_DEBITED status. This happens when a crash occurs between the
 * serializable TX commit (debit) and the subsequent ISSUED update (which
 * sets shopifyDiscountNodeId).
 *
 * EXACTLY-ONCE guarantee:
 *   The composite unique `@@unique([shopifyRewardRedemptionId, reason])` on
 *   PointTransaction (name: "uq_point_tx_redemption_reason") prevents two
 *   ledger rows for the same (redemption, reason) pair. On a P2002 violation
 *   during the refund path, a refund row already exists → swallow and set
 *   REFUNDED without incrementing points again.
 *
 *   NOTE on NULL semantics: because shopifyRewardRedemptionId is nullable,
 *   Postgres treats NULL as distinct from every other NULL, so existing
 *   QR/BONUS rows (shopifyRewardRedemptionId = NULL) are entirely unaffected
 *   by this index. Only rows where shopifyRewardRedemptionId IS NOT NULL
 *   participate in the uniqueness constraint.
 *
 * SECURITY: tokens are never logged.
 */

import { Prisma } from "@prisma/client";
import { refundShopifyRewardPoints } from "@/lib/points";
import {
  assertTransition,
  ShopifyRewardRedemptionStatus,
} from "@/lib/reward-redemption-state";
import {
  getShopifyDiscountUsageStatus,
  getShopifyDiscountByCode,
} from "@/lib/shopify-discounts";
import { getValidAccessToken } from "@/lib/shopify-token-manager";

// ---------------------------------------------------------------------------
// Dependency-injection interfaces (for unit testing without a real DB)
// ---------------------------------------------------------------------------

export type ReconciliationRow = {
  id: string;
  userId: string;
  brandId: string;
  code: string;
  status: ShopifyRewardRedemptionStatus;
  pointsCost: number;
  shopifyShopDomain: string;
  shopifyDiscountNodeId: string | null;
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
   * Sets status, shopifyDiscountNodeId (if provided), issuedAt, expiresAt,
   * shopifyDiscountStatus, and clears reconcileLockedUntil.
   */
  completeToIssued(
    id: string,
    data: {
      shopifyDiscountNodeId?: string;
      shopifyDiscountStatus?: string | null;
      issuedAt?: Date;
      expiresAt?: Date | null;
      lastReconcileReason?: string;
    },
  ): Promise<void>;

  /**
   * Refunds a row in a single atomic transaction:
   *   1. Re-read row for validation (bail if not POINTS_DEBITED).
   *   2. Create PointTransaction (SHOPIFY_REWARD_REFUND) — throws P2002 if exists.
   *   3. If created: increment user points + set status = REFUNDED.
   *   4. If P2002: set status = REFUNDED without incrementing (idempotent).
   * Returns 'refunded' | 'already_refunded' | 'skipped'.
   */
  refundRow(row: ReconciliationRow): Promise<"refunded" | "already_refunded" | "skipped">;

  /** Resolves the Shopify access token for the brand. */
  getToken(
    brandId: string,
  ): Promise<{ ok: true; accessToken: string } | { ok: false; reason: string }>;

  /** Looks up the discount by node ID (if known). */
  lookupByNodeId(opts: {
    shopDomain: string;
    accessToken: string;
    discountNodeId: string;
  }): Promise<
    | { ok: true; exists: true; status: string | null; endsAt: Date | null; asyncUsageCount: number; discountNodeId: string }
    | { ok: true; exists: false }
    | { ok: false; status: number; error: string }
  >;

  /** Looks up the discount by code string. */
  lookupByCode(opts: {
    shopDomain: string;
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
    const tokenResult = await deps.getToken(row.brandId);
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

    if (row.shopifyDiscountNodeId) {
      // Prefer node ID lookup (stronger / more direct)
      const byNodeId = await deps.lookupByNodeId({
        shopDomain: row.shopifyShopDomain,
        accessToken: tokenResult.accessToken,
        discountNodeId: row.shopifyDiscountNodeId,
      });
      if (byNodeId.ok && byNodeId.exists) {
        lookupResult = {
          ok: true,
          exists: true,
          discountNodeId: row.shopifyDiscountNodeId,
          status: byNodeId.status,
          endsAt: byNodeId.endsAt,
          asyncUsageCount: byNodeId.asyncUsageCount,
        };
      } else {
        lookupResult = byNodeId as typeof lookupResult;
      }
    } else {
      lookupResult = await deps.lookupByCode({
        shopDomain: row.shopifyShopDomain,
        accessToken: tokenResult.accessToken,
        code: row.code,
      });
    }

    // --- Decision ---
    const decision = makeReconciliationDecision(lookupResult, row.reconcileAttempts, maxAttempts);

    if (decision.action === "COMPLETE_ISSUED") {
      assertTransition(ShopifyRewardRedemptionStatus.POINTS_DEBITED, ShopifyRewardRedemptionStatus.ISSUED);
      await deps.completeToIssued(row.id, {
        shopifyDiscountNodeId: decision.discountNodeId,
        shopifyDiscountStatus: decision.status,
        issuedAt: row.issuedAt ?? now,
        expiresAt: decision.endsAt,
        lastReconcileReason: "reconciled: discount found on Shopify",
      });
      summary.issued++;
      continue;
    }

    if (decision.action === "REFUND") {
      assertTransition(ShopifyRewardRedemptionStatus.POINTS_DEBITED, ShopifyRewardRedemptionStatus.REFUNDED);
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
      return prisma.shopifyRewardRedemption.findMany({
        where: {
          status: ShopifyRewardRedemptionStatus.POINTS_DEBITED,
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
          code: true,
          status: true,
          pointsCost: true,
          shopifyShopDomain: true,
          shopifyDiscountNodeId: true,
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
      return prisma.shopifyRewardRedemption.updateMany({
        where: {
          id,
          status: ShopifyRewardRedemptionStatus.POINTS_DEBITED,
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
      await prisma.shopifyRewardRedemption.update({
        where: { id },
        data: { reconcileLockedUntil: null },
      });
    },

    async updateReconcileMetadata(id, data) {
      const prisma = await getPrisma();
      await prisma.shopifyRewardRedemption.update({
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
      await prisma.shopifyRewardRedemption.update({
        where: { id },
        data: {
          status: ShopifyRewardRedemptionStatus.ISSUED,
          shopifyDiscountNodeId: data.shopifyDiscountNodeId ?? undefined,
          shopifyDiscountStatus: data.shopifyDiscountStatus,
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
          const current = await tx.shopifyRewardRedemption.findUnique({
            where: { id: row.id },
            select: { status: true },
          });
          if (current?.status !== ShopifyRewardRedemptionStatus.POINTS_DEBITED) {
            return "skipped" as const;
          }

          // Central refund helper: restores spendable points, raises lifetime
          // refunded (never lifetime earned), keeps legacy User.points in sync,
          // and writes the positive SHOPIFY_REWARD_REFUND ledger row — all inside
          // this TX. Exactly-once is preserved by the ledger's unique constraints:
          //   * A refund row already carrying an idempotencyKey → helper returns
          //     applied:false (no double increment); flip status idempotently here.
          //   * A historical refund row without an idempotencyKey → helper's create
          //     hits P2002 and throws, aborting this TX; handled by the OUTSIDE
          //     catch below, which flips status without incrementing again.
          const refund = await refundShopifyRewardPoints({
            userId: row.userId,
            points: row.pointsCost,
            shopifyRewardRedemptionId: row.id,
            db: tx,
          });

          const settledReason = refund.applied
            ? "reconciled: discount not found"
            : "reconciled: discount not found (idempotent)";

          await tx.shopifyRewardRedemption.update({
            where: { id: row.id },
            data: {
              status: ShopifyRewardRedemptionStatus.REFUNDED,
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
          await prisma.shopifyRewardRedemption.updateMany({
            where: {
              id: row.id,
              status: ShopifyRewardRedemptionStatus.POINTS_DEBITED,
            },
            data: {
              status: ShopifyRewardRedemptionStatus.REFUNDED,
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

    async getToken(brandId) {
      const result = await getValidAccessToken(brandId);
      if (!result.ok) {
        return { ok: false, reason: result.reason };
      }
      return { ok: true, accessToken: result.accessToken };
    },

    async lookupByNodeId({ shopDomain, accessToken, discountNodeId }) {
      const result = await getShopifyDiscountUsageStatus({
        shopDomain,
        accessToken,
        discountNodeId,
      });
      if (!result.ok) {
        return { ok: false, status: result.status, error: result.error };
      }
      // getShopifyDiscountUsageStatus returns ok:true even when node exists but has no codeDiscount
      // We interpret a successful fetch with data as "exists"
      return {
        ok: true,
        exists: true,
        discountNodeId,
        status: result.status,
        endsAt: result.endsAt,
        asyncUsageCount: result.asyncUsageCount,
      };
    },

    async lookupByCode({ shopDomain, accessToken, code }) {
      return getShopifyDiscountByCode({ shopDomain, accessToken, code });
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
