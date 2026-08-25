/**
 * src/lib/commerce/providers/commerce7-products.ts
 *
 * PHASE 16C1 — Commerce7 READ-ONLY product catalog: backend API client, cursor
 * pagination, and normalization into the canonical `CommerceProduct` contract.
 *
 * CREDENTIALS: app-global only. Basic auth is `App ID : App Secret`, both read
 * from backend environment configuration via `getCommerce7AppConfig()`. There
 * is deliberately NO `CommerceConnectionSecret` involvement — Commerce7's
 * secret authenticates SQRATCH-the-app, not one winery, so storing a per-tenant
 * copy would multiply a leak's blast radius for no benefit.
 *
 * TENANT BINDING: every request carries an explicit `tenant` header that the
 * caller derived from `CommerceConnection.externalAccountId`. This module never
 * accepts a tenant from a browser and never falls back to a default tenant.
 *
 * LOGGING: nothing here logs the Authorization header, the App Secret, or a raw
 * provider payload. Provider failures are surfaced as `CommerceProviderApiError`
 * carrying a sanitized message plus the upstream HTTP status only.
 */

import { CommerceProvider } from "@prisma/client";
import { CommerceProviderApiError } from "../errors";
import type { CommerceProduct } from "../types";
import {
  buildCommerce7AppAuthorizationHeader,
  getCommerce7AppConfig,
  normalizeCommerce7Tenant,
} from "./commerce7";
import {
  buildCommerce7ProductDestinationUrl,
  validateCommerce7ProductRoute,
  validateCommerce7StorefrontUrl,
} from "./commerce7-connection-config";

const COMMERCE7_API_BASE = "https://api.commerce7.com/v1";

/** Commerce7's documented first-page cursor sentinel. */
export const COMMERCE7_START_CURSOR = "start";

/**
 * PHASE 16C2: Commerce7's official API documentation
 * (developer.commerce7.com/docs/commerce7-apis) states plainly that "Currency
 * amounts are stored in Commerce7 in cents" — this is now DOCUMENTED provider
 * API semantics, not an inference from sandbox behavior. Exponent 2 is
 * therefore fixed, not derived from a currency code (see the currency-source
 * note in `computeCommerce7Availability`'s neighboring exports below for why
 * no currency CODE has an equally authoritative source yet). The canonical
 * catalog stores integer minor units, so this module converts cents to the
 * decimal STRING form the neutral persistence layer parses (`priceRangeRaw`),
 * using integer/string arithmetic only — never a float divide-then-multiply
 * round trip.
 */
const COMMERCE7_MINOR_UNIT_EXPONENT = 2;

export type Commerce7Fetch = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal?: AbortSignal;
  },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export type Commerce7ProductPage = {
  products: CommerceProduct[];
  nextCursor: string | null;
  isComplete: boolean;
};

function providerError(message: string, httpStatus?: number): never {
  throw new CommerceProviderApiError(
    CommerceProvider.COMMERCE7,
    message,
    undefined,
    httpStatus,
  );
}

/**
 * Converts an integer minor-unit amount to its canonical decimal string.
 * Pure integer/string math: `4200 -> "42.00"`, `5 -> "0.05"`, `0 -> "0.00"`.
 * Never uses floating point, so no representable amount can drift.
 */
export function minorUnitsToDecimalString(
  minorUnits: number,
  exponent: number = COMMERCE7_MINOR_UNIT_EXPONENT,
): string | null {
  if (!Number.isInteger(minorUnits) || !Number.isFinite(minorUnits)) {
    return null;
  }
  if (exponent <= 0) {
    return String(minorUnits);
  }

  const negative = minorUnits < 0;
  const digits = String(Math.abs(minorUnits)).padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);

  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Availability / security normalization
// ---------------------------------------------------------------------------

