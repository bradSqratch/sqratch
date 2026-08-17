/**
 * shopify-token-manager.ts
 *
 * Manages Shopify offline access token lifecycle for both legacy (non-expiring)
 * and expiring-offline token modes (public apps using token exchange).
 *
 * SECURITY: Decrypted tokens and refresh tokens are NEVER logged or returned
 * from this module as plain text. They are only passed directly to callers
 * through the ok:true return value, or to Shopify HTTP endpoints in memory.
 *
 * TESTABILITY: prisma is imported lazily (inside DB helper functions) so that
 * test files can import the pure helper exports without triggering the
 * DATABASE_URL check at module load time.
 */

import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { randomUUID } from "node:crypto";
import { recordShopifyConnectionLoss } from "@/lib/shopify-connection-transitions";
import {
  safeSyncShopifyCommerceConnection,
  safeMarkShopifyCommerceConnectionDisconnected,
} from "@/lib/commerce/connection-sync";

// ---------------------------------------------------------------------------
// Lazy DB access — import only when a DB operation is needed
// ---------------------------------------------------------------------------

async function getDb() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Seconds before access token expiry to trigger a proactive refresh. */
const SAFETY_BUFFER_SECONDS = 120;

/** How long (ms) the refresh lock is held by one request. */
const LOCK_DURATION_MS = 30_000;

/** How long (ms) to wait total for another process to finish refreshing. */
const LOCK_WAIT_MS = 3_000;

/** Interval (ms) between lock-wait polls. */
const LOCK_POLL_INTERVAL_MS = 250;

/** Required scopes — changing this list is intentional and reviewed. */
const REQUIRED_SCOPES = [
  "read_products",
  "read_themes",
  "read_discounts",
  "write_discounts",
] as const;

// ---------------------------------------------------------------------------
// Shopify token endpoint types
// ---------------------------------------------------------------------------

export type ShopifyTokenResponse = {
  access_token: string;
  scope: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in: number;
};

export type TokenEndpointFn = (
  shop: string,
  body: Record<string, string | number>,
) => Promise<ShopifyTokenResponse>;

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export type GetValidAccessTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "NEEDS_RECONNECT" | "NOT_CONNECTED" };

// ---------------------------------------------------------------------------
// Pure helper functions (exported for unit testing without a real DB)
// ---------------------------------------------------------------------------

/**
 * Returns true when the access token is still usable (not about to expire).
 * "Fresh" means more than SAFETY_BUFFER_SECONDS remain until expiry.
 */
export function isAccessTokenFresh(
  expiresAt: Date | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() - nowMs > SAFETY_BUFFER_SECONDS * 1000;
}

/**
 * Returns true when the granted scopes cover all required ones.
 * grantedScopes is a comma-separated string (may have spaces).
 */
export function hasSufficientScopes(
  grantedScopes: string | null | undefined,
): boolean {
  if (!grantedScopes) return false;

  const granted = grantedScopes
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const grantedSet = new Set(granted);

  return REQUIRED_SCOPES.every((required) => {
    if (grantedSet.has(required)) {
      return true;
    }

    // Shopify may return only write_discounts even when discount read/write access
    // is configured. Treat write_discounts as satisfying read_discounts.
    if (required === "read_discounts" && grantedSet.has("write_discounts")) {
      return true;
    }

    return false;
  });
}

/**
 * Conversion ingestion is an additive capability. It intentionally does not
 * gate existing catalog/reward operations for installations granted before
 * Phase 12; those stores are surfaced as not conversion-ready until reauth.
 */
export function hasOrderAttributionScope(
  grantedScopes: string | null | undefined,
): boolean {
  return Boolean(
    grantedScopes
      ?.split(",")
      .map((scope) => scope.trim())
      .includes("read_orders"),
  );
}

/**
 * Builds a new expiry Date from a Shopify `expires_in` seconds value.
 */
export function computeExpiresAt(
  expiresInSeconds: number,
  nowMs: number = Date.now(),
): Date {
  return new Date(nowMs + expiresInSeconds * 1000);
}

export function ownsRefreshLock(
  currentLockId: string | null | undefined,
  expectedLockId: string,
): boolean {
  return currentLockId === expectedLockId;
}

// ---------------------------------------------------------------------------
// Default Shopify token endpoint implementation
// ---------------------------------------------------------------------------

