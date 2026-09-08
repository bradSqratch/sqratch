import { NextResponse, type NextRequest } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  buildAttributionWhere,
  buildCommerceOrderCursorWhere,
  buildOrderDateWhere,
  buildOrderListWhere,
  buildOrderNumberWhere,
  clampOrderListLimit,
  decodeCommerceOrderCursor,
  encodeCommerceOrderCursor,
  MAX_ORDER_NUMBER_SEARCH_LENGTH,
  normalizeAttributionFilter,
  normalizeConnectionIdFilter,
  normalizeOrderFinancialStatusFilter,
  normalizeOrderFulfillmentStatusFilter,
  normalizeOrderNumberSearch,
  normalizeOrderProviderFilter,
  parseOrderDateRange,
  resolveDisplayOrderDate,
} from "@/lib/commerce/order-list";
import type { CommerceOrderFinancialStatus, CommerceOrderFulfillmentStatus, CommerceProvider, Prisma } from "@prisma/client";

/**
 * `GET /api/brand/commerce/orders`
 *
 * PHASE 18 — PART 7: the canonical, provider-neutral Brand-owned order
 * list. `brandId` is ALWAYS the authenticated context's own brand — never
 * client-supplied, so cross-brand access is structurally impossible (the
 * query's `where.brandId` is the ONLY brandId ever used).
 *
 * NO customer PII: only order-level financial/status fields and line-item
 * counts are ever selected — no customer name/email/address/payment data
 * exists on `CommerceOrder` to begin with (see the model's own doc
 * comments), so there is nothing to accidentally leak here.
 *
 * "Unknown must display as unknown, never as zero": every money/status
 * field that is `null` in the database is returned as `null` in the JSON
 * response — this route never substitutes `0` or a guessed default.
 */
export type BrandCommerceOrderListRow = {
  id: string;
  connectionId: string;
  provider: CommerceProvider;
  orderNumber: string | null;
  orderDate: string;
  financialStatus: CommerceOrderFinancialStatus | null;
  fulfillmentStatus: CommerceOrderFulfillmentStatus | null;
  currencyCode: string | null;
  /**
   * PHASE 19 REPAIR (P1-3): the persisted exponent these money fields were
   * computed at — a UI MUST use this exact value to format them, never
   * derive/guess one from `currencyCode`. `null` only when unresolved.
   */
  minorUnitExponent: number | null;
  totalMinor: string | null;
  totalRefundedMinor: string | null;
  netRevenueMinor: string | null;
  attributed: boolean;
  updatedAt: string;
};

export type BrandCommerceOrderListDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  findOrders(input: {
    brandId: string;
    provider: CommerceProvider | null;
    financialStatus: CommerceOrderFinancialStatus | null;
    /** PHASE B — canonical fulfillment enum, independent of financial status. */
    fulfillmentStatus: CommerceOrderFulfillmentStatus | null;
    /** PHASE B — exact connection scope. Always ANDed with `brandId`, never a substitute for it. */
    connectionId: string | null;
    attributionWhere: Prisma.CommerceOrderWhereInput;
    /** PHASE B — order-number substring match. The ONLY free-text search; never customer data. */
    orderNumberWhere: Prisma.CommerceOrderWhereInput;
    /** PHASE B — business-order-date range (`providerCreatedAt ?? createdAt`). */
    dateWhere: Prisma.CommerceOrderWhereInput;
    cursorWhere: Prisma.CommerceOrderWhereInput | null;
    limit: number;
  }): Promise<
    Array<{
      id: string;
      connectionId: string;
      provider: CommerceProvider;
      orderNumber: string | null;
      providerCreatedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
      financialStatus: CommerceOrderFinancialStatus | null;
      fulfillmentStatus: CommerceOrderFulfillmentStatus | null;
      currencyCode: string | null;
      minorUnitExponent: number | null;
      totalMinor: bigint | null;
      totalRefundedMinor: bigint;
      netRevenueMinor: bigint | null;
      attributionId: string | null;
    }>
  >;
};

const ORDER_SELECT = {
  id: true,
  connectionId: true,
  provider: true,
  orderNumber: true,
  providerCreatedAt: true,
  createdAt: true,
  updatedAt: true,
  financialStatus: true,
  fulfillmentStatus: true,
  currencyCode: true,
  minorUnitExponent: true,
  totalMinor: true,
  totalRefundedMinor: true,
  netRevenueMinor: true,
  attributionId: true,
} as const;

async function defaultFindOrders(
  input: Parameters<BrandCommerceOrderListDeps["findOrders"]>[0],
) {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.commerceOrder.findMany({
    // PHASE B — composition lives in a PURE, separately-tested helper so the
    // AND-vs-spread correctness (see `buildOrderListWhere`) is provable
    // without a database.
    where: buildOrderListWhere(input),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: ORDER_SELECT,
  });
}

const DEFAULT_DEPS: BrandCommerceOrderListDeps = {
  getContext: getBrandManagementContext,
  findOrders: defaultFindOrders,
};

