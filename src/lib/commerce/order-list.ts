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

import type { CommerceOrderFinancialStatus, CommerceProvider, Prisma } from "@prisma/client";

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
