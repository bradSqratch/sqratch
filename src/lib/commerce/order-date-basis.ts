import type { Prisma } from "@prisma/client";

/**
 * Which date places an order in a reporting period.
 *
 * - `provider` (default): the store's own order time, `providerCreatedAt`. An
 *   order the store did not date falls back to `createdAt`, the time SQRATCH
 *   received it, and is counted so the report can say so. A missing provider
 *   date is never invented.
 * - `ingested`: `createdAt` only, the time SQRATCH received the order.
 *
 * Either way the figures describe an order cohort: orders placed (or received)
 * in the period, each with its CURRENT refund and cancellation state. A refund
 * on an older order changes that older cohort; it is not shown as new activity.
 * No payment or refund timestamps are stored, so nothing here reports payment
 * or refund activity by date.
 */
export type OrderDateBasis = "provider" | "ingested";

export const DEFAULT_ORDER_DATE_BASIS: OrderDateBasis = "provider";

export function parseOrderDateBasis(value: string | null): OrderDateBasis | null {
  if (value === null || value === "") return DEFAULT_ORDER_DATE_BASIS;
  return value === "provider" || value === "ingested" ? value : null;
}

type Range = { start: Date; end: Date };

/** Where-clause fragment selecting orders whose effective date falls in `range`. */
export function orderDateWhere(basis: OrderDateBasis, range: Range): Prisma.CommerceOrderWhereInput {
  const inRange = { gte: range.start, lte: range.end };
  if (basis === "ingested") return { createdAt: inRange };
  return {
    OR: [
      { providerCreatedAt: inRange },
      { providerCreatedAt: null, createdAt: inRange },
    ],
  };
}

type DatedOrder = { createdAt: Date; providerCreatedAt: Date | null };

/** The date the order is placed on under `basis`. */
export function effectiveOrderDate(row: DatedOrder, basis: OrderDateBasis): Date {
  return basis === "provider" && row.providerCreatedAt ? row.providerCreatedAt : row.createdAt;
}

/** Orders dated by SQRATCH's receipt time because the store gave no date. Always 0 on the ingestion basis. */
export function countFallbackOrders(rows: readonly DatedOrder[], basis: OrderDateBasis): number {
  if (basis !== "provider") return 0;
  return rows.filter((row) => row.providerCreatedAt === null).length;
}
