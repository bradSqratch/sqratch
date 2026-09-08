/**
 * src/lib/commerce/public-shop-pagination.ts
 *
 * PHASE 29 — bounded, cursor-paginated public Experience shop catalog.
 *
 * ===========================================================================
 * THE PROBLEM THIS REPLACES
 * ===========================================================================
 * `GET /api/public/experience/[experienceSlug]/products` previously fetched
 * EVERY eligible product for every visible campaign and every visible brand
 * storefront in one request, with no `take:` anywhere, and let the browser
 * slice the full array into pages. For a brand with a large catalog this was
 * an unbounded public, anonymous-accessible payload and an unbounded Prisma
 * result set.
 *
 * ===========================================================================
 * WHY THIS IS NOT A SINGLE-TABLE KEYSET PROBLEM
 * ===========================================================================
 * The unpaginated response is a UNION of independently-sourced, independently
 * ORDERED, and cross-deduplicated result sets:
 *
 *   - one "block" per visible CAMPAIGN (CampaignCommerceProduct rows,
 *     ordered by displayOrder/title/brandCommerceProductId), and
 *   - one "block" per distinct visible BRAND storefront (BrandCommerceProduct
 *     rows, ordered by displayOrder/title/connectedProductId), which
 *     EXCLUDES any product already shown as campaign-scoped.
 *
 * These blocks are CONCATENATED, not merged: every campaign block precedes
 * every storefront block, regardless of each row's own `displayOrder`. A
 * single flat `ORDER BY` across all sources cannot express this — the
 * business rule is "campaign-scoped first, in campaign order; then brand
 * storefront, deduplicated" — so pagination here is BLOCK-AWARE keyset
 * pagination: a cursor identifies (which block, and where within that
 * block's own keyset ordering).
 *
 * ===========================================================================
 * THE STOREFRONT EXCLUSION SET
 * ===========================================================================
 * A storefront block must exclude every `BrandCommerceProduct.id` that is
 * ALSO an authorized, active campaign assignment for one of this
 * Experience's visible campaigns — otherwise the same product could appear
 * twice (once campaign-scoped, once generic) as a shopper pages through both
 * blocks, or worse, appear as a duplicate on the SAME response if a page
 * happens to straddle both.
 *
 * This exclusion set must be complete — computed across ALL visible
 * campaigns, not just the block currently being paged — because dedup is a
 * GLOBAL invariant, not a per-page one: a shopper five pages into the
 * storefront block must not see a product that a DIFFERENT (already-served)
 * campaign page already showed.
 *
 * It is recomputed on every request rather than cached, but it is DELIBERATELY
 * NARROW: only `BrandCommerceProduct.id` plus the columns needed to
 * reapply `isCampaignAssignmentCatalogAuthorized` as defense in depth (see
 * `campaign-assignment-authorization.ts`) are selected — never title, image,
 * description, or price. This is architecturally different from the
 * unbounded-payload defect being fixed: it is a narrow, indexed,
 * authorization-shaped id lookup, not the expensive per-card presentation
 * data, and its result is NEVER returned to the client.
 *
 * ===========================================================================
 * CURSOR SHAPE
 * ===========================================================================
 * `{ blockIndex, displayOrder, sortKey, catalogId }`. `blockIndex` is this
 * request's position in the deterministic block ordering (campaign blocks in
 * campaign order, then storefront blocks in brand order — see the route for
 * exactly how blocks are assigned). `sortKey` is the row's product title —
 * kept as a generic name because a CAMPAIGN block's tiebreak column
 * (`BrandCommerceProduct.id`) differs from a STOREFRONT block's
 * (`ConnectedCommerceProduct.id`), and `catalogId` carries whichever one this
 * block kind actually orders by. The cursor is opaque to the client; only the
 * server ever interprets `catalogId`'s meaning, keyed off `blockIndex`.
 *
 * A cursor's `blockIndex` referring to a block that no longer exists (the
 * dataset changed between page loads — e.g. an operator unassigned a
 * campaign mid-browsing) is handled by treating the page as exhausted rather
 * than erroring: correctness guarantees (no duplicates, no missing rows) are
 * for an UNCHANGED dataset, matching every other keyset cursor in this
 * repository (see `order-list.ts`, `order-activity.ts`). A live edit
 * mid-pagination is rare and must never crash a public, anonymous page.
 */

export type PublicShopBlockCursor = {
  blockIndex: number;
  displayOrder: number;
  sortKey: string;
  catalogId: string;
};

export function encodePublicShopCursor(cursor: PublicShopBlockCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** Malformed input decodes to `null` (treated as "start from the top"), never thrown. */
export function decodePublicShopCursor(raw: string | null): PublicShopBlockCursor | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.blockIndex !== "number" ||
      !Number.isInteger(record.blockIndex) ||
      record.blockIndex < 0
    ) {
      return null;
    }
    if (typeof record.displayOrder !== "number" || !Number.isFinite(record.displayOrder)) {
      return null;
    }
    if (typeof record.sortKey !== "string") {
      return null;
    }
    if (typeof record.catalogId !== "string" || record.catalogId === "") {
      return null;
    }
    return {
      blockIndex: record.blockIndex,
      displayOrder: record.displayOrder,
      sortKey: record.sortKey,
      catalogId: record.catalogId,
    };
  } catch {
    return null;
  }
}

