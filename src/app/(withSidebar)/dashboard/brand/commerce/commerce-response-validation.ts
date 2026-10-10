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
  /**
   * PHASE B — CUMULATIVE refunded amount, surfaced separately from
   * `totalMinor`/`netRevenueMinor` so a partially-refunded order can show
   * gross / refunded / net independently (the Commerce7 #1002 case). The
   * server has always returned this; it was simply missing from the client
   * type, exactly like `fulfillmentStatus` was before Phase 23.
   */
  totalRefundedMinor: string | null;
  netRevenueMinor: string | null;
  attributed: boolean;
  /** When SQRATCH last wrote this row. Distinct from the PROVIDER's own timestamp. */
  updatedAt: string;
};

export type OrderListEnvelope = {
  data: OrderListRow[];
  meta: { hasNextPage: boolean; nextCursor: string | null };
};

const FINANCIAL_STATUSES = new Set<string>([
  "PENDING",
  "AUTHORIZED",
  "PARTIALLY_PAID",
  "PAID",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "VOIDED",
]);

const FULFILLMENT_STATUSES = new Set<string>([
  "UNFULFILLED",
  "PARTIALLY_FULFILLED",
  "FULFILLED",
  "RESTOCKED",
]);

const PROVIDERS = new Set<string>(["SHOPIFY", "COMMERCE7"]);

/** A decimal-integer money string, exactly what the API serializes a BigInt as. Never a float, never `NaN`. */
function isMoneyString(value: unknown): value is string {
  return typeof value === "string" && /^-?\d+$/.test(value);
}

function isNullableMoneyString(value: unknown): boolean {
  return value === null || isMoneyString(value);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && value !== "" && !Number.isNaN(new Date(value).getTime());
}

/**
 * PHASE B — REAL per-row runtime validation.
 *
 * This previously validated only that `data` was an array and then
 * `as OrderListRow[]` cast every element unchecked, which is a TypeScript
 * assertion rather than a runtime guarantee: a malformed row (a money field
 * arriving as a float, an unknown enum from a future provider, a missing
 * timestamp) reached the renderer and produced a blank/NaN cell — or a crash
 * — instead of a controlled error state.
 *
 * Rejecting the WHOLE envelope on a single bad row is deliberate: a
 * partially-rendered order list is worse than an honest error, because an
 * operator cannot tell which rows were silently dropped.
 */
export function isOrderListRow(value: unknown): value is OrderListRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;

  if (typeof row.id !== "string" || row.id === "") return false;
  if (typeof row.connectionId !== "string" || row.connectionId === "") return false;
  if (typeof row.provider !== "string" || !PROVIDERS.has(row.provider)) return false;
  if (row.orderNumber !== null && typeof row.orderNumber !== "string") return false;
  if (!isIsoTimestamp(row.orderDate)) return false;
  if (row.financialStatus !== null && !FINANCIAL_STATUSES.has(String(row.financialStatus))) {
    return false;
  }
  if (row.fulfillmentStatus !== null && !FULFILLMENT_STATUSES.has(String(row.fulfillmentStatus))) {
    return false;
  }
  if (row.currencyCode !== null && typeof row.currencyCode !== "string") return false;
  // The exponent is load-bearing for money rendering — a non-integer or
  // out-of-range value must never reach `formatMoneyDisplay`.
  if (
    row.minorUnitExponent !== null &&
    (typeof row.minorUnitExponent !== "number" ||
      !Number.isInteger(row.minorUnitExponent) ||
      row.minorUnitExponent < 0 ||
      row.minorUnitExponent > 6)
  ) {
    return false;
  }
  if (!isNullableMoneyString(row.totalMinor)) return false;
  if (!isNullableMoneyString(row.totalRefundedMinor)) return false;
  if (!isNullableMoneyString(row.netRevenueMinor)) return false;
  if (typeof row.attributed !== "boolean") return false;
  if (!isIsoTimestamp(row.updatedAt)) return false;
  return true;
}