/**
 * Commerce7 documented lifecycle + access states.
 *
 *   webStatus            Available | Not Available | Retired
 *   adminStatus          Available | Not Available | Hidden
 *   security.availableTo Public | Allocation | Group | Club
 *
 * TWO DISTINCT DECISIONS, deliberately kept apart (the canonical catalog draws
 * the same line between `isAvailable` and `hasPublicStorefrontUrl`):
 *
 *   isCatalogAvailable — the product is a live sellable catalog entry. Requires
 *     webStatus === "Available" AND adminStatus === "Available". A Retired or
 *     Hidden product still SYNCS (so its state change is representable) but is
 *     never marked available.
 *
 *   isPublicEligible — additionally requires security.availableTo === "Public".
 *     An Allocation/Group/Club product is gated behind Commerce7-side customer
 *     entitlement that SQRATCH cannot evaluate, so it must never be treated as
 *     a public destination.
 *
 * Anything unrecognized fails closed to `false` on both — this never invents an
 * access rule Commerce7 does not document.
 *
 * `isPublicEligible` is a NECESSARY but not sufficient component of true
 * public eligibility: it is combined with a verified, merchant-confirmed
 * `CommerceConnection.storefrontUrl`/`productRoute` and a usable `slug` by
 * `computeCommerce7ProductDestination` below (PHASE 16 BIG ROUND / SUBPHASE
 * 2) before `hasProviderStorefrontPublication` is ever set `true`. A
 * Club/Group/Allocation product, or one on an unconfigured connection,
 * remains unreachable as a public destination regardless of this value.
 */
export type Commerce7Availability = {
  isCatalogAvailable: boolean;
  isPublicEligible: boolean;
  /**
   * The token handed to the neutral catalog as `CommerceProduct.status`.
   * Persistence maps exactly `"ACTIVE"` to `isAvailable: true`
   * (see `isStatusActive` in ../product-sync.ts), so only a genuinely
   * available catalog entry may produce it.
   */
  statusToken: string;
};

function readTrimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function computeCommerce7Availability(raw: {
  webStatus?: unknown;
  adminStatus?: unknown;
  security?: unknown;
}): Commerce7Availability {
  const webStatus = readTrimmed(raw.webStatus);
  const adminStatus = readTrimmed(raw.adminStatus);

  const security =
    raw.security && typeof raw.security === "object" && !Array.isArray(raw.security)
      ? (raw.security as Record<string, unknown>)
      : null;
  const availableTo = readTrimmed(security?.availableTo);

  const webAvailable = webStatus === "Available";
  const adminAvailable = adminStatus === "Available";
  const isCatalogAvailable = webAvailable && adminAvailable;
  const isPublicEligible = isCatalogAvailable && availableTo === "Public";

  // A non-available product carries a descriptive, non-ACTIVE token so the
  // reason survives into the catalog without inventing a neutral enum value.
  const statusToken = isCatalogAvailable
    ? "ACTIVE"
    : webStatus === "Retired"
      ? "RETIRED"
      : !webAvailable
        ? "WEB_NOT_AVAILABLE"
        : "ADMIN_NOT_AVAILABLE";

  return { isCatalogAvailable, isPublicEligible, statusToken };
}

// ---------------------------------------------------------------------------
// Product normalization
// ---------------------------------------------------------------------------

