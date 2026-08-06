/**
 * src/lib/commerce/connection-sync.ts
 *
 * The Phase-1 dual-write: keeps a `CommerceConnection` (+
 * `CommerceConnectionSecret`) mirror of the legacy `Brand.shopify*` columns
 * in sync, without ever being on the critical path of an install/disconnect
 * request.
 *
 * CRITICAL ORDERING RULE (Phase-1 decision D2): every call into this module
 * from a route MUST happen AFTER the existing legacy-column transaction has
 * committed, never inside it. In Postgres a failed statement aborts the
 * whole enclosing transaction, so running this dual-write inside the
 * existing Serializable install transaction could turn a working install
 * into a failed one over a mirror-table hiccup. `safeSyncShopifyCommerceConnection`
 * / `safeMarkShopifyCommerceConnectionDisconnected` /
 * `safeDeleteShopifyCommerceConnectionByShopDomain` are the only entry
 * points routes should call — each is a single best-effort, non-throwing
 * operation that runs in its OWN transaction, separate from the caller's.
 *
 * IDEMPOTENCY: the write path is keyed on `CommerceConnection`'s
 * `@@unique([provider, externalAccountId])` constraint via
 * `prisma.commerceConnection.upsert(...)`. Re-running a sync for the same
 * shop domain always updates the same row — it can never create a
 * duplicate. This is also how RELINK is handled: when a shop domain that
 * used to belong to brand A is relinked to brand B (mirroring
 * `src/app/api/shopify/installations/[installId]/route.ts`'s relink
 * semantics, which reassign `Brand.shopifyShopDomain` from A to B), the
 * upsert's `update` branch reassigns `brandId` on the SAME row rather than
 * creating a second one or failing — there is no unique index on
 * `[brandId, provider]`, only on `[provider, externalAccountId]`, so a
 * shop domain can only ever be "owned" by one `CommerceConnection` row at a
 * time, exactly like `Brand.shopifyShopDomain @unique` today.
 *
 * SINGLE-PRIMARY ENFORCEMENT: a connection becomes primary iff the brand
 * has no OTHER `CONNECTED` connection for that provider (excluding this
 * shop domain). As of migration `20260806130000_commerce_connection_single_primary`
 * this is backstopped in Postgres by a partial unique index,
 * `CommerceConnection_brandId_provider_primary_key`, on
 * `(brandId, provider) WHERE "isPrimary" = true` -- DB-only, Prisma cannot
 * express a partial unique index in schema.prisma (see that migration's
 * header comment). `applyShopifyConnectionSync` clears `isPrimary` on every
 * OTHER connection for (brand, provider) FIRST, then upserts this row with
 * its computed `isPrimary` value SECOND, in the same transaction -- that
 * ordering means a single-writer sync can never itself transiently violate
 * the index (there is never a moment with two isPrimary:true rows written
 * by the same transaction). The index exists to catch the remaining case
 * this ordering cannot: two DIFFERENT transactions racing to become primary
 * for the same (brandId, provider) with different externalAccountId values
 * under READ COMMITTED, where each transaction's own read of
 * `otherConnectedCount` cannot see the other's uncommitted write.
 * `syncShopifyCommerceConnectionForBrand` wraps the whole transaction in a
 * bounded retry (`MAX_PRIMARY_CONFLICT_ATTEMPTS`) that catches the P2002
 * (unique-violation) or P2034 (serialization failure) this produces and
 * re-runs the transaction from scratch on a fresh read -- see
 * `isPrimaryConflictError` below for why this converges rather than looping
 * forever: the retry's fresh `otherConnectedCount` read sees whichever
 * transaction won, so the loser correctly recomputes `isPrimary: false`
 * instead of re-attempting the same conflicting write.
 *
 * SECRET MIRROR (Phase-1 decision D3): `CommerceConnectionSecret.encryptedPayload`
 * is WRITE-ONLY in Phase 1 — nothing reads it for authentication.
 * `getValidAccessToken(brandId)` against `Brand` columns (in
 * `src/lib/shopify-token-manager.ts`, NOT modified by this file) remains
 * the sole auth path. The payload holds the DECRYPTED credential values
 * (re-encrypted as one blob via `encryptSecret`) plus expiries and auth
 * mode — see `ShopifyConnectionSecretPayload` below. Because this mirror is
 * only refreshed when a lifecycle event fires (install/disconnect/uninstall)
 * or the backfill script runs, an `EXPIRING_OFFLINE` brand whose access
 * token silently rotates between those events will have a STALE mirror
 * until the next event or backfill run — the backfill script is safe to
 * re-run at any time to catch it up, and Phase 2 must re-sync every
 * connection at cutover before treating this mirror as authoritative.
 *
 * SECURITY: no function in this file ever logs a token, encrypted payload,
 * or the encryption key — see the `safe*` wrappers' catch blocks.
 */

