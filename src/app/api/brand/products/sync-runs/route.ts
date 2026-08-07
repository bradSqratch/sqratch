import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import {
  buildSyncRunCursorWhere,
  clampLimit,
  decodeSyncRunCursor,
  DEFAULT_SYNC_RUN_LIST_LIMIT,
  encodeSyncRunCursor,
  MAX_SYNC_RUN_LIST_LIMIT,
} from "@/lib/commerce/product-catalog-api";

/**
 * `GET /api/brand/products/sync-runs` — recent `CommerceProductSyncRun` rows
 * for the brand, an audit surface. Only the already-sanitized
 * `failureSummary` (bounded, classified — see `product-sync.ts`'s
 * `classifySyncFailure`) is exposed; no raw error object, response body, or
 * provider payload is ever read or returned here.
 */

export type SyncRunRow = {
  id: string;
  connectionId: string;
  provider: string;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  markedUnavailableCount: number;
  failedCount: number;
  hasNextPage: boolean;
  requestedLimit: number | null;
  failureSummary: string | null;
  triggeredBy: string | null;
};

export type FindSyncRunsArgs = {
  brandId: string;
  connectionId: string | null;
  cursor: { startedAt: string; id: string } | null;
  limit: number;
};

export type BrandProductSyncRunsDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  connectionBelongsToBrand(brandId: string, connectionId: string): Promise<boolean>;
  findSyncRuns(args: FindSyncRunsArgs): Promise<SyncRunRow[]>;
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

async function defaultFindSyncRuns(args: FindSyncRunsArgs): Promise<SyncRunRow[]> {
  const where: Prisma.CommerceProductSyncRunWhereInput = {
    AND: [
      { brandId: args.brandId },
      ...(args.connectionId ? [{ connectionId: args.connectionId }] : []),
      ...(args.cursor ? [buildSyncRunCursorWhere(args.cursor)] : []),
    ],
  };

  return prisma.commerceProductSyncRun.findMany({
    where,
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    take: args.limit,
    select: {
      id: true,
      connectionId: true,
      provider: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      fetchedCount: true,
      createdCount: true,
      updatedCount: true,
      unchangedCount: true,
      markedUnavailableCount: true,
      failedCount: true,
      hasNextPage: true,
      requestedLimit: true,
      failureSummary: true,
      triggeredBy: true,
    },
  });
}

const DEFAULT_DEPS: BrandProductSyncRunsDeps = {
  getContext: getBrandManagementContext,
  connectionBelongsToBrand: defaultConnectionBelongsToBrand,
  findSyncRuns: defaultFindSyncRuns,
};

export async function GET(request: NextRequest) {
  return syncRunsListImpl(request);
}

export async function syncRunsListImpl(
  request: NextRequest,
  overrides: Partial<BrandProductSyncRunsDeps> = {},
) {
  const deps: BrandProductSyncRunsDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const context = await deps.getContext();

    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    // The ONLY brand id ever used below.
    const brand = context.membership.brand;

    const params = request.nextUrl.searchParams;
    const limit = clampLimit(
      params.get("limit"),
      DEFAULT_SYNC_RUN_LIST_LIMIT,
      MAX_SYNC_RUN_LIST_LIMIT,
    );
    const cursor = decodeSyncRunCursor(params.get("cursor"));
    const requestedConnectionId = params.get("connectionId");

    let connectionId: string | null = null;
    if (requestedConnectionId) {
      const belongsToBrand = await deps.connectionBelongsToBrand(brand.id, requestedConnectionId);
      if (!belongsToBrand) {
        return NextResponse.json({
          data: [],
          meta: { nextCursor: null, hasNextPage: false, limit },
        });
      }
      connectionId = requestedConnectionId;
    }

    const rows = await deps.findSyncRuns({
      brandId: brand.id,
      connectionId,
      cursor,
      limit: limit + 1,
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];
    const nextCursor =
      hasNextPage && lastRow
        ? encodeSyncRunCursor({ startedAt: lastRow.startedAt.toISOString(), id: lastRow.id })
        : null;

    return NextResponse.json({
      data: page,
      meta: { nextCursor, hasNextPage, limit },
    });
  } catch (error) {
    console.error("[brand/products/sync-runs][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load sync runs." },
      { status: 500 },
    );
  }
}
