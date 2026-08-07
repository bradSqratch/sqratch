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
 * (200 / 1000 / 2048, http(s)-only image URLs). This is friendly
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
  | { status: "PARTIAL" }
  | { status: "SKIPPED"; code: "NO_CONNECTION" | "LEGACY_FALLBACK" }
  | { status: "SYNC_IN_PROGRESS" }
  | { status: "SYNC_FAILED"; failureSummary: string | null }
  | { status: "UNKNOWN_ERROR"; message?: string | null };

/**
 * Maps every documented `POST /api/brand/products/sync` outcome to a
 * distinct, non-misleading notice. A skipped or failed sync NEVER maps to
 * `tone: "success"` — `PARTIAL` (catalog truncated) is surfaced as a
 * warning, never presented as if the sync fully completed.
 */
export function describeSyncOutcome(input: SyncOutcomeInput): SyncOutcomeNotice {
  switch (input.status) {
    case "SUCCEEDED":
      return {
        tone: "success",
        message: "Sync completed successfully. All available products were synced.",
      };
    case "PARTIAL":
      return {
        tone: "warning",
        message:
          "Sync completed, but the catalog was truncated — not every product was synced yet. Run sync again to continue.",
      };
    case "SKIPPED":
      if (input.code === "NO_CONNECTION") {
        return {
          tone: "error",
          message:
            "No commerce connection is configured for this brand. Connect a store before syncing.",
        };
      }
      return {
        tone: "error",
        message:
          "This brand's Shopify connection needs to be reconnected before syncing products.",
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
export const IMAGE_URL_OVERRIDE_MAX_LENGTH = 2048;

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

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** An empty string is treated as "clear the override" — not a validation error. */
export function validateImageUrlOverride(value: string): string | null {
  if (value.length === 0) {
    return null;
  }
  if (value.length > IMAGE_URL_OVERRIDE_MAX_LENGTH) {
    return `Image URL override must be at most ${IMAGE_URL_OVERRIDE_MAX_LENGTH} characters.`;
  }
  if (!isHttpUrl(value)) {
    return "Image URL override must be a valid http(s) URL.";
  }
  return null;
}
