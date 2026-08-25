import { NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  getBrandCommerceOrderDetail,
  type BrandCommerceOrderDetail,
} from "@/lib/commerce/order-detail";

/**
 * `GET /api/brand/commerce/orders/[orderId]`
 *
 * PHASE 19 — PART 11: canonical, provider-neutral Brand-owned order detail.
 * `brandId` is always the authenticated context's own brand — cross-brand
 * access is structurally impossible (the service's own query filters on
 * both `id` and `brandId` together; a foreign order id is indistinguishable
 * from a nonexistent one, both 404).
 */
export type BrandCommerceOrderDetailDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  getOrderDetail(orderId: string, brandId: string): Promise<BrandCommerceOrderDetail | null>;
};

const DEFAULT_DEPS: BrandCommerceOrderDetailDeps = {
  getContext: getBrandManagementContext,
  getOrderDetail: getBrandCommerceOrderDetail,
};

export async function GET(
  _request: Request,
  context: { params: Promise<{ orderId: string }> },
) {
  const { orderId } = await context.params;
  return brandCommerceOrderDetailGetImpl({}, orderId);
}

export async function brandCommerceOrderDetailGetImpl(
  overrides: Partial<BrandCommerceOrderDetailDeps> = {},
  orderId?: string,
) {
  const deps: BrandCommerceOrderDetailDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const context = await deps.getContext();
    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    if (!orderId || typeof orderId !== "string" || !orderId.trim()) {
      return NextResponse.json({ error: "An order id is required." }, { status: 400 });
    }

    const order = await deps.getOrderDetail(orderId, context.membership.brand.id);
    if (!order) {
      return NextResponse.json({ error: "That order was not found." }, { status: 404 });
    }

    return NextResponse.json({ data: order });
  } catch (error) {
    console.error("[brand/commerce/orders/[orderId]][GET] Error:", error);
    return NextResponse.json({ error: "Failed to load order." }, { status: 500 });
  }
}
