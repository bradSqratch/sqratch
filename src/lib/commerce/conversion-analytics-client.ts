/**
 * src/lib/commerce/conversion-analytics-client.ts
 *
 * PHASE 24 — pure, DB-free, network-free response types and runtime
 * validators for `GET /api/brand/analytics/conversions` and
 * `GET /api/creator/analytics/conversions`. Same idiom as
 * `src/app/(withSidebar)/dashboard/brand/commerce/commerce-response-validation.ts`
 * and `product-catalog-helpers.ts`: kept separate from the page components so
 * they are unit-testable with `node:test` and no DOM (this repo has no React
 * testing library), and so a malformed server response fails into a
 * controlled UI error rather than "Cannot read properties of undefined."
 *
 * Both routes serialize `{ data: T }` — `fetchJson`
 * (`@/components/experience/client-utils`) already unwraps that envelope, so
 * every parser here validates the ALREADY-UNWRAPPED value.
 *
 * MONEY IS ALWAYS AN ARRAY, GROUPED BY CURRENCY. `MoneyRow[]` mirrors
 * `MinorByCurrencyRow[]` from `order-analytics.ts` exactly (decimal-string
 * `minor`, never a parsed number, so a value beyond `Number.MAX_SAFE_INTEGER`
 * is never silently corrupted in transit). No helper in this file ever sums
 * two `MoneyRow`s together — see `formatMoneyRows` below, which renders each
 * currency independently and is the ONLY intended rendering path for one of
 * these arrays.
 */

import { formatMoneyDisplay, getCurrencyExponent } from "./money";

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export type ConversionRange = { start: string; end: string };

export type MoneyRow = { currencyCode: string; minor: string };

export type ConversionCounts = {
  totalIngestedOrders: number;
  attributedOrders: number;
  currentlyNetPositivePaidOrders: number;
  pendingOrAuthorizedOrders: number;
  partiallyRefundedOrders: number;
  fullyRefundedOrders: number;
};

/** A dimension resolved (or not) to a display name — see `conversion-breakdown-naming.ts`. */
export type NamedBreakdownRow = { id: string; name: string | null; orders: number };

export type ProviderBreakdownRow = { id: string; orders: number };

const COUNT_FIELDS: readonly (keyof ConversionCounts)[] = [
  "totalIngestedOrders",
  "attributedOrders",
  "currentlyNetPositivePaidOrders",
  "pendingOrAuthorizedOrders",
  "partiallyRefundedOrders",
  "fullyRefundedOrders",
];

function isValidCounts(record: Record<string, unknown>): record is Record<string, unknown> & ConversionCounts {
  return COUNT_FIELDS.every((field) => typeof record[field] === "number" && Number.isFinite(record[field]));
}

function isMoneyRow(value: unknown): value is MoneyRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.currencyCode === "string" && typeof row.minor === "string";
}

function isMoneyRowArray(value: unknown): value is MoneyRow[] {
  return Array.isArray(value) && value.every(isMoneyRow);
}

function isNamedBreakdownRow(value: unknown): value is NamedBreakdownRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    (row.name === null || typeof row.name === "string") &&
    typeof row.orders === "number"
  );
}

function isNamedBreakdownArray(value: unknown): value is NamedBreakdownRow[] {
  return Array.isArray(value) && value.every(isNamedBreakdownRow);
}

function isProviderBreakdownRow(value: unknown): value is ProviderBreakdownRow {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === "string" && typeof row.orders === "number";
}

function isProviderBreakdownArray(value: unknown): value is ProviderBreakdownRow[] {
  return Array.isArray(value) && value.every(isProviderBreakdownRow);
}

function isRange(value: unknown): value is ConversionRange {
  if (!value || typeof value !== "object") return false;
  const range = value as Record<string, unknown>;
  return typeof range.start === "string" && typeof range.end === "string";
}

const REVENUE_FIELDS = [
  "grossAttributedRevenueByCurrency",
  "refundedRevenueByCurrency",
  "netAttributedRevenueByCurrency",
] as const;

// ---------------------------------------------------------------------------
// Brand response — GET /api/brand/analytics/conversions
// ---------------------------------------------------------------------------

export type BrandConversionAnalytics = ConversionCounts & {
  range: ConversionRange;
  grossAttributedRevenueByCurrency: MoneyRow[];
  refundedRevenueByCurrency: MoneyRow[];
  netAttributedRevenueByCurrency: MoneyRow[];
  attributedOrdersByProvider: ProviderBreakdownRow[];
  /**
   * Already brand-owned-only by construction (the route drops a foreign
   * entry campaign before aggregation — see the route's `ownedCampaignId`).
   * There is deliberately no "other brand's campaign" bucket here: a foreign
   * entry campaign still counts toward `attributedOrders` above, it simply
   * has nothing to name in this breakdown.
   */
  attributedOrdersByEntryCampaign: NamedBreakdownRow[];
  attributedOrdersByProductCampaign: NamedBreakdownRow[];
  attributedOrdersByExperience: NamedBreakdownRow[];
  attributedOrdersByCreator: NamedBreakdownRow[];
  attributedOrdersByLesson: NamedBreakdownRow[];
  attributedOrdersByProduct: NamedBreakdownRow[];
};

