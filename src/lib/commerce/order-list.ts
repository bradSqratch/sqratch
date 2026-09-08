/**
 * src/lib/commerce/order-list.ts
 *
 * PHASE 18 — PART 7: the canonical, provider-neutral Brand order list.
 * Pure cursor/filter helpers only — no I/O — mirroring the established
 * keyset-pagination pattern in `./product-catalog-api.ts`
 * (`SyncRunListCursor` / `encodeSyncRunCursor` / `buildSyncRunCursorWhere`).
 *
 * CURSOR FIELD CHOICE: `createdAt` (SQRATCH's own ingestion timestamp, NOT
 * NULL, `@default(now())`) rather than `providerCreatedAt` (nullable — a
 * malformed/partial ingest can leave it null, which would break strict
 * keyset ordering). `createdAt` is used ONLY for pagination correctness;
 * the DISPLAYED "order date" field falls back to `providerCreatedAt` first
 * (the semantically correct "when the order was placed") and only to
 * `createdAt` when the provider value is unknown — see
 * `resolveDisplayOrderDate` below.
 *
 * NO NEW INDEX EXISTS for `(brandId, createdAt)` — only
 * `(brandId, providerCreatedAt)` is indexed today. This is a known,
 * accepted v1 limitation (a full brand-scoped scan sorted by `createdAt`),
 * not silently ignored: see the PROPOSED SCHEMA CHANGE in the final round
 * report for the exact index that would resolve it. No migration was
 * created for it per this round's explicit schema-change prohibition.
 */

import type {
  CommerceOrderFinancialStatus,
  CommerceOrderFulfillmentStatus,
  CommerceProvider,
  Prisma,
} from "@prisma/client";

export type CommerceOrderListCursor = { createdAt: string; id: string };

