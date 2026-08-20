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

import {
  recordShopifyConnectionLoss,
  recordShopifyConnectionInstall,
} from "@/lib/shopify-connection-transitions";
import type { Prisma } from "@prisma/client";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";
import {
  loadShopifyCredential,
  acquireCredentialRefreshLease,
  releaseCredentialRefreshLease,
  isCredentialRefreshLeaseHeld,
  persistRotatedShopifyCredential,
  markShopifyCredentialRequiresReconnect,
  healShopifyCredentialConnected,
} from "@/lib/commerce/providers/shopify-credential-store";

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

/**
 * BASELINE scopes — what SQRATCH's core, always-on functionality (catalog
 * display, reward-discount issuance) needs to consider a connection usable at
 * all. Changing this list is intentional and reviewed.
 *
 * Deliberately EXCLUDES `read_orders` and `read_themes`. Those are ADDITIVE,
 * OPTIONAL capabilities (order-conversion attribution, live theme/app-embed
 * verification) layered on top of an already-usable connection — see
 * `hasOrderAttributionScope` / `hasThemeVerificationScope` below. A store
 * that installed before either scope existed, or hasn't yet approved
 * Shopify's managed-installation scope-update prompt for them, still has a
 * fully valid, fully usable connection for everything this baseline list
 * covers; it simply isn't ready for the newer capability yet. Folding either
 * scope into this list would make `hasSufficientScopes` — and therefore
 * `getValidAccessToken`'s internal gate — treat "hasn't approved an
 * optional, newly-added scope" as equivalent to "connection is broken",
 * which is exactly the bug this comment now guards against: it did that for
 * `read_themes` for one release and produced a false, self-inflicted
 * `REQUIRES_RECONNECT` for every already-connected store that hadn't yet
 * clicked Shopify's native "Update" button.
 */
