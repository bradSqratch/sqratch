import { NextResponse, type NextRequest } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  getReconciliationState,
  type Commerce7ReconciliationStateView,
} from "@/lib/commerce/providers/commerce7-order-reconciliation";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
} from "@/lib/commerce/errors";

/**
 * `GET /api/brand/commerce/connections/[connectionId]/orders/reconciliation-state`
 *
 * PHASE 22 — read-only durable reconciliation state, so a page load/reload
 * shows the REAL checkpoint/progress instead of resetting to nothing (see
 * `@/lib/commerce/providers/commerce7-order-reconciliation`'s
 * `getReconciliationState`). Never mutates anything, never calls Commerce7.
 */
export type BrandCommerceReconciliationStateDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  getState(input: {
    brandId: string;
    connectionId: string;
  }): Promise<Commerce7ReconciliationStateView>;
};

const DEFAULT_DEPS: BrandCommerceReconciliationStateDeps = {
  getContext: getBrandManagementContext,
  getState: getReconciliationState,
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  return brandCommerceReconciliationStateGetImpl({}, connectionId);
}

export async function brandCommerceReconciliationStateGetImpl(
  overrides: Partial<BrandCommerceReconciliationStateDeps> = {},
  connectionId?: string,
) {
  const deps: BrandCommerceReconciliationStateDeps = { ...DEFAULT_DEPS, ...overrides };

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

    let state: Commerce7ReconciliationStateView;
    try {
      state = await deps.getState({ brandId, connectionId });
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
      throw error;
    }

    return NextResponse.json({ data: state });
  } catch (error) {
    console.error(
      "[brand/commerce/connections/[connectionId]/orders/reconciliation-state][GET] Error:",
      error,
    );
    return NextResponse.json({ error: "Failed to load reconciliation state." }, { status: 500 });
  }
}