export function parseOrderListEnvelope(json: unknown): OrderListEnvelope | null {
  if (!json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;
  if (!Array.isArray(record.data)) return null;
  if (!record.data.every(isOrderListRow)) return null;
  const meta = record.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta.hasNextPage !== "boolean") return null;
  // A cursor is an opaque base64url token — validated as a plain non-empty
  // string here, never decoded or interpreted client-side.
  const nextCursor =
    typeof meta.nextCursor === "string" && meta.nextCursor !== "" ? meta.nextCursor : null;
  return {
    data: record.data as OrderListRow[],
    meta: { hasNextPage: meta.hasNextPage, nextCursor },
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
  activeRunStartedAt?: string | null;
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
  if (record.activeRunStartedAt !== undefined && record.activeRunStartedAt !== null && typeof record.activeRunStartedAt !== "string") return null;
  return data as ReconciliationStateView;
}

// ---------------------------------------------------------------------------
// PHASE C — GET /api/brand/commerce/connections/[connectionId]/orders/activity
// Server envelope: { data: BrandCommerceOrderActivityPage } — fetchJson
// unwraps to the page directly.
// ---------------------------------------------------------------------------

export type OrderActivityCategory = "WEBHOOK" | "RECONCILIATION" | "OTHER";

export type OrderActivityEntry = {
  id: string;
  category: OrderActivityCategory;
  provider: CommerceProvider;
  status: string;
  receivedAt: string;
  processedAt: string | null;
  providerUpdatedAt: string | null;
  externalOrderRef: string | null;
  failureSummary: string | null;
  order: { id: string; orderNumber: string | null; currencyCode?: string | null; minorUnitExponent?: number | null } | null;
};

export type OrderActivityPage = {
  entries: OrderActivityEntry[];
  hasNextPage: boolean;
  nextCursor: string | null;
  limit: number;
};

const ACTIVITY_CATEGORIES = new Set<string>(["WEBHOOK", "RECONCILIATION", "OTHER"]);
const ACTIVITY_STATUSES = new Set<string>([
  "RECEIVED",
  "PROCESSED",
  "FAILED",
  "SKIPPED_STALE",
  "SKIPPED_DISCONNECTED",
]);

function isOrderActivityEntry(value: unknown): value is OrderActivityEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id === "") return false;
  if (typeof entry.category !== "string" || !ACTIVITY_CATEGORIES.has(entry.category)) return false;
  if (typeof entry.provider !== "string" || !PROVIDERS.has(entry.provider)) return false;
  // An unrecognized status is rejected rather than rendered as a blank
  // badge — an operator must never see an event whose outcome is unlabelled.
  if (typeof entry.status !== "string" || !ACTIVITY_STATUSES.has(entry.status)) return false;
  if (!isIsoTimestamp(entry.receivedAt)) return false;
  if (entry.processedAt !== null && !isIsoTimestamp(entry.processedAt)) return false;
  if (entry.providerUpdatedAt !== null && !isIsoTimestamp(entry.providerUpdatedAt)) return false;
  if (entry.externalOrderRef !== null && typeof entry.externalOrderRef !== "string") return false;
  if (entry.failureSummary !== null && typeof entry.failureSummary !== "string") return false;
  if (entry.order !== null) {
    if (!entry.order || typeof entry.order !== "object") return false;
    const order = entry.order as Record<string, unknown>;
    if (typeof order.id !== "string" || order.id === "") return false;
    if (order.orderNumber !== null && typeof order.orderNumber !== "string") return false;
    // Optional (older servers omit them); when present they must be exact, or a note's amount could be misformatted.
    if (order.currencyCode != null && typeof order.currencyCode !== "string") return false;
    if (order.minorUnitExponent != null && (!Number.isInteger(order.minorUnitExponent) || (order.minorUnitExponent as number) < 0)) return false;
  }
  return true;
}

export function parseOrderActivityPage(data: unknown): OrderActivityPage | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (!Array.isArray(record.entries)) return null;
  if (!record.entries.every(isOrderActivityEntry)) return null;
  if (typeof record.hasNextPage !== "boolean") return null;
  if (typeof record.limit !== "number" || !Number.isInteger(record.limit)) return null;
  const nextCursor =
    typeof record.nextCursor === "string" && record.nextCursor !== "" ? record.nextCursor : null;
  return {
    entries: record.entries as OrderActivityEntry[],
    hasNextPage: record.hasNextPage,
    nextCursor,
    limit: record.limit,
  };
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

