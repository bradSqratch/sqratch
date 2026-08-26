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

export type CommerceOrderFulfillmentStatus =
  | "UNFULFILLED"
  | "PARTIALLY_FULFILLED"
  | "FULFILLED"
  | "RESTOCKED";

export type OrderListRow = {
  id: string;
  connectionId: string;
  provider: CommerceProvider;
  orderNumber: string | null;
  orderDate: string;
  financialStatus: CommerceOrderFinancialStatus | null;
  /**
   * PHASE 22 (Commerce7 order reconciliation hardening, Part 5) — surfaced
   * separately from `financialStatus`, never merged: a PAID order can be
   * UNFULFILLED, and a FULFILLED order can be REFUNDED — collapsing the two
   * into one field would silently hide one axis whenever they disagree.
   * Already selected/returned by `GET /api/brand/commerce/orders` (see
   * `BrandCommerceOrderListRow` in that route) — this was purely a missing
   * client-side field before this fix.
   */
  fulfillmentStatus: CommerceOrderFulfillmentStatus | null;
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

// ---------------------------------------------------------------------------
// PHASE 21 (live QA hotfix, Issue 1) — the readiness-checklist refresh-key
// transition. `Commerce7ReadinessChecklist`'s diagnostics `useEffect`
// previously depended ONLY on `connectionId`, so a successful settings
// sync/disconnect/reconnect (none of which change `connectionId`) never
// re-triggered a diagnostics re-fetch — the checklist stayed stale until a
// full page reload. The fix threads a `refreshKey` into that effect's
// dependency array (`[connectionId, refreshKey]`) and bumps it here.
//
// Extracted as a pure function (rather than an inline `k => k + 1` in the
// component) so the exact intended behavior — bump on every event that
// actually changed server state, do NOT bump on a failed sync (nothing
// changed, so re-fetching would be wasted and could even race a stale
// response) — is directly unit-testable without a DOM (this repo has no
// React testing library).
// ---------------------------------------------------------------------------

export type DiagnosticsRefreshEvent =
  | { type: "SETTINGS_SYNC_SUCCEEDED" }
  | { type: "SETTINGS_SYNC_FAILED" }
  | { type: "CONNECTION_DISCONNECTED" }
  | { type: "CONNECTION_RECONNECTED" };

/** Never throws, never skips unpredictably — a switch over the exhaustive event union. */
export function nextDiagnosticsRefreshKey(
  currentKey: number,
  event: DiagnosticsRefreshEvent,
): number {
  switch (event.type) {
    case "SETTINGS_SYNC_SUCCEEDED":
    case "CONNECTION_DISCONNECTED":
    case "CONNECTION_RECONNECTED":
      return currentKey + 1;
    case "SETTINGS_SYNC_FAILED":
      // Nothing changed server-side — re-fetching would be wasted, and
      // could even race a stale response into looking like confirmation of
      // a change that never actually happened.
      return currentKey;
    default: {
      const exhaustive: never = event;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// PHASE 22 (Commerce7 order reconciliation hardening) — the three new
// reconciliation endpoints:
//   GET  /api/brand/commerce/connections/[connectionId]/orders/reconciliation-state
//   POST /api/brand/commerce/connections/[connectionId]/orders/catch-up
//   POST /api/brand/commerce/connections/[connectionId]/orders/reconcile-range
// All three return `{ data: T }` (no `meta`) — `fetchJson` unwraps to `T`
// directly, same idiom as every other validator in this file.
// ---------------------------------------------------------------------------

export type ReconciliationStateView = {
  reconciledThrough: string | null;
  targetThrough: string | null;
  lastAttemptedAt: string | null;
  lastRunOutcome: string | null;
  lastRunError: string | null;
  customRangeFrom: string | null;
  customRangeTo: string | null;
  customRangeCursor: string | null;
};

const RECONCILIATION_STATE_STRING_OR_NULL_FIELDS = [
  "reconciledThrough",
  "targetThrough",
  "lastAttemptedAt",
  "lastRunOutcome",
  "lastRunError",
  "customRangeFrom",
  "customRangeTo",
  "customRangeCursor",
] as const;

export function parseReconciliationState(data: unknown): ReconciliationStateView | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const allValid = RECONCILIATION_STATE_STRING_OR_NULL_FIELDS.every(
    (field) => record[field] === null || typeof record[field] === "string",
  );
  if (!allValid) return null;
  return data as ReconciliationStateView;
}

export type ReconciliationStepStatus = "UP_TO_DATE" | "PROGRESS" | "FAILED";

function isValidStepStatus(value: unknown): value is ReconciliationStepStatus {
  return value === "UP_TO_DATE" || value === "PROGRESS" || value === "FAILED";
}

export type CatchUpStepResult = {
  status: ReconciliationStepStatus;
  reconciledThrough: string | null;
  target: string;
  reachedTarget: boolean;
  chunk: { from: string; to: string } | null;
  ordersFetched: number;
  ordersProcessed: number;
  error: string | null;
};

export function parseCatchUpStepResult(data: unknown): CatchUpStepResult | null {
  if (!data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  if (!isValidStepStatus(r.status)) return null;
  if (typeof r.target !== "string" || typeof r.reachedTarget !== "boolean") return null;
  if (typeof r.ordersFetched !== "number" || typeof r.ordersProcessed !== "number") return null;
  return data as CatchUpStepResult;
}

export type CustomRangeStepResult = {
  status: ReconciliationStepStatus;
  cursor: string | null;
  from: string;
  to: string;
  reachedTarget: boolean;
  chunk: { from: string; to: string } | null;
  ordersFetched: number;
  ordersProcessed: number;
  error: string | null;
};

export function parseCustomRangeStepResult(data: unknown): CustomRangeStepResult | null {
  if (!data || typeof data !== "object") return null;
  const r = data as Record<string, unknown>;
  if (!isValidStepStatus(r.status)) return null;
  if (typeof r.from !== "string" || typeof r.to !== "string" || typeof r.reachedTarget !== "boolean") {
    return null;
  }
  if (typeof r.ordersFetched !== "number" || typeof r.ordersProcessed !== "number") return null;
  return data as CustomRangeStepResult;
}

// ---------------------------------------------------------------------------
// PHASE 26 — custom-range date/time selection.
//
// `<input type="datetime-local">` emits (and accepts) a `YYYY-MM-DDTHH:mm`
// string with NO timezone designator, which both the HTML spec and
// `Date`'s parser interpret as the USER'S LOCAL time. That local-time
// meaning is exactly what the operator intends when they pick "the
// afternoon the refund happened", so it is preserved end-to-end:
//
//   local "2026-08-26T04:39"  ->  new Date(...)  ->  .toISOString()
//
// `new Date("2026-08-26T04:39")` is already local-time parsing, so the
// conversion to a UTC instant is correct as-is. What must NEVER happen is
// appending a literal "Z" to the raw control value — that would silently
// reinterpret the operator's local wall-clock time as UTC and shift the
// window by their whole offset.
//
// The helpers below exist as pure functions (no DOM, no React) so this
// behavior is unit-testable and timezone-independent: every one of them
// derives local components with the same `Date` accessors the browser would.
// ---------------------------------------------------------------------------

/**
 * Formats a `Date` as the `YYYY-MM-DDTHH:mm` LOCAL-time string that
 * `<input type="datetime-local">`'s `max` attribute requires. Seconds and
 * milliseconds are deliberately dropped: the control's default step is one
 * minute, and a `max` carrying seconds can make the browser reject the
 * whole current minute.
 */
export function formatDateTimeLocalMax(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export type CustomRangeSelectionResult =
  | { ok: true; fromIso: string; toIso: string }
  | { ok: false; message: string };

/**
 * The exact message the operator sees when they pick a future range. Kept as
 * a shared constant so the client-side pre-flight check and any server-driven
 * rendering of the same condition can never drift into two different wordings.
 */
export const CUSTOM_RANGE_FUTURE_MESSAGE =
  "The reconciliation range cannot extend past the current time.";

/**
 * PURE client-side pre-flight validation for the custom-range controls.
 *
 * `now` is injected rather than read from the clock so this is fully
 * deterministic under test. This validation is a UX affordance ONLY — it
 * exists so the operator gets a specific, actionable message instead of a
 * round-trip 400, and it deliberately does NOT replace the server's own
 * authoritative checks (see the reconcile-range route, which re-validates
 * every one of these conditions against the SERVER's clock).
 */
export function validateCustomRangeSelection(input: {
  fromValue: string;
  toValue: string;
  now: Date;
}): CustomRangeSelectionResult {
  const { fromValue, toValue, now } = input;
  if (!fromValue || !toValue) {
    return { ok: false, message: "Choose a valid From and To date/time." };
  }
  // Local-time parsing — see this section's header for why no "Z" is added.
  const fromDate = new Date(fromValue);
  const toDate = new Date(toValue);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return { ok: false, message: "Choose a valid From and To date/time." };
  }
  if (fromDate.getTime() >= toDate.getTime()) {
    return { ok: false, message: '"From" must be strictly before "To".' };
  }
  if (fromDate.getTime() > now.getTime() || toDate.getTime() > now.getTime()) {
    return { ok: false, message: CUSTOM_RANGE_FUTURE_MESSAGE };
  }
  return { ok: true, fromIso: fromDate.toISOString(), toIso: toDate.toISOString() };
}