async function defaultTokenEndpoint(
  shop: string,
  body: Record<string, string | number>,
): Promise<ShopifyTokenResponse> {
  const url = `https://${shop}/admin/oauth/access_token`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // Network error — retry once immediately (same request, no back-off per spec)
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  if (!response.ok) {
    let errorPayload: Record<string, unknown> = {};
    try {
      errorPayload = await response.json();
    } catch {
      // ignore parse error
    }
    const err = new Error(
      `Shopify token endpoint responded with ${response.status}`,
    );
    (err as Error & { status: number; shopifyError: unknown }).status =
      response.status;
    (err as Error & { status: number; shopifyError: unknown }).shopifyError =
      errorPayload;
    throw err;
  }

  return response.json() as Promise<ShopifyTokenResponse>;
}

// ---------------------------------------------------------------------------
// Internal DB helpers
// ---------------------------------------------------------------------------

type BrandShopifyFields = {
  id: string;
  shopifyShopDomain: string | null;
  shopifyAdminAccessTokenEncrypted: string | null;
  shopifyConnectionStatus: string;
  shopifyAuthMode: string;
  shopifyAccessTokenExpiresAt: Date | null;
  shopifyRefreshTokenEncrypted: string | null;
  shopifyRefreshTokenExpiresAt: Date | null;
  shopifyGrantedScopes: string | null;
  shopifyClientId: string | null;
  shopifyTokenRefreshLockedUntil: Date | null;
  shopifyTokenRefreshLockId: string | null;
  shopifyCurrencyCode: string | null;
};

/**
 * Fetches fresh brand shopify fields from DB.
 */
async function reloadBrand(
  brandId: string,
): Promise<BrandShopifyFields | null> {
  const db = await getDb();
  return db.brand.findUnique({
    where: { id: brandId },
    select: {
      id: true,
      shopifyShopDomain: true,
      shopifyAdminAccessTokenEncrypted: true,
      shopifyConnectionStatus: true,
      shopifyAuthMode: true,
      shopifyAccessTokenExpiresAt: true,
      shopifyRefreshTokenEncrypted: true,
      shopifyRefreshTokenExpiresAt: true,
      shopifyGrantedScopes: true,
      shopifyClientId: true,
      shopifyTokenRefreshLockedUntil: true,
      shopifyTokenRefreshLockId: true,
      shopifyCurrencyCode: true,
    },
  });
}

/**
 * Attempts to acquire the refresh lock via a compare-and-swap UPDATE.
 * Returns the unique lease ID if this process now holds the lock, otherwise null.
 */
async function acquireRefreshLock(
  brandId: string,
  nowMs: number,
): Promise<string | null> {
  const db = await getDb();
  const now = new Date(nowMs);
  const lockUntil = new Date(nowMs + LOCK_DURATION_MS);
  const lockId = randomUUID();

  const result = await db.brand.updateMany({
    where: {
      id: brandId,
      OR: [
        { shopifyTokenRefreshLockedUntil: null },
        { shopifyTokenRefreshLockedUntil: { lt: now } },
      ],
    },
    data: {
      shopifyTokenRefreshLockedUntil: lockUntil,
      shopifyTokenRefreshLockId: lockId,
    },
  });

  return result.count === 1 ? lockId : null;
}

/**
 * Releases the refresh lock (sets it to null).
 */
async function releaseRefreshLock(
  brandId: string,
  lockId: string,
): Promise<void> {
  const db = await getDb();
  await db.brand.updateMany({
    where: { id: brandId, shopifyTokenRefreshLockId: lockId },
    data: {
      shopifyTokenRefreshLockedUntil: null,
      shopifyTokenRefreshLockId: null,
    },
  });
}

/**
 * Waits for another process holding the lock to finish refreshing.
 * Returns the re-read brand data after the wait.
 */
async function waitForLockHolder(
  brandId: string,
): Promise<BrandShopifyFields | null> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));
    const brand = await reloadBrand(brandId);
    if (!brand) return null;
    // If lock is released, the refresh is done (or the holder crashed)
    const lockHeld =
      brand.shopifyTokenRefreshLockedUntil &&
      brand.shopifyTokenRefreshLockedUntil.getTime() > Date.now();
    if (!lockHeld) return brand;
  }
  // Deadline passed — return whatever is in the DB now
  return reloadBrand(brandId);
}

