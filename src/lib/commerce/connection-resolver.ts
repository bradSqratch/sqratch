/**
 * src/lib/commerce/connection-resolver.ts
 *
 * Provider-neutral READ path that lets Phase-2 (and tests) ask "what is
 * brand X's commerce connection for provider Y" without caring whether the
 * answer lives in a real `CommerceConnection` row or is still only present
 * as legacy `Brand.shopify*` columns.
 *
 * PHASE 1 SCOPE: nothing on the live request path calls this module yet
 * (see the Phase-1 architectural decision that reads stay on
 * `Brand.shopify*` columns unchanged). This is a library entry point for
 * the Phase-2 cutover, exercised today only by unit tests.
 *
 * RESOLUTION ORDER (`resolveCommerceConnectionForBrand`):
 *   1. Prefer an existing `CommerceConnection` row for (brandId, provider).
 *      If more than one exists (not expected today, but not prevented by
 *      the schema either — there is no `@@unique([brandId, provider])`),
 *      pick deterministically via `pickPreferredConnectionRow`:
 *        a. `isPrimary: true` wins over `isPrimary: false`.
 *        b. Else, the row with the most recent `installedAt` wins (rows
 *           with a null `installedAt` sort last).
 *        c. Else, the row with the most recent `createdAt` wins.
 *   2. If no `CommerceConnection` row exists, derive a legacy fallback
 *      summary from `Brand.shopify*` columns (`SHOPIFY` only — there is no
 *      legacy column set for any other provider). The result has `id: null`
 *      and `isLegacyFallback: true`.
 *   3. If the brand doesn't exist, or exists but has no shop domain on
 *      record (never connected, or fully redacted), return `null` — a
 *      brand with no Shopify connection at all keeps resolving to `null`
 *      rather than a bogus empty summary.
 *
 * SECURITY: nothing exported from this file ever reads or returns
 * `CommerceConnectionSecret`, `Brand.shopifyAdminAccessTokenEncrypted`, or
 * any other credential column. `CommerceConnectionSummary` has no
 * credential field by construction (see `./types.ts`).
 *
 * TESTABILITY: dependency injection follows the same idiom as
 * `ReconciliationDeps` in `src/lib/reward-reconciliation.ts` — the pure
 * mapping helpers (`mapLegacyBrandToConnectionSummary`,
 * `mapCommerceConnectionToSummary`, `mapLegacyShopifyStatusToCommerceStatus`,
 * `pickPreferredConnectionRow`) take plain objects and need no DB. The
 * default DB-backed deps lazily import `@/lib/prisma` (only resolved when a
 * lookup actually runs), matching `getPrisma()` in reward-reconciliation.ts
 * and the "lazy defaults" pattern documented in
 * `./providers/shopify-commerce-adapter.ts`.
 */

import {
  CommerceProvider,
  type CommerceConnectionStatus,
  type Prisma,
  type ShopifyConnectionStatus,
} from "@prisma/client";
import type { CommerceConnectionSummary } from "./types";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Maps a legacy `Brand.shopifyConnectionStatus` value to the neutral
 * `CommerceConnectionStatus`. The four legacy statuses map 1:1 onto four of
 * the six neutral statuses; `PENDING` and `ERROR` have no legacy
 * equivalent and are never produced here for a value that matches a known
 * legacy status.
 *
 * Typed to accept `string` (not just the closed `ShopifyConnectionStatus`
 * union) so it can defensively handle a value that doesn't match any known
 * legacy status without throwing and without an `any` cast — falling back
 * to `ERROR` to surface the anomaly rather than silently misreporting it as
 * `DISCONNECTED` or any other real status.
 */
export function mapLegacyShopifyStatusToCommerceStatus(
  status: ShopifyConnectionStatus | string,
): CommerceConnectionStatus {
  switch (status) {
    case "DISCONNECTED":
      return "DISCONNECTED";
    case "CONNECTED":
      return "CONNECTED";
    case "UNINSTALLED":
      return "UNINSTALLED";
    case "REQUIRES_RECONNECT":
      return "REQUIRES_RECONNECT";
    default:
      return "ERROR";
  }
}

/**
 * Derives a readable display name for a Shopify connection. Chosen over
 * always using the raw shop domain because "acme" reads better than
 * "acme.myshopify.com" in UI contexts — the `.myshopify.com` suffix is
 * stripped when present, leaving custom domains untouched. Falls back to
 * the brand name when no domain is known (defensive — callers of
 * `mapLegacyBrandToConnectionSummary` never hit this branch since a summary
 * is only built once a domain is confirmed present), and finally to a
 * static placeholder so this never returns an empty string.
 */