function readVariants(raw: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

function readImageUrl(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return (
      readTrimmed(record.url) ??
      readTrimmed(record.src) ??
      readTrimmed(record.image)
    );
  }
  return null;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Merchant-confirmed storefront configuration, as persisted by
 * `configureCommerce7Storefront` (`./commerce7-storefront-configuration.ts`)
 * onto `CommerceConnection.storefrontUrl` /
 * `CommerceConnection.providerMetadata.productRoute`. `null` fields mean the
 * Brand Admin has not configured that value yet.
 */
export type Commerce7StorefrontConfig = {
  storefrontUrl: string | null;
  productRoute: string | null;
};

/**
 * PHASE 16 BIG ROUND / SUBPHASE 2 — computes a Commerce7 product's public
 * destination from MERCHANT-CONFIRMED config (never provider-supplied, never
 * derived from `tenantId`). Requires ALL of:
 *   1. `config` is present (the connection has been configured — see
 *      Subphase 1) and both `storefrontUrl` and `productRoute` still pass
 *      the SAME validators the write path enforced (defensive
 *      re-validation, not a second policy).
 *   2. `availability.isPublicEligible` — webStatus/adminStatus both
 *      `"Available"` AND `security.availableTo === "Public"` (see
 *      `computeCommerce7Availability` above). An Allocation/Group/Club
 *      product, or a Retired/Hidden one, never qualifies.
 *   3. The product has a non-empty `slug`.
 *   4. `buildCommerce7ProductDestinationUrl` accepts the slug (rejects any
 *      slash/traversal attempt) and returns a URL whose origin is byte-equal
 *      to the configured storefront origin.
 * Any failure yields `{ productUrl: "", isPublic: false }` — the same
 * canonical absence as before this phase existed. Never throws.
 */
function computeCommerce7ProductDestination(
  record: Record<string, unknown>,
  availability: Commerce7Availability,
  config?: Commerce7StorefrontConfig,
): { productUrl: string; isPublic: boolean } {
  const CLOSED = { productUrl: "", isPublic: false } as const;

  if (!config || !availability.isPublicEligible) {
    return CLOSED;
  }

  const storefrontResult = validateCommerce7StorefrontUrl(config.storefrontUrl ?? "");
  if (!storefrontResult.ok) {
    return CLOSED;
  }
  const routeResult = validateCommerce7ProductRoute(config.productRoute ?? "");
  if (!routeResult.ok) {
    return CLOSED;
  }

  const slug = readTrimmed(record.slug);
  if (!slug) {
    return CLOSED;
  }

  const url = buildCommerce7ProductDestinationUrl(storefrontResult.value, routeResult.value, slug);
  if (!url) {
    return CLOSED;
  }

  return { productUrl: url, isPublic: true };
}

/**
 * Normalizes one Commerce7 product into the canonical neutral contract.
 *
 * PUBLIC DESTINATION (Phase 16C1/16C2: fail-closed, no verified storefront
 * source existed. PHASE 16 BIG ROUND / SUBPHASE 2: resolved — a Brand Admin
 * now explicitly configures the storefront URL and product-page route via
 * `configureCommerce7Storefront`, so `productUrl` is computed by
 * `computeCommerce7ProductDestination` above from that MERCHANT-CONFIRMED
 * config, never from `tenantId` and never from a provider-supplied host.)
 *
 * `hasProviderSuppliedStorefrontUrl` stays `false` UNCONDITIONALLY — this
 * product's URL is always SQRATCH-constructed from connection config, never
 * returned by Commerce7 itself, so it must never be treated as
 * provider-supplied navigation data the way Shopify's `onlineStoreUrl` is
 * (see `providerTrustsSuppliedStorefrontUrl` in `../provider-capabilities.ts`,
 * which deliberately answers `false` for COMMERCE7). The click-redirect path
 * (`validateDestination` in `../click-attribution.ts`) therefore always
 * re-validates a Commerce7 destination against the connection's own
 * `storefrontUrl` via its host-pinning fallback — which
 * `buildCommerce7ProductDestinationUrl` already guarantees will match, since
 * it constructs the URL FROM that exact origin.
 *
 * `config` is omitted entirely (not merely `null`) by every caller until the
 * connection has genuinely been configured, so an unconfigured Commerce7
 * connection continues to produce `productUrl: ""` / public: false exactly
 * as it always has.
 *
 * Returns `null` for a product with no usable external id — the neutral sync
 * service rejects the whole page in that case rather than persisting a partial.
 */
export function normalizeCommerce7Product(
  raw: unknown,
  config?: Commerce7StorefrontConfig,
): CommerceProduct | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const record = raw as Record<string, unknown>;

  const externalId = readTrimmed(record.id);
  if (!externalId) {
    return null;
  }

  const title = readTrimmed(record.title) ?? "";
  const availability = computeCommerce7Availability(record);
  const variants = readVariants(record.variants);

  // Prices are integer cents across every variant; the canonical catalog stores
  // a min/max range. A product with no variant carrying a usable integer price
  // yields a null range rather than a fabricated zero — the domain contract is
  // explicit that a missing price must never be invented.
  //
  // PHASE 16C2: `Number.isSafeInteger`, not merely `Number.isInteger` — a
  // value like `2 ** 53` is technically an "integer" by `Number.isInteger`
  // but is no longer guaranteed to round-trip exactly through IEEE-754
  // double precision, so it must never be trusted as an exact cents amount.
  // Negative/malformed amounts are NOT special-cased here: they pass through
  // to `minorUnitsToDecimalString` -> `providerPriceStringToMinorUnits` in
  // the canonical layer, whose `NEGATIVE`/`OUT_OF_RANGE` results already null
  // that bound rather than persist a corrupt price — see this file's
  // `minorUnitsToDecimalString` and `../product-sync.ts`'s `computePrice`.
  const variantPrices = variants
    .map((variant) => variant.price)
    .filter((price): price is number => Number.isSafeInteger(price));

  const minCents = variantPrices.length ? Math.min(...variantPrices) : null;
  const maxCents = variantPrices.length ? Math.max(...variantPrices) : null;

  const images: string[] = [];
  const primaryImage = readImageUrl(record.image);
  if (primaryImage) {
    images.push(primaryImage);
  }
  if (Array.isArray(record.images)) {
    for (const entry of record.images) {
      const url = readImageUrl(entry);
      if (url && !images.includes(url)) {
        images.push(url);
      }
    }
  }

  const externalVariantIds = variants
    .map((variant) => readTrimmed(variant.id))
    .filter((id): id is string => Boolean(id));

  const skus = variants
    .map((variant) => readTrimmed(variant.sku))
    .filter((sku): sku is string => Boolean(sku));

  const destination = computeCommerce7ProductDestination(record, availability, config);

  return {
    externalId,
    title,
    // Commerce7's slug is the product handle. It is carried as neutral catalog
    // data ONLY — it is never combined with a host to build a URL here; that
    // happens exclusively inside `computeCommerce7ProductDestination` above,
    // which pins the result to the merchant-configured storefront origin.
    handle: readTrimmed(record.slug),
    productUrl: destination.productUrl,
    imageUrl: images[0] ?? null,
    images,
    priceText: null,
    // Commerce7's product payload documents no currency field, so this stays
    // empty per-product exactly as it always has. The canonical layer
    // resolves currency from the CONNECTION
    // (`CommerceConnectionSummary.currencyCode`), which — as of PHASE 16 BIG
    // ROUND / SUBPHASE 1 — is a genuine Brand-Admin-confirmed value written
    // by `configureCommerce7Storefront`, not merely a placeholder awaiting a
    // future source.
    currency: "",
    priceRange: {
      min: minCents === null ? null : minCents / 10 ** COMMERCE7_MINOR_UNIT_EXPONENT,
      max: maxCents === null ? null : maxCents / 10 ** COMMERCE7_MINOR_UNIT_EXPONENT,
    },
    priceRangeRaw: {
      min: minCents === null ? null : minorUnitsToDecimalString(minCents),
      max: maxCents === null ? null : minorUnitsToDecimalString(maxCents),
    },
    externalVariantIds,
    descriptionText: readTrimmed(record.teaser) ?? readTrimmed(record.content),
    sku: skus.length === 1 ? skus[0] : null,
    status: availability.statusToken,
    providerCreatedAt: readDate(record.createdAt),
    providerUpdatedAt: readDate(record.updatedAt),
    hasProviderStorefrontPublication: destination.isPublic,
    // ALWAYS false — see the `hasProviderSuppliedStorefrontUrl` doc comment
    // on `normalizeCommerce7Product` above.
    hasProviderSuppliedStorefrontUrl: false,
  };
}

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