/**
 * Card payloads here carry images and descriptions — heavier than an order
 * row — so the ceiling is deliberately lower than the generic
 * `MAX_ORDER_LIST_LIMIT`/`MAX_ORDER_ACTIVITY_LIMIT` (100). 24 tiles evenly on
 * both the 2-column and 3-column grid breakpoints the shop UI actually uses.
 */
export const DEFAULT_PUBLIC_SHOP_LIMIT = 24;
export const MAX_PUBLIC_SHOP_LIMIT = 60;

export function clampPublicShopLimit(raw: string | null): number {
  if (!raw) {
    return DEFAULT_PUBLIC_SHOP_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_PUBLIC_SHOP_LIMIT;
  }
  return Math.min(parsed, MAX_PUBLIC_SHOP_LIMIT);
}

/** One row as far as pagination cares — the fields needed for ordering/cursoring. */
export type PublicShopPageRow<T> = {
  displayOrder: number;
  sortKey: string;
  catalogId: string;
  item: T;
};

export type PublicShopBlock = { blockIndex: number };

export type PublicShopPaginationDeps<T> = {
  blockCount: number;
  /**
   * Fetches up to `limit` rows from block `blockIndex`, strictly after
   * `cursor` under that block's own keyset ordering (or from the block's
   * start when `cursor` is `null`). MUST return rows in ascending
   * `(displayOrder, sortKey, catalogId)` order — the same order every other
   * keyset helper in this repository assumes.
   */
  fetchBlockPage(
    blockIndex: number,
    cursor: PublicShopBlockCursor | null,
    limit: number,
  ): Promise<Array<PublicShopPageRow<T>>>;
};

export type PublicShopPage<T> = {
  items: T[];
  hasNextPage: boolean;
  nextCursor: PublicShopBlockCursor | null;
};

/**
 * PURE ORCHESTRATION over injected block fetchers — no Prisma import here, so
 * the block-walking/hasNextPage logic is unit-testable with fakes exactly
 * like `order-ingestion.ts`'s dependency-injected core.
 *
 * Walks blocks in order starting from the cursor's block (or block 0),
 * accumulating rows until `limit` is reached or every block is exhausted.
 * `hasNextPage` is proven, never guessed: if a page fills EXACTLY at a block
 * boundary, the next block (if any) is probed with a 1-row peek before
 * answering `hasNextPage` — a page must never claim more data exists when it
 * does not, and must never claim exhaustion while a later, currently-empty
 * block conceals a nonempty one after it.
 */
export async function resolvePublicShopPage<T>(
  options: { cursor: PublicShopBlockCursor | null; limit: number },
  deps: PublicShopPaginationDeps<T>,
): Promise<PublicShopPage<T>> {
  const { cursor, limit } = options;
  const items: T[] = [];
  let lastRow: PublicShopPageRow<T> | null = null;
  let lastBlockIndex = 0;

  // A cursor pointing at a block that no longer exists (dataset changed
  // between page loads) is treated as "nothing more to show" rather than an
  // error — see the file header.
  if (cursor && cursor.blockIndex >= deps.blockCount) {
    return { items: [], hasNextPage: false, nextCursor: null };
  }

  let startBlockIndex = cursor ? cursor.blockIndex : 0;
  if (startBlockIndex < 0) {
    startBlockIndex = 0;
  }

  let hasNextPage = false;

  for (let blockIndex = startBlockIndex; blockIndex < deps.blockCount; blockIndex++) {
    const remaining = limit - items.length;
    if (remaining <= 0) {
      break;
    }

    const withinBlockCursor = cursor && blockIndex === cursor.blockIndex ? cursor : null;
    // Over-fetch by one to distinguish "this block has exactly `remaining`
    // more rows" from "this block has more than `remaining`" without a
    // second round trip in the common case.
    const rows = await deps.fetchBlockPage(blockIndex, withinBlockCursor, remaining + 1);

    if (rows.length > remaining) {
      for (const row of rows.slice(0, remaining)) {
        items.push(row.item);
        lastRow = row;
      }
      lastBlockIndex = blockIndex;
      hasNextPage = true;
      break;
    }

    for (const row of rows) {
      items.push(row.item);
      lastRow = row;
    }
    lastBlockIndex = blockIndex;

    if (items.length === limit) {
      // Filled exactly at this block's own end (or exactly filled without
      // exhausting it — impossible here since rows.length <= remaining means
      // this block contributed everything it had). Prove whether more data
      // exists later rather than guessing from block count alone.
      hasNextPage = await probeForMoreRows(blockIndex + 1, deps);
      break;
    }
    // Otherwise this block is exhausted; continue into the next block from
    // its own start.
  }

  const nextCursor =
    hasNextPage && lastRow
      ? {
          blockIndex: lastBlockIndex,
          displayOrder: lastRow.displayOrder,
          sortKey: lastRow.sortKey,
          catalogId: lastRow.catalogId,
        }
      : null;

  return { items, hasNextPage, nextCursor: hasNextPage ? nextCursor : null };
}

/** A 1-row peek per remaining block, stopping at the first nonempty one. */
async function probeForMoreRows<T>(
  fromBlockIndex: number,
  deps: PublicShopPaginationDeps<T>,
): Promise<boolean> {
  for (let blockIndex = fromBlockIndex; blockIndex < deps.blockCount; blockIndex++) {
    const rows = await deps.fetchBlockPage(blockIndex, null, 1);
    if (rows.length > 0) {
      return true;
    }
  }
  return false;
}