export function encodeCommerceOrderCursor(cursor: CommerceOrderListCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCommerceOrderCursor(raw: string | null): CommerceOrderListCursor | null {
  if (!raw) {
    return null;
  }
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Record<string, unknown>).createdAt === "string" &&
      typeof (parsed as Record<string, unknown>).id === "string"
    ) {
      const createdAt = (parsed as CommerceOrderListCursor).createdAt;
      if (Number.isNaN(new Date(createdAt).getTime())) {
        return null;
      }
      return { createdAt, id: (parsed as CommerceOrderListCursor).id };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Keyset predicate for "strictly before this (createdAt, id)" under
 * `orderBy: [{createdAt:"desc"},{id:"desc"}]`.
 */
export function buildCommerceOrderCursorWhere(
  cursor: CommerceOrderListCursor,
): Prisma.CommerceOrderWhereInput {
  const createdAt = new Date(cursor.createdAt);
  return {
    OR: [
      { createdAt: { lt: createdAt } },
      { AND: [{ createdAt }, { id: { lt: cursor.id } }] },
    ],
  };
}

export const DEFAULT_ORDER_LIST_LIMIT = 25;
export const MAX_ORDER_LIST_LIMIT = 100;

export function clampOrderListLimit(raw: string | null): number {
  if (!raw) {
    return DEFAULT_ORDER_LIST_LIMIT;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return DEFAULT_ORDER_LIST_LIMIT;
  }
  return Math.min(parsed, MAX_ORDER_LIST_LIMIT);
}

/** Accepts only a real `CommerceProvider` value; anything else is ignored (no filter applied), never silently mistreated as a match-nothing filter. */
export function normalizeOrderProviderFilter(
  raw: string | null,
): CommerceProvider | null {
  if (raw === "SHOPIFY" || raw === "COMMERCE7") {
    return raw;
  }
  return null;
}

const VALID_FINANCIAL_STATUSES = new Set<CommerceOrderFinancialStatus>([
  "PENDING",
  "AUTHORIZED",
  "PARTIALLY_PAID",
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "VOIDED",
]);

export function normalizeOrderFinancialStatusFilter(
  raw: string | null,
): CommerceOrderFinancialStatus | null {
  if (raw && VALID_FINANCIAL_STATUSES.has(raw as CommerceOrderFinancialStatus)) {
    return raw as CommerceOrderFinancialStatus;
  }
  return null;
}

export type AttributionFilter = "attributed" | "unattributed" | null;

export function normalizeAttributionFilter(raw: string | null): AttributionFilter {
  if (raw === "attributed" || raw === "unattributed") {
    return raw;
  }
  return null;
}

export function buildAttributionWhere(
  filter: AttributionFilter,
): Prisma.CommerceOrderWhereInput {
  if (filter === "attributed") {
    return { attributionId: { not: null } };
  }
  if (filter === "unattributed") {
    return { attributionId: null };
  }
  return {};
}

/**
 * The "order date" a Brand Admin sees. Prefers the provider's own
 * timestamp (when the order was actually placed); falls back to SQRATCH's
 * ingestion timestamp only when the provider value is unknown — never
 * silently substitutes `null` -> a fabricated "now."
 */
export function resolveDisplayOrderDate(
  providerCreatedAt: Date | null,
  createdAt: Date,
): Date {
  return providerCreatedAt ?? createdAt;
}

// ---------------------------------------------------------------------------
// PHASE B — ORDER EXPLORER FILTERS
//
// Every helper below is PURE and provider-neutral. They exist so the route
// stays a thin validate-then-query shell and so each filter's exact
// semantics are unit-testable without a database.
//
// VALIDATION POLICY, stated once so it cannot drift filter by filter:
//
//   STRUCTURALLY INVALID input -> a 400 with a machine-readable code.
//   These are inputs a correct client never sends, and where silently
//   ignoring the filter would actively mislead (the operator would see an
//   unfiltered result set while the UI insists a filter is applied):
//     - a malformed timestamp
//     - an inverted range (from > to)
//     - an over-long order-number search
//
//   UNRECOGNIZED ENUM VALUE -> ignored, no filter applied. This preserves
//   the pre-existing, deliberately-documented contract of
//   `normalizeOrderProviderFilter` / `normalizeOrderFinancialStatusFilter`
//   ("anything else is ignored ... never silently mistreated as a
//   match-nothing filter"). The UI only ever emits values from a closed
//   dropdown, so this path is unreachable from the product surface, and an
//   unknown enum can never be turned into an injection or a match-nothing
//   query.
// ---------------------------------------------------------------------------

const VALID_FULFILLMENT_STATUSES = new Set<CommerceOrderFulfillmentStatus>([
  "UNFULFILLED",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
  "RESTOCKED",
]);

/** Mirrors `normalizeOrderFinancialStatusFilter` exactly — unknown values are ignored, never match-nothing. */
export function normalizeOrderFulfillmentStatusFilter(
  raw: string | null,
): CommerceOrderFulfillmentStatus | null {
  if (raw && VALID_FULFILLMENT_STATUSES.has(raw as CommerceOrderFulfillmentStatus)) {
    return raw as CommerceOrderFulfillmentStatus;
  }
  return null;
}

/**
 * Upper bound on the order-number search term.
 *
 * Order numbers are short provider-assigned identifiers (Shopify `#1001`,
 * Commerce7 `1002`), so anything long is malformed input rather than a real
 * search. Bounding it keeps an unbounded string out of a `contains` predicate.
 */
export const MAX_ORDER_NUMBER_SEARCH_LENGTH = 64;

export type OrderNumberSearchResult =
  | { ok: true; value: string | null }
  | { ok: false; code: "ORDER_NUMBER_TOO_LONG" };

/**
 * Validates the order-number search term.
 *
 * DELIBERATELY THE ONLY FREE-TEXT SEARCH THIS EXPLORER HAS. There is no
 * customer name/email/phone/address search and there must never be one:
 * `CommerceOrder` carries no customer field at all (see its model doc and
 * `order-ingestion.ts`'s NO PII header), and adding one would turn an
 * operations tool into a CRM lookup surface.
 */
export function normalizeOrderNumberSearch(raw: string | null): OrderNumberSearchResult {
  if (raw === null) {
    return { ok: true, value: null };
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { ok: true, value: null };
  }
  if (trimmed.length > MAX_ORDER_NUMBER_SEARCH_LENGTH) {
    return { ok: false, code: "ORDER_NUMBER_TOO_LONG" };
  }
  return { ok: true, value: trimmed };
}

/**
 * Case-insensitive substring match on the provider's own order number.
 * `contains` (not `equals`) because operators routinely paste a partial or
 * `#`-prefixed number.
 */
export function buildOrderNumberWhere(search: string | null): Prisma.CommerceOrderWhereInput {
  if (!search) {
    return {};
  }
  return { orderNumber: { contains: search, mode: "insensitive" } };
}

export type OrderDateRangeResult =
  | { ok: true; from: Date | null; to: Date | null }
  | { ok: false; code: "INVALID_DATE" | "INVERTED_RANGE" };

/**
 * Parses the `dateFrom`/`dateTo` filter.
 *
 * SEMANTICS, chosen once and documented rather than left implicit:
 *   - Both bounds are INCLUSIVE (`gte` / `lte`).
 *   - Both are optional and independent: either alone is a valid open-ended
 *     range.
 *   - A malformed timestamp is a 400 (`INVALID_DATE`), never silently
 *     dropped — an ignored date filter would show the operator far more
 *     orders than they asked for while the UI claims a range is applied.
 *   - An inverted range is a 400 (`INVERTED_RANGE`), never silently
 *     swapped. Auto-correcting input hides a real client bug and returns
 *     results the operator did not ask for.
 *
 * There is deliberately NO artificial cap on range WIDTH: the result set is
 * already bounded by `MAX_ORDER_LIST_LIMIT` plus keyset pagination, so a
 * wide range costs no more than a narrow one, and capping it would block the
 * legitimate "show me everything this year" case.
 */
export function parseOrderDateRange(
  rawFrom: string | null,
  rawTo: string | null,
): OrderDateRangeResult {
  const parse = (raw: string | null): Date | null | "INVALID" => {
    if (raw === null || raw.trim() === "") {
      return null;
    }
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? "INVALID" : parsed;
  };

  const from = parse(rawFrom);
  const to = parse(rawTo);
  if (from === "INVALID" || to === "INVALID") {
    return { ok: false, code: "INVALID_DATE" };
  }
  if (from && to && from.getTime() > to.getTime()) {
    return { ok: false, code: "INVERTED_RANGE" };
  }
  return { ok: true, from, to };
}

/**
 * Filters on the BUSINESS ORDER DATE — the same value
 * `resolveDisplayOrderDate` renders — rather than on SQRATCH's own
 * `createdAt` ingestion timestamp.
 *
 * WHY THE `OR`. The displayed order date is `providerCreatedAt ?? createdAt`,
 * which is not a single column. Filtering only on `createdAt` would be
 * plainly wrong for backfilled history (an order PLACED in June but
 * INGESTED in August would vanish from a June filter); filtering only on
 * `providerCreatedAt` would silently drop every row where the provider
 * reported no timestamp. So the predicate matches the fallback exactly:
 *   - rows WITH a provider timestamp are compared on it, and
 *   - rows WITHOUT one fall back to `createdAt`,
 * which is precisely what the operator sees in the Date column.
 *
 * A Prisma comparison on a NULL column never matches, so the first branch
 * inherently excludes null-`providerCreatedAt` rows and the two branches
 * cannot double-count.
 *
 * The first branch is served by the existing `@@index([brandId,
 * providerCreatedAt])`.
 */
export function buildOrderDateWhere(
  from: Date | null,
  to: Date | null,
): Prisma.CommerceOrderWhereInput {
  if (!from && !to) {
    return {};
  }
  const range = {
    ...(from ? { gte: from } : {}),
    ...(to ? { lte: to } : {}),
  };
  return {
    OR: [
      { providerCreatedAt: range },
      { AND: [{ providerCreatedAt: null }, { createdAt: range }] },
    ],
  };
}

export type OrderListWhereInput = {
  brandId: string;
  provider: CommerceProvider | null;
  financialStatus: CommerceOrderFinancialStatus | null;
  fulfillmentStatus: CommerceOrderFulfillmentStatus | null;
  connectionId: string | null;
  attributionWhere: Prisma.CommerceOrderWhereInput;
  orderNumberWhere: Prisma.CommerceOrderWhereInput;
  dateWhere: Prisma.CommerceOrderWhereInput;
  cursorWhere: Prisma.CommerceOrderWhereInput | null;
};

/**
 * PURE. Composes every filter into ONE Prisma `where`.
 *
 * WHY THIS IS A FUNCTION AND NOT AN INLINE OBJECT LITERAL. Several of these
 * predicates legitimately emit a TOP-LEVEL `OR` — the business-date range
 * does, and so does the cursor keyset. Object-spreading two of them into one
 * literal (`{ ...dateWhere, ...cursorWhere }`) would have the second `OR`
 * silently OVERWRITE the first, which either drops a filter or, far worse,
 * breaks keyset pagination into repeated/skipped rows. `AND` composes them
 * correctly and keeps composing correctly as predicates are added.
 *
 * Extracted so that exact composition is unit-testable without a database —
 * it is the single riskiest line in the list route and was previously
 * unreachable by any test.
 *
 * `brandId` is ALWAYS applied and is never derived from client input.
 */
export function buildOrderListWhere(input: OrderListWhereInput): Prisma.CommerceOrderWhereInput {
  return {
    brandId: input.brandId,
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.financialStatus ? { financialStatus: input.financialStatus } : {}),
    ...(input.fulfillmentStatus ? { fulfillmentStatus: input.fulfillmentStatus } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
    AND: [
      input.attributionWhere,
      input.orderNumberWhere,
      input.dateWhere,
      ...(input.cursorWhere ? [input.cursorWhere] : []),
    ],
  };
}

/**
 * Validates a caller-supplied connection id.
 *
 * NOT an authorization check and never treated as one — the query is ALWAYS
 * additionally scoped by the authenticated `brandId`, so a well-formed id
 * belonging to another Brand simply matches nothing rather than exposing a
 * row. This only rejects structurally impossible input before it reaches a
 * query.
 */
export function normalizeConnectionIdFilter(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed.length > 64) {
    return null;
  }
  return trimmed;
}