export type Commerce7ProductRequest = {
  /** Exact tenant, always derived from `CommerceConnection.externalAccountId`. */
  tenant: string;
  cursor?: string | null;
  signal?: AbortSignal;
  /**
   * Merchant-confirmed storefront config for THIS exact connection (see
   * `Commerce7StorefrontConfig` above). Omitted (not merely `null`) means
   * "not configured" — every normalized product then gets `productUrl: ""`.
   * Named distinctly from the local `config` (app credential) binding below
   * to avoid confusion between the two.
   */
  storefrontConfig?: Commerce7StorefrontConfig;
};

/**
 * Fetches ONE Commerce7 product page.
 *
 * Auth: `Authorization: Basic base64(appId:appSecret)` + `tenant: <exact>`.
 * A missing App ID or App Secret fails closed BEFORE any network call.
 */
export async function fetchCommerce7ProductPage(
  request: Commerce7ProductRequest,
  deps: { fetchImpl?: Commerce7Fetch } = {},
): Promise<Commerce7ProductPage> {
  const tenant = normalizeCommerce7Tenant(request.tenant);
  if (!tenant) {
    providerError("A valid Commerce7 tenant is required.");
  }

  const config = getCommerce7AppConfig();
  if (!config) {
    // Deliberately does not name which variable is missing.
    providerError("Commerce7 API credentials are not configured.");
  }

  const fetchImpl = (deps.fetchImpl ??
    (globalThis.fetch as unknown as Commerce7Fetch)) as Commerce7Fetch;

  const cursor = request.cursor?.trim() || COMMERCE7_START_CURSOR;
  const url = `${COMMERCE7_API_BASE}/product?cursor=${encodeURIComponent(cursor)}`;

  let response: Awaited<ReturnType<Commerce7Fetch>>;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: {
        Authorization: buildCommerce7AppAuthorizationHeader(config),
        tenant,
        Accept: "application/json",
      },
      ...(request.signal ? { signal: request.signal } : {}),
    });
  } catch {
    // The thrown error can echo request headers; never surface it.
    providerError("Commerce7 could not be reached.");
  }

  if (response.status === 401 || response.status === 403) {
    providerError(
      "Commerce7 rejected the app credentials for this tenant.",
      response.status,
    );
  }

  if (!response.ok) {
    providerError("Commerce7 returned an error for the product request.", response.status);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    providerError("Commerce7 returned a malformed product response.", response.status);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    providerError("Commerce7 returned a malformed product response.");
  }

  const body = payload as Record<string, unknown>;
  const rawProducts = body.products;

  if (!Array.isArray(rawProducts)) {
    providerError("Commerce7 returned a malformed product response.");
  }

  const products: CommerceProduct[] = [];
  for (const entry of rawProducts) {
    const normalized = normalizeCommerce7Product(entry, request.storefrontConfig);
    if (!normalized) {
      providerError("Commerce7 returned a product without a usable id.");
    }
    products.push(normalized);
  }

  const nextCursor = readTrimmed(body.cursor);

  return {
    products,
    nextCursor,
    isComplete: nextCursor === null,
  };
}

