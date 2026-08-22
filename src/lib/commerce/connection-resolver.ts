/**
 * src/lib/commerce/connection-resolver.ts
 *
 * Provider-neutral READ path that lets Phase-2 (and tests) ask "what is
 * brand X's commerce connection for provider Y".
 *
 * PHASE 14C-A: legacy `Brand.shopify*` fallback removed. Every currently
 * installed Shopify merchant already has a canonical `CommerceConnection` +
 * `CommerceConnectionSecret` (operator-verified live DB evidence) — there is
 * no legitimate legacy source of truth left to derive a summary from. A
 * brand with no `CommerceConnection` row for a provider now simply resolves
 * to `null`, the same as a brand that never connected at all. This module's
 * pure mapping helper `mapCommerceConnectionToSummary` is on the live
 * request path — `connection-service.ts`'s `getActiveCommerceConnection`/
 * `getPrimaryCommerceConnection` are built directly on top of it, and
 * several routes (status, products, dashboard, rewards) call through to
 * those.
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
 *   2. If no `CommerceConnection` row exists, resolves to `null` — no
 *      legacy fallback.
 *
 * SECURITY: nothing exported from this file ever reads or returns
 * `CommerceConnectionSecret` or any credential column.
 * `CommerceConnectionSummary` has no
 * credential field by construction (see `./types.ts`).
 *
 * TESTABILITY: dependency injection follows the same idiom as
 * `ReconciliationDeps` in `src/lib/reward-reconciliation.ts` — the pure
 * mapping helpers (`mapCommerceConnectionToSummary`, `pickPreferredConnectionRow`)
 * take plain objects and need no DB. The default DB-backed deps lazily
 * import `@/lib/prisma` (only resolved when a lookup actually runs),
 * matching `getPrisma()` in reward-reconciliation.ts and the "lazy
 * defaults" pattern documented in `./providers/shopify-commerce-adapter.ts`.
 */

import { CommerceProvider, type CommerceConnectionStatus, type Prisma } from "@prisma/client";
import type { CommerceConnectionSummary } from "./types";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Derives a readable display name for a Shopify connection. Chosen over
 * always using the raw shop domain because "acme" reads better than
 * "acme.myshopify.com" in UI contexts — the `.myshopify.com` suffix is
 * stripped when present, leaving custom domains untouched. Falls back to
 * the brand name when no domain is known (defensive), and finally to a
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
 * Normalizes a comma-separated scope string into `string[]`, trimming each
 * entry and dropping empties before canonical persistence.
 */
export function normalizeGrantedScopes(
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
  /** Provider-opaque metadata. Only `currencyCode` is read out of it here. */
  providerMetadata: Prisma.JsonValue | null;
};

/**
 * Extracts `currencyCode` from `CommerceConnection.providerMetadata`.
 * Tolerates any shape that isn't a plain object with a string `currencyCode`
 * (the column is `Json?`, with no compile-time guarantee) by returning
 * `null` rather than throwing.
 */
export function extractCurrencyCodeFromProviderMetadata(
  raw: Prisma.JsonValue | null | undefined,
): string | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = (raw as Record<string, unknown>).currencyCode;
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

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
    currencyCode: extractCurrencyCodeFromProviderMetadata(row.providerMetadata),
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
      providerMetadata: true,
    },
  });
}

const DEFAULT_RESOLVER_DEPS: CommerceConnectionResolverDeps = {
  findConnectionRows: defaultFindConnectionRows,
};

// ---------------------------------------------------------------------------
// Public resolver
// ---------------------------------------------------------------------------

/**
 * Resolves the commerce connection SQRATCH should treat as authoritative
 * for (brandId, provider) — see the resolution-order doc comment at the top
 * of this file. Returns `null` when the brand has no `CommerceConnection`
 * row at all for this provider — no legacy fallback (Phase 14C-A).
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
  return preferred ? mapCommerceConnectionToSummary(preferred) : null;
}
