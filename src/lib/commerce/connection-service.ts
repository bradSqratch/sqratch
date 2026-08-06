/**
 * src/lib/commerce/connection-service.ts
 *
 * The provider-neutral commerce connection SERVICE — the single entry point
 * routes should use to ask "what is brand X's commerce connection", "is it
 * usable", and "what can this provider's adapter do", instead of each route
 * re-implementing provider selection and legacy/mirror preference logic by
 * hand.
 *
 * This module is built ON TOP OF `./connection-resolver.ts` (never rewrites
 * or removes it): it reuses `mapLegacyBrandToConnectionSummary`,
 * `mapCommerceConnectionToSummary`, and `pickPreferredConnectionRow`
 * unchanged, and adds the CONSISTENCY-CHECKED preference + drift signal that
 * `resolveCommerceConnectionForBrand` (connection-resolver.ts's own
 * resolver, which always prefers the row when one exists) does not attempt.
 *
 * ---------------------------------------------------------------------------
 * CONSISTENCY-CHECKED PREFERENCE (`getActiveCommerceConnection`)
 * ---------------------------------------------------------------------------
 * Every Shopify write path now dual-writes into `CommerceConnection` (see
 * `./connection-sync.ts`), but that mirror write is best-effort and can lag
 * or fail independently of the legacy `Brand.shopify*` write it mirrors. So
 * the row is only trusted when it AGREES with legacy truth:
 *
 *   - `CommerceConnection` row exists, `Brand.shopifyShopDomain` present,
 *     and the row's `externalAccountId` (normalized) equals the normalized
 *     legacy domain -> the row is used (no drift).
 *   - Anything else — the row's domain disagrees with legacy, the row
 *     exists but legacy has no domain on record, or legacy has a domain but
 *     no row exists yet — is treated as the mirror being stale. Legacy wins,
 *     and the disagreement is reported via `detectConnectionDrift` /
 *     the `drift` half of the internal resolution so a later reconciliation
 *     tool can act on it. Preferring a stale row here would be a
 *     user-visible behavior change, which Phase 2 must not introduce.
 *   - Both sides agreeing there is no connection at all is NOT drift.
 *
 * Only SHOPIFY has a legacy source of truth to disagree with (see
 * connection-resolver.ts's own resolver) — for any other provider the row,
 * if one exists, is authoritative as-is and `detectConnectionDrift` always
 * reports `driftDetected: false`.
 *
 * Multiple `CommerceConnection` rows for the same (brandId, provider) are
 * resolved with `pickPreferredConnectionRow`'s existing tiebreak — this
 * module does not invent a second, divergent ordering.
 *
 * ---------------------------------------------------------------------------
 * WHY `isConnectionUsable` DOESN'T CHECK A TOKEN FIELD
 * ---------------------------------------------------------------------------
 * Today's "is this brand's Shopify connection usable" gates (e.g.
 * `src/app/api/brand/shopify/products/route.ts`, the `CandidateBrand` check
 * in `src/lib/lesson-product-links.ts`) are a three-part AND: shop domain
 * present, access token present, status === CONNECTED. `CommerceConnectionSummary`
 * never carries a credential field by construction (see `./types.ts`), so
 * the token-presence leg cannot be expressed directly against a summary.
 * Instead this relies on an invariant every Shopify write path in this
 * codebase upholds (verified by inspection, not merely assumed):
 *   - `shopifyConnectionStatus` is set to `CONNECTED` ONLY in the same write
 *     that also sets a non-null access token
 *     (`src/lib/shopify-token-manager.ts` ~L421-432).
 *   - Every write that moves status AWAY from `CONNECTED` nulls the token in
 *     that SAME write: `DISCONNECTED`
 *     (`src/app/api/brand/shopify/disconnect/route.ts`), `UNINSTALLED`
 *     (`src/app/api/shopify/webhooks/app/uninstalled/route.ts`,
 *     `src/app/api/shopify/webhooks/shop/redact/route.ts`), and
 *     `REQUIRES_RECONNECT` (`shopify-token-manager.ts` ~L333-334).
 * So for any summary this service can produce, `status === "CONNECTED"` is
 * equivalent to "domain present + token present + status CONNECTED" — not
 * an approximation, a direct consequence of those write paths. This is also
 * why `connection-resolver.ts`'s own `LegacyBrandShopifyFields` type (which
 * `mapLegacyBrandToConnectionSummary` consumes) never includes the token
 * column either — that decision already encodes the same judgment.
 *
 * ---------------------------------------------------------------------------
 * `getCommerceCapabilities` NEVER THROWS (a deliberate, consistent choice)
 * ---------------------------------------------------------------------------
 * `getCommerceCapabilities` returns an all-`false` `CommerceCapabilities`
 * for an unsupported provider (COMMERCE7 today) rather than throwing —
 * chosen because "what can this provider do" is a query callers should be
 * able to branch on freely (e.g. to grey out a button) without a
 * provider-support try/catch at every call site. `getAdapterForConnection`
 * makes the OPPOSITE choice deliberately: it throws `UnsupportedProviderError`
 * for an unsupported provider, because "give me the adapter to actually call
 * a method on" has no sane non-throwing fallback value — returning `null`
 * would just move the crash to the next line (`adapter.syncProducts(...)`)
 * with a worse error. Both behaviors are achieved via the registry's own
 * `tryGet` (non-throwing) / `get` (throwing) methods respectively — this
 * file does not re-implement that choice, only picks which one each function
 * uses.
 *
 * ---------------------------------------------------------------------------
 * READS NEVER WRITE
 * ---------------------------------------------------------------------------
 * Every exported function in this file is read-only: the default
 * dependencies only ever call `findMany` / `findUnique` on `prisma.brand`
 * and `prisma.commerceConnection`. Nothing here creates, updates, upserts,
 * or deletes a row, and nothing here reads `CommerceConnectionSecret`.
 *
 * TESTABILITY: dependency-injectable in the same idiom as
 * `CommerceConnectionResolverDeps` in `./connection-resolver.ts` and
 * `ConnectionSyncDeps` in `./connection-sync.ts` — the default DB-backed
 * deps lazily import `@/lib/prisma` (only resolved when a lookup actually
 * runs), so importing this module never requires `DATABASE_URL`.
 */

