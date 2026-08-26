import { NextResponse, type NextRequest } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  runCatchUpStep,
  type Commerce7CatchUpStepResult,
} from "@/lib/commerce/providers/commerce7-order-reconciliation";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "@/lib/commerce/errors";

/**
 * `POST /api/brand/commerce/connections/[connectionId]/orders/catch-up`
 *
 * PHASE 22 — replaces the fixed "reconcile last 24 hours" action. Runs ONE
 * bounded, adaptively-chunked step of the durable, resumable Catch Up
 * sequence (see `@/lib/commerce/providers/commerce7-order-reconciliation`
 * for the full checkpoint/resumability/concurrency design) and returns
 * immediately — the caller (the Brand Admin's browser) decides whether to
 * call again (`reachedTarget: false`) or stop. The durable checkpoint this
 * call may have advanced survives regardless of whether anyone calls again.
 */
export type BrandCommerceCatchUpDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  catchUp(input: { brandId: string; connectionId: string }): Promise<Commerce7CatchUpStepResult>;
};

const DEFAULT_DEPS: BrandCommerceCatchUpDeps = {
  getContext: getBrandManagementContext,
  catchUp: runCatchUpStep,
};

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  return brandCommerceCatchUpPostImpl({}, connectionId);
}

export async function brandCommerceCatchUpPostImpl(
  overrides: Partial<BrandCommerceCatchUpDeps> = {},
  connectionId?: string,
) {
  const deps: BrandCommerceCatchUpDeps = { ...DEFAULT_DEPS, ...overrides };

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

    const brandId = context.membership.brand.id;

    let result: Commerce7CatchUpStepResult;
    try {
      result = await deps.catchUp({ brandId, connectionId });
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
        reconciledThrough: result.reconciledThrough?.toISOString() ?? null,
        target: result.target.toISOString(),
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
    console.error("[brand/commerce/connections/[connectionId]/orders/catch-up][POST] Error:", error);
    return NextResponse.json({ error: "Failed to run order catch-up." }, { status: 500 });
  }
}
