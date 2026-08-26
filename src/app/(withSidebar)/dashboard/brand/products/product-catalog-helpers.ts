/**
 * src/app/(withSidebar)/dashboard/brand/products/product-catalog-helpers.ts
 *
 * Pure, DB-free, network-free helpers backing the brand products page
 * (`BrandProductsClient.tsx`). Kept separate from the component so they can
 * be unit tested with `node:test` without React or a DOM (this repo has no
 * React testing library — see `tests/brand-product-page.test.ts`).
 *
 * These helpers deliberately duplicate (rather than import) the validation
 * bounds enforced server-side in `src/lib/commerce/product-catalog-api.ts`
 * (200 / 1000). This is friendly
 * client-side validation only — the server remains authoritative and
 * re-validates independently.
 */

// ---------------------------------------------------------------------------
// Money formatting — INTEGER MINOR UNITS, never assume /100
// ---------------------------------------------------------------------------

export type ProductPrice = {
  minMinor: number | null;
  maxMinor: number | null;
  currencyCode: string | null;
  minorUnitExponent: number | null;
};

const PRICE_UNAVAILABLE = "Price unavailable";
const PRICE_UNKNOWN_CURRENCY = "Price unavailable (currency unknown)";

/**
 * Formats a product price for display.
 *
 * - Values are integer MINOR units; the actual amount is
 *   `minorValue / 10 ** minorUnitExponent` — the exponent is read from the
 *   payload, never assumed to be 2.
 * - A `minMinor === maxMinor` renders a single price; otherwise a range.
 * - A `null` `currencyCode` NEVER renders a currency symbol and NEVER
 *   guesses a default currency — the amount is shown as unavailable/unknown
 *   instead of a bare, misleadingly-precise number.
 */
export function formatPriceDisplay(price: ProductPrice): string {
  if (
    price.minMinor === null ||
    price.maxMinor === null ||
    price.minorUnitExponent === null
  ) {
    return PRICE_UNAVAILABLE;
  }

  if (price.currencyCode === null) {
    return PRICE_UNKNOWN_CURRENCY;
  }

  const divisor = 10 ** price.minorUnitExponent;
  const minValue = price.minMinor / divisor;
  const maxValue = price.maxMinor / divisor;

  const formattedMin = formatCurrencyAmount(
    minValue,
    price.minorUnitExponent,
    price.currencyCode,
  );

  if (price.minMinor === price.maxMinor) {
    return formattedMin;
  }

  const formattedMax = formatCurrencyAmount(
    maxValue,
    price.minorUnitExponent,
    price.currencyCode,
  );

  return `${formattedMin} - ${formattedMax}`;
}

function formatCurrencyAmount(
  value: number,
  exponent: number,
  currencyCode: string,
): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(value);
  } catch {
    // An invalid/unrecognized ISO code (Intl throws a RangeError) — fall
    // back to the raw code + amount rather than guessing a symbol.
    return `${currencyCode} ${value.toFixed(exponent)}`;
  }
}

// ---------------------------------------------------------------------------
// Sync outcome -> user-facing notice
// ---------------------------------------------------------------------------

export type SyncTone = "success" | "warning" | "error";

export type SyncOutcomeNotice = {
  tone: SyncTone;
  message: string;
};

export type SyncOutcomeInput =
  | { status: "SUCCEEDED" }
  | {
      status: "PARTIAL";
      failureSummary?: string | null;
      hasNextPage?: boolean;
      fetchedCount?: number;
      failedCount?: number;
      runId?: string;
    }
  | { status: "SKIPPED"; code: "NO_CONNECTION" }
  | { status: "SYNC_IN_PROGRESS" }
  | { status: "SYNC_FAILED"; failureSummary: string | null }
  | { status: "UNKNOWN_ERROR"; message?: string | null };

/**
 * Maps every documented `POST /api/brand/products/sync` outcome to a
 * distinct, non-misleading notice. A skipped or failed sync NEVER maps to
 * `tone: "success"`. Partial diagnostics are classified by the server's
 * sanitized failure tag; raw provider details are deliberately not rendered.
 */
export function describeSyncOutcome(input: SyncOutcomeInput): SyncOutcomeNotice {
  switch (input.status) {
    case "SUCCEEDED":
      return {
        tone: "success",
        message: "Sync completed successfully. All available products were synced.",
      };
    case "PARTIAL":
      return describePartialSyncOutcome(input);
    case "SKIPPED":
      return {
        tone: "error",
        message:
          "No commerce connection is configured for this brand. Connect a store before syncing.",
      };
    case "SYNC_IN_PROGRESS":
      return {
        tone: "warning",
        message: "A product sync is already in progress for this brand. Try again shortly.",
      };
    case "SYNC_FAILED":
      return {
        tone: "error",
        message: input.failureSummary
          ? `Product sync failed: ${input.failureSummary}`
          : "Product sync failed.",
      };
    case "UNKNOWN_ERROR":
    default:
      return {
        tone: "error",
        message: input.message || "Failed to sync products.",
      };
  }
}

const PARTIAL_FAILURE_TAG = /^([A-Z][A-Z0-9_]{2,63})\s*:/;

function partialFailureTag(summary: string | null | undefined): string | null {
  if (!summary) return null;
  const match = PARTIAL_FAILURE_TAG.exec(summary.trim());
  return match?.[1] ?? null;
}

function safeCount(value: number | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000
    ? value
    : null;
}