import {
  CommerceProvider,
  Prisma,
  type CommerceConnectionStatus,
  type ShopifyAuthMode,
  type ShopifyConnectionStatus,
} from "@prisma/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import {
  deriveShopifyDisplayName,
  mapLegacyShopifyStatusToCommerceStatus,
  normalizeLegacyGrantedScopes,
} from "./connection-resolver";

type TxClient = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

/** The legacy `Brand` columns needed to build a Shopify connection sync input. */
export type LegacyBrandForShopifySync = {
  id: string;
  name: string | null;
  shopifyShopDomain: string | null;
  shopifyAdminAccessTokenEncrypted: string | null;
  shopifyInstalledAt: Date | null;
  shopifyUninstalledAt: Date | null;
  shopifyConnectionStatus: ShopifyConnectionStatus | string;
  shopifyLastProductSyncAt: Date | null;
  shopifyCurrencyCode: string | null;
  shopifyAccessTokenExpiresAt: Date | null;
  shopifyRefreshTokenEncrypted: string | null;
  shopifyRefreshTokenExpiresAt: Date | null;
  shopifyGrantedScopes: string | null;
  shopifyClientId: string | null;
  shopifyAuthMode: ShopifyAuthMode | string;
};

/**
 * The decrypted-credential payload written (re-encrypted as one blob) into
 * `CommerceConnectionSecret.encryptedPayload`. Every date is stored as an
 * ISO string so the payload round-trips cleanly through `JSON.stringify`.
 * NEVER logged, NEVER returned from any exported function — this type only
 * ever flows into `encryptSecret`.
 */
export type ShopifyConnectionSecretPayload = {
  accessToken: string;
  accessTokenExpiresAt: string | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: string | null;
  authMode: ShopifyAuthMode | string;
};

/** The neutral field values + secret payload derived from a legacy Brand row. */
export type ShopifyConnectionSyncInput = {
  externalAccountId: string;
  displayName: string;
  storefrontUrl: string;
  providerClientId: string | null;
  status: CommerceConnectionStatus;
  installedAt: Date | null;
  uninstalledAt: Date | null;
  lastProductSyncAt: Date | null;
  grantedScopes: string[];
  providerMetadata: { authMode: ShopifyAuthMode | string; currencyCode: string | null };
  /** `null` when the brand currently has no access token (disconnected/uninstalled/redacted). */
  secretPayload: ShopifyConnectionSecretPayload | null;
};

/**
 * Normalizes a shop domain into the exact string stored/matched as
 * `CommerceConnection.externalAccountId`. MUST be used on every path that
 * either writes or reads that column keyed by domain — the write side
 * (`buildShopifyConnectionSyncInput`) and the delete side
 * (`deleteShopifyCommerceConnectionByShopDomain`) call this SAME helper so
 * they can never drift apart. If they used different normalization (e.g.
 * one trims only, the other also lowercases), a domain written in one case
 * would silently fail to match a delete keyed on another case — this is
 * exactly the shape of the missed-erase GDPR bug this dual-write was built
 * to avoid, so the two sides must always agree on the key.
 */
export function normalizeExternalAccountId(domain: string): string {
  return domain.trim().toLowerCase();
}

/**
 * Pure builder: maps legacy `Brand.shopify*` columns onto the neutral
 * `ShopifyConnectionSyncInput` the upsert needs. Returns `null` when the
 * brand has no shop domain — there is nothing to sync (the caller should
 * treat this as a no-op, not an error).
 *
 * `displayName` is derived from the shop domain (see
 * `deriveShopifyDisplayName` in `./connection-resolver.ts`) rather than the
 * brand name, so the display name reflects which store is actually
 * connected even if a brand is later renamed.
 *
 * Decrypts `shopifyAdminAccessTokenEncrypted` / `shopifyRefreshTokenEncrypted`
 * (via `decryptSecret`) so the secret payload holds plaintext credential
 * values, which are then re-encrypted as a single blob by the caller via
 * `encryptSecret` before ever reaching the DB — this function itself never
 * returns anything already encrypted twice, and never logs a decrypted
 * value.
 */