const REQUIRED_SCOPES = [
  "read_products",
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
 * Theme/app-embed verification is likewise additive: it does not gate
 * baseline connectivity (see `REQUIRED_SCOPES`), only whether SQRATCH may
 * attempt the live theme inspection in
 * `src/lib/commerce/providers/shopify-theme-readiness.ts`.
 */
export function hasThemeVerificationScope(
  grantedScopes: string | null | undefined,
): boolean {
  return Boolean(
    grantedScopes
      ?.split(",")
      .map((scope) => scope.trim())
      .includes("read_themes"),
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

// ---------------------------------------------------------------------------
// PHASE 14C-A: CANONICAL CREDENTIAL AUTHORITY — SOLE SOURCE
// ---------------------------------------------------------------------------
//
// Runtime credential resolution is:
//
//   brandId -> CommerceConnection (SHOPIFY) -> CommerceConnectionSecret
//           -> decrypted provider credential
//
// `Brand.shopify*` is not read or written anywhere in this resolution path.
// Every currently installed Shopify merchant already has a canonical
// CommerceConnection + CommerceConnectionSecret (operator-verified live DB
// evidence) — there is no legitimate legacy source of truth left to fall
// back to.
//
// FAIL-CLOSED POLICY:
//   NO_CONNECTION / NO_SECRET (CONNECTED) -> NOT_CONNECTED. "Unknown" is
//     never upgraded to "assume connected."
//   NO_SECRET (REQUIRES_RECONNECT)        -> NEEDS_RECONNECT.
//   CORRUPT_SECRET                        -> NEEDS_RECONNECT. FAIL CLOSED.
//   database error                        -> propagates (never mistaken for
//     "absent").
//   canonical REQUIRES_RECONNECT / DISCONNECTED / UNINSTALLED
//                                          -> honored as-is.

/** Where a resolved runtime credential came from — always canonical (Phase 14C-A). */
type RuntimeCredentialSource = "CANONICAL";

type RuntimeCredential = {
  brandId: string;
  /** Non-null only for CANONICAL — it is the lease/write key. */
  connectionId: string | null;
  source: RuntimeCredentialSource;
  shopDomain: string | null;
  providerClientId: string | null;
  /** Normalized to the legacy vocabulary the branches below already speak. */
  connectionStatus: string;
  grantedScopes: string | null;
  authMode: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
  currencyCode: string | null;
};

type ResolveRuntimeCredentialResult =
  | { outcome: "OK"; credential: RuntimeCredential }
  | { outcome: "NOT_CONNECTED" }
  | { outcome: "NEEDS_RECONNECT" };

/**
 * Maps `CommerceConnectionStatus` onto the legacy status vocabulary the
 * existing branches compare against, so the state machine below is unchanged
 * by the storage cutover. `PENDING`/`ERROR` have no legacy equivalent and are
 * treated as "not usable", which is the conservative reading.
 */
function normalizeCanonicalStatus(status: string): string {
  switch (status) {
    case "CONNECTED":
      return "CONNECTED";
    case "REQUIRES_RECONNECT":
      return "REQUIRES_RECONNECT";
    case "UNINSTALLED":
      return "UNINSTALLED";
    default:
      return "DISCONNECTED";
  }
}

/**
 * THE resolution point. Resolves the live Shopify credential canonically —
 * no legacy `Brand` fallback (Phase 14C-A, see above).
 */
async function resolveRuntimeCredential(
  brandId: string,
): Promise<ResolveRuntimeCredentialResult> {
  const canonical = await loadShopifyCredential(brandId);

  if (canonical.outcome === "CORRUPT_SECRET") {
    // FAIL CLOSED — see the FALLBACK POLICY block above. Never consult Brand.
    return { outcome: "NEEDS_RECONNECT" };
  }

  if (canonical.outcome === "OK") {
    const c = canonical.credential;
    const status = normalizeCanonicalStatus(c.status);

    if (status === "REQUIRES_RECONNECT") {
      return { outcome: "NEEDS_RECONNECT" };
    }
    if (!c.accessToken || status === "DISCONNECTED" || status === "UNINSTALLED") {
      return { outcome: "NOT_CONNECTED" };
    }

    return {
      outcome: "OK",
      credential: {
        brandId,
        connectionId: c.connectionId,
        source: "CANONICAL",
        shopDomain: c.shopDomain,
        providerClientId: c.providerClientId,
        connectionStatus: status,
        grantedScopes: c.grantedScopes,
        authMode: c.authMode,
        accessToken: c.accessToken,
        accessTokenExpiresAt: c.accessTokenExpiresAt,
        refreshToken: c.refreshToken,
        refreshTokenExpiresAt: c.refreshTokenExpiresAt,
        // `CommerceConnection.providerMetadata.currencyCode` — see
        // `loadShopifyCredential`'s `ShopifyCredential.currencyCode`. Used
        // only to populate connection-loss/heal event snapshots
        // (`ShopifyConnectionEvent`); `null` there is fine (no
        // `Brand.shopifyCurrencyCode` fallback, Phase 14C-A).
        currencyCode: c.currencyCode,
      },
    };
  }

  // -------------------------------------------------------------------------
  // NO_CONNECTION / NO_SECRET — PHASE 14C-A: no legacy Brand fallback.
  // Every live Shopify install already has a canonical CommerceConnection +
  // CommerceConnectionSecret (operator-verified) — there is no legitimate
  // pre-cutover record left to fall back to. A canonical connection that is
  // CONNECTED but has no secret (NO_SECRET) is therefore just as
  // "not connected" as one that genuinely has no row at all; this also
  // preserves the DISCONNECT/UNINSTALL RESURRECTION GUARD's fail-closed
  // property (a revoked connection's absent secret is never rescued from
  // anywhere).
  if (canonical.outcome === "NO_SECRET") {
    const canonicalStatus = normalizeCanonicalStatus(canonical.status);
    if (canonicalStatus === "REQUIRES_RECONNECT") {
      return { outcome: "NEEDS_RECONNECT" };
    }
    return { outcome: "NOT_CONNECTED" };
  }

  return { outcome: "NOT_CONNECTED" };
}

/**
 * PHASE 14C-A: every resolved credential is canonical, so this always leases
 * on `CommerceConnectionSecret` — a Postgres compare-and-swap, no in-memory
 * or process-local mutex, so serverless instances coordinate through the
 * database. `connectionId` is guaranteed non-null for any resolved
 * credential (see `resolveRuntimeCredential`).
 */
async function acquireLeaseFor(
  credential: RuntimeCredential,
  nowMs: number,
): Promise<string | null> {
  if (!credential.connectionId) {
    return null;
  }
  return acquireCredentialRefreshLease(
    credential.connectionId,
    nowMs,
    LOCK_DURATION_MS,
  );
}

async function releaseLeaseFor(
  credential: RuntimeCredential,
  lockId: string,
): Promise<void> {
  if (!credential.connectionId) {
    return;
  }
  await releaseCredentialRefreshLease(credential.connectionId, lockId);
}

/**
 * PHASE 14C-A: waits for the current lease holder to finish, then
 * re-resolves the credential CANONICALLY so the waiter observes whatever the
 * winner actually persisted. The liveness probe polls
 * `CommerceConnectionSecret`, the same storage the lease lives in — Postgres
 * compare-and-swap coordinated.
 */
async function waitForLeaseHolder(
  credential: RuntimeCredential,
): Promise<ResolveRuntimeCredentialResult> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_INTERVAL_MS));

    const held = credential.connectionId
      ? await isCredentialRefreshLeaseHeld(credential.connectionId, Date.now())
      : false;

    if (!held) {
      return resolveRuntimeCredential(credential.brandId);
    }
  }
  // Deadline passed — return whatever is canonical now.
  return resolveRuntimeCredential(credential.brandId);
}

