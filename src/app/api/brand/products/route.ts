import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import {
  buildAvailabilityWhere,
  buildProductCursorWhere,
  buildSearchWhere,
  buildSelectionWhere,
  clampLimit,
  decodeProductCursor,
  DEFAULT_PRODUCT_LIST_LIMIT,
  encodeProductCursor,
  extractProviderStatus,
  MAX_PRODUCT_LIST_LIMIT,
  normalizeAvailabilityFilter,
  normalizeSelectionFilter,
} from "@/lib/commerce/product-catalog-api";

/**
 * `GET /api/brand/products` — the persisted catalog (`ConnectedCommerceProduct`)
 * joined with the brand's own selection state (`BrandCommerceProduct`),
 * scoped ENTIRELY to the server-resolved brand context. A `connectionId`
 * (or any other identifier) supplied by the client is only ever used as a
 * narrowing filter validated against the brand — never trusted as an
 * authorization boundary on its own.
 *
 * Uses keyset ("seek") pagination on `orderBy: [{title:"asc"},{id:"asc"}]`
 * rather than offset paging, because `ConnectedCommerceProduct` rows are
 * concurrently rewritten by `syncBrandCommerceProducts`
 * (`src/lib/commerce/product-sync.ts`) — offset paging over a table that's
 * being upserted mid-scroll silently drops and duplicates rows.
 */

export type BrandProductRow = {
  id: string;
  externalId: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  sku: string | null;
  isAvailable: boolean;
  lastSeenAt: Date;
  unavailableSince: Date | null;
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
  providerMetadata: Prisma.JsonValue | null;
  brandSelections: Array<{
    isVisibleInShop: boolean;
    isCampaignEligible: boolean;
    displayOrder: number;
    titleOverride: string | null;
    shortDescriptionOverride: string | null;
  }>;
};

export type FindProductsArgs = {
  brandId: string;
  connectionId: string | null;
  availability: ReturnType<typeof normalizeAvailabilityFilter>;
  selection: ReturnType<typeof normalizeSelectionFilter>;
  q: string | null;
  cursor: { title: string; id: string } | null;
  limit: number;
};

export type LastSyncRunSummary = {
  id: string;
  status: string;
  finishedAt: Date | null;
};

export type BrandProductsListDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  /** Validates `connectionId` belongs to `brandId`. Returns `false` for a missing or cross-tenant connection — the caller treats that identically to "no products", never a distinguishable error. */
  connectionBelongsToBrand(brandId: string, connectionId: string): Promise<boolean>;
  findProducts(args: FindProductsArgs): Promise<BrandProductRow[]>;
  getLastSyncRun(brandId: string, connectionId: string | null): Promise<LastSyncRunSummary | null>;
};

async function defaultConnectionBelongsToBrand(
  brandId: string,
  connectionId: string,
): Promise<boolean> {
  const connection = await prisma.commerceConnection.findFirst({
    where: { id: connectionId, brandId },
    select: { id: true },
  });
  return connection !== null;
}

async function defaultFindProducts(args: FindProductsArgs): Promise<BrandProductRow[]> {
  const where: Prisma.ConnectedCommerceProductWhereInput = {
    AND: [
      { brandId: args.brandId },
      ...(args.connectionId ? [{ connectionId: args.connectionId }] : []),
      buildAvailabilityWhere(args.availability),
      buildSelectionWhere(args.selection, args.brandId),
      buildSearchWhere(args.q),
      ...(args.cursor ? [buildProductCursorWhere(args.cursor)] : []),
    ],
  };

  return prisma.connectedCommerceProduct.findMany({
    where,
    orderBy: [{ title: "asc" }, { id: "asc" }],
    take: args.limit,
    select: {
      id: true,
      externalId: true,
      title: true,
      handle: true,
      productUrl: true,
      imageUrl: true,
      images: true,
      sku: true,
      isAvailable: true,
      lastSeenAt: true,
      unavailableSince: true,
      currencyCode: true,
      priceMinMinor: true,
      priceMaxMinor: true,
      priceMinorUnitExponent: true,
      providerMetadata: true,
      brandSelections: {
        where: { brandId: args.brandId },
        take: 1,
        select: {
          isVisibleInShop: true,
          isCampaignEligible: true,
          displayOrder: true,
          titleOverride: true,
          shortDescriptionOverride: true,
        },
      },
    },
  });
}