export function buildShopifyConnectionSyncInput(
  brand: LegacyBrandForShopifySync,
): ShopifyConnectionSyncInput | null {
  const shopDomain = brand.shopifyShopDomain
    ? normalizeExternalAccountId(brand.shopifyShopDomain)
    : null;
  if (!shopDomain) {
    return null;
  }

  const secretPayload: ShopifyConnectionSecretPayload | null = brand.shopifyAdminAccessTokenEncrypted
    ? {
        accessToken: decryptSecret(brand.shopifyAdminAccessTokenEncrypted),
        accessTokenExpiresAt: brand.shopifyAccessTokenExpiresAt
          ? brand.shopifyAccessTokenExpiresAt.toISOString()
          : null,
        refreshToken: brand.shopifyRefreshTokenEncrypted
          ? decryptSecret(brand.shopifyRefreshTokenEncrypted)
          : null,
        refreshTokenExpiresAt: brand.shopifyRefreshTokenExpiresAt
          ? brand.shopifyRefreshTokenExpiresAt.toISOString()
          : null,
        authMode: brand.shopifyAuthMode,
      }
    : null;

  return {
    externalAccountId: shopDomain,
    displayName: deriveShopifyDisplayName(shopDomain, brand.name),
    storefrontUrl: `https://${shopDomain}`,
    providerClientId: brand.shopifyClientId,
    status: mapLegacyShopifyStatusToCommerceStatus(brand.shopifyConnectionStatus),
    installedAt: brand.shopifyInstalledAt,
    uninstalledAt: brand.shopifyUninstalledAt,
    lastProductSyncAt: brand.shopifyLastProductSyncAt,
    grantedScopes: normalizeLegacyGrantedScopes(brand.shopifyGrantedScopes),
    providerMetadata: {
      authMode: brand.shopifyAuthMode,
      currencyCode: brand.shopifyCurrencyCode,
    },
    secretPayload,
  };
}

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export type ShopifyConnectionSyncResult = {
  outcome: "created" | "updated" | "skipped_no_shop_domain" | "skipped_brand_not_found";
  connectionId: string | null;
  isPrimary: boolean;
  secretWritten: boolean;
};

export type ShopifyConnectionMarkDisconnectedResult = {
  outcome: "updated" | "noop";
  count: number;
};

export type ShopifyConnectionDeleteResult = {
  outcome: "deleted" | "noop";
  count: number;
};

// ---------------------------------------------------------------------------
// Transactional core (operates on an injected TxClient — unit-testable with
// a fake `tx`, same idiom as `src/lib/shopify-connection-transitions.ts`)
// ---------------------------------------------------------------------------

async function applyShopifyConnectionSync(
  tx: TxClient,
  brandId: string,
  input: ShopifyConnectionSyncInput,
): Promise<ShopifyConnectionSyncResult> {
  const uniqueWhere = {
    provider_externalAccountId: {
      provider: CommerceProvider.SHOPIFY,
      externalAccountId: input.externalAccountId,
    },
  };

  const existing = await tx.commerceConnection.findUnique({
    where: uniqueWhere,
    select: { id: true },
  });

  // Primary iff the brand has no OTHER CONNECTED Shopify connection (a
  // different shop domain) already. The row for THIS shop domain is
  // excluded from the count via `externalAccountId: { not: ... }` so a
  // re-sync of the same, already-primary connection doesn't see itself as
  // "another" connection and flip isPrimary to false.
  const otherConnectedCount = await tx.commerceConnection.count({
    where: {
      brandId,
      provider: CommerceProvider.SHOPIFY,
      status: "CONNECTED",
      externalAccountId: { not: input.externalAccountId },
    },
  });
  const isPrimary = otherConnectedCount === 0;

  // ORDERING (required by the partial unique index
  // `CommerceConnection_brandId_provider_primary_key` added by migration
  // `20260806130000_commerce_connection_single_primary`): siblings are
  // cleared to `isPrimary: false` FIRST, and only THEN is this row
  // (re)written with its computed `isPrimary` value. Excluded by
  // `externalAccountId` (not `id`) so this runs correctly even on the
  // `create` path, before this row's id exists. Doing the clear first means
  // this transaction never itself holds two `isPrimary: true` rows for
  // (brandId, provider) at once, so the upsert below can never transiently
  // violate the index for a single-writer sequence — see the file header
  // comment ("SINGLE-PRIMARY ENFORCEMENT") for how genuine cross-transaction
  // races are handled instead (the index plus the bounded retry in
  // `syncShopifyCommerceConnectionForBrand`).
  if (isPrimary) {
    await tx.commerceConnection.updateMany({
      where: {
        brandId,
        provider: CommerceProvider.SHOPIFY,
        externalAccountId: { not: input.externalAccountId },
        isPrimary: true,
      },
      data: { isPrimary: false },
    });
  }

  const sharedData = {
    brandId,
    status: input.status,
    displayName: input.displayName,
    storefrontUrl: input.storefrontUrl,
    providerClientId: input.providerClientId,
    isPrimary,
    grantedScopes: input.grantedScopes,
    providerMetadata: input.providerMetadata,
    installedAt: input.installedAt,
    uninstalledAt: input.uninstalledAt,
    lastProductSyncAt: input.lastProductSyncAt,
  };

  // Keyed on the @@unique([provider, externalAccountId]) constraint: a
  // repeated install of the same shop domain always resolves to this same
  // row (idempotent), and RELINK (shop domain moving from brand A to brand
  // B) is handled by the `update` branch reassigning `brandId` — never a
  // second row, never a failure. This upsert is the statement that can
  // raise a P2002 against the partial unique index when a concurrent sync
  // for a different externalAccountId on the same (brandId, provider) has
  // already committed `isPrimary: true` since this transaction's count()
  // read above — see `syncShopifyCommerceConnectionForBrand`'s retry loop.
  const connection = await tx.commerceConnection.upsert({
    where: uniqueWhere,
    create: {
      provider: CommerceProvider.SHOPIFY,
      externalAccountId: input.externalAccountId,
      ...sharedData,
    },
    update: sharedData,
    select: { id: true },
  });

  if (input.secretPayload) {
    const encryptedPayload = encryptSecret(JSON.stringify(input.secretPayload));
    const now = new Date();
    await tx.commerceConnectionSecret.upsert({
      where: { connectionId: connection.id },
      create: {
        connectionId: connection.id,
        encryptedPayload,
        keyVersion: 1,
        rotatedAt: now,
      },
      update: {
        encryptedPayload,
        keyVersion: 1,
        rotatedAt: now,
      },
    });
  } else {
    // No token on the Brand row (disconnected / uninstalled / redacted) —
    // delete rather than write an empty/placeholder payload. `deleteMany`
    // (not `delete`) so this is a no-op, never a throw, when no secret
    // exists yet.
    await tx.commerceConnectionSecret.deleteMany({
      where: { connectionId: connection.id },
    });
  }

  return {
    outcome: existing ? "updated" : "created",
    connectionId: connection.id,
    isPrimary,
    secretWritten: input.secretPayload !== null,
  };
}

