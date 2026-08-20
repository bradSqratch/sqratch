/**
 * src/lib/commerce/connection-sync.ts
 *
 * PHASE 14C-A: no runtime route calls a Brand-sourced dual-write anymore —
 * every request-serving path establishes `CommerceConnection` +
 * `CommerceConnectionSecret` directly from authenticated provider facts
 * (`applyShopifyConnectionSyncFromInstall`, called by the installations
 * route from the pending-install payload). The Brand-sourced builders
 * (`buildShopifyConnectionSyncInput`, `syncShopifyCommerceConnectionForBrand`,
 * `rebuildShopifyConnectionSecretForBrand`) remain — legitimately — as the
 * pure/transactional core the pre-column-drop reconciliation tool
 * (`connection-reconciliation.ts` / `scripts/reconcile-commerce-connections.ts`)
 * depends on to detect and (optionally) repair drift while the Brand columns
 * still physically exist. They must be deleted together with that tool once
 * the columns are dropped (Phase 14C-B) — at that point there is no legacy
 * source left to sync FROM.
 *
 * `safeDeleteShopifyCommerceConnectionByShopDomain` remains load-bearing:
 * it backs the `shop/redact` GDPR erasure path, a genuine privacy
 * obligation independent of runtime authority.
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

/**
 * PHASE 14B.3 — the INSTALL-FACTS shape.
 *
 * Everything needed to write the canonical connection + credential using ONLY
 * data that came out of the authenticated install / token exchange itself.
 * Deliberately has no `Brand.shopify*` field on it: the canonical row must
 * never be derived from the legacy mirror, or the mirror would be the real
 * authority with an extra hop (and a stale mirror could walk canonical state
 * backwards). `brandDisplayName` is cosmetic only — it feeds
 * `deriveShopifyDisplayName` and never influences credential or status.
 *
 * Tokens here are PLAINTEXT (already decrypted by the caller from the pending
 * install / exchange response) and are re-encrypted as one blob before they
 * reach the DB. Never log this object.
 */
export type ShopifyInstallFacts = {
  shopDomain: string;
  brandDisplayName: string | null;
  providerClientId: string | null;
  authMode: ShopifyAuthMode | string;
  currencyCode: string | null;
  /** Space/comma-delimited scope string exactly as the provider returned it. */
  grantedScopes: string | null;
  installedAt: Date;
  lastProductSyncAt: Date | null;
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
};

/**
 * Pure builder for the install path. Same output shape as
 * `buildShopifyConnectionSyncInput`, but sourced from install facts rather
 * than from `Brand`. Status is always `CONNECTED` and `uninstalledAt` is
 * always cleared — a successful install IS the authoritative connect event.
 */
export function buildShopifyConnectionSyncInputFromInstall(
  facts: ShopifyInstallFacts,
): ShopifyConnectionSyncInput | null {
  const shopDomain = facts.shopDomain
    ? normalizeExternalAccountId(facts.shopDomain)
    : null;
  if (!shopDomain || !facts.accessToken) {
    return null;
  }

  return {
    externalAccountId: shopDomain,
    displayName: deriveShopifyDisplayName(shopDomain, facts.brandDisplayName),
    storefrontUrl: `https://${shopDomain}`,
    providerClientId: facts.providerClientId,
    status: "CONNECTED",
    installedAt: facts.installedAt,
    uninstalledAt: null,
    lastProductSyncAt: facts.lastProductSyncAt,
    grantedScopes: normalizeLegacyGrantedScopes(facts.grantedScopes),
    providerMetadata: {
      authMode: facts.authMode,
      currencyCode: facts.currencyCode,
    },
    secretPayload: {
      accessToken: facts.accessToken,
      accessTokenExpiresAt: facts.accessTokenExpiresAt
        ? facts.accessTokenExpiresAt.toISOString()
        : null,
      refreshToken: facts.refreshToken,
      refreshTokenExpiresAt: facts.refreshTokenExpiresAt
        ? facts.refreshTokenExpiresAt.toISOString()
        : null,
      authMode: facts.authMode,
    },
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
    // PHASE 14B.3 P1 FIX: a fresh credential write ALWAYS clears any held
    // refresh lease. Without this, a lease acquired against the PRIOR
    // payload (e.g. an in-flight refresh outstanding at the moment of a
    // reconnect or relink) survives untouched — `update` only assigns the
    // fields listed, so an existing `refreshLockId`/`refreshLockedUntil`
    // would otherwise persist across this write. That stale lease later lets
    // `persistRotatedShopifyCredential`'s CAS (`WHERE refreshLockId = <old
    // lockId>`) still match, so the old refresher's stale-writer rotation
    // would silently overwrite the credential just installed here — on
    // relink, that can place a PRIOR BRAND's rotated token onto the new
    // brand's connection. Resetting the lease to null makes that CAS match
    // nothing, so the old holder is correctly rejected as superseded.
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
        refreshLockId: null,
        refreshLockedUntil: null,
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
 * PHASE 14B.3 — CANONICAL-FIRST INSTALL WRITE.
 *
 * Writes the canonical `CommerceConnection` + `CommerceConnectionSecret` for
 * an install / reconnect / relink from INSTALL FACTS ONLY, inside the caller's
 * own transaction (so it commits atomically with the install claim and can
 * never leave a claimed install without a canonical credential).
 *
 * This is the deliberate exception to this file's "never inside the caller's
 * transaction" rule, and the reason for the exception is that the rule was
 * written when this module produced a best-effort MIRROR. It no longer does:
 * as of Phase 14B the credential written here IS the runtime authority
 * (`resolveRuntimeCredential` reads exactly this row), so it must not be
 * possible for the install to commit and this write to be lost. A failure
 * here correctly fails the install, because an install that cannot establish
 * a canonical credential has not actually connected anything.
 *
 * No retry loop wraps this, unlike `syncShopifyCommerceConnectionForBrand`:
 * the caller owns the transaction, so a primary-assignment conflict (P2002 on
 * the partial unique index) or serialization failure aborts the caller's
 * transaction and must be surfaced to the caller to retry as a whole. The
 * install route already maps P2002/P2034 onto a 409 that the client retries.
 */
export async function applyShopifyConnectionSyncFromInstall(
  tx: TxClient,
  brandId: string,
  facts: ShopifyInstallFacts,
): Promise<ShopifyConnectionSyncResult> {
  const input = buildShopifyConnectionSyncInputFromInstall(facts);
  if (!input) {
    return {
      outcome: "skipped_no_shop_domain",
      connectionId: null,
      isPrimary: false,
      secretWritten: false,
    };
  }
  return applyShopifyConnectionSync(tx, brandId, input);
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
