import { NextResponse, type NextRequest } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  runCustomRangeStep,
  MAX_CUSTOM_RANGE_WINDOW_MS,
  type Commerce7CustomRangeStepResult,
} from "@/lib/commerce/providers/commerce7-order-reconciliation";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "@/lib/commerce/errors";

/**
 * `POST /api/brand/commerce/connections/[connectionId]/orders/reconcile-range`
 *
 * PHASE 22, Part 4 — "Reconcile custom range." Runs ONE bounded,
 * adaptively-chunked step of an EXPLICIT, admin-chosen `[from, to]` repair
 * window, using the identical canonical chunk processor Catch Up uses (see
 * `@/lib/commerce/providers/commerce7-order-reconciliation`). Calling this
 * again with the SAME `from`/`to` resumes from the durable
 * `customRangeCursor`; a DIFFERENT `from`/`to` starts a fresh sequence.
 *
 * NEVER advances the primary contiguous `reconciledThrough` checkpoint —
 * see that module's header for the exact Aug-5/Aug-20 example this
 * intentionally guards against.
 */
const MAX_CUSTOM_RANGE_WINDOW_DAYS = Math.floor(MAX_CUSTOM_RANGE_WINDOW_MS / (24 * 60 * 60 * 1000));

export type BrandCommerceReconcileRangeDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  reconcileRange(input: {
    brandId: string;
    connectionId: string;
    from: Date;
    to: Date;
  }): Promise<Commerce7CustomRangeStepResult>;
};

const DEFAULT_DEPS: BrandCommerceReconcileRangeDeps = {
  getContext: getBrandManagementContext,
  reconcileRange: runCustomRangeStep,
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  const body = await request.json().catch(() => null);
  return brandCommerceReconcileRangePostImpl(
    {},
    connectionId,
    body as { from?: unknown; to?: unknown } | null,
  );
}

export async function brandCommerceReconcileRangePostImpl(
  overrides: Partial<BrandCommerceReconcileRangeDeps> = {},
  connectionId?: string,
  body?: { from?: unknown; to?: unknown } | null,
) {
  const deps: BrandCommerceReconcileRangeDeps = { ...DEFAULT_DEPS, ...overrides };

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

    if (!body || typeof body.from !== "string" || typeof body.to !== "string") {
      return NextResponse.json(
        { error: '"from" and "to" (ISO timestamps) are both required.' },
        { status: 400 },
      );
    }

    const from = new Date(body.from);
    const to = new Date(body.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return NextResponse.json({ error: '"from" and "to" must be valid timestamps.' }, { status: 400 });
    }
    if (from.getTime() >= to.getTime()) {
      return NextResponse.json({ error: '"from" must be strictly before "to".' }, { status: 400 });
    }
    // PHASE 26 — this rejection is now MACHINE-READABLE. It was previously a
    // bare message, so a client could not distinguish "you picked a future
    // range" from any other 400 and fell back to a generic "Failed to
    // reconcile the custom range." The UI additionally pre-validates the
    // same condition against the browser clock, but THIS check remains the
    // authoritative one: it is evaluated against the SERVER's clock, which a
    // client cannot influence (a skewed or deliberately-altered browser
    // clock can pass the client check and must still be refused here).
    //
    // `serverNow` is returned purely so an operator can see the clock the
    // rejection was made against — it is a plain timestamp, never internal
    // state.
    const nowDate = new Date();
    const now = nowDate.getTime();
    if (from.getTime() > now || to.getTime() > now) {
      return NextResponse.json(
        {
          error: "The reconciliation range cannot extend past the current time.",
          code: "RANGE_IN_FUTURE",
          serverNow: nowDate.toISOString(),
        },
        { status: 400 },
      );
    }
    const windowMs = to.getTime() - from.getTime();
    if (windowMs > MAX_CUSTOM_RANGE_WINDOW_MS) {
      return NextResponse.json(
        {
          error: `The custom reconciliation range must not exceed ${MAX_CUSTOM_RANGE_WINDOW_DAYS} days.`,
          code: "WINDOW_TOO_WIDE",
          maxWindowDays: MAX_CUSTOM_RANGE_WINDOW_DAYS,
        },
        { status: 400 },
      );
    }

    const brandId = context.membership.brand.id;

    let result: Commerce7CustomRangeStepResult;
    try {
      result = await deps.reconcileRange({ brandId, connectionId, from, to });
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

    return NextResponse.json({
      data: {
        status: result.status,
        cursor: result.cursor?.toISOString() ?? null,
        from: result.from.toISOString(),
        to: result.to.toISOString(),
        reachedTarget: result.reachedTarget,
        chunk: result.chunk
          ? { from: result.chunk.from.toISOString(), to: result.chunk.to.toISOString() }
          : null,
        ordersFetched: result.ordersFetched,
        ordersProcessed: result.ordersProcessed,
        error: result.error,
      },
    });
  } catch (error) {
    console.error(
      "[brand/commerce/connections/[connectionId]/orders/reconcile-range][POST] Error:",
      error,
    );
    return NextResponse.json({ error: "Failed to reconcile the custom range." }, { status: 500 });
  }
}
