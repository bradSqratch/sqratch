/**
 * src/app/(withSidebar)/dashboard/brand/commerce/commerce-response-validation.ts
 *
 * PHASE 20 HOTFIX (Part 10) — pure, DB-free, network-free response-shape
 * validators backing `BrandCommerceClient.tsx` and
 * `orders/BrandCommerceOrdersClient.tsx`. Kept separate from the components
 * so they can be unit tested with `node:test` without React or a DOM (this
 * repo has no React testing library — same idiom as
 * `../products/product-catalog-helpers.ts`).
 *
 * WHY THESE EXIST: commit 6e718f3 introduced several call sites that typed
 * `fetchJson<{ data: T }>(...)` and then read `.data` off the result —
 * except `fetchJson` (`@/components/experience/client-utils`) already
 * unwraps the server's `{ data, meta }` envelope, so the resolved value IS
 * `T` (or, for an endpoint that also returns `meta`, the unwrapping helper
 * is the wrong tool entirely — see `parseOrderListEnvelope` below). Every
 * validator here operates on the ALREADY-UNWRAPPED value (or, for
 * `parseOrderListEnvelope`, the full raw JSON body from a non-unwrapping
 * `fetch()` call) and returns `null` for anything that does not genuinely
 * match — never throws, never silently substitutes an empty/zero value that
 * could be mistaken for a genuine "no data" response.
 */

// ---------------------------------------------------------------------------
// GET /api/brand/commerce/connections/[connectionId]/diagnostics
// Server envelope: { data: Commerce7Diagnostics } — fetchJson unwraps to
// Commerce7Diagnostics directly.
// ---------------------------------------------------------------------------

export type Commerce7Diagnostics = {
  connectionId: string;
  connected: boolean;
  storefrontUrlConfigured: boolean;
  productRouteConfigured: boolean;
  currencyConfigured: boolean;
  productsSynced: boolean;
  lastProductSyncAt: string | null;
  orderReceiverConfigured: boolean;
  latestOrderIngestedAt: string | null;
  latestWebhookProcessedAt: string | null;
  latestFailedWebhookEvent: { receivedAt: string; failureSummary: string | null } | null;
  orderReadOperational: boolean;
};

const DIAGNOSTICS_BOOLEAN_FIELDS = [
  "connected",
  "storefrontUrlConfigured",
  "productRouteConfigured",
  "currencyConfigured",
  "productsSynced",
  "orderReceiverConfigured",
  "orderReadOperational",
] as const;

export function parseCommerce7Diagnostics(data: unknown): Commerce7Diagnostics | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const allBooleans = DIAGNOSTICS_BOOLEAN_FIELDS.every(
    (field) => typeof record[field] === "boolean",
  );
  if (!allBooleans || typeof record.connectionId !== "string") return null;
  return data as Commerce7Diagnostics;
}

// ---------------------------------------------------------------------------
// POST /api/brand/commerce/connections/[connectionId]/orders/reconcile
// Server envelope: { data: ReconcileResult } — fetchJson unwraps to
// ReconcileResult directly.
// ---------------------------------------------------------------------------

export type ReconcileResult = {
  status: "SUCCEEDED" | "PARTIAL";
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  failedCount: number;
  truncated: boolean;
};

export function parseReconcileResult(data: unknown): ReconcileResult | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.status !== "SUCCEEDED" && record.status !== "PARTIAL") return null;
  if (
    typeof record.fetchedCount !== "number" ||
    typeof record.createdCount !== "number" ||
    typeof record.updatedCount !== "number" ||
    typeof record.unchangedCount !== "number" ||
    typeof record.failedCount !== "number" ||
    typeof record.truncated !== "boolean"
  ) {
    return null;
  }
  return data as ReconcileResult;
}

// ---------------------------------------------------------------------------
// GET /api/brand/commerce/orders/summary
// Server envelope: { data: BrandOrderOperationsSummary } — fetchJson
// unwraps to BrandOrderOperationsSummary directly.
// ---------------------------------------------------------------------------

export type CommerceProvider = "SHOPIFY" | "COMMERCE7";
export type CommerceConnectionStatus =
  | "PENDING"
  | "CONNECTED"
  | "REQUIRES_RECONNECT"
  | "DISCONNECTED"
  | "UNINSTALLED"
  | "ERROR";
export type CommerceOrderFinancialStatus =
  | "PENDING"
  | "AUTHORIZED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED"
  | "VOIDED";

export type ConnectionOrderOperationsSummary = {
  connectionId: string;
  provider: CommerceProvider;
  displayName: string;
  externalAccountId: string;
  status: CommerceConnectionStatus;
  latestOrderIngestedAt: string | null;
  latestWebhookProcessedAt: string | null;
  orderCountsByFinancialStatus: Partial<Record<CommerceOrderFinancialStatus, number>>;
  unknownFinancialStatusCount: number;
  attributedOrderCount: number;
  unattributedOrderCount: number;
  orderReceiverConfigured: boolean | null;
};

export type BrandOrderOperationsSummary = {
  connections: ConnectionOrderOperationsSummary[];
  complete: boolean;
};

/**
 * Deliberately does NOT accept a malformed shape as "zero connections" —
 * that would read as "no commerce connections yet" in the UI and could mask
 * a real, existing connection (the exact live symptom of commit 6e718f3's
 * bug). A malformed response must surface as a distinguishable, controlled
 * error state instead.
 */
export function parseOrderOperationsSummary(data: unknown): BrandOrderOperationsSummary | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.connections) || typeof record.complete !== "boolean") return null;
  return data as BrandOrderOperationsSummary;
}

// ---------------------------------------------------------------------------
// GET /api/brand/commerce/orders
// Server envelope: { data: OrderListRow[], meta: { hasNextPage, nextCursor } }
// This endpoint genuinely needs BOTH `data` AND `meta` — the caller must use
// a non-unwrapping `fetch()` and pass the FULL raw JSON body here, never
// `fetchJson`'s already-unwrapped result (which would have already
// discarded `meta`, and — before this fix — was the direct cause of
// "Cannot read properties of undefined (reading 'hasNextPage')").
// ---------------------------------------------------------------------------

export type OrderListRow = {
  id: string;
  connectionId: string;
  provider: CommerceProvider;
  orderNumber: string | null;
  orderDate: string;
  financialStatus: CommerceOrderFinancialStatus | null;
  currencyCode: string | null;
  minorUnitExponent: number | null;
  totalMinor: string | null;
  netRevenueMinor: string | null;
  attributed: boolean;
};

export type OrderListEnvelope = {
  data: OrderListRow[];
  meta: { hasNextPage: boolean; nextCursor: string | null };
};

export function parseOrderListEnvelope(json: unknown): OrderListEnvelope | null {
  if (!json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;
  if (!Array.isArray(record.data)) return null;
  const meta = record.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta.hasNextPage !== "boolean") return null;
  return {
    data: record.data as OrderListRow[],
    meta: {
      hasNextPage: meta.hasNextPage,
      nextCursor: typeof meta.nextCursor === "string" ? meta.nextCursor : null,
    },
  };
}