async function applyMarkShopifyConnectionsDisconnected(
  tx: TxClient,
  brandId: string,
  status: CommerceConnectionStatus,
): Promise<ShopifyConnectionMarkDisconnectedResult> {
  const rows = await tx.commerceConnection.findMany({
    where: { brandId, provider: CommerceProvider.SHOPIFY },
    select: { id: true },
  });

  if (rows.length === 0) {
    return { outcome: "noop", count: 0 };
  }

  const ids = rows.map((row) => row.id);
  // Mirrors the legacy semantics: UNINSTALLED stamps uninstalledAt; every
  // other status (DISCONNECTED, REQUIRES_RECONNECT, etc.) clears it, same
  // as `buildLocalShopifyDisconnectData` / the manual disconnect routes do
  // for `Brand.shopifyUninstalledAt`.
  const uninstalledAt = status === "UNINSTALLED" ? new Date() : null;

  await tx.commerceConnection.updateMany({
    where: { id: { in: ids } },
    data: { status, uninstalledAt },
  });

  await tx.commerceConnectionSecret.deleteMany({
    where: { connectionId: { in: ids } },
  });

  return { outcome: "updated", count: ids.length };
}

/**
 * Deletes the single `CommerceConnection` row keyed on
 * `(provider, externalAccountId)` for the shop domain being redacted —
 * NOT every connection belonging to whichever brand currently owns a
 * `shopifyShopDomain`. This is deliberate: the brand that owned `shopDomain`
 * at install time may no longer be the brand whose `Brand.shopifyShopDomain`
 * currently equals it (a later relink can move that legacy column to a
 * different shop entirely), and a brand may legitimately hold more than one
 * Shopify `CommerceConnection` once multi-store ships. Keying the delete on
 * the domain itself (rather than resolving a brand and deleting all of that
 * brand's rows) is correct in both cases: it always removes exactly the row
 * Shopify's `shop/redact` request is actually about, never a sibling
 * connection for an unrelated shop.
 *
 * `externalAccountId` is unique per `provider` (`@@unique([provider,
 * externalAccountId])`), so at most one row can ever match.
 */
async function applyDeleteShopifyConnectionByShopDomain(
  tx: TxClient,
  shopDomain: string,
): Promise<ShopifyConnectionDeleteResult> {
  // CommerceConnectionSecret.connection declares `onDelete: Cascade` (see
  // the CommerceConnectionSecret model in prisma/schema.prisma), so deleting
  // the CommerceConnection row also removes its secret — no separate secret
  // delete needed.
  const result = await tx.commerceConnection.deleteMany({
    where: { provider: CommerceProvider.SHOPIFY, externalAccountId: shopDomain },
  });

  return result.count > 0
    ? { outcome: "deleted", count: result.count }
    : { outcome: "noop", count: 0 };
}

