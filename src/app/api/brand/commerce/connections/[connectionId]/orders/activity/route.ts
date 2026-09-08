import { NextResponse, type NextRequest } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  clampOrderActivityLimit,
  getBrandCommerceOrderActivity,
  type BrandCommerceOrderActivityPage,
} from "@/lib/commerce/order-activity";

/**
 * `GET /api/brand/commerce/connections/[connectionId]/orders/activity`
 *
 * PHASE C — bounded, sanitized order-ingestion activity for ONE connection.
 * Sits beside the existing `orders/catch-up`, `orders/reconcile-range` and
 * `orders/reconciliation-state` routes, following the same
 * exact-connection-scoped convention rather than introducing a new shape.
 *
 * `brandId` ALWAYS comes from the authenticated context — never the browser.
 * A connection id belonging to another Brand is answered with the SAME 404 a
 * nonexistent one gets (see `getBrandCommerceOrderActivity`), so this route
 * cannot be used to probe which connection ids exist.
 *
 * The response is a deliberately narrow DTO; see `order-activity.ts`'s
 * header for exactly what is and is not exposed and why.
 */
export type BrandCommerceOrderActivityDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  getActivity(input: {
    connectionId: string;
    brandId: string;
    cursor: string | null;
    limit: number;
  }): Promise<BrandCommerceOrderActivityPage | null>;
};

const DEFAULT_DEPS: BrandCommerceOrderActivityDeps = {
  getContext: getBrandManagementContext,
  getActivity: (input) => getBrandCommerceOrderActivity(input),
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  const params = request.nextUrl.searchParams;
  return brandCommerceOrderActivityGetImpl({}, connectionId, {
    cursor: params.get("cursor"),
    limit: params.get("limit"),
  });
}

export async function brandCommerceOrderActivityGetImpl(
  overrides: Partial<BrandCommerceOrderActivityDeps> = {},
  connectionId?: string,
  query: { cursor: string | null; limit: string | null } = { cursor: null, limit: null },
) {
  const deps: BrandCommerceOrderActivityDeps = { ...DEFAULT_DEPS, ...overrides };

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

    const page = await deps.getActivity({
      connectionId,
      brandId: context.membership.brand.id,
      cursor: query.cursor,
      limit: clampOrderActivityLimit(query.limit),
    });

    if (!page) {
      return NextResponse.json({ error: "That commerce connection was not found." }, { status: 404 });
    }

    return NextResponse.json({ data: page });
  } catch (error) {
    // Classified server-side only — the client never receives an internal
    // error or stack trace.
    console.error(
      "[brand/commerce/connections/[connectionId]/orders/activity][GET] Error:",
      error,
    );
    return NextResponse.json({ error: "Failed to load order activity." }, { status: 500 });
  }
}