// ---------------------------------------------------------------------------
// GET /api/brand/campaigns/[id]/commerce-products
//
// THE `meta` TRAP, AGAIN. This route answers
//   { data: { campaign, products }, meta: { hasNextPage, nextCursor, limit } }
// with `meta` OUTSIDE `data`. `fetchJson` ends in `(json?.data ?? json)`, so a
// caller using it receives ONLY the inner `{ campaign, products }` object and
// `result.meta` is ALWAYS `undefined`.
//
// That was not theoretical: the campaign products page did exactly this, so
// `meta?.hasNextPage` was permanently falsy and the "Load more products"
// control NEVER rendered. A brand whose catalog exceeded one page (50) could
// not reach — and therefore could not assign — any product past the first
// page. The fix is the same as `parseOrderListEnvelope`'s: read the FULL body
// with a plain `fetch` and validate both halves here.
// ---------------------------------------------------------------------------

export type CampaignProductRow = {
  brandCommerceProductId: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  productUrl?: string | null;
  isVisibleInShop: boolean;
  isCampaignEligible: boolean;
  isAvailable: boolean;
  hasPublicStorefrontUrl: boolean;
  assignment: {
    id: string;
    isActive: boolean;
    displayOrder: number;
    deactivatedAt?: string | null;
  } | null;
};

export type CampaignProductEnvelope = {
  campaign: { id: string; name: string };
  products: CampaignProductRow[];
  meta: { hasNextPage: boolean; nextCursor: string | null; limit: number };
};

/** Bounded: the route's own MAX_PAGE_SIZE is 100, so anything larger is wrong. */
const MAX_CAMPAIGN_PRODUCT_ROWS = 100;

function isCampaignProductAssignment(value: unknown): boolean {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    row.id !== "" &&
    typeof row.isActive === "boolean" &&
    typeof row.displayOrder === "number" &&
    Number.isFinite(row.displayOrder)
  );
}

export function isCampaignProductRow(value: unknown): value is CampaignProductRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.brandCommerceProductId !== "string" || row.brandCommerceProductId === "") {
    return false;
  }
  if (typeof row.title !== "string") return false;
  for (const key of ["description", "imageUrl"] as const) {
    if (row[key] !== null && typeof row[key] !== "string") return false;
  }
  // Each of these four booleans drives a DIFFERENT eligibility explanation in
  // the UI. Coercing a missing one would state the wrong reason a product is
  // or is not publicly purchasable, so all four are required outright.
  for (const key of [
    "isVisibleInShop",
    "isCampaignEligible",
    "isAvailable",
    "hasPublicStorefrontUrl",
  ] as const) {
    if (typeof row[key] !== "boolean") return false;
  }
  return isCampaignProductAssignment(row.assignment);
}

/** Takes the FULL response body (not a `fetchJson`-unwrapped value). */
export function parseCampaignProductEnvelope(json: unknown): CampaignProductEnvelope | null {
  if (!json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;

  const data = record.data as Record<string, unknown> | undefined;
  if (!data || typeof data !== "object") return null;

  const campaign = data.campaign as Record<string, unknown> | undefined;
  if (!campaign || typeof campaign !== "object") return null;
  if (typeof campaign.id !== "string" || campaign.id === "") return null;
  if (typeof campaign.name !== "string") return null;

  if (!Array.isArray(data.products)) return null;
  if (data.products.length > MAX_CAMPAIGN_PRODUCT_ROWS) return null;
  if (!data.products.every(isCampaignProductRow)) return null;

  const meta = record.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta.hasNextPage !== "boolean") return null;
  if (typeof meta.limit !== "number" || !Number.isInteger(meta.limit) || meta.limit < 1) {
    return null;
  }
  // An opaque base64url token — validated as a non-empty string, never decoded
  // or interpreted client-side.
  const nextCursor =
    typeof meta.nextCursor === "string" && meta.nextCursor !== "" ? meta.nextCursor : null;

  return {
    campaign: { id: campaign.id, name: campaign.name },
    products: data.products as CampaignProductRow[],
    meta: { hasNextPage: meta.hasNextPage, nextCursor, limit: meta.limit },
  };
}
