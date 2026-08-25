import { NextResponse, type NextRequest } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  backfillCommerce7Orders,
  type Commerce7OrderBackfillOutcome,
} from "@/lib/commerce/providers/commerce7-order-backfill";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "@/lib/commerce/errors";

/**
 * `POST /api/brand/commerce/connections/[connectionId]/orders/reconcile`
 *
 * PHASE 18 — PART 9: authenticated, Brand-admin-triggered, MANUAL, bounded
 * Commerce7 order reconciliation. Thin route only — every real invariant
 * (exact connection, owned, COMMERCE7, CONNECTED, tenant taken exclusively
 * from `CommerceConnection.externalAccountId`, bounded result count,
 * deterministic idempotent event ids) lives in
 * `backfillCommerce7Orders` (`@/lib/commerce/providers/commerce7-order-backfill`),
 * which this route never reimplements or bypasses.
 *
 * CONSERVATIVE WINDOW CAP: Commerce7's `GET /order` documents no
 * server-side upper-bound date filter and no pagination (confirmed during
 * this round's research — see `fetchCommerce7OrdersByDateRange`'s doc
 * comment). Since completeness for an arbitrarily large window cannot be
 * proven, this route additionally caps the requestable window at
 * `MAX_RECONCILIATION_WINDOW_DAYS` — a conservative bound chosen for a
 * first version, not derived from any documented Commerce7 limit. A
 * `status: "TRUNCATED"` result (from `backfillCommerce7Orders`'s own
 * `COMMERCE7_BACKFILL_MAX_RESULTS` cap) is surfaced honestly as `truncated:
 * true`, never silently reported as complete.
 *
 * NEVER auto-run: this route exists ONLY to be called explicitly by an
 * authenticated Brand Admin from the operations dashboard — nothing in
 * this codebase calls it automatically (no cron, no webhook, no startup
 * hook).
 */
const MAX_RECONCILIATION_WINDOW_DAYS = 31;

export type BrandCommerceReconcileDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  reconcile(input: {
    brandId: string;
    connectionId: string;
    updatedAtGte: Date;
    updatedAtLte: Date;
  }): Promise<Commerce7OrderBackfillOutcome>;
};

const DEFAULT_DEPS: BrandCommerceReconcileDeps = {
  getContext: getBrandManagementContext,
  reconcile: ({ brandId, connectionId, updatedAtGte, updatedAtLte }) =>
    backfillCommerce7Orders({ brandId, connectionId, updatedAtGte, updatedAtLte }),
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  const body = await request.json().catch(() => null);
  return brandCommerceReconcilePostImpl(
    {},
    connectionId,
    body as { from?: unknown; to?: unknown } | null,
  );
}

export async function brandCommerceReconcilePostImpl(
  overrides: Partial<BrandCommerceReconcileDeps> = {},
  connectionId?: string,
  body?: { from?: unknown; to?: unknown } | null,
) {
  const deps: BrandCommerceReconcileDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const context = await deps.getContext();
    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    if (!connectionId || typeof connectionId !== "string" || !connectionId.trim()) {
      return NextResponse.json({ error: "A commerce connection id is required." }, { status: 400 });
    }

    if (
      !body ||
      typeof body.from !== "string" ||
      typeof body.to !== "string"
    ) {
      return NextResponse.json(
        { error: "\"from\" and \"to\" (ISO timestamps) are both required." },
        { status: 400 },
      );
    }

    const from = new Date(body.from);
    const to = new Date(body.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return NextResponse.json({ error: "\"from\" and \"to\" must be valid timestamps." }, { status: 400 });
    }
    if (from.getTime() >= to.getTime()) {
      return NextResponse.json({ error: "\"from\" must be strictly before \"to\"." }, { status: 400 });
    }
    const windowMs = to.getTime() - from.getTime();
    const maxWindowMs = MAX_RECONCILIATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
    if (windowMs > maxWindowMs) {
      return NextResponse.json(
        {
          error: `The reconciliation window must not exceed ${MAX_RECONCILIATION_WINDOW_DAYS} days.`,
          code: "WINDOW_TOO_WIDE",
          maxWindowDays: MAX_RECONCILIATION_WINDOW_DAYS,
        },
        { status: 400 },
      );
    }

    const brandId = context.membership.brand.id;

    let outcome: Commerce7OrderBackfillOutcome;
    try {
      outcome = await deps.reconcile({ brandId, connectionId, updatedAtGte: from, updatedAtLte: to });
    } catch (error) {
      if (error instanceof CommerceConnectionNotFoundError) {
        return NextResponse.json(
          { error: "That commerce connection was not found.", code: error.code },
          { status: 404 },
        );
      }
      if (error instanceof CommerceConnectionMismatchError) {
        return NextResponse.json(
          { error: "That connection is not a Commerce7 connection.", code: error.code },
          { status: 400 },
        );
      }
      if (error instanceof CommerceConnectionNotReadyError) {
        return NextResponse.json(
          { error: "Commerce connection is not connected.", code: error.code },
          { status: 409 },
        );
      }
      throw error;
    }

    let createdCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    let failedCount = 0;
    for (const item of outcome.outcomes) {
      if (item.status === "CREATED") createdCount += 1;
      else if (item.status === "UPDATED") updatedCount += 1;
      else if (item.status === "ALREADY_PROCESSED" || item.status === "SKIPPED_STALE" || item.status === "SKIPPED_DISCONNECTED") unchangedCount += 1;
      else failedCount += 1; // FAILED, IN_FLIGHT
    }

    return NextResponse.json({
      data: {
        status: outcome.status === "TRUNCATED" ? "PARTIAL" : failedCount > 0 ? "PARTIAL" : "SUCCEEDED",
        fetchedCount: outcome.ordersFetched,
        createdCount,
        updatedCount,
        unchangedCount,
        failedCount,
        truncated: outcome.status === "TRUNCATED",
      },
    });
  } catch (error) {
    console.error("[brand/commerce/connections/[connectionId]/orders/reconcile][POST] Error:", error);
    return NextResponse.json({ error: "Failed to reconcile orders." }, { status: 500 });
  }
}
