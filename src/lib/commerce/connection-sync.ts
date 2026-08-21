/**
 * src/lib/commerce/connection-sync.ts
 *
 * PHASE 14C-A: no runtime route calls a Brand-sourced dual-write anymore —
 * every request-serving path establishes `CommerceConnection` +
 * `CommerceConnectionSecret` directly from authenticated provider facts
 * (`applyShopifyConnectionSyncFromInstall`, called by the installations
 * route from the pending-install payload).
 *
 * PHASE 14C-B1: the Brand-sourced rebuild machinery that used to live here
 * (`buildShopifyConnectionSyncInput`, `syncShopifyCommerceConnectionForBrand`,
 * `rebuildShopifyConnectionSecretForBrand`, `LegacyBrandForShopifySync`, and
 * their shared `shopifySecretPayloadMatches`/`determineShopifySecretRebuildOutcome`
 * helpers) has been removed along with the pre-column-drop reconciliation tool
 * it existed solely to serve (`connection-reconciliation.ts` /
 * `scripts/reconcile-commerce-connections.ts`). There is no remaining path
 * from `Brand.shopify*` to a canonical `CommerceConnection` write anywhere in
 * this file, or anywhere in the codebase — `applyShopifyConnectionSyncFromInstall`
 * below is now the ONLY writer of a `CommerceConnection`/`CommerceConnectionSecret`
 * pair, and it is built exclusively from authenticated install facts.
 *
 * `safeDeleteShopifyCommerceConnectionByShopDomain` remains available as a
 * generic best-effort utility, but has no production caller after
 * `shop/redact` moved to strict deletion: compliance erasure must propagate
 * a transient delete failure so Shopify can retry rather than acknowledging
 * incomplete redaction.
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
 * `otherConnectedCount` cannot see the other's uncommitted write. The index
 * exists precisely to reject that case (P2002) rather than silently allow
 * two primaries. `applyShopifyConnectionSyncFromInstall` does not itself
 * retry — a caller-level conflict (P2002 on the partial unique index, or
 * P2034 serialization failure) aborts the caller's own transaction and is
 * the CALLER's responsibility to retry as a whole (the installations route
 * maps both onto a 409 the client retries).
 *
 * CREDENTIAL AUTHORITY: `CommerceConnectionSecret.encryptedPayload` is the
 * SOLE runtime credential source (Phase 14) — `getValidAccessToken(brandId)`
 * (`src/lib/shopify-token-manager.ts`) reads exactly this row, via
 * `loadShopifyCredential`, and nothing else. The payload holds the DECRYPTED
 * credential values (re-encrypted as one blob via `encryptSecret`) plus
 * expiries and auth mode — see `ShopifyConnectionSecretPayload` below.
 *
 * SECURITY: no function in this file ever logs a token, encrypted payload,
 * or the encryption key — see the `safe*` wrappers' catch blocks.
 */

import { CommerceProvider, Prisma, type CommerceConnectionStatus } from "@prisma/client";
import { encryptSecret } from "@/lib/crypto";
import { deriveShopifyDisplayName, normalizeLegacyGrantedScopes } from "./connection-resolver";

type TxClient = Prisma.TransactionClient;

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
  /**
   * PHASE 14C-B1: a plain `string`, not the Prisma `ShopifyAuthMode` enum —
   * this payload is built from authenticated install facts only (see
   * `ShopifyInstallFacts.authMode` below), never from the `Brand.shopifyAuthMode`
   * column, so it has no reason to depend on that column's type. The two
   * values this ever actually holds are `"LEGACY_OFFLINE"` /
   * `"EXPIRING_OFFLINE"` (see `src/lib/shopify.ts`'s pending-install payload
   * shapes), enforced by the caller, not by this type.
   */
  authMode: string;
};

/** The neutral field values + secret payload the canonical upsert needs. */
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
  /** Provider facts that are not credential semantics. */
  providerMetadata: { currencyCode: string | null };
  /** `null` when there is currently no access token (disconnected/uninstalled/redacted). */
  secretPayload: ShopifyConnectionSecretPayload | null;
};

/**
 * Normalizes a shop domain into the exact string stored/matched as
 * `CommerceConnection.externalAccountId`. MUST be used on every path that
 * either writes or reads that column keyed by domain — the write side
 * (`buildShopifyConnectionSyncInputFromInstall`) and the delete side
 * (`deleteShopifyCommerceConnectionByShopDomain`) call this SAME helper so
 * they can never drift apart. If they used different normalization (e.g.
 * one trims only, the other also lowercases), a domain written in one case
 * would silently fail to match a delete keyed on another case — this is
 * exactly the shape of the missed-erase GDPR bug this normalization was
 * built to avoid, so every side must always agree on the key.
 */
export function normalizeExternalAccountId(domain: string): string {
  return domain.trim().toLowerCase();
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
  /** `"LEGACY_OFFLINE"` | `"EXPIRING_OFFLINE"` — see `ShopifyConnectionSecretPayload.authMode`'s doc comment for why this is a plain `string`, not the Prisma enum. */
  authMode: string;
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
    providerMetadata: { currencyCode: facts.currencyCode },
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
  /** Runs `fn` inside a DB transaction and returns its result. */
  runTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;
};

async function defaultRunTransaction<T>(
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.$transaction(fn);
}

const DEFAULT_SYNC_DEPS: ConnectionSyncDeps = {
  runTransaction: defaultRunTransaction,
};

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

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