/**
 * Persists a failed-reconnect state: marks the brand REQUIRES_RECONNECT
 * and clears all token fields atomically. Reward offer deactivation and the
 * connection-history event are written in the same transaction, after the
 * refresh-lock compare-and-swap guard (`shopifyTokenRefreshLockId: lockId`)
 * succeeds — a stale/superseded lock holder writes nothing.
 */
async function markRequiresReconnect(
  brandId: string,
  lockId: string,
): Promise<boolean> {
  const db = await getDb();

  return db.$transaction(async (tx) => {
    const before = await tx.brand.findUnique({
      where: { id: brandId },
      select: {
        shopifyShopDomain: true,
        shopifyCurrencyCode: true,
        shopifyClientId: true,
      },
    });

    const result = await tx.brand.updateMany({
      where: { id: brandId, shopifyTokenRefreshLockId: lockId },
      data: {
        shopifyConnectionStatus: "REQUIRES_RECONNECT",
        shopifyAdminAccessTokenEncrypted: null,
        shopifyRefreshTokenEncrypted: null,
        shopifyAccessTokenExpiresAt: null,
        shopifyRefreshTokenExpiresAt: null,
        shopifyTokenRefreshLockedUntil: null,
        shopifyTokenRefreshLockId: null,
      },
    });

    if (result.count === 1) {
      await recordShopifyConnectionLoss(tx, {
        brandId,
        eventType: "REQUIRES_RECONNECT",
        snapshot: {
          shopDomain: before?.shopifyShopDomain ?? null,
          currencyCode: before?.shopifyCurrencyCode ?? null,
          shopifyClientId: before?.shopifyClientId ?? null,
        },
      });
    }

    return result.count === 1;
  });
}

/**
 * Performs the actual token refresh HTTP call and persists the new tokens.
 * Returns the new plaintext access token.
 * Throws with { permanent: true } on HTTP 400/401 (invalid_grant / expired).
 * Throws with { permanent: false } on transient errors.
 */
async function performTokenRefresh(
  brand: BrandShopifyFields,
  lockId: string,
  tokenEndpoint: TokenEndpointFn,
): Promise<string> {
  if (!brand.shopifyRefreshTokenEncrypted) {
    throw Object.assign(new Error("No refresh token available"), {
      permanent: true,
    });
  }

  const shop = brand.shopifyShopDomain!;
  const clientId = brand.shopifyClientId;
  const clientSecret = process.env.SHOPIFY_API_SECRET;

  if (!clientId || !clientSecret) {
    throw Object.assign(
      new Error("Missing SHOPIFY_API_SECRET env or shopifyClientId on brand"),
      { permanent: false },
    );
  }

  const refreshToken = decryptSecret(brand.shopifyRefreshTokenEncrypted);

  let tokenResponse: ShopifyTokenResponse;
  try {
    tokenResponse = await tokenEndpoint(shop, {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  } catch (err: unknown) {
    const status = (err as { status?: number }).status;
    // 400/401 = permanent failure (invalid_grant, token expired/revoked)
    const isPermanent = status === 400 || status === 401;
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      permanent: isPermanent,
    });
  }

  const nowMs = Date.now();
  const newAccessToken = tokenResponse.access_token;
  const newRefreshToken = tokenResponse.refresh_token;

  // Encrypt both tokens before persisting — NEVER store plain text
  const encryptedAccessToken = encryptSecret(newAccessToken);
  const encryptedRefreshToken = encryptSecret(newRefreshToken);

  const db = await getDb();
  const result = await db.brand.updateMany({
    where: {
      id: brand.id,
      shopifyTokenRefreshLockId: lockId,
    },
    data: {
      shopifyAdminAccessTokenEncrypted: encryptedAccessToken,
      shopifyAccessTokenExpiresAt: computeExpiresAt(
        tokenResponse.expires_in,
        nowMs,
      ),
      shopifyRefreshTokenEncrypted: encryptedRefreshToken,
      shopifyRefreshTokenExpiresAt: computeExpiresAt(
        tokenResponse.refresh_token_expires_in,
        nowMs,
      ),
      shopifyGrantedScopes: tokenResponse.scope,
      shopifyConnectionStatus: "CONNECTED",
      shopifyTokenRefreshLockedUntil: null, // release lock atomically with save
      shopifyTokenRefreshLockId: null,
    },
  });

  if (result.count !== 1) {
    throw Object.assign(
      new Error("Shopify token refresh lease was superseded"),
      {
        staleWriter: true,
        permanent: false,
      },
    );
  }

  return newAccessToken;
}