// ---------------------------------------------------------------------------
// Dependency injection (for unit testing without a real DB)
// ---------------------------------------------------------------------------

export type ConnectionSyncDeps = {
  /** Loads the legacy Shopify fields needed to build a sync input, or `null` if the brand doesn't exist. */
  findBrandForSync(brandId: string): Promise<LegacyBrandForShopifySync | null>;
  /** Runs `fn` inside a DB transaction and returns its result. */
  runTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
};

async function defaultFindBrandForSync(
  brandId: string,
): Promise<LegacyBrandForShopifySync | null> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.brand.findUnique({
    where: { id: brandId },
    select: {
      id: true,
      name: true,
      shopifyShopDomain: true,
      shopifyAdminAccessTokenEncrypted: true,
      shopifyInstalledAt: true,
      shopifyUninstalledAt: true,
      shopifyConnectionStatus: true,
      shopifyLastProductSyncAt: true,
      shopifyCurrencyCode: true,
      shopifyAccessTokenExpiresAt: true,
      shopifyRefreshTokenEncrypted: true,
      shopifyRefreshTokenExpiresAt: true,
      shopifyGrantedScopes: true,
      shopifyClientId: true,
      shopifyAuthMode: true,
    },
  });
}

async function defaultRunTransaction<T>(
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.$transaction(fn);
}

const DEFAULT_SYNC_DEPS: ConnectionSyncDeps = {
  findBrandForSync: defaultFindBrandForSync,
  runTransaction: defaultRunTransaction,
};

// ---------------------------------------------------------------------------
// Primary-assignment conflict retry (see the "SINGLE-PRIMARY ENFORCEMENT"
// file header comment for the full picture)
// ---------------------------------------------------------------------------

/**
 * Bounded attempt count for `syncShopifyCommerceConnectionForBrand`'s retry
 * around the whole transaction. 3 (1 initial attempt + 2 retries) is enough
 * to absorb a two-way race for the same (brandId, provider) — see the file
 * header comment for why a retry converges instead of looping forever: each
 * retry re-reads `otherConnectedCount` inside a brand-new transaction, so
 * the loser of the race sees the winner's already-committed row and
 * correctly computes `isPrimary: false` on its next attempt. Deliberately
 * NOT unbounded — under sustained contention this must give up rather than
 * retry forever.
 */
const MAX_PRIMARY_CONFLICT_ATTEMPTS = 3;

/**
 * True for a Prisma P2002 (unique-violation — almost certainly the partial
 * unique index `CommerceConnection_brandId_provider_primary_key` rejecting
 * a second `isPrimary: true` row for the same (brandId, provider)) or P2034
 * (serialization/write-conflict) error. Both are the concurrency signature
 * of two syncs racing to become primary for the same (brandId, provider)
 * with different `externalAccountId` values.
 */
function isPrimaryConflictError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === "P2002" || error.code === "P2034")
  );
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

/**
 * Idempotently upserts the `CommerceConnection` (+ secret) mirror for a
 * brand's current Shopify state. Safe to call repeatedly — see the
 * IDEMPOTENCY doc comment at the top of this file. Returns a typed result
 * describing what happened; never throws for "nothing to sync" (brand not
 * found / no shop domain) — those are reported as `skipped_*` outcomes.
 *
 * Retries the whole transaction, up to `MAX_PRIMARY_CONFLICT_ATTEMPTS`
 * times, when it fails with a primary-assignment conflict (see
 * `isPrimaryConflictError`) — this is a bounded retry, never unbounded, and
 * a conflict that still hasn't resolved after the last attempt is thrown
 * exactly like any other DB error, never silently downgraded to
 * `isPrimary: false`. Every other error is thrown immediately, on the first
 * attempt, without retrying.
 *
 * Does not catch DB errors — use `safeSyncShopifyCommerceConnection` from a
 * request path per Phase-1 decision D2.
 */
