/**
 * src/lib/commerce/conversion-breakdown-naming.ts
 *
 * PHASE 24 — pure, DB-free helper shared by both conversion analytics routes
 * (`src/app/api/brand/analytics/conversions/route.ts` and
 * `src/app/api/creator/analytics/conversions/route.ts`) for attaching a
 * display name onto a `buildConversionAnalytics` breakdown row.
 *
 * `buildConversionAnalytics` (`order-analytics.ts`) itself stays untouched
 * and returns bare `{ id, orders }` rows — it has no tenant identity and no
 * business naming any dimension it's handed. Each route resolves names AFTER
 * calling it, from an id set that is ALREADY safe to name by the time it
 * reaches this function:
 *
 *  - the brand route only ever calls `buildConversionAnalytics` with campaign
 *    ids that survived `ownedCampaignId` (foreign campaigns are dropped
 *    before aggregation, never bucketed), so every id this function is asked
 *    to name for a campaign breakdown is already brand-owned;
 *  - every other id (Experience/Lesson/product/CreatorProfile) came from one
 *    of THIS tenant's own attributed orders, never from client input.
 *
 * This function therefore does no authorization of its own — it is pure
 * id-to-name attachment, nothing more. An id with no matching entry in the
 * supplied map renders as `name: null` (the row still counts, matching the
 * click-analytics `attachNames` precedent in
 * `src/app/api/brand/analytics/commerce/route.ts`) rather than disappearing,
 * so a panel can never silently disagree with its own order count.
 */

export type ConversionCountRow = { id: string; orders: number };

export type ConversionNamedBreakdownRow = {
  id: string;
  name: string | null;
  orders: number;
};

export function attachConversionNames(
  rows: readonly ConversionCountRow[],
  names: ReadonlyMap<string, string | null>,
): ConversionNamedBreakdownRow[] {
  return rows.map((row) => ({
    id: row.id,
    name: names.get(row.id) ?? null,
    orders: row.orders,
  }));
}
