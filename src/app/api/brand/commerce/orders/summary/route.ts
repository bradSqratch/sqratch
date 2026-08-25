import { NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  getBrandOrderOperationsSummary,
  type BrandOrderOperationsSummary,
} from "@/lib/commerce/order-operations-summary";

/**
 * `GET /api/brand/commerce/orders/summary`
 *
 * PHASE 18 — PART 6: per-connection order operations summary backing the
 * `/dashboard/brand/commerce/orders` dashboard. `brandId` always comes from
 * the authenticated context, never a client-supplied value — cross-brand
 * access is structurally impossible.
 */
export type BrandCommerceOrdersSummaryDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  getSummary(brandId: string): Promise<BrandOrderOperationsSummary>;
};

const DEFAULT_DEPS: BrandCommerceOrdersSummaryDeps = {
  getContext: getBrandManagementContext,
  getSummary: getBrandOrderOperationsSummary,
};

export async function GET() {
  return brandCommerceOrdersSummaryGetImpl({});
}

export async function brandCommerceOrdersSummaryGetImpl(
  overrides: Partial<BrandCommerceOrdersSummaryDeps> = {},
) {
  const deps: BrandCommerceOrdersSummaryDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const context = await deps.getContext();
    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    const summary = await deps.getSummary(context.membership.brand.id);
    return NextResponse.json({ data: summary });
  } catch (error) {
    console.error("[brand/commerce/orders/summary][GET] Error:", error);
    return NextResponse.json({ error: "Failed to load order operations summary." }, { status: 500 });
  }
}