import { CommerceProvider } from "@prisma/client";
import type { CommerceAdapter } from "./adapter";
import { defaultCommerceAdapterRegistry } from "./default-registry";
import type { CommerceAdapterRegistry } from "./registry";
import {
  mapCommerceConnectionToSummary,
  mapLegacyBrandToConnectionSummary,
  pickPreferredConnectionRow,
  type CommerceConnectionRow,
  type LegacyBrandShopifyFields,
} from "./connection-resolver";
import { normalizeExternalAccountId } from "./connection-sync";
import type { CommerceCapabilities, CommerceConnectionSummary } from "./types";

export type { CommerceConnectionRow, LegacyBrandShopifyFields } from "./connection-resolver";

// ---------------------------------------------------------------------------
// Drift signal (reused by a later reconciliation tool)
// ---------------------------------------------------------------------------

export type CommerceConnectionDriftReason =
  /** A `CommerceConnection` row exists but its externalAccountId disagrees with the normalized legacy domain. */
  | "ROW_LEGACY_MISMATCH"
  /** A `CommerceConnection` row exists but the legacy Brand has no shop domain on record. */
  | "ROW_WITHOUT_LEGACY_DOMAIN"
  /** The legacy Brand has a shop domain but no `CommerceConnection` row exists yet (mirror hasn't caught up / not backfilled). */
  | "LEGACY_DOMAIN_WITHOUT_ROW";

/**
 * Typed drift signal for (brandId, provider). Never carries a credential —
 * only the two externalAccountId (shop domain) strings being compared, which
 * are provider account identifiers, not secrets.
 */
export type CommerceConnectionDriftResult =
  | { driftDetected: false; brandId: string; provider: CommerceProvider }
  | {
      driftDetected: true;
      brandId: string;
      provider: CommerceProvider;
      reason: CommerceConnectionDriftReason;
      rowExternalAccountId: string | null;
      legacyExternalAccountId: string | null;
    };

// ---------------------------------------------------------------------------
// Dependency injection (for unit testing without a real DB)
// ---------------------------------------------------------------------------