/**
 * PHASE 14C-A: the sole permanent-failure path. Clears the canonical
 * credential and moves `CommerceConnection.status` to REQUIRES_RECONNECT
 * under the caller's lease, recording the connection-loss event (which also
 * deactivates the brand's reward offers) inside the SAME transaction.
 * CAS-guarded, so a superseded lease holder can never disconnect a merchant
 * another caller just refreshed.
 */
async function markRequiresReconnectCanonical(
  credential: RuntimeCredential,
  lockId: string,
): Promise<boolean> {
  return markShopifyCredentialRequiresReconnect({
    connectionId: credential.connectionId!,
    lockId,
    onCleared: async (tx) => {
      await recordShopifyConnectionLoss(tx as Prisma.TransactionClient, {
        brandId: credential.brandId,
        eventType: "REQUIRES_RECONNECT",
        snapshot: {
          shopDomain: credential.shopDomain,
          currencyCode: credential.currencyCode,
          shopifyClientId: credential.providerClientId,
        },
      });
    },
  });
}

/**
 * Performs the actual token refresh HTTP call and persists the new tokens.
 * Returns the new plaintext access token.
 * Throws with { permanent: true } on HTTP 400/401 (invalid_grant / expired).
 * Throws with { permanent: false } on transient errors.
 */
async function performTokenRefresh(
  credential: RuntimeCredential,
  lockId: string,
  tokenEndpoint: TokenEndpointFn,
): Promise<string> {
  if (!credential.refreshToken) {
    throw Object.assign(new Error("No refresh token available"), {
      permanent: true,
    });
  }

  const shop = credential.shopDomain!;
  const clientId = credential.providerClientId;
  const clientSecret = process.env.SHOPIFY_API_SECRET;

  if (!clientId || !clientSecret) {
    throw Object.assign(
      new Error("Missing SHOPIFY_API_SECRET env or provider client id"),
      { permanent: false },
    );
  }

  const refreshToken = credential.refreshToken;

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
  const accessTokenExpiresAt = computeExpiresAt(tokenResponse.expires_in, nowMs);
  const refreshTokenExpiresAt = computeExpiresAt(
    tokenResponse.refresh_token_expires_in,
    nowMs,
  );

  // -------------------------------------------------------------------------
  // CANONICAL WRITE FIRST. The rotated access token and its rotated refresh
  // token are persisted together, under this caller's lease, and the lease is
  // released in the same statement — so a reader can never observe one
  // without the other, and a superseded refresher writes NOTHING.
  // -------------------------------------------------------------------------
  if (!credential.connectionId) {
    throw Object.assign(new Error("No canonical connection to refresh"), {
      permanent: true,
    });
  }

  const persisted = await persistRotatedShopifyCredential({
    connectionId: credential.connectionId,
    lockId,
    write: {
      authMode: credential.authMode,
      accessToken: newAccessToken,
      accessTokenExpiresAt,
      refreshToken: newRefreshToken,
      refreshTokenExpiresAt,
    },
    grantedScopes: tokenResponse.scope,
  });

  if (!persisted) {
    throw Object.assign(
      new Error("Shopify token refresh lease was superseded"),
      { staleWriter: true, permanent: false },
    );
  }

  return newAccessToken;
}

/**
 * After losing a rotation race, re-resolve the CANONICAL credential to pick up
 * whatever the winner just persisted. Goes through the same canonical-first
 * resolver, so a loser can never read a stale legacy copy of a token the
 * winner already rotated away.
 */
