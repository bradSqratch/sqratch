/**
 * src/lib/commerce/order-activity.ts
 *
 * PHASE C — a SANITIZED, bounded, provider-neutral view of the
 * `CommerceOrderEvent` ledger for one commerce connection.
 *
 * WHY THIS EXISTS. Answering "what actually happened to this order event?"
 * previously required Vercel logs or direct SQL. Both are operator-hostile
 * and neither is available to a Brand Admin. The ledger already records
 * everything needed; it simply had no safe read surface.
 *
 * ===========================================================================
 * CURRENT ORDER STATE vs EVENT HISTORY — THE CENTRAL DISTINCTION
 * ===========================================================================
 * These are DIFFERENT CONCEPTS and this module never conflates them.
 *
 * The real case that motivated it: Commerce7 refund child #1003 produced a
 * webhook event that FAILED with `CONTRADICTORY_FINANCIAL_SNAPSHOT` under an
 * older interpretation of Commerce7's refund model. Later, a reconciliation
 * run PROCESSED root order #1002 and repaired it to
 * `PARTIALLY_REFUNDED / 9831 / 3277 / 6554`.
 *
 * Both facts are true and both must remain visible:
 *   - the historical FAILED event is genuine audit evidence and is NEVER
 *     deleted, mutated, or hidden merely because a later run succeeded;
 *   - the order's CURRENT canonical state is correct and must NOT be
 *     described as broken because an older event failed.
 *
 * So this module returns HISTORY ONLY. It deliberately reports no
 * "health"/"is-broken" verdict derived from event status — the canonical
 * order row is the single source of truth for current state, and the UI
 * shows the two side by side rather than letting one imply the other.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY NOT EXPOSED
 * ===========================================================================
 *   - `payloadDigest` — proves which bytes were processed; an operator has
 *     no use for it and it is a fingerprint of the raw body.
 *   - `providerEventId` — a provider/transport-internal delivery id with no
 *     operator meaning. Omitted per "unless truly required"; it is not.
 *   - Anything derived from the raw webhook body, headers, Basic Auth, HMAC,
 *     access tokens, or `providerMetadata`. None of these are even selected.
 *   - Customer fields — `CommerceOrderEvent` has none to begin with.
 *
 * `externalOrderRef` IS included, deliberately: it is the PROVIDER'S ORDER
 * IDENTIFIER (never customer data), and without it the #1003 case above
 * renders as an anonymous failure an operator cannot act on. It is the only
 * way to see that a failed event concerned the refund document rather than
 * the root order.
 *
 * `failureSummary` is already contractually a "short, classified, bounded
 * failure tag. Never an error object, response body, URL, or payload
 * excerpt" (see the model), so it is safe to surface verbatim.
 */

import type { CommerceOrderEventStatus, CommerceProvider } from "@prisma/client";
import { classifyOrderEventTopic, type OrderEventCategory } from "./order-operations-summary";

export type BrandCommerceOrderActivityEntry = {
  id: string;
  /** WEBHOOK / RECONCILIATION / OTHER — see `classifyOrderEventTopic`; OTHER fails closed. */
  category: OrderEventCategory;
  provider: CommerceProvider;
  status: CommerceOrderEventStatus;
  receivedAt: string;
  processedAt: string | null;
  /** The provider's own version of the order this event carried, when known. */
  providerUpdatedAt: string | null;
  /** The PROVIDER's order identifier this event concerned. Never customer data — see the file header. */
  externalOrderRef: string | null;
  /** Short classified tag only, never an error object or payload excerpt. */
  failureSummary: string | null;
  /**
   * The canonical SQRATCH order this event resolved to, when it resolved to
   * one. `null` is meaningful and common — e.g. an event for a Commerce7
   * refund child, which by design never becomes a canonical order. Its
   * currency and exponent (never customer data) let a note's amount be
   * formatted exactly; `null` when unknown.
   */
  order: { id: string; orderNumber: string | null; currencyCode: string | null; minorUnitExponent: number | null } | null;
};

export type BrandCommerceOrderActivityPage = {
  entries: BrandCommerceOrderActivityEntry[];
  hasNextPage: boolean;
  nextCursor: string | null;
  limit: number;
};

export const DEFAULT_ORDER_ACTIVITY_LIMIT = 25;
export const MAX_ORDER_ACTIVITY_LIMIT = 100;

/** Bounded, exactly like the order list — an unbounded event history is never returned. */
export function clampOrderActivityLimit(raw: string | null): number {
  if (!raw) return DEFAULT_ORDER_ACTIVITY_LIMIT;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_ORDER_ACTIVITY_LIMIT;
  return Math.min(parsed, MAX_ORDER_ACTIVITY_LIMIT);
}

export type OrderActivityCursor = { receivedAt: string; id: string };

/**
 * Seek cursor on `(receivedAt, id)` — the exact ordering the query uses, and
 * backed by the existing `@@index([connectionId, receivedAt])`. `id` breaks
 * ties so two events sharing a millisecond can never be skipped or repeated.
 */
export function encodeOrderActivityCursor(cursor: OrderActivityCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeOrderActivityCursor(raw: string | null): OrderActivityCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.receivedAt !== "string" || typeof record.id !== "string") return null;
    if (Number.isNaN(new Date(record.receivedAt).getTime())) return null;
    return { receivedAt: record.receivedAt, id: record.id };
  } catch {
    return null;
  }
}