export type CommerceConnectionServiceDeps = {
  /** Loads every `CommerceConnection` row for (brandId, provider). */
  findConnectionRows(
    brandId: string,
    provider: CommerceProvider,
  ): Promise<CommerceConnectionRow[]>;
  /** Loads the legacy Shopify fields for a brand, or `null` if it doesn't exist. */
  findLegacyBrandFields(brandId: string): Promise<LegacyBrandShopifyFields | null>;
  /** Loads a single `CommerceConnection` row by its own id, or `null` if it does not exist. */
  findConnectionRowById(connectionId: string): Promise<CommerceConnectionRow | null>;
  /** The adapter registry used by `getCommerceCapabilities` / `getAdapterForConnection`. */
  registry: CommerceAdapterRegistry;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

/** Shared `select` shape for a `CommerceConnectionRow` — kept in one place so the two default readers below can never drift apart field-by-field. */
const CONNECTION_ROW_SELECT = {
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
} as const;

async function defaultFindConnectionRows(
  brandId: string,
  provider: CommerceProvider,
): Promise<CommerceConnectionRow[]> {
  const prisma = await getPrisma();
  return prisma.commerceConnection.findMany({
    where: { brandId, provider },
    select: CONNECTION_ROW_SELECT,
  });
}

async function defaultFindConnectionRowById(
  connectionId: string,
): Promise<CommerceConnectionRow | null> {
  const prisma = await getPrisma();
  return prisma.commerceConnection.findUnique({
    where: { id: connectionId },
    select: CONNECTION_ROW_SELECT,
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

const DEFAULT_SERVICE_DEPS: CommerceConnectionServiceDeps = {
  findConnectionRows: defaultFindConnectionRows,
  findLegacyBrandFields: defaultFindLegacyBrandFields,
  findConnectionRowById: defaultFindConnectionRowById,
  registry: defaultCommerceAdapterRegistry,
};

function resolveServiceDeps(
  deps: Partial<CommerceConnectionServiceDeps>,
): CommerceConnectionServiceDeps {
  return { ...DEFAULT_SERVICE_DEPS, ...deps };
}

// ---------------------------------------------------------------------------
// Internal: the consistency-checked resolution shared by
// getActiveCommerceConnection / getPrimaryCommerceConnection / detectConnectionDrift
// ---------------------------------------------------------------------------

type PreferredConnectionResolution = {
  connection: CommerceConnectionSummary | null;
  drift: CommerceConnectionDriftResult;
};

async function resolvePreferredConnection(
  brandId: string,
  provider: CommerceProvider,
  deps: CommerceConnectionServiceDeps,
  rowFilter?: (row: CommerceConnectionRow) => boolean,
): Promise<PreferredConnectionResolution> {
  const rows = await deps.findConnectionRows(brandId, provider);
  const candidateRows = rowFilter ? rows.filter(rowFilter) : rows;
  const preferredRow = pickPreferredConnectionRow(candidateRows);

  if (provider !== CommerceProvider.SHOPIFY) {
    // No legacy fallback exists for any other provider (see
    // connection-resolver.ts's own resolver) — there is no second source of
    // truth to disagree with, so the row (if any) is authoritative as-is.
    return {
      connection: preferredRow ? mapCommerceConnectionToSummary(preferredRow) : null,
      drift: { driftDetected: false, brandId, provider },
    };
  }

  const legacyBrand = await deps.findLegacyBrandFields(brandId);
  const legacyDomain = legacyBrand?.shopifyShopDomain
    ? normalizeExternalAccountId(legacyBrand.shopifyShopDomain)
    : null;
  const legacySummary = legacyBrand ? mapLegacyBrandToConnectionSummary(legacyBrand) : null;

  if (!preferredRow) {
    if (legacyDomain === null) {
      // Both sides agree: no connection at all. Not drift.
      return { connection: null, drift: { driftDetected: false, brandId, provider } };
    }
    // Legacy says connected; the mirror has no row yet (dual-write never ran,
    // or the brand predates the backfill). Legacy wins; flagged so a
    // reconciliation tool can create/backfill the missing row.
    return {
      connection: legacySummary,
      drift: {
        driftDetected: true,
        brandId,
        provider,
        reason: "LEGACY_DOMAIN_WITHOUT_ROW",
        rowExternalAccountId: null,
        legacyExternalAccountId: legacyDomain,
      },
    };
  }

  const rowExternalAccountId = normalizeExternalAccountId(preferredRow.externalAccountId);

  if (legacyDomain === null) {
    // A CommerceConnection row exists but legacy has no domain on record
    // (e.g. redacted, or relinked away since the row was written) — the
    // mirror is stale relative to legacy. Legacy wins (there is nothing to
    // be connected to from legacy's point of view), flagged as drift.
    return {
      connection: legacySummary, // null — legacyBrand has no domain
      drift: {
        driftDetected: true,
        brandId,
        provider,
        reason: "ROW_WITHOUT_LEGACY_DOMAIN",
        rowExternalAccountId,
        legacyExternalAccountId: null,
      },
    };
  }

  if (rowExternalAccountId === legacyDomain) {
    // The mirror agrees with legacy truth — safe to prefer the row.
    return {
      connection: mapCommerceConnectionToSummary(preferredRow),
      drift: { driftDetected: false, brandId, provider },
    };
  }

  // Disagreement: the mirror is stale for this shop. Legacy wins per the
  // dual-write rationale (every write path dual-writes, but the mirror is
  // best-effort) — never silently trust a stale row.
  return {
    connection: legacySummary,
    drift: {
      driftDetected: true,
      brandId,
      provider,
      reason: "ROW_LEGACY_MISMATCH",
      rowExternalAccountId,
      legacyExternalAccountId: legacyDomain,
    },
  };
}

// ---------------------------------------------------------------------------
// Public connection lookups
// ---------------------------------------------------------------------------

/**
 * Resolves the commerce connection SQRATCH should treat as authoritative for
 * (brandId, provider) using the consistency-checked preference described in
 * the file header. Returns `null` when the brand has no connection at all
 * for this provider.
 */
export async function getActiveCommerceConnection(
  brandId: string,
  provider: CommerceProvider = CommerceProvider.SHOPIFY,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): Promise<CommerceConnectionSummary | null> {
  const resolved = await resolvePreferredConnection(brandId, provider, resolveServiceDeps(deps));
  return resolved.connection;
}

/**
 * Looks up a connection by its own `CommerceConnection.id`. Unlike
 * `getActiveCommerceConnection`, there is no legacy fallback here — a
 * legacy-derived summary always has `id: null`, so it can never be the
 * target of an id lookup in the first place. Returns `null` if no row with
 * this id exists.
 */
export async function getCommerceConnectionById(
  connectionId: string,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): Promise<CommerceConnectionSummary | null> {
  const resolvedDeps = resolveServiceDeps(deps);
  const row = await resolvedDeps.findConnectionRowById(connectionId);
  return row ? mapCommerceConnectionToSummary(row) : null;
}

/**
 * Resolves the connection marked primary for (brandId, provider), using the
 * SAME consistency-checked preference as `getActiveCommerceConnection`
 * (restricted to rows with `isPrimary: true` before the tiebreak). Falls
 * back to the legacy-derived summary when no row is marked primary — which
 * is always `isPrimary: true` itself (see
 * `mapLegacyBrandToConnectionSummary`'s doc comment) — and to `null` when
 * neither exists. Never throws when nothing is marked primary; that is the
 * expected, common case for a brand that predates multi-store support.
 */
export async function getPrimaryCommerceConnection(
  brandId: string,
  provider: CommerceProvider = CommerceProvider.SHOPIFY,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): Promise<CommerceConnectionSummary | null> {
  const resolved = await resolvePreferredConnection(
    brandId,
    provider,
    resolveServiceDeps(deps),
    (row) => row.isPrimary,
  );
  return resolved.connection;
}

/**
 * Reports whether (brandId, provider)'s `CommerceConnection` mirror agrees
 * with legacy `Brand.shopify*` truth — see the file header for the full
 * rule. Intended for reuse by a later reconciliation tool; deliberately does
 * NOT log anything itself (this can run on an ordinary page load, and
 * logging a drift signal on every such request — even at a low level —
 * would spam. A caller that wants to log a finding should do so itself,
 * e.g. from a periodic reconciliation job, not from this hot path).
 */
export async function detectConnectionDrift(
  brandId: string,
  provider: CommerceProvider = CommerceProvider.SHOPIFY,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): Promise<CommerceConnectionDriftResult> {
  const resolved = await resolvePreferredConnection(brandId, provider, resolveServiceDeps(deps));
  return resolved.drift;
}

// ---------------------------------------------------------------------------
// Capabilities / adapter access
// ---------------------------------------------------------------------------

/**
 * Reports which optional operations `provider` supports. Never throws — an
 * unsupported provider (COMMERCE7 today) reports every capability `false`
 * rather than raising `UnsupportedProviderError`. See the file header for
 * why this is the opposite choice from `getAdapterForConnection`.
 */
export function getCommerceCapabilities(
  provider: CommerceProvider,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): CommerceCapabilities {
  const { registry } = resolveServiceDeps(deps);
  const adapter = registry.tryGet(provider);

  if (!adapter) {
    return {
      canSyncProducts: false,
      canCreateDiscount: false,
      canRevokeDiscount: false,
      canVerifyWebhooks: false,
    };
  }

  return adapter.getCapabilities();
}

/**
 * Returns the `CommerceAdapter` for `summary.provider`. Throws
 * `UnsupportedProviderError` for a provider with no registered adapter
 * (COMMERCE7 today) — see the file header for why this, unlike
 * `getCommerceCapabilities`, throws rather than returning a fallback value.
 * Never makes a network call: the registry only constructs (and memoizes)
 * the adapter object, which itself only stores its dependencies at
 * construction time.
 */
export function getAdapterForConnection(
  summary: CommerceConnectionSummary,
  deps: Partial<CommerceConnectionServiceDeps> = {},
): CommerceAdapter {
  const { registry } = resolveServiceDeps(deps);
  return registry.get(summary.provider);
}

// ---------------------------------------------------------------------------
// Status predicates (provider-neutral, pure — see the file header for why
// these don't check a token field)
// ---------------------------------------------------------------------------

/**
 * True when `summary` represents a connection today's routes would treat as
 * "connected" — reproduces the exact three-part gate used today (e.g.
 * `src/app/api/brand/shopify/products/route.ts`,
 * `src/lib/lesson-product-links.ts`'s `CandidateBrand` check), see the file
 * header for the invariant that lets `status === "CONNECTED"` stand in for
 * the token-presence leg. `externalAccountId` is checked too as a
 * documented no-op — see the file header.
 */
export function isConnectionUsable(summary: CommerceConnectionSummary): boolean {
  return summary.status === "CONNECTED" && summary.externalAccountId.trim().length > 0;
}

/** True when `summary` is in a state where the user must reconnect (re-authenticate) before it can be used again. */
export function connectionRequiresReconnect(summary: CommerceConnectionSummary): boolean {
  return summary.status === "REQUIRES_RECONNECT";
}

/**
 * Serialization-safe boundary marker. `CommerceConnectionSummary` already
 * excludes every credential field by construction (see `./types.ts`), so
 * there is nothing for this function to strip today — it is an identity
 * function. It exists so a route can write
 * `NextResponse.json(toSafeConnectionSummary(summary))` as an explicit,
 * greppable assertion of intent ("this object is safe to serialize")
 * instead of relying on every future summary field being manually
 * re-audited. If a field that could carry sensitive data is ever proposed
 * for `CommerceConnectionSummary`, THIS is the function to turn into a real
 * narrowing/redaction step.
 */
export function toSafeConnectionSummary(
  summary: CommerceConnectionSummary,
): CommerceConnectionSummary {
  return summary;
}

// ---------------------------------------------------------------------------
// Small pure helpers for the Task-2 low-risk cutover call sites
// ---------------------------------------------------------------------------

/**
 * Convenience combinator for callers that already hold a raw legacy Brand
 * row (e.g. a batch of candidate brands fetched in a single query) and want
 * the SAME connectivity decision `isConnectionUsable` makes, without
 * hand-building a `CommerceConnectionSummary` themselves. Equivalent to
 * `mapLegacyBrandToConnectionSummary(brand)` followed by `isConnectionUsable`,
 * treating `null` (no summary — no shop domain on record) as "not usable".
 * No I/O — pure, synchronous. Deliberately NOT `getActiveCommerceConnection`:
 * that function can prefer a `CommerceConnection` row whose `status` differs
 * from legacy even when its domain agrees (the consistency check only
 * compares `externalAccountId`), which would NOT reproduce today's
 * legacy-only gate exactly. This helper stays legacy-only on purpose so
 * low-risk connectivity gates keep byte-identical behavior.
 */
export function isLegacyShopifyBrandConnectionUsable(brand: LegacyBrandShopifyFields): boolean {
  const summary = mapLegacyBrandToConnectionSummary(brand);
  return summary !== null && isConnectionUsable(summary);
}

/**
 * Extracts the provider-neutral `externalAccountId` (== normalized shop
 * domain, trim only) from a bare Shopify domain value — the same derivation
 * `mapLegacyBrandToConnectionSummary` uses internally — without requiring a
 * caller to supply the full `LegacyBrandShopifyFields` shape just to read
 * this one field. No I/O — pure, synchronous.
 */
export function externalAccountIdFromShopDomain(
  shopDomain: string | null | undefined,
): string | null {
  const trimmed = shopDomain?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Derives the storefront URL SQRATCH displays for a Shopify shop domain —
 * the exact `https://${domain}` formula used both by
 * `mapLegacyBrandToConnectionSummary` (`storefrontUrl`) and by
 * `src/app/api/rewards/shopify/redemptions/route.ts`'s `shopUrl` field,
 * exposed standalone for callers that only need the URL (not a full
 * connectivity decision) from an already-fetched shop domain. No I/O —
 * pure, synchronous. Deliberately does not trim/normalize `shopDomain` — it
 * reproduces the ORIGINAL literal `domain ? \`https://${domain}\` : null`
 * expression exactly, byte for byte.
 */
export function deriveShopifyStorefrontUrl(
  shopDomain: string | null | undefined,
): string | null {
  return shopDomain ? `https://${shopDomain}` : null;
}