async function readWinnerToken(
  brandId: string,
): Promise<GetValidAccessTokenResult | null> {
  const resolved = await resolveRuntimeCredential(brandId);
  if (resolved.outcome === "NOT_CONNECTED") {
    return { ok: false, reason: "NOT_CONNECTED" };
  }
  if (resolved.outcome === "NEEDS_RECONNECT") {
    return { ok: false, reason: "NEEDS_RECONNECT" };
  }
  const current = resolved.credential;
  if (
    current.accessToken &&
    current.accessTokenExpiresAt &&
    current.accessTokenExpiresAt.getTime() > Date.now()
  ) {
    return { ok: true, accessToken: current.accessToken };
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

  // PHASE 14B: canonical-first resolution. Everything below operates on the
  // resolved credential, never on `Brand.shopify*` directly.
  const resolved = await resolveRuntimeCredential(brandId);
  if (resolved.outcome === "NOT_CONNECTED") {
    return { ok: false, reason: "NOT_CONNECTED" };
  }
  if (resolved.outcome === "NEEDS_RECONNECT") {
    return { ok: false, reason: "NEEDS_RECONNECT" };
  }
  const credential = resolved.credential;

  // ---------------------------------------------------------------------------
  // LEGACY_OFFLINE path — custom apps, non-expiring tokens (no refresh)
  // ---------------------------------------------------------------------------
  if (credential.authMode === "LEGACY_OFFLINE") {
    return { ok: true, accessToken: credential.accessToken! };
  }

  // ---------------------------------------------------------------------------
  // EXPIRING_OFFLINE path
  // ---------------------------------------------------------------------------

  // Scope check — if missing required scopes, treat as NEEDS_RECONNECT
  if (!options?.skipScopeCheck && !hasSufficientScopes(credential.grantedScopes)) {
    const db = await getDb();

    // Tokens are NOT cleared on this path (only the status changes — the
    // credential is granted-but-insufficient).
    await db.$transaction(async (tx) => {
      await tx.commerceConnection.update({
        where: { id: credential.connectionId! },
        data: { status: "REQUIRES_RECONNECT" },
      });
      await recordShopifyConnectionLoss(tx, {
        brandId,
        eventType: "REQUIRES_RECONNECT",
        snapshot: {
          shopDomain: credential.shopDomain,
          currencyCode: credential.currencyCode,
          shopifyClientId: credential.providerClientId,
        },
      });
    });
    return { ok: false, reason: "NEEDS_RECONNECT" };
  }

  const nowMs = Date.now();

  // Token is still fresh — return it immediately without a network call
  if (isAccessTokenFresh(credential.accessTokenExpiresAt, nowMs)) {
    return { ok: true, accessToken: credential.accessToken! };
  }

  // Token is stale — need to refresh. Try to acquire the DB compare-and-swap lease.
  const lockId = await acquireLeaseFor(credential, nowMs);

  if (!lockId) {
    // Another request holds the lease — wait for it to finish
    const refreshed = await waitForLeaseHolder(credential);
    if (refreshed.outcome === "NOT_CONNECTED") {
      return { ok: false, reason: "NOT_CONNECTED" };
    }
    if (refreshed.outcome === "NEEDS_RECONNECT") {
      return { ok: false, reason: "NEEDS_RECONNECT" };
    }
    const after = refreshed.credential;

    // If a fresh token is now present, use it
    if (after.accessToken && isAccessTokenFresh(after.accessTokenExpiresAt, Date.now())) {
      return { ok: true, accessToken: after.accessToken };
    }
    // Fallback: token not yet expired (but within safety buffer) — still usable
    if (
      after.accessToken &&
      after.accessTokenExpiresAt &&
      after.accessTokenExpiresAt.getTime() > Date.now()
    ) {
      return { ok: true, accessToken: after.accessToken };
    }

    // Token still appears expired after waiting — try to take over the refresh
    const rechecked = await resolveRuntimeCredential(brandId);
    if (rechecked.outcome === "NOT_CONNECTED") {
      return { ok: false, reason: "NOT_CONNECTED" };
    }
    if (rechecked.outcome === "NEEDS_RECONNECT") {
      return { ok: false, reason: "NEEDS_RECONNECT" };
    }
    const recheck = rechecked.credential;

    const takeoverLockId = await acquireLeaseFor(recheck, Date.now());
    if (!takeoverLockId) {
      // Could not acquire the lease again — give up gracefully
      if (
        recheck.accessToken &&
        recheck.accessTokenExpiresAt &&
        recheck.accessTokenExpiresAt.getTime() > Date.now()
      ) {
        return { ok: true, accessToken: recheck.accessToken };
      }
      return { ok: false, reason: "NEEDS_RECONNECT" };
    }

    return runRefreshUnderLease(recheck, takeoverLockId, tokenEndpoint);
  }

  // We hold the lease — perform the refresh
  return runRefreshUnderLease(credential, lockId, tokenEndpoint);
}

/**
 * The shared refresh body used by both the direct-lease and takeover-lease
 * paths. Extracted so the two callers can never drift apart — the duplicated
 * copies they replaced were a standing maintenance hazard in a function where
 * every branch is safety-critical.
 */
async function runRefreshUnderLease(
  credential: RuntimeCredential,
  lockId: string,
  tokenEndpoint: TokenEndpointFn,
): Promise<GetValidAccessTokenResult> {
  try {
    const accessToken = await performTokenRefresh(credential, lockId, tokenEndpoint);
    return { ok: true, accessToken };
  } catch (err: unknown) {
    if ((err as { staleWriter?: boolean }).staleWriter) {
      return (
        (await readWinnerToken(credential.brandId)) ?? {
          ok: false,
          reason: "NEEDS_RECONNECT",
        }
      );
    }

    const isPermanent = (err as { permanent?: boolean }).permanent ?? false;
    if (isPermanent) {
      const marked = await markRequiresReconnectCanonical(credential, lockId);

      if (!marked) {
        return (
          (await readWinnerToken(credential.brandId)) ?? {
            ok: false,
            reason: "NEEDS_RECONNECT",
          }
        );
      }
      return { ok: false, reason: "NEEDS_RECONNECT" };
    }

    // Transient failure — release the lease and return a soft error. The
    // credential is left intact: a transient failure must never disconnect a
    // merchant.
    await releaseLeaseFor(credential, lockId).catch(() => {});
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
  | {
      applied: true;
      brandId: string;
      /**
       * True when the row's status was `REQUIRES_RECONNECT` WITH a
       * credential still on file at the moment this update was resolved —
       * i.e. the scope-drift signature (see `reconcileShopifyConnectionScopes`'s
       * doc comment). Read from the SAME lookup this function already
       * performs, so a caller that wants to react to this (see
       * `POST /api/shopify/webhooks/app/scopes_update`) never needs a second,
       * redundant `findUnique` of its own — which would also be a race
       * hazard, since two lookups of the same row are not the same atomic
       * read a real concurrent write could interleave with.
       */
      wasScopeDriftReconnect: boolean;
    }
  | { applied: false; reason: "UNKNOWN_SHOP" | "SUPERSEDED" };

/**
 * Synchronizes Shopify's granted scopes into canonical
 * `CommerceConnection.grantedScopes` — the sole provider-neutral readiness
 * authority (Phase 14C-A; no legacy `Brand.shopifyGrantedScopes` mirror).
 *
 * This grants nothing and authorizes nothing. Under Shopify-managed
 * installation, Shopify itself decides what an installation holds and then
 * announces the result via `app/scopes_update`; this function only records that
 * announcement so the readers above stop reporting a stale grant. It is
 * therefore deliberately a pure cache write: no status transition, no
 * connection-history event, no reward-offer side effect.
 *
 * CANONICAL IDENTITY RESOLUTION. `shopDomain` (the value the caller took
 * from the HMAC-verified `X-Shopify-Shop-Domain` header) resolves DIRECTLY
 * to `CommerceConnection` via `(provider, externalAccountId)`. No canonical
 * row for this domain means `UNKNOWN_SHOP` — every live Shopify install
 * already has a canonical connection (operator-verified).
 *
 * The write mirrors `performTokenRefresh`'s compare-and-swap shape: an
 * `updateMany` whose `where` re-states the resolved row's OWN id plus the
 * predicates that must still hold at write time, so it can never widen to a
 * second tenant and never races a concurrent refresh into a wrong row.
 *   - `id` pins the write to exactly the row resolved above.
 *   - `externalAccountId` is the optimistic-concurrency guard: if the row was
 *     relinked or redacted (domain reassigned) between the read and the
 *     write, the write matches nothing rather than landing on a shop it was
 *     not authenticated for.
 *   - `status: { not: "UNINSTALLED" }` stops a late/reordered delivery from
 *     resurrecting scopes on a row whose uninstall handler has already
 *     cleared them.
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
  const normalizedScopes = input.grantedScopes
    .split(",")
    .map((scope) => scope.trim())
    .filter(Boolean);

  // CommerceConnection.grantedScopes is the sole provider-neutral cache.
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
        select: { id: true, brandId: true, status: true },
      })
    : null;

  if (connection) {
    // See `ApplyGrantedScopesUpdateResult.wasScopeDriftReconnect`'s doc
    // comment: the scope-drift signature is REQUIRES_RECONNECT with a
    // credential still on file. Read from the canonical secret's mere
    // presence — never decrypted — right before the write below.
    const secretModel = (db as typeof db & {
      commerceConnectionSecret?: typeof db.commerceConnectionSecret;
    }).commerceConnectionSecret;
    const hasCanonicalSecret = secretModel
      ? (await secretModel.findUnique({
          where: { connectionId: connection.id },
          select: { connectionId: true },
        })) !== null
      : false;
    const wasScopeDriftReconnect =
      connection.status === "REQUIRES_RECONNECT" && hasCanonicalSecret;

    const result = await connectionModel!.updateMany({
      where: {
        id: connection.id,
        brandId: connection.brandId,
        provider: "SHOPIFY",
        externalAccountId: shopDomain,
        status: { not: "UNINSTALLED" },
      },
      data: { grantedScopes: normalizedScopes },
    });
    if (result.count !== 1) return { applied: false, reason: "SUPERSEDED" };

    return { applied: true, brandId: connection.brandId, wasScopeDriftReconnect };
  }

  // PHASE 14C-A: no canonical connection exists for this domain — no legacy
  // Brand fallback (every live Shopify install already has a canonical
  // connection, operator-verified).
  return { applied: false, reason: "UNKNOWN_SHOP" };
}

// ---------------------------------------------------------------------------
// Scope-drift healing (Brand back to CONNECTED) + authoritative reconciliation
// ---------------------------------------------------------------------------

/**
 * CAS-guarded transition of a scope-drift-caused `REQUIRES_RECONNECT` back to
 * `CONNECTED`, plus a truthful `RECONNECTED` `ShopifyConnectionEvent` — the
 * mirror image of `markRequiresReconnectCanonical`.
 *
 * ONLY call this once genuine positive evidence exists that this
 * `REQUIRES_RECONNECT` carries the scope-drift signature (not a genuine
 * credential failure) AND that Shopify still considers the installation
 * live. This function itself does not re-verify anything — it trusts its
 * caller completely, so it must never be exposed as a standalone "mark
 * connected" primitive. Exactly two callers exist, each with its own
 * justification for that trust:
 *   - `reconcileShopifyConnectionScopes` below, after proving the stored
 *     credential works via a REAL Shopify Admin API call.
 *   - `POST /api/shopify/webhooks/app/scopes_update`, after
 *     `applyGrantedScopesUpdate` succeeds for a brand whose prior status was
 *     `REQUIRES_RECONNECT` with a token still on file — an HMAC-verified
 *     `app/scopes_update` delivery is itself Shopify's own authenticated
 *     notification that this exact installation is live, and the token
 *     presence alone already rules out a genuine credential failure (see
 *     `markRequiresReconnectCanonical`, which always clears the credential
 *     for that case).
 *
 * The canonical CAS guard (`healShopifyCredentialConnected`, keyed on
 * `CommerceConnection.status === "REQUIRES_RECONNECT"`) means this is a
 * safe no-op (`healed: false`) if the row already moved on (healed by a
 * concurrent request, or freshly disconnected/uninstalled) — it can never
 * resurrect a status a different, more recent write chose.
 *
 * Reward offers are NOT reactivated here, matching `recordShopifyConnectionInstall`'s
 * existing, deliberate behavior for every install/reconnect/relink: a Brand
 * Admin must always explicitly review and reactivate them. This healing path
 * reverses only the status/event side effects of the false alarm, not the
 * reward-offer deactivation `recordShopifyConnectionLoss` already applied
 * when the false `REQUIRES_RECONNECT` was recorded — that is a real,
 * separate consequence of the original bug and is left for deliberate
 * Brand Admin action, not auto-reversed by this fix.
 */
export async function healScopeDriftReconnect(brandId: string): Promise<boolean> {
  // PHASE 14C-A: CANONICAL-ONLY heal — targeted status write, CAS-guarded on
  // `CommerceConnection.status === "REQUIRES_RECONNECT"` (see
  // `healShopifyCredentialConnected`), so this is a safe no-op if the row
  // already moved on. No legacy `Brand` read or write.
  const canonicalHeal = await healShopifyCredentialConnected(brandId);

  if (canonicalHeal.outcome !== "HEALED") {
    return false;
  }

  // Same shop, same currency, same client id — this heals a status flag, it
  // does not represent any actual change of shop identity. Sourced fresh
  // from the just-healed canonical credential, never from `Brand`.
  const healedCredential = await loadShopifyCredential(brandId);
  if (healedCredential.outcome === "OK") {
    const db = await getDb();
    const c = healedCredential.credential;
    await db.$transaction((tx) =>
      recordShopifyConnectionInstall(tx, {
        brandId,
        eventType: "RECONNECTED",
        shopDomain: c.shopDomain,
        previousShopDomain: c.shopDomain,
        currencyCode: c.currencyCode,
        previousCurrencyCode: c.currencyCode,
        shopifyClientId: c.providerClientId,
      }),
    );
  }

  return true;
}

/**
 * Fetches the Shopify-authoritative granted-scope list for the installation
 * that issued `accessToken`, via `currentAppInstallation.accessScopes` —
 * Shopify's own record of what this installation currently holds, not
 * whatever SQRATCH last cached. Returns `{ok:false}` (never throws) on any
 * network/HTTP/GraphQL-error/shape failure — including a 401/403, which is
 * itself meaningful evidence that the credential is NOT valid and this
 * reconciliation attempt must not proceed to healing.
 */
async function fetchShopifyCurrentAppInstallationScopes(
  shopDomain: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; scopes: string[] } | { ok: false }> {
  try {
    const response = await fetchImpl(
      `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "X-Shopify-Access-Token": accessToken,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          query: `{ currentAppInstallation { accessScopes { handle } } }`,
        }),
      },
    );

    if (!response.ok) {
      return { ok: false };
    }

    const payload = (await response.json()) as {
      data?: {
        currentAppInstallation?: {
          accessScopes?: Array<{ handle?: unknown }>;
        };
      };
      errors?: unknown;
    };

    if (payload.errors) {
      return { ok: false };
    }

    const scopes = payload.data?.currentAppInstallation?.accessScopes;
    if (!Array.isArray(scopes)) {
      return { ok: false };
    }

    const handles = scopes
      .map((entry) => entry?.handle)
      .filter((handle): handle is string => typeof handle === "string" && handle.trim().length > 0);

    return { ok: true, scopes: handles };
  } catch {
    return { ok: false };
  }
}

export type ReconcileShopifyConnectionScopesResult =
  | { outcome: "RECONCILED"; healedConnection: boolean; grantedScopes: string[] }
  | {
      outcome: "NOT_ELIGIBLE";
      reason: "NO_BRAND" | "NO_SHOP_DOMAIN" | "NOT_SCOPE_DRIFT" | "TERMINAL";
    }
  | { outcome: "CREDENTIAL_INVALID" };

/**
 * Authoritative scope reconciliation: proves the stored credential still
 * works against Shopify by actually using it (a real Admin API call, not
 * merely a stored expiry timestamp), fetches Shopify's own current
 * `accessScopes` for the installation, persists them as the canonical
 * `CommerceConnection.grantedScopes` via `applyGrantedScopesUpdate`, and —
 * ONLY when this brand's `REQUIRES_RECONNECT`
 * carries the scope-drift signature (status is `REQUIRES_RECONNECT` while a
 * credential is still on file; a GENUINE credential failure always clears the
 * token in the same write that sets `REQUIRES_RECONNECT`, see
 * `markRequiresReconnect` above) — heals the connection back to `CONNECTED`.
 *
 * This is deliberately NOT the primary sync path — `app/scopes_update` (see
 * `applyGrantedScopesUpdate`) is faster and is Shopify's own push notification
 * of a scope change. This function exists for two purposes: (1) it is the
 * healing trigger for a connection ALREADY stuck in a false
 * `REQUIRES_RECONNECT` before this fix, since nothing else clears that sticky
 * status; (2) it is a pull-based safety net against a missed or delayed
 * `app/scopes_update` delivery, safe to call opportunistically (e.g. from the
 * Brand Shopify status route) whenever the stored status is
 * `REQUIRES_RECONNECT`.
 *
 * NEVER heals a genuine credential failure: if no usable token can be
 * obtained, or Shopify's own API rejects the token, this returns
 * `CREDENTIAL_INVALID` and leaves every stored field untouched.
 */
export async function reconcileShopifyConnectionScopes(
  brandId: string,
  deps: { tokenEndpoint?: TokenEndpointFn; fetchImpl?: typeof fetch } = {},
): Promise<ReconcileShopifyConnectionScopesResult> {
  // PHASE 14B.4B — CANONICAL ELIGIBILITY. Whether this brand is even a
  // candidate for reconciliation is now decided from the CANONICAL
  // connection/secret, not `Brand.shopify*` — eligibility used to be a
  // legacy-only gate even though the credential resolved below already came
  // from the canonical store. Obtained via the low-level load (not
  // `resolveRuntimeCredential`), precisely because that function's own
  // REQUIRES_RECONNECT guard is exactly the sticky gate this reconciliation
  // exists to get past. A corrupt canonical secret fails closed here too —
  // it is never "rescued" from the legacy row.
  const canonicalForReconcile = await loadShopifyCredential(brandId);
  if (canonicalForReconcile.outcome === "CORRUPT_SECRET") {
    return { outcome: "CREDENTIAL_INVALID" };
  }

  let wasRequiresReconnect: boolean;
  let reconcileCredential: RuntimeCredential;

  if (canonicalForReconcile.outcome === "OK") {
    wasRequiresReconnect =
      normalizeCanonicalStatus(canonicalForReconcile.credential.status) ===
      "REQUIRES_RECONNECT";
    reconcileCredential = {
      brandId,
      connectionId: canonicalForReconcile.credential.connectionId,
      source: "CANONICAL",
      shopDomain: canonicalForReconcile.credential.shopDomain,
      providerClientId: canonicalForReconcile.credential.providerClientId,
      connectionStatus: normalizeCanonicalStatus(
        canonicalForReconcile.credential.status,
      ),
      grantedScopes: canonicalForReconcile.credential.grantedScopes,
      authMode: canonicalForReconcile.credential.authMode,
      accessToken: canonicalForReconcile.credential.accessToken,
      accessTokenExpiresAt:
        canonicalForReconcile.credential.accessTokenExpiresAt,
      refreshToken: canonicalForReconcile.credential.refreshToken,
      refreshTokenExpiresAt:
        canonicalForReconcile.credential.refreshTokenExpiresAt,
      currencyCode: canonicalForReconcile.credential.currencyCode,
    };
  } else {
    // PHASE 14C-A: no legacy Brand fallback. NO_CONNECTION means there is no
    // canonical connection to reconcile at all. NO_SECRET whose status is
    // terminal (DISCONNECTED / UNINSTALLED / anything but CONNECTED or
    // REQUIRES_RECONNECT) is authoritative about its own revocation. A
    // CONNECTED-or-REQUIRES_RECONNECT NO_SECRET row has no credential to
    // test either way — every live merchant has a secret whenever its
    // status implies one (operator-verified), so this is not expected in
    // practice, only handled defensively.
    return { outcome: "NOT_ELIGIBLE", reason: "NO_BRAND" };
  }

  if (!reconcileCredential.accessToken || !reconcileCredential.shopDomain) {
    return { outcome: "NOT_ELIGIBLE", reason: "NOT_SCOPE_DRIFT" };
  }

  let accessToken: string;
  if (reconcileCredential.authMode === "LEGACY_OFFLINE") {
    accessToken = reconcileCredential.accessToken;
  } else {
    const nowMs = Date.now();
    if (isAccessTokenFresh(reconcileCredential.accessTokenExpiresAt, nowMs)) {
      accessToken = reconcileCredential.accessToken;
    } else {
      const lockId = await acquireLeaseFor(reconcileCredential, nowMs);
      if (!lockId) {
        // A concurrent request already holds the refresh lock — do not wait
        // or contend for it here; this is an opportunistic reconciliation,
        // not the primary token path, so the next scheduled attempt (e.g.
        // the next status-route load) will simply try again.
        return { outcome: "CREDENTIAL_INVALID" };
      }
      try {
        accessToken = await performTokenRefresh(
          reconcileCredential,
          lockId,
          deps.tokenEndpoint ?? defaultTokenEndpoint,
        );
      } catch {
        await releaseLeaseFor(reconcileCredential, lockId).catch(() => {});
        // Deliberately does NOT call markRequiresReconnect on a refresh
        // failure here — that is getValidAccessToken's own responsibility on
        // its normal cycle. This function only ever adds positive evidence
        // (a proven-good credential); it never adds negative evidence.
        return { outcome: "CREDENTIAL_INVALID" };
      }
    }
  }

  const scopesResult = await fetchShopifyCurrentAppInstallationScopes(
    reconcileCredential.shopDomain,
    accessToken,
    deps.fetchImpl,
  );
  if (!scopesResult.ok) {
    return { outcome: "CREDENTIAL_INVALID" };
  }

  const applied = await applyGrantedScopesUpdate({
    shopDomain: reconcileCredential.shopDomain,
    grantedScopes: scopesResult.scopes.join(","),
  });

  let healedConnection = false;
  if (wasRequiresReconnect && applied.applied) {
    healedConnection = await healScopeDriftReconnect(brandId);
  }

  return {
    outcome: "RECONCILED",
    healedConnection,
    grantedScopes: scopesResult.scopes,
  };
}