export function parseBrandConversionAnalytics(data: unknown): BrandConversionAnalytics | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!isRange(record.range)) return null;
  if (!isValidCounts(record)) return null;
  if (!REVENUE_FIELDS.every((field) => isMoneyRowArray(record[field]))) return null;
  if (!isProviderBreakdownArray(record.attributedOrdersByProvider)) return null;
  const namedFields = [
    "attributedOrdersByEntryCampaign",
    "attributedOrdersByProductCampaign",
    "attributedOrdersByExperience",
    "attributedOrdersByCreator",
    "attributedOrdersByLesson",
    "attributedOrdersByProduct",
  ] as const;
  if (!namedFields.every((field) => isNamedBreakdownArray(record[field]))) return null;
  return data as BrandConversionAnalytics;
}

// ---------------------------------------------------------------------------
// Creator response — GET /api/creator/analytics/conversions
//
// Deliberately NO entry/product campaign fields in this type: the route
// always nulls those dimensions out before aggregation (a creator's clicks
// can legitimately carry a sponsoring brand's campaign id, which belongs to
// the brand, not the creator), so `buildConversionAnalytics` always returns
// them empty here. A permissive parser that ignores extra fields is exactly
// right — the raw response may still carry the two empty arrays, and this
// type simply never names them, so the Creator page has no field to render
// them from and cannot accidentally present "0 campaign performance" (see
// that page's own doc comment for why an empty array is not the same claim
// as "deliberately withheld").
// ---------------------------------------------------------------------------

export type CreatorConversionAnalytics = ConversionCounts & {
  range: ConversionRange;
  grossAttributedRevenueByCurrency: MoneyRow[];
  refundedRevenueByCurrency: MoneyRow[];
  netAttributedRevenueByCurrency: MoneyRow[];
  attributedOrdersByProvider: ProviderBreakdownRow[];
  attributedOrdersByExperience: NamedBreakdownRow[];
  attributedOrdersByLesson: NamedBreakdownRow[];
  attributedOrdersByProduct: NamedBreakdownRow[];
  /** Echoes the validated, ownership-checked filter actually applied — never raw request input. */
  filters: { experienceId: string | null };
};

export function parseCreatorConversionAnalytics(data: unknown): CreatorConversionAnalytics | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!isRange(record.range)) return null;
  if (!isValidCounts(record)) return null;
  if (!REVENUE_FIELDS.every((field) => isMoneyRowArray(record[field]))) return null;
  if (!isProviderBreakdownArray(record.attributedOrdersByProvider)) return null;
  const namedFields = [
    "attributedOrdersByExperience",
    "attributedOrdersByLesson",
    "attributedOrdersByProduct",
  ] as const;
  if (!namedFields.every((field) => isNamedBreakdownArray(record[field]))) return null;
  const filters = record.filters as Record<string, unknown> | undefined;
  if (!filters || (filters.experienceId !== null && typeof filters.experienceId !== "string")) return null;
  return data as CreatorConversionAnalytics;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/** Best-effort label for a `CommerceProvider` value. An unrecognized/future value renders as-is rather than crashing. */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  SHOPIFY: "Shopify",
  COMMERCE7: "Commerce7",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * The exponent used to render a `MoneyRow`. Every persisted order money
 * column is denominated in the connection's OWN currency at whatever
 * exponent that currency actually uses (see `money.ts`'s
 * `getCurrencyExponent`) — this reuses that resolution exactly rather than
 * hardcoding `/100` (see `formatMoneyDisplay`'s own header for why that would
 * silently misrender JPY/KWD-style currencies).
 *
 * `UNKNOWN` (the aggregator's bucket for a row whose own currency could not
 * be resolved — see `order-analytics.ts`) is handled by the caller BEFORE
 * this is invoked: an amount with no known currency must never be formatted
 * as if it had one. See `formatMoneyRows` below.
 */
export function moneyRowExponent(currencyCode: string): number {
  return getCurrencyExponent(currencyCode).exponent;
}

const UNKNOWN_CURRENCY_CODE = "UNKNOWN";

/**
 * Renders one `MoneyRow[]` as an array of independently-labelled display
 * lines — NEVER a single summed figure (see this file's header). The
 * `UNKNOWN` bucket (a row whose own currency could not be resolved) is
 * rendered as an explicit, intentionally unformatted minor-unit count rather
 * than fabricating a `$`/exponent for a currency we do not actually know —
 * see PART 5 of the Phase 24 task brief.
 */
export function formatMoneyRows(rows: readonly MoneyRow[]): string[] {
  return rows.map((row) => {
    if (row.currencyCode === UNKNOWN_CURRENCY_CODE) {
      return `Unknown currency — ${row.minor} minor units`;
    }
    return formatMoneyDisplay(row.minor, row.currencyCode, moneyRowExponent(row.currencyCode));
  });
}