export async function syncShopifyCommerceConnectionForBrand(
  brandId: string,
  deps: Partial<ConnectionSyncDeps> = {},
): Promise<ShopifyConnectionSyncResult> {
  const resolvedDeps: ConnectionSyncDeps = { ...DEFAULT_SYNC_DEPS, ...deps };

  const brand = await resolvedDeps.findBrandForSync(brandId);
  if (!brand) {
    return {
      outcome: "skipped_brand_not_found",
      connectionId: null,
      isPrimary: false,
      secretWritten: false,
    };
  }

  const input = buildShopifyConnectionSyncInput(brand);
  if (!input) {
    return {
      outcome: "skipped_no_shop_domain",
      connectionId: null,
      isPrimary: false,
      secretWritten: false,
    };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt < MAX_PRIMARY_CONFLICT_ATTEMPTS; attempt++) {
    try {
      return await resolvedDeps.runTransaction((tx) =>
        applyShopifyConnectionSync(tx, brandId, input),
      );
    } catch (error) {
      lastError = error;
      if (!isPrimaryConflictError(error)) {
        throw error;
      }
      // Otherwise: bounded retry — loop around and re-run the whole
      // transaction from scratch, so `otherConnectedCount` is re-read fresh
      // and can see whichever side of the race already committed.
    }
  }
  throw lastError;
}

/**
 * Marks every existing `CommerceConnection` row for (brandId, SHOPIFY) with
 * the given neutral status, stamps/clears `uninstalledAt` to match, and
 * deletes their secret. Used by the plain disconnect paths, where the
 * legacy `Brand.shopifyShopDomain` has already been nulled by the time this
 * runs (so a full `syncShopifyCommerceConnectionForBrand` rebuild has
 * nothing to key off of).
 *
 * A no-op (never a throw) when no `CommerceConnection` row exists for the
 * brand — e.g. the original dual-write never ran or already failed once;
 * the backfill script or a later lifecycle event will reconcile it.
 */
export async function markShopifyCommerceConnectionDisconnected(
  brandId: string,
  status: CommerceConnectionStatus,
  deps: Partial<ConnectionSyncDeps> = {},
): Promise<ShopifyConnectionMarkDisconnectedResult> {
  const resolvedDeps: ConnectionSyncDeps = { ...DEFAULT_SYNC_DEPS, ...deps };
  return resolvedDeps.runTransaction((tx) =>
    applyMarkShopifyConnectionsDisconnected(tx, brandId, status),
  );
}

/**
 * Deletes the `CommerceConnection` row for the Shopify shop domain being
 * redacted — used by the `shop/redact` GDPR path. Keyed on
 * `(provider, externalAccountId)`, i.e. the redacted domain itself, NOT on
 * whichever brand currently happens to hold `Brand.shopifyShopDomain ===
 * shopDomain` — see `applyDeleteShopifyConnectionByShopDomain`'s doc comment
 * for why. `shopDomain` is normalized via `normalizeExternalAccountId` (trim
 * + lowercase) — the SAME helper `buildShopifyConnectionSyncInput` uses for
 * the write side — to match how `verifyShopifyWebhookRequest` normalizes the
 * incoming domain and how the dual-write's `externalAccountId` key is
 * derived. Secrets cascade-delete automatically. A no-op (never a throw)
 * when no row exists.
 */
export async function deleteShopifyCommerceConnectionByShopDomain(
  shopDomain: string,
  deps: Partial<ConnectionSyncDeps> = {},
): Promise<ShopifyConnectionDeleteResult> {
  const resolvedDeps: ConnectionSyncDeps = { ...DEFAULT_SYNC_DEPS, ...deps };
  const normalizedShopDomain = normalizeExternalAccountId(shopDomain);
  return resolvedDeps.runTransaction((tx) =>
    applyDeleteShopifyConnectionByShopDomain(tx, normalizedShopDomain),
  );
}

// ---------------------------------------------------------------------------
// Secret-mirror rebuild (Phase-2 reconciliation helper)
//
// Narrower than `syncShopifyCommerceConnectionForBrand`: it touches ONLY
// `CommerceConnectionSecret`, never `CommerceConnection`'s own columns
// (displayName, status, isPrimary, grantedScopes, ...). Intended for a
// reconciliation CLI repairing secret drift left over from the historical
// gap this closes (a rotated Shopify token that updated `Brand.shopify*`
// but never reached the mirror before the corresponding `getValidAccessToken`
// call sites started mirroring on every winning rotation) — a full
// `syncShopifyCommerceConnectionForBrand` re-sync would also be correct, but
// this is the minimal-blast-radius fix: it operates only on a
// `CommerceConnection` row that already exists (keyed on the brand's CURRENT
// `shopifyShopDomain`, exactly like the sync's own lookup), and never
// creates or mutates that row itself.
// ---------------------------------------------------------------------------

export type RebuildShopifyConnectionSecretOutcome =
  | "created"
  | "rebuilt"
  | "up_to_date"
  | "no_credentials"
  | "skipped_brand_not_found"
  | "skipped_no_shop_domain"
  | "skipped_no_connection";

/** Typed result — NEVER carries a credential value, only an outcome tag + id. */
export type RebuildShopifyConnectionSecretResult = {
  outcome: RebuildShopifyConnectionSecretOutcome;
  connectionId: string | null;
};