export type BrandCommerceOrderListQuery = {
  provider: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  connectionId: string | null;
  orderNumber: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  attributed: string | null;
  cursor: string | null;
  limit: string | null;
};

const EMPTY_QUERY: BrandCommerceOrderListQuery = {
  provider: null,
  financialStatus: null,
  fulfillmentStatus: null,
  connectionId: null,
  orderNumber: null,
  dateFrom: null,
  dateTo: null,
  attributed: null,
  cursor: null,
  limit: null,
};

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  return brandCommerceOrdersGetImpl(
    {},
    {
      provider: params.get("provider"),
      financialStatus: params.get("financialStatus"),
      fulfillmentStatus: params.get("fulfillmentStatus"),
      connectionId: params.get("connectionId"),
      orderNumber: params.get("orderNumber"),
      dateFrom: params.get("dateFrom"),
      dateTo: params.get("dateTo"),
      attributed: params.get("attributed"),
      cursor: params.get("cursor"),
      limit: params.get("limit"),
    },
  );
}

export async function brandCommerceOrdersGetImpl(
  overrides: Partial<BrandCommerceOrderListDeps> = {},
  // `Partial` so a caller (notably a test) can supply only the filters it
  // cares about; every unmentioned filter defaults to "not applied".
  rawQuery: Partial<BrandCommerceOrderListQuery> = {},
) {
  const deps: BrandCommerceOrderListDeps = { ...DEFAULT_DEPS, ...overrides };
  const query: BrandCommerceOrderListQuery = { ...EMPTY_QUERY, ...rawQuery };

  try {
    const context = await deps.getContext();
    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }
    const brandId = context.membership.brand.id;

    const provider = normalizeOrderProviderFilter(query.provider);
    const financialStatus = normalizeOrderFinancialStatusFilter(query.financialStatus);
    const fulfillmentStatus = normalizeOrderFulfillmentStatusFilter(query.fulfillmentStatus);
    const connectionId = normalizeConnectionIdFilter(query.connectionId);
    const attributionFilter = normalizeAttributionFilter(query.attributed);
    const cursor = decodeCommerceOrderCursor(query.cursor);
    const limit = clampOrderListLimit(query.limit);

    // PHASE B — STRUCTURALLY INVALID input is rejected with a
    // machine-readable code rather than silently ignored. Silently dropping a
    // date filter would show the operator far more orders than they asked
    // for while the UI still displays the range as applied. See
    // `order-list.ts`'s VALIDATION POLICY block for why enum filters
    // deliberately stay lenient instead.
    const dateRange = parseOrderDateRange(query.dateFrom, query.dateTo);
    if (!dateRange.ok) {
      return NextResponse.json(
        {
          error:
            dateRange.code === "INVERTED_RANGE"
              ? '"dateFrom" must not be after "dateTo".'
              : '"dateFrom" and "dateTo" must be valid timestamps.',
          code: dateRange.code,
        },
        { status: 400 },
      );
    }

    const orderNumberSearch = normalizeOrderNumberSearch(query.orderNumber);
    if (!orderNumberSearch.ok) {
      return NextResponse.json(
        {
          error: `"orderNumber" must be at most ${MAX_ORDER_NUMBER_SEARCH_LENGTH} characters.`,
          code: orderNumberSearch.code,
        },
        { status: 400 },
      );
    }

    const rows = await deps.findOrders({
      brandId,
      provider,
      financialStatus,
      fulfillmentStatus,
      connectionId,
      attributionWhere: buildAttributionWhere(attributionFilter),
      orderNumberWhere: buildOrderNumberWhere(orderNumberSearch.value),
      dateWhere: buildOrderDateWhere(dateRange.from, dateRange.to),
      cursorWhere: cursor ? buildCommerceOrderCursorWhere(cursor) : null,
      limit,
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;

    const data: BrandCommerceOrderListRow[] = page.map((row) => ({
      id: row.id,
      connectionId: row.connectionId,
      provider: row.provider,
      orderNumber: row.orderNumber,
      orderDate: resolveDisplayOrderDate(row.providerCreatedAt, row.createdAt).toISOString(),
      financialStatus: row.financialStatus,
      fulfillmentStatus: row.fulfillmentStatus,
      currencyCode: row.currencyCode,
      minorUnitExponent: row.minorUnitExponent,
      totalMinor: row.totalMinor === null ? null : row.totalMinor.toString(),
      totalRefundedMinor:
        row.totalRefundedMinor === null ? null : row.totalRefundedMinor.toString(),
      netRevenueMinor: row.netRevenueMinor === null ? null : row.netRevenueMinor.toString(),
      attributed: row.attributionId !== null,
      updatedAt: row.updatedAt.toISOString(),
    }));

    const last = page[page.length - 1];
    const nextCursor =
      hasNextPage && last
        ? encodeCommerceOrderCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;

    return NextResponse.json({
      data,
      meta: { hasNextPage, nextCursor, limit },
    });
  } catch (error) {
    console.error("[brand/commerce/orders][GET] Error:", error);
    return NextResponse.json({ error: "Failed to load orders." }, { status: 500 });
  }
}