/** Bounded guard against a provider that never stops paginating. */
const MAX_CATALOG_PAGES = 200;

/**
 * Walks the whole Commerce7 catalog with cursor pagination.
 *
 * Terminates when a page returns no cursor. Fails loudly — never returning a
 * partial catalog as if it were complete — when a later page errors, when a
 * cursor repeats (provider loop), or when the page guard is reached. That
 * matters because the caller persists absence as unavailability: a silently
 * truncated catalog would mark live products as gone.
 */
export async function fetchAllCommerce7Products(
  request: { tenant: string; signal?: AbortSignal; storefrontConfig?: Commerce7StorefrontConfig },
  deps: { fetchImpl?: Commerce7Fetch } = {},
): Promise<CommerceProduct[]> {
  const products: CommerceProduct[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = COMMERCE7_START_CURSOR;
  let pages = 0;

  while (cursor) {
    if (pages >= MAX_CATALOG_PAGES) {
      providerError("Commerce7 catalog exceeded the maximum page guard.");
    }

    const page: Commerce7ProductPage = await fetchCommerce7ProductPage(
      {
        tenant: request.tenant,
        cursor,
        signal: request.signal,
        storefrontConfig: request.storefrontConfig,
      },
      deps,
    );
    pages += 1;
    products.push(...page.products);

    if (page.isComplete || !page.nextCursor) {
      return products;
    }

    if (seenCursors.has(page.nextCursor)) {
      providerError("Commerce7 returned a repeated catalog cursor.");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return products;
}