/**
 * True when `existingEncryptedPayload` already decrypts to a JSON payload
 * equal (field-by-field) to `expected`. Used to make the rebuild a genuine
 * no-op (no write, no `rotatedAt` bump) when a second run finds nothing has
 * actually changed since the last one — `encryptSecret` uses a random IV per
 * call, so ciphertexts alone can never be compared directly. A decrypt
 * failure (corrupt payload, old key version, etc.) is treated as "not
 * matching" so the row gets rebuilt rather than the comparison throwing.
 */
function shopifySecretPayloadMatches(
  existingEncryptedPayload: string,
  expected: ShopifyConnectionSecretPayload,
): boolean {
  try {
    const existing = JSON.parse(
      decryptSecret(existingEncryptedPayload),
    ) as ShopifyConnectionSecretPayload;
    return (
      existing.accessToken === expected.accessToken &&
      existing.accessTokenExpiresAt === expected.accessTokenExpiresAt &&
      existing.refreshToken === expected.refreshToken &&
      existing.refreshTokenExpiresAt === expected.refreshTokenExpiresAt &&
      existing.authMode === expected.authMode
    );
  } catch {
    return false;
  }
}

/**
 * PURELY ADDITIVE (Phase-2 reconciliation CLI support) — read-only preview
 * of what `rebuildShopifyConnectionSecretForBrand` would decide for a
 * connection, WITHOUT performing any write. Reuses the exact same
 * decrypt-and-compare predicate (`shopifySecretPayloadMatches`) the real
 * rebuild path uses below, so a caller previewing staleness (e.g. a
 * reconciliation tool's dry-run mode, which must never write) can never
 * drift from what an `--apply` run of that same tool would actually decide
 * — there is only ever one comparison, not two.
 *
 * NEVER returns, logs, or otherwise exposes a decrypted or encrypted secret
 * value — only one of the four outcome tags below, matching
 * `RebuildShopifyConnectionSecretOutcome`'s non-skip cases.
 */
export function determineShopifySecretRebuildOutcome(
  existingEncryptedPayload: string | null,
  expectedSecretPayload: ShopifyConnectionSecretPayload | null,
): "no_credentials" | "up_to_date" | "rebuilt" | "created" {
  if (!expectedSecretPayload) {
    return "no_credentials";
  }
  if (
    existingEncryptedPayload !== null &&
    shopifySecretPayloadMatches(existingEncryptedPayload, expectedSecretPayload)
  ) {
    return "up_to_date";
  }
  return existingEncryptedPayload !== null ? "rebuilt" : "created";
}

async function applyRebuildShopifyConnectionSecret(
  tx: TxClient,
  input: ShopifyConnectionSyncInput,
): Promise<RebuildShopifyConnectionSecretResult> {
  const connection = await tx.commerceConnection.findUnique({
    where: {
      provider_externalAccountId: {
        provider: CommerceProvider.SHOPIFY,
        externalAccountId: input.externalAccountId,
      },
    },
    select: { id: true },
  });

  if (!connection) {
    // Nothing to attach a secret to. A full `syncShopifyCommerceConnectionForBrand`
    // must run first to create the connection row; this helper deliberately
    // never creates one itself (see file-header comment).
    return { outcome: "skipped_no_connection", connectionId: null };
  }

  const existingSecret = await tx.commerceConnectionSecret.findUnique({
    where: { connectionId: connection.id },
    select: { encryptedPayload: true },
  });

  if (!input.secretPayload) {
    // Brand has no credentials right now — match the sync's existing
    // behavior (see `applyShopifyConnectionSync`): delete rather than write
    // an empty/placeholder payload. `deleteMany` (not `delete`) so this is a
    // no-op, never a throw, whether or not a secret row currently exists.
    await tx.commerceConnectionSecret.deleteMany({
      where: { connectionId: connection.id },
    });
    return { outcome: "no_credentials", connectionId: connection.id };
  }

  if (
    existingSecret &&
    shopifySecretPayloadMatches(existingSecret.encryptedPayload, input.secretPayload)
  ) {
    return { outcome: "up_to_date", connectionId: connection.id };
  }

  const encryptedPayload = encryptSecret(JSON.stringify(input.secretPayload));
  const now = new Date();
  await tx.commerceConnectionSecret.upsert({
    where: { connectionId: connection.id },
    create: {
      connectionId: connection.id,
      encryptedPayload,
      keyVersion: 1,
      rotatedAt: now,
    },
    update: {
      encryptedPayload,
      keyVersion: 1,
      rotatedAt: now,
    },
  });

  return {
    outcome: existingSecret ? "rebuilt" : "created",
    connectionId: connection.id,
  };
}