function describePartialSyncOutcome(
  input: Extract<SyncOutcomeInput, { status: "PARTIAL" }>,
): SyncOutcomeNotice {
  const tag = partialFailureTag(input.failureSummary);
  let message: string;

  switch (tag) {
    case "PAGINATION_TIMEOUT":
      message = "The sync reached its time limit before the complete catalog was retrieved. Products already synchronized were kept, and no missing products were marked inactive. Retry the sync.";
      break;
    case "MAX_PAGES_REACHED":
      message = "The sync reached its page safety limit before the complete catalog was retrieved. Existing products were preserved, and no missing products were marked inactive. Retry the sync.";
      break;
    case "MAX_PRODUCTS_REACHED":
      message = "The sync reached its product safety limit before the complete catalog was retrieved. Existing products were preserved, and no missing products were marked inactive. Retry the sync.";
      break;
    case "MISSING_CURSOR":
    case "CURSOR_LOOP":
    case "INVALID_PAGE":
      message = "Shopify returned incomplete pagination information. Products already synchronized were kept, and no missing products were marked inactive. Retry the sync.";
      break;
    case "PARTIAL_WRITE_FAILURE":
      message = "Some products could not be saved. Successfully synchronized products were kept, and no missing products were marked inactive. Retry the sync.";
      break;
    default:
      message = "The product sync did not complete. Products already synchronized were kept, and no missing products were marked inactive. Retry the sync.";
      break;
  }

  const fetchedCount = safeCount(input.fetchedCount);
  const failedCount = safeCount(input.failedCount);
  const details: string[] = [];
  if (fetchedCount !== null) details.push(`Products fetched: ${fetchedCount}.`);
  if (failedCount !== null && failedCount > 0) details.push(`Product writes failed: ${failedCount}.`);

  return { tone: "warning", message: details.length ? `${message} ${details.join(" ")}` : message };
}

// ---------------------------------------------------------------------------
// Query-string building for GET /api/brand/products
// ---------------------------------------------------------------------------

export type ProductListQueryParams = {
  q?: string | null;
  availability?: string | null;
  selection?: string | null;
  connectionId?: string | null;
  cursor?: string | null;
  limit?: number | null;
};

/**
 * Builds the query string for `GET /api/brand/products`. Only defined,
 * non-empty values are included — an omitted/empty field means "let the
 * server apply its documented default" rather than sending an explicit
 * empty param.
 */
export function buildProductQueryString(params: ProductListQueryParams): string {
  const search = new URLSearchParams();

  if (params.q && params.q.trim().length > 0) {
    search.set("q", params.q.trim());
  }
  if (params.availability && params.availability.length > 0) {
    search.set("availability", params.availability);
  }
  if (params.selection && params.selection.length > 0) {
    search.set("selection", params.selection);
  }
  if (params.connectionId && params.connectionId.length > 0) {
    search.set("connectionId", params.connectionId);
  }
  if (params.cursor && params.cursor.length > 0) {
    search.set("cursor", params.cursor);
  }
  if (typeof params.limit === "number" && Number.isFinite(params.limit)) {
    search.set("limit", String(params.limit));
  }

  return search.toString();
}

// ---------------------------------------------------------------------------
// Client-side selection-override validation (server remains authoritative)
// ---------------------------------------------------------------------------

export const TITLE_OVERRIDE_MAX_LENGTH = 200;
export const SHORT_DESCRIPTION_OVERRIDE_MAX_LENGTH = 1000;
// Keep these aligned with the authoritative PATCH validation in
// `src/lib/commerce/product-catalog-api.ts`.
export const DISPLAY_ORDER_MIN = 0;
export const DISPLAY_ORDER_MAX = 1_000_000;

export function validateTitleOverride(value: string): string | null {
  if (value.length > TITLE_OVERRIDE_MAX_LENGTH) {
    return `Title override must be at most ${TITLE_OVERRIDE_MAX_LENGTH} characters.`;
  }
  return null;
}

export function validateShortDescriptionOverride(value: string): string | null {
  if (value.length > SHORT_DESCRIPTION_OVERRIDE_MAX_LENGTH) {
    return `Short description override must be at most ${SHORT_DESCRIPTION_OVERRIDE_MAX_LENGTH} characters.`;
  }
  return null;
}

/**
 * Validates the text value of the display-order number input before it is
 * serialized as JSON. Keeping the draft as text lets a user temporarily clear
 * or replace the field without accidentally converting that intermediate
 * state to zero.
 */
export function validateDisplayOrder(value: string): string | null {
  if (value.trim().length === 0) {
    return "Display order is required.";
  }

  const numberValue = Number(value);
  if (
    !Number.isFinite(numberValue) ||
    !Number.isInteger(numberValue) ||
    numberValue < DISPLAY_ORDER_MIN ||
    numberValue > DISPLAY_ORDER_MAX
  ) {
    return `Display order must be an integer between ${DISPLAY_ORDER_MIN} and ${DISPLAY_ORDER_MAX}.`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// PHASE 20 HOTFIX (Part 10) — GET /api/brand/products/sync-runs response
// validation. `fetchJson` (see @/components/experience/client-utils) already
// unwraps that route's `{ data, meta }` envelope, so the value this helper
// receives IS the sync-run array itself (never a re-wrapped `{ data }`
// object — that mismatch was exactly commit 6e718f3's live crash). Extracted
// as a pure function (rather than inlined in `SyncRunHistory`) so it is
// directly unit-testable without a DOM/React runtime.
// ---------------------------------------------------------------------------

export type SyncRunRow = {
  id: string;
  connectionId: string;
  provider: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  markedUnavailableCount: number;
  failedCount: number;
  hasNextPage: boolean;
  failureSummary: string | null;
};

/** Returns the validated array, or `null` for anything that is not genuinely an array — never throws, never silently substitutes `[]` for a malformed (as opposed to genuinely empty) response. */
export function parseSyncRunRows(data: unknown): SyncRunRow[] | null {
  return Array.isArray(data) ? (data as SyncRunRow[]) : null;
}