async function readWinnerToken(
  brandId: string,
): Promise<GetValidAccessTokenResult | null> {
  const current = await reloadBrand(brandId);
  if (!current) return { ok: false, reason: "NOT_CONNECTED" };
  if (current.shopifyConnectionStatus === "REQUIRES_RECONNECT") {
    return { ok: false, reason: "NEEDS_RECONNECT" };
  }
  if (
    current.shopifyAdminAccessTokenEncrypted &&
    current.shopifyAccessTokenExpiresAt &&
    current.shopifyAccessTokenExpiresAt.getTime() > Date.now()
  ) {
    return {
      ok: true,
      accessToken: decryptSecret(current.shopifyAdminAccessTokenEncrypted),
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Returns a valid, decrypted Shopify access token for the given brand.
 *
 * - LEGACY_OFFLINE brands: returns the stored token as-is (no refresh).
 * - EXPIRING_OFFLINE brands: proactively refreshes near expiry with
 *   DB-level compare-and-swap locking to prevent concurrent refreshes.
 *
 * The returned `accessToken` string is decrypted and must NOT be logged.
 */
export async function getValidAccessToken(
  brandId: string,
  options?: { tokenEndpoint?: TokenEndpointFn; skipScopeCheck?: boolean },
): Promise<GetValidAccessTokenResult> {
  const tokenEndpoint = options?.tokenEndpoint ?? defaultTokenEndpoint;

  const brand = await reloadBrand(brandId);

  if (!brand) {
    return { ok: false, reason: "NOT_CONNECTED" };
  }

  // Not connected at all
  if (
    !brand.shopifyAdminAccessTokenEncrypted ||
    brand.shopifyConnectionStatus === "DISCONNECTED" ||
    brand.shopifyConnectionStatus === "UNINSTALLED"
  ) {
    return { ok: false, reason: "NOT_CONNECTED" };
  }

  // Already marked as needing reconnect
  if (brand.shopifyConnectionStatus === "REQUIRES_RECONNECT") {
    return { ok: false, reason: "NEEDS_RECONNECT" };
  }

  // ---------------------------------------------------------------------------
  // LEGACY_OFFLINE path — custom apps, non-expiring tokens (no refresh)
  // ---------------------------------------------------------------------------
  if (brand.shopifyAuthMode === "LEGACY_OFFLINE") {
    const token = decryptSecret(brand.shopifyAdminAccessTokenEncrypted);
    return { ok: true, accessToken: token };
  }

  // ---------------------------------------------------------------------------
  // EXPIRING_OFFLINE path
  // ---------------------------------------------------------------------------

  // Scope check — if missing required scopes, treat as NEEDS_RECONNECT
  if (!options?.skipScopeCheck && !hasSufficientScopes(brand.shopifyGrantedScopes)) {
    const db = await getDb();
    await db.$transaction(async (tx) => {
      await tx.brand.update({
        where: { id: brand.id },
        data: { shopifyConnectionStatus: "REQUIRES_RECONNECT" },
      });
      await recordShopifyConnectionLoss(tx, {
        brandId: brand.id,
        eventType: "REQUIRES_RECONNECT",
        snapshot: {
          shopDomain: brand.shopifyShopDomain,
          currencyCode: brand.shopifyCurrencyCode,
          shopifyClientId: brand.shopifyClientId,
        },
      });
    });
    // Best-effort mirror: the legacy transaction above already committed the
    // REQUIRES_RECONNECT status change. Tokens are NOT cleared on this path
    // (only the status changes — the brand still has a granted-but-insufficient
    // token), so a fresh full re-sync (not the disconnect-and-clear-secret
    // helper) is what correctly reflects that on the CommerceConnection
    // mirror. Never throws, never affects the return value below.
    await safeSyncShopifyCommerceConnection(brand.id).catch(() => {});
    return { ok: false, reason: "NEEDS_RECONNECT" };
  }

  const nowMs = Date.now();

  // Token is still fresh — return it immediately without a network call
  if (isAccessTokenFresh(brand.shopifyAccessTokenExpiresAt, nowMs)) {
    const token = decryptSecret(brand.shopifyAdminAccessTokenEncrypted);
    return { ok: true, accessToken: token };
  }

  // Token is stale — need to refresh. Try to acquire the DB compare-and-swap lock.
  const lockId = await acquireRefreshLock(brand.id, nowMs);

  if (!lockId) {
    // Another request holds the lock — wait for it to finish
    const refreshedBrand = await waitForLockHolder(brand.id);
    if (!refreshedBrand) {
      return { ok: false, reason: "NOT_CONNECTED" };
    }
    if (refreshedBrand.shopifyConnectionStatus === "REQUIRES_RECONNECT") {
      return { ok: false, reason: "NEEDS_RECONNECT" };
    }
    // If a fresh token is now present, use it
    if (
      refreshedBrand.shopifyAdminAccessTokenEncrypted &&
      isAccessTokenFresh(refreshedBrand.shopifyAccessTokenExpiresAt, Date.now())
    ) {
      const token = decryptSecret(
        refreshedBrand.shopifyAdminAccessTokenEncrypted,
      );
      return { ok: true, accessToken: token };
    }
    // Fallback: token not yet expired (but within safety buffer) — still usable
    if (
      refreshedBrand.shopifyAdminAccessTokenEncrypted &&
      refreshedBrand.shopifyAccessTokenExpiresAt &&
      refreshedBrand.shopifyAccessTokenExpiresAt.getTime() > Date.now()
    ) {
      const token = decryptSecret(
        refreshedBrand.shopifyAdminAccessTokenEncrypted,
      );
      return { ok: true, accessToken: token };
    }

    // Token still appears expired after waiting — try to take over the refresh
    const recheck = await reloadBrand(brand.id);
    if (!recheck) return { ok: false, reason: "NOT_CONNECTED" };

    const takeoverLockId = await acquireRefreshLock(recheck.id, Date.now());
    if (!takeoverLockId) {
      // Could not acquire lock again — give up gracefully
      if (
        recheck.shopifyAdminAccessTokenEncrypted &&
        recheck.shopifyAccessTokenExpiresAt &&
        recheck.shopifyAccessTokenExpiresAt.getTime() > Date.now()
      ) {
        const token = decryptSecret(recheck.shopifyAdminAccessTokenEncrypted);
        return { ok: true, accessToken: token };
      }
      return { ok: false, reason: "NEEDS_RECONNECT" };
    }

    try {
      const accessToken = await performTokenRefresh(
        recheck,
        takeoverLockId,
        tokenEndpoint,
      );
      // Best-effort mirror — runs strictly AFTER performTokenRefresh's CAS
      // updateMany has committed (count === 1, or it would have thrown
      // staleWriter above). Re-reads the Brand row fresh internally, so it
      // mirrors the winning rotation, never an in-memory snapshot. Never
      // throws, never changes the return value below.
      await safeSyncShopifyCommerceConnection(recheck.id).catch(() => {});
      return { ok: true, accessToken };
    } catch (err: unknown) {
      if ((err as { staleWriter?: boolean }).staleWriter) {
        return (
          (await readWinnerToken(recheck.id)) ?? {
            ok: false,
            reason: "NEEDS_RECONNECT",
          }
        );
      }
      const isPermanent = (err as { permanent?: boolean }).permanent ?? false;
      if (isPermanent) {
        const marked = await markRequiresReconnect(recheck.id, takeoverLockId);
        if (!marked) {
          return (
            (await readWinnerToken(recheck.id)) ?? {
              ok: false,
              reason: "NEEDS_RECONNECT",
            }
          );
        }
        // Best-effort mirror — only after the CAS-guarded markRequiresReconnect
        // actually committed (count === 1). Tokens were cleared on the Brand
        // row by that same transaction, so the disconnect helper (which also
        // deletes the secret mirror) matches legacy truth exactly.
        await safeMarkShopifyCommerceConnectionDisconnected(
          recheck.id,
          "REQUIRES_RECONNECT",
        ).catch(() => {});
        return { ok: false, reason: "NEEDS_RECONNECT" };
      }
      await releaseRefreshLock(recheck.id, takeoverLockId).catch(() => {});
      return { ok: false, reason: "NEEDS_RECONNECT" };
    }
  }

  // We hold the lock — perform the refresh
  try {
    const accessToken = await performTokenRefresh(brand, lockId, tokenEndpoint);
    // Best-effort mirror — runs strictly AFTER performTokenRefresh's CAS
    // updateMany has committed (count === 1, or it would have thrown
    // staleWriter above). Re-reads the Brand row fresh internally, so it
    // mirrors the winning rotation, never an in-memory snapshot. Never
    // throws, never changes the return value below.
    await safeSyncShopifyCommerceConnection(brand.id).catch(() => {});
    return { ok: true, accessToken };
  } catch (err: unknown) {
    if ((err as { staleWriter?: boolean }).staleWriter) {
      return (
        (await readWinnerToken(brand.id)) ?? {
          ok: false,
          reason: "NEEDS_RECONNECT",
        }
      );
    }
    const isPermanent = (err as { permanent?: boolean }).permanent ?? false;
    if (isPermanent) {
      const marked = await markRequiresReconnect(brand.id, lockId);
      if (!marked) {
        return (
          (await readWinnerToken(brand.id)) ?? {
            ok: false,
            reason: "NEEDS_RECONNECT",
          }
        );
      }
      // Best-effort mirror — only after the CAS-guarded markRequiresReconnect
      // actually committed (count === 1). Tokens were cleared on the Brand
      // row by that same transaction, so the disconnect helper (which also
      // deletes the secret mirror) matches legacy truth exactly.
      await safeMarkShopifyCommerceConnectionDisconnected(
        brand.id,
        "REQUIRES_RECONNECT",
      ).catch(() => {});
      return { ok: false, reason: "NEEDS_RECONNECT" };
    }
    // Transient failure — release lock and return a soft error
    await releaseRefreshLock(brand.id, lockId).catch(() => {});
    return { ok: false, reason: "NEEDS_RECONNECT" };
  }
}

// ---------------------------------------------------------------------------
// Token exchange (public app initial install via session token)
// ---------------------------------------------------------------------------

export type ExchangeSessionTokenInput = {
  shop: string;
  sessionToken: string;
  clientId: string;
  clientSecret: string;
};

export type ExchangeSessionTokenResult = {
  accessToken: string;
  scope: string;
  expiresIn: number;
  refreshToken: string;
  refreshTokenExpiresIn: number;
};

/**
 * Exchanges a Shopify session token (id_token) for an expiring offline access
 * token + refresh token via the Shopify token exchange endpoint.
 *
 * The returned tokens are plaintext strings — callers must encrypt them
 * before persisting (use encryptSecret from @/lib/crypto).
 *
 * An optional tokenEndpoint can be injected for unit testing.
 */
export async function exchangeSessionTokenForOfflineToken(
  input: ExchangeSessionTokenInput,
  options?: { tokenEndpoint?: TokenEndpointFn },
): Promise<ExchangeSessionTokenResult> {
  const endpoint = options?.tokenEndpoint ?? defaultTokenEndpoint;

  const response = await endpoint(input.shop, {
    client_id: input.clientId,
    client_secret: input.clientSecret,
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: input.sessionToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:id_token",
    requested_token_type:
      "urn:shopify:params:oauth:token-type:offline-access-token",
    expiring: 1,
  });

  return {
    accessToken: response.access_token,
    scope: response.scope,
    expiresIn: response.expires_in,
    refreshToken: response.refresh_token,
    refreshTokenExpiresIn: response.refresh_token_expires_in,
  };
}

// ---------------------------------------------------------------------------
// Granted-scope synchronization (Shopify `app/scopes_update` webhook)
// ---------------------------------------------------------------------------

export type ApplyGrantedScopesUpdateResult =
  | { applied: true; brandId: string }
  | { applied: false; reason: "UNKNOWN_SHOP" | "SUPERSEDED" };

/**
 * Synchronizes Shopify's granted scopes into canonical
 * `CommerceConnection.grantedScopes`. A legacy `Brand.shopifyGrantedScopes`
 * mirror is maintained only for older token lifecycle code.
 *
 * This grants nothing and authorizes nothing. Under Shopify-managed
 * installation, Shopify itself decides what an installation holds and then
 * announces the result via `app/scopes_update`; this function only records that
 * announcement so the readers above stop reporting a stale grant. It is
 * therefore deliberately a pure cache write: no status transition, no
 * connection-history event, no reward-offer side effect.
 *
 * SHOP DOMAIN IS THE ONLY IDENTITY INPUT. The brand row is resolved solely from
 * `shopDomain` (the value the caller took from the HMAC-verified
 * `X-Shopify-Shop-Domain` header) via the `@unique` `Brand.shopifyShopDomain`
 * column. No id, no payload field, and no other caller-suppliable value can
 * select or influence which row is written.
 *
 * The write mirrors `performTokenRefresh`'s compare-and-swap shape: an
 * `updateMany` whose `where` re-states the resolved row's OWN id plus the
 * predicates that must still hold at write time, so it can never widen to a
 * second tenant and never races a concurrent refresh into a wrong row.
 *   - `id` pins the write to exactly the row resolved above.
 *   - `shopifyShopDomain` is the optimistic-concurrency guard: if the row was
 *     relinked or redacted (domain nulled/changed) between the read and the
 *     write, the write matches nothing rather than landing on a shop it was
 *     not authenticated for.
 *   - `shopifyConnectionStatus: { not: "UNINSTALLED" }` stops a late/reordered
 *     delivery from resurrecting scopes on a row whose uninstall handler has
 *     already cleared them.
 * A zero-count outcome is a deterministic SUPERSEDED no-op, not a failure.
 *
 * `grantedScopes` must already be the comma-separated form Shopify returns in
 * `scope`; it is normalized before being stored in either representation.
 *
 * Throws only on a genuine transient DB failure, so the caller can answer in a
 * way that asks Shopify to retry.
 */
export async function applyGrantedScopesUpdate(input: {
  shopDomain: string;
  grantedScopes: string;
}): Promise<ApplyGrantedScopesUpdateResult> {
  const shopDomain = input.shopDomain.trim().toLowerCase();

  if (!shopDomain) {
    return { applied: false, reason: "UNKNOWN_SHOP" };
  }

  const db = await getDb();

  const brand = await db.brand.findUnique({
    where: { shopifyShopDomain: shopDomain },
    select: { id: true },
  });

  if (!brand) {
    return { applied: false, reason: "UNKNOWN_SHOP" };
  }

  const normalizedScopes = input.grantedScopes
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  // CommerceConnection.grantedScopes is the canonical provider-neutral cache.
  // The legacy Brand mirror is retained only for older token lifecycle code.
  const connectionModel = (db as typeof db & {
    commerceConnection?: typeof db.commerceConnection;
  }).commerceConnection;
  const connection = connectionModel
    ? await connectionModel.findUnique({
    where: {
      provider_externalAccountId: {
        provider: "SHOPIFY",
        externalAccountId: shopDomain,
      },
    },
    select: { id: true, brandId: true },
      })
    : null;

  if (connection && connection.brandId === brand.id) {
    const result = await connectionModel!.updateMany({
      where: {
        id: connection.id,
        brandId: brand.id,
        provider: "SHOPIFY",
        externalAccountId: shopDomain,
        status: { not: "UNINSTALLED" },
      },
      data: { grantedScopes: normalizedScopes },
    });
    if (result.count !== 1) return { applied: false, reason: "SUPERSEDED" };

    // Compatibility mirror for legacy token checks. Never use this as the
    // provider-neutral readiness authority.
    await db.brand.updateMany({
      where: {
        id: brand.id,
        shopifyShopDomain: shopDomain,
        shopifyConnectionStatus: { not: "UNINSTALLED" },
      },
      data: { shopifyGrantedScopes: normalizedScopes.join(",") },
    });
    return { applied: true, brandId: brand.id };
  }

  // A connection row for the same external shop but a different brand is
  // inconsistent state; never fall back to a tenant-wide legacy write.
  if (connection && connection.brandId !== brand.id) {
    return { applied: false, reason: "SUPERSEDED" };
  }

  // Pre-cutover installations may not have a CommerceConnection row yet.
  const result = await db.brand.updateMany({
    where: {
      id: brand.id,
      shopifyShopDomain: shopDomain,
      shopifyConnectionStatus: { not: "UNINSTALLED" },
    },
    data: { shopifyGrantedScopes: normalizedScopes.join(",") },
  });

  return result.count === 1
    ? { applied: true, brandId: brand.id }
    : { applied: false, reason: "SUPERSEDED" };
}

// Re-export encryptSecret so callers saving tokens can use the same lib
export { encryptSecret };