/**
 * Idempotently rebuilds `CommerceConnectionSecret` for a brand's existing
 * Shopify `CommerceConnection` row from the current, authoritative
 * `Brand.shopify*` columns. Never writes a plaintext credential (always
 * `encryptSecret`s the JSON payload, exactly like `applyShopifyConnectionSync`),
 * never returns or logs a credential value, and never touches any
 * `CommerceConnection` column.
 *
 * Dependency-injectable in the same `Partial<ConnectionSyncDeps>` idiom as
 * `syncShopifyCommerceConnectionForBrand` — a reconciliation CLI can pass a
 * real `findBrandForSync`/`runTransaction` (the defaults) or inject fakes
 * for a dry run / test.
 *
 * Does not catch DB errors — callers (e.g. a per-brand loop in a
 * reconciliation script) should catch per-brand, the same way
 * `scripts/backfill-commerce-connections.ts` does around
 * `syncShopifyCommerceConnectionForBrand`, so one brand's failure doesn't
 * abort the whole run.
 */
export async function rebuildShopifyConnectionSecretForBrand(
  brandId: string,
  deps: Partial<ConnectionSyncDeps> = {},
): Promise<RebuildShopifyConnectionSecretResult> {
  const resolvedDeps: ConnectionSyncDeps = { ...DEFAULT_SYNC_DEPS, ...deps };

  const brand = await resolvedDeps.findBrandForSync(brandId);
  if (!brand) {
    return { outcome: "skipped_brand_not_found", connectionId: null };
  }

  const input = buildShopifyConnectionSyncInput(brand);
  if (!input) {
    return { outcome: "skipped_no_shop_domain", connectionId: null };
  }

  return resolvedDeps.runTransaction((tx) =>
    applyRebuildShopifyConnectionSecret(tx, input),
  );
}

// ---------------------------------------------------------------------------
// Best-effort wrappers (per Phase-1 decision D2 — call these from routes)
// ---------------------------------------------------------------------------

/**
 * Best-effort wrapper for `syncShopifyCommerceConnectionForBrand`. Catches
 * and sanitized-logs every failure; NEVER throws. Call this AFTER the
 * legacy-column transaction has already committed — never from inside it.
 */
export async function safeSyncShopifyCommerceConnection(
  brandId: string,
  deps: Partial<ConnectionSyncDeps> = {},
): Promise<void> {
  try {
    await syncShopifyCommerceConnectionForBrand(brandId, deps);
  } catch {
    // Sanitized: brandId + a fixed outcome tag only. Never the caught
    // error object — encryptSecret/decryptSecret failures, while unlikely
    // to embed secret material in their message, are deliberately never
    // risked here. The legacy write already committed; this mirror can be
    // repaired by the backfill script or the next lifecycle event.
    console.error("[commerce/connection-sync]", {
      outcome: "sync_failed",
      brandId,
      provider: "SHOPIFY",
    });
  }
}

/**
 * Best-effort wrapper for `markShopifyCommerceConnectionDisconnected`.
 * Catches and sanitized-logs every failure; NEVER throws.
 */
export async function safeMarkShopifyCommerceConnectionDisconnected(
  brandId: string,
  status: CommerceConnectionStatus,
  deps: Partial<ConnectionSyncDeps> = {},
): Promise<void> {
  try {
    await markShopifyCommerceConnectionDisconnected(brandId, status, deps);
  } catch {
    console.error("[commerce/connection-sync]", {
      outcome: "mark_disconnected_failed",
      brandId,
      provider: "SHOPIFY",
    });
  }
}

/**
 * Best-effort wrapper for `deleteShopifyCommerceConnectionByShopDomain`.
 * Catches and sanitized-logs every failure; NEVER throws. Call this AFTER
 * the legacy-column transaction has already committed — never from inside
 * it — and regardless of whether a brand lookup for the shop domain
 * succeeded (see the `shop/redact` route: this must run even when no brand
 * currently has `shopifyShopDomain === shopDomain`).
 */
export async function safeDeleteShopifyCommerceConnectionByShopDomain(
  shopDomain: string,
  deps: Partial<ConnectionSyncDeps> = {},
): Promise<void> {
  try {
    await deleteShopifyCommerceConnectionByShopDomain(shopDomain, deps);
  } catch {
    // Sanitized: the shop domain (not a credential — it's already logged in
    // plaintext by the redact route's own audit log) and a fixed outcome
    // tag only. Never the caught error object.
    console.error("[commerce/connection-sync]", {
      outcome: "delete_by_shop_domain_failed",
      shopDomain,
      provider: "SHOPIFY",
    });
  }
}