export function deriveShopifyDisplayName(
  shopDomain: string | null | undefined,
  brandName: string | null | undefined,
): string {
  const trimmedDomain = shopDomain?.trim();
  if (trimmedDomain) {
    const suffix = ".myshopify.com";
    return trimmedDomain.endsWith(suffix)
      ? trimmedDomain.slice(0, -suffix.length)
      : trimmedDomain;
  }

  const trimmedName = brandName?.trim();
  return trimmedName && trimmedName.length > 0 ? trimmedName : "Shopify";
}

/**
 * Normalizes the legacy `Brand.shopifyGrantedScopes` shape (a
 * comma-separated string, or `null`) into `string[]`, trimming each entry
 * and dropping empties.
 */
export function normalizeLegacyGrantedScopes(
  raw: string | null | undefined,
): string[] {
  if (!raw) {
    return [];
  }

  return raw
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/**
 * Normalizes `CommerceConnection.grantedScopes` (a `Json?` column) into
 * `string[]`. Tolerates any shape that isn't a genuine array (object,
 * number, string, null, etc.) by returning `[]` rather than throwing —
 * Json columns carry no compile-time guarantee about their runtime shape.
 */
export function normalizeGrantedScopesJson(
  raw: Prisma.JsonValue | null | undefined,
): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((scope): scope is string => typeof scope === "string")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
}

/** The subset of legacy `Brand` columns needed to derive a fallback summary. */
export type LegacyBrandShopifyFields = {
  id: string;
  name: string | null;
  shopifyShopDomain: string | null;
  shopifyConnectionStatus: ShopifyConnectionStatus | string;
  shopifyInstalledAt: Date | null;
  shopifyUninstalledAt: Date | null;
  shopifyLastProductSyncAt: Date | null;
  shopifyGrantedScopes: string | null;
};

/**
 * Derives a `CommerceConnectionSummary` from legacy `Brand.shopify*`
 * columns. Returns `null` when the brand has no shop domain on record —
 * there is nothing to represent as a connection (never connected, or fully
 * redacted). `isPrimary` is always `true` for a legacy-derived summary: the
 * legacy schema only ever allows a single Shopify connection per brand
 * (`Brand.shopifyShopDomain` is `@unique`), so there is never a rival
 * connection for it to lose primacy to.
 */
export function mapLegacyBrandToConnectionSummary(
  brand: LegacyBrandShopifyFields,
): CommerceConnectionSummary | null {
  const shopDomain = brand.shopifyShopDomain?.trim();
  if (!shopDomain) {
    return null;
  }

  return {
    id: null,
    brandId: brand.id,
    provider: CommerceProvider.SHOPIFY,
    status: mapLegacyShopifyStatusToCommerceStatus(brand.shopifyConnectionStatus),
    displayName: deriveShopifyDisplayName(shopDomain, brand.name),
    externalAccountId: shopDomain,
    storefrontUrl: `https://${shopDomain}`,
    isPrimary: true,
    grantedScopes: normalizeLegacyGrantedScopes(brand.shopifyGrantedScopes),
    installedAt: brand.shopifyInstalledAt,
    uninstalledAt: brand.shopifyUninstalledAt,
    lastProductSyncAt: brand.shopifyLastProductSyncAt,
    isLegacyFallback: true,
  };
}

/**
 * The subset of a `CommerceConnection` row this module needs. `createdAt`
 * is required (for the tiebreak) even though it is not part of
 * `CommerceConnectionSummary`. Never includes the related
 * `CommerceConnectionSecret` — this file must never read credentials.
 */
export type CommerceConnectionRow = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: CommerceConnectionStatus;
  displayName: string;
  externalAccountId: string;
  storefrontUrl: string | null;
  isPrimary: boolean;
  grantedScopes: Prisma.JsonValue | null;
  installedAt: Date | null;
  uninstalledAt: Date | null;
  lastProductSyncAt: Date | null;
  createdAt: Date;
};

/** Maps a real `CommerceConnection` row to the neutral summary shape. */
export function mapCommerceConnectionToSummary(
  row: CommerceConnectionRow,
): CommerceConnectionSummary {
  return {
    id: row.id,
    brandId: row.brandId,
    provider: row.provider,
    status: row.status,
    displayName: row.displayName,
    externalAccountId: row.externalAccountId,
    storefrontUrl: row.storefrontUrl,
    isPrimary: row.isPrimary,
    grantedScopes: normalizeGrantedScopesJson(row.grantedScopes),
    installedAt: row.installedAt,
    uninstalledAt: row.uninstalledAt,
    lastProductSyncAt: row.lastProductSyncAt,
    isLegacyFallback: false,
  };
}