export type OrderActivityRow = {
  id: string;
  provider: CommerceProvider;
  topic: string;
  status: CommerceOrderEventStatus;
  receivedAt: Date;
  processedAt: Date | null;
  providerUpdatedAt: Date | null;
  externalOrderRef: string | null;
  failureSummary: string | null;
  order: { id: string; orderNumber: string | null; currencyCode?: string | null; minorUnitExponent?: number | null } | null;
};

export type BrandCommerceOrderActivityDeps = {
  /**
   * Resolves the connection ONLY when it belongs to this brand. Returning
   * `null` for a foreign id is what makes a foreign connection
   * indistinguishable from a nonexistent one (both 404), matching the
   * information-hiding convention the order-detail service already uses.
   */
  loadConnection(
    connectionId: string,
    brandId: string,
  ): Promise<{ id: string; provider: CommerceProvider } | null>;
  findEvents(input: {
    connectionId: string;
    brandId: string;
    cursor: OrderActivityCursor | null;
    limit: number;
  }): Promise<OrderActivityRow[]>;
};

/**
 * The ONLY columns ever read. `payloadDigest` and `providerEventId` are
 * absent by construction rather than filtered out later — a column that is
 * never selected cannot be leaked by a future refactor of the mapper.
 */
const ACTIVITY_SELECT = {
  id: true,
  provider: true,
  topic: true,
  status: true,
  receivedAt: true,
  processedAt: true,
  providerUpdatedAt: true,
  externalOrderRef: true,
  failureSummary: true,
  // Joined in the SAME query — never an N+1 lookup per event.
  order: { select: { id: true, orderNumber: true, currencyCode: true, minorUnitExponent: true } },
} as const;

async function defaultLoadConnection(connectionId: string, brandId: string) {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.commerceConnection.findFirst({
    where: { id: connectionId, brandId },
    select: { id: true, provider: true },
  });
}

async function defaultFindEvents(
  input: Parameters<BrandCommerceOrderActivityDeps["findEvents"]>[0],
): Promise<OrderActivityRow[]> {
  const { default: prisma } = await import("@/lib/prisma");
  const cursorWhere = input.cursor
    ? {
        OR: [
          { receivedAt: { lt: new Date(input.cursor.receivedAt) } },
          {
            AND: [
              { receivedAt: new Date(input.cursor.receivedAt) },
              { id: { lt: input.cursor.id } },
            ],
          },
        ],
      }
    : null;
  return prisma.commerceOrderEvent.findMany({
    // BOTH scopes, always. `brandId` comes from the authenticated context, so
    // a foreign `connectionId` can only ever match zero rows.
    //
    // The cursor keyset goes under `AND`, not an object spread. It emits a
    // top-level `OR`, so spreading it would be clobbered the moment any
    // future filter here also emits one — silently breaking pagination into
    // repeated/skipped rows. This mirrors `buildOrderListWhere`'s reasoning;
    // keeping both compositions the same shape means the landmine cannot be
    // reintroduced on one side only.
    where: {
      connectionId: input.connectionId,
      brandId: input.brandId,
      ...(cursorWhere ? { AND: [cursorWhere] } : {}),
    },
    orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    select: ACTIVITY_SELECT,
  });
}

const DEFAULT_DEPS: BrandCommerceOrderActivityDeps = {
  loadConnection: defaultLoadConnection,
  findEvents: defaultFindEvents,
};

/**
 * Returns one bounded page of sanitized activity, or `null` when the
 * connection does not exist OR does not belong to this brand (deliberately
 * indistinguishable — the caller turns both into the same 404).
 */
export async function getBrandCommerceOrderActivity(
  input: { connectionId: string; brandId: string; cursor: string | null; limit: number },
  deps: Partial<BrandCommerceOrderActivityDeps> = {},
): Promise<BrandCommerceOrderActivityPage | null> {
  const resolved: BrandCommerceOrderActivityDeps = { ...DEFAULT_DEPS, ...deps };

  const connection = await resolved.loadConnection(input.connectionId, input.brandId);
  if (!connection) {
    return null;
  }

  const rows = await resolved.findEvents({
    connectionId: input.connectionId,
    brandId: input.brandId,
    cursor: decodeOrderActivityCursor(input.cursor),
    limit: input.limit,
  });

  const hasNextPage = rows.length > input.limit;
  const page = hasNextPage ? rows.slice(0, input.limit) : rows;

  const entries: BrandCommerceOrderActivityEntry[] = page.map((row) => ({
    id: row.id,
    // Classified from the row's OWN provider, never the connection's, so a
    // historically mis-provisioned row is described by what it actually is.
    category: classifyOrderEventTopic(row.provider, row.topic),
    provider: row.provider,
    status: row.status,
    receivedAt: row.receivedAt.toISOString(),
    processedAt: row.processedAt?.toISOString() ?? null,
    providerUpdatedAt: row.providerUpdatedAt?.toISOString() ?? null,
    externalOrderRef: row.externalOrderRef,
    failureSummary: row.failureSummary,
    order: row.order
      ? { id: row.order.id, orderNumber: row.order.orderNumber, currencyCode: row.order.currencyCode ?? null, minorUnitExponent: row.order.minorUnitExponent ?? null }
      : null,
  }));

  const last = page[page.length - 1];
  return {
    entries,
    hasNextPage,
    nextCursor:
      hasNextPage && last
        ? encodeOrderActivityCursor({ receivedAt: last.receivedAt.toISOString(), id: last.id })
        : null,
    limit: input.limit,
  };
}