async function defaultGetLastSyncRun(
  brandId: string,
  connectionId: string | null,
): Promise<LastSyncRunSummary | null> {
  const run = await prisma.commerceProductSyncRun.findFirst({
    where: { brandId, ...(connectionId ? { connectionId } : {}) },
    orderBy: [{ startedAt: "desc" }],
    select: { id: true, status: true, finishedAt: true },
  });
  return run;
}

const DEFAULT_DEPS: BrandProductsListDeps = {
  getContext: getBrandManagementContext,
  connectionBelongsToBrand: defaultConnectionBelongsToBrand,
  findProducts: defaultFindProducts,
  getLastSyncRun: defaultGetLastSyncRun,
};

/**
 * Maps a persisted row to the wire shape. ONLY the fields listed in the
 * type below are ever included — `providerMetadata` (raw JSON) is consumed
 * ONLY to extract the whitelisted `status` string via `extractProviderStatus`
 * and is never itself serialized.
 */
function serializeProduct(row: BrandProductRow) {
  const selection = row.brandSelections[0] ?? null;

  return {
    id: row.id,
    externalId: row.externalId,
    title: row.title,
    handle: row.handle,
    productUrl: row.productUrl,
    imageUrl: row.imageUrl,
    images: row.images,
    sku: row.sku,
    status: extractProviderStatus(row.providerMetadata),
    isAvailable: row.isAvailable,
    lastSeenAt: row.lastSeenAt,
    unavailableSince: row.unavailableSince,
    price: {
      minMinor: row.priceMinMinor,
      maxMinor: row.priceMaxMinor,
      currencyCode: row.currencyCode,
      minorUnitExponent: row.priceMinorUnitExponent,
    },
    selection: {
      isVisibleInShop: selection?.isVisibleInShop ?? false,
      isCampaignEligible: selection?.isCampaignEligible ?? false,
      displayOrder: selection?.displayOrder ?? 0,
      titleOverride: selection?.titleOverride ?? null,
      shortDescriptionOverride: selection?.shortDescriptionOverride ?? null,
    },
  };
}

export async function GET(request: NextRequest) {
  return listProductsImpl(request);
}

export async function listProductsImpl(
  request: NextRequest,
  overrides: Partial<BrandProductsListDeps> = {},
) {
  const deps: BrandProductsListDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const context = await deps.getContext();

    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    // The ONLY brand id ever used below. Any `brandId` present in the query
    // string is deliberately never read.
    const brand = context.membership.brand;

    const params = request.nextUrl.searchParams;
    const limit = clampLimit(params.get("limit"), DEFAULT_PRODUCT_LIST_LIMIT, MAX_PRODUCT_LIST_LIMIT);
    const availability = normalizeAvailabilityFilter(params.get("availability"));
    const selection = normalizeSelectionFilter(params.get("selection"));
    const q = params.get("q");
    const cursor = decodeProductCursor(params.get("cursor"));
    const requestedConnectionId = params.get("connectionId");

    let connectionId: string | null = null;
    if (requestedConnectionId) {
      const belongsToBrand = await deps.connectionBelongsToBrand(brand.id, requestedConnectionId);
      if (!belongsToBrand) {
        // A connectionId that doesn't exist, or belongs to another brand,
        // is indistinguishable from a connectionId with zero products —
        // return an empty page rather than leaking cross-tenant existence.
        return NextResponse.json({
          data: [],
          meta: { nextCursor: null, hasNextPage: false, limit, lastSyncRun: null },
        });
      }
      connectionId = requestedConnectionId;
    }

    const rows = await deps.findProducts({
      brandId: brand.id,
      connectionId,
      availability,
      selection,
      q,
      cursor,
      limit: limit + 1,
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];
    const nextCursor =
      hasNextPage && lastRow ? encodeProductCursor({ title: lastRow.title, id: lastRow.id }) : null;

    const lastSyncRun = await deps.getLastSyncRun(brand.id, connectionId);

    return NextResponse.json({
      data: page.map(serializeProduct),
      meta: {
        nextCursor,
        hasNextPage,
        limit,
        lastSyncRun,
      },
    });
  } catch (error) {
    console.error("[brand/products][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load products." },
      { status: 500 },
    );
  }
}