/**
 * Deterministic tiebreak across multiple `CommerceConnection` rows for the
 * same (brandId, provider) — see the resolution-order doc comment at the
 * top of this file for the exact rule. Returns `null` for an empty input.
 * Does not mutate the input array.
 */
export function pickPreferredConnectionRow(
  rows: readonly CommerceConnectionRow[],
): CommerceConnectionRow | null {
  if (rows.length === 0) {
    return null;
  }

  return [...rows].sort(compareConnectionRowsByPreference)[0];
}

function compareConnectionRowsByPreference(
  a: CommerceConnectionRow,
  b: CommerceConnectionRow,
): number {
  if (a.isPrimary !== b.isPrimary) {
    return a.isPrimary ? -1 : 1;
  }

  const aInstalledAt = a.installedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bInstalledAt = b.installedAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aInstalledAt !== bInstalledAt) {
    return bInstalledAt - aInstalledAt;
  }

  return b.createdAt.getTime() - a.createdAt.getTime();
}

// ---------------------------------------------------------------------------
// Dependency injection (for unit testing without a real DB)
// ---------------------------------------------------------------------------

export type CommerceConnectionResolverDeps = {
  /** Loads every `CommerceConnection` row for (brandId, provider). */
  findConnectionRows(
    brandId: string,
    provider: CommerceProvider,
  ): Promise<CommerceConnectionRow[]>;

  /** Loads the legacy Shopify fields for a brand, or `null` if it doesn't exist. */
  findLegacyBrandFields(
    brandId: string,
  ): Promise<LegacyBrandShopifyFields | null>;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

async function defaultFindConnectionRows(
  brandId: string,
  provider: CommerceProvider,
): Promise<CommerceConnectionRow[]> {
  const prisma = await getPrisma();
  return prisma.commerceConnection.findMany({
    where: { brandId, provider },
    select: {
      id: true,
      brandId: true,
      provider: true,
      status: true,
      displayName: true,
      externalAccountId: true,
      storefrontUrl: true,
      isPrimary: true,
      grantedScopes: true,
      installedAt: true,
      uninstalledAt: true,
      lastProductSyncAt: true,
      createdAt: true,
    },
  });
}

async function defaultFindLegacyBrandFields(
  brandId: string,
): Promise<LegacyBrandShopifyFields | null> {
  const prisma = await getPrisma();
  return prisma.brand.findUnique({
    where: { id: brandId },
    select: {
      id: true,
      name: true,
      shopifyShopDomain: true,
      shopifyConnectionStatus: true,
      shopifyInstalledAt: true,
      shopifyUninstalledAt: true,
      shopifyLastProductSyncAt: true,
      shopifyGrantedScopes: true,
    },
  });
}

const DEFAULT_RESOLVER_DEPS: CommerceConnectionResolverDeps = {
  findConnectionRows: defaultFindConnectionRows,
  findLegacyBrandFields: defaultFindLegacyBrandFields,
};

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Resolves the commerce connection SQRATCH should treat as authoritative
 * for (brandId, provider) — see the resolution-order doc comment at the top
 * of this file. Returns `null` when the brand has no connection at all for
 * this provider (including: brand not found, or a Shopify brand that never
 * connected / was fully redacted).
 *
 * Not wired into any request path in Phase 1 — see the file header.
 */
export async function resolveCommerceConnectionForBrand(
  brandId: string,
  provider: CommerceProvider = CommerceProvider.SHOPIFY,
  deps: Partial<CommerceConnectionResolverDeps> = {},
): Promise<CommerceConnectionSummary | null> {
  const resolvedDeps: CommerceConnectionResolverDeps = {
    ...DEFAULT_RESOLVER_DEPS,
    ...deps,
  };

  const rows = await resolvedDeps.findConnectionRows(brandId, provider);
  const preferred = pickPreferredConnectionRow(rows);
  if (preferred) {
    return mapCommerceConnectionToSummary(preferred);
  }

  // Only SHOPIFY has a legacy Brand.shopify* fallback — no other provider
  // ever had a pre-CommerceConnection representation in this codebase.
  if (provider !== CommerceProvider.SHOPIFY) {
    return null;
  }

  const legacyBrand = await resolvedDeps.findLegacyBrandFields(brandId);
  if (!legacyBrand) {
    return null;
  }

  return mapLegacyBrandToConnectionSummary(legacyBrand);
}
