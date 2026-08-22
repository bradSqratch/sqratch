/**
 * src/lib/commerce/providers/shopify-credential-store.ts
 *
 * PHASE 14. The canonical Shopify credential store: the single place that
 * reads and writes live Shopify credentials against
 * `CommerceConnection` + `CommerceConnectionSecret`, replacing
 * `Brand.shopify*` as the runtime source of truth.
 *
 * ===========================================================================
 * WHAT INVERTED, AND WHAT DELIBERATELY DID NOT
 * ===========================================================================
 * BEFORE: `shopify-token-manager.ts` read/wrote `Brand.shopify*` for the
 * access token, refresh token, both expiries, auth mode, and the refresh
 * lease; `CommerceConnectionSecret` was written by the Phase-1 mirror and
 * READ BY NOTHING.
 *
 * AFTER (PHASE 14C-A): this module is the SOLE authority. The token manager
 * asks it for a credential, asks it to arbitrate the refresh lease, and asks
 * it to persist a rotation. There is no `Brand.shopify*` mirror write at all
 * any more — canonical `CommerceConnection`/`CommerceConnectionSecret` is
 * both the write path and the only read path.
 *
 * UNCHANGED ON PURPOSE: the refresh state machine itself — one winner, lease
 * takeover, stale-writer rejection, invalid_grant -> REQUIRES_RECONNECT,
 * transient failures never disconnecting a merchant. This module supplies the
 * same primitives against different storage; it does not redesign them.
 *
 * ===========================================================================
 * WHY THE LEASE IS TWO PLAIN COLUMNS, NOT PART OF THE ENCRYPTED PAYLOAD
 * ===========================================================================
 * `encryptSecret` (`@/lib/crypto`) is AES-256-GCM with a random per-call IV,
 * so encrypting the same plaintext twice yields different ciphertext. A
 * compare-and-swap therefore CANNOT be written as
 * `WHERE "encryptedPayload" = $expected`, and emulating it by
 * decrypt -> compare -> re-encrypt is a read-modify-write race — precisely
 * the failure the lease exists to prevent. So the lease lives in
 * `CommerceConnectionSecret.refreshLockId` / `.refreshLockedUntil`, where one
 * atomic Postgres UPDATE can arbitrate the winner, exactly as the legacy
 * `Brand.shopifyTokenRefresh*` columns did. Serverless instances continue to
 * coordinate through Postgres; nothing here is process-local.
 *
 * ===========================================================================
 * FAIL-CLOSED CLASSIFICATION (the security-critical part)
 * ===========================================================================
 * `loadShopifyCredential` distinguishes states that look similar but must be
 * handled very differently — see `LoadShopifyCredentialOutcome`:
 *
 *   NO_CONNECTION / NO_SECRET — the canonical record genuinely does not exist
 *     yet. PHASE 14C-A: there is no legacy `Brand` credential left to consult
 *     for this case either — every live Shopify install already has a
 *     canonical `CommerceConnection` + `CommerceConnectionSecret`
 *     (operator-verified) — so the caller simply treats this as not
 *     connected.
 *
 *   CORRUPT_SECRET — a canonical secret row EXISTS but could not be decrypted
 *     or parsed. The caller must FAIL CLOSED. A stale access/refresh token
 *     would silently violate the rotation and stale-writer guarantees this
 *     whole module exists to keep. Refusing to authenticate is recoverable
 *     (the merchant reconnects); using a superseded refresh token is not.
 *
 * A transient database error is NOT classified here at all — it propagates as
 * a thrown error so a caller can retry, and is never mistaken for "absent".
 *
 * ===========================================================================
 * SECURITY
 * ===========================================================================
 * Decrypted values never leave this module except as the `ShopifyCredential`
 * handed to the token manager. Nothing here logs, serializes, stringifies, or
 * returns an encrypted payload, a token, or the encryption key. No exported
 * symbol accepts a logger.
 */

import {
  CommerceProvider,
  type CommerceConnectionStatus,
  type Prisma,
} from "@prisma/client";
import { randomUUID } from "crypto";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { extractCurrencyCodeFromProviderMetadata } from "@/lib/commerce/connection-resolver";

type TxClient = Prisma.TransactionClient;

/**
 * Injectable client seam, matching the lazy-default idiom used by
 * `connection-reconciliation.ts` and `order-ingestion.ts`: the real Prisma
 * client is imported ONLY when no override is supplied, so importing this
 * module never requires `DATABASE_URL` and every function is unit-testable
 * without a database.
 */
export type ShopifyCredentialStoreClient = {
  commerceConnection: {
    findFirst: (args: unknown) => Promise<unknown>;
    findUnique: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  commerceConnectionSecret: {
    findUnique: (args: unknown) => Promise<unknown>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
    deleteMany: (args: unknown) => Promise<{ count: number }>;
    upsert: (args: unknown) => Promise<unknown>;
  };
  $transaction: <T>(fn: (tx: ShopifyCredentialStoreClient) => Promise<T>) => Promise<T>;
};

export type ShopifyCredentialStoreDeps = { client?: ShopifyCredentialStoreClient };

async function getDb(
  deps?: ShopifyCredentialStoreDeps,
): Promise<ShopifyCredentialStoreClient> {
  if (deps?.client) return deps.client;
  const { default: prisma } = await import("@/lib/prisma");
  return prisma as unknown as ShopifyCredentialStoreClient;
}

/**
 * The canonical live Shopify credential for one brand. `accessToken` and
 * `refreshToken` are DECRYPTED — never log, serialize, or return this object
 * outside the token-manager boundary.
 */
export type ShopifyCredential = {
  connectionId: string;
  brandId: string;
  /** `CommerceConnection.externalAccountId` — the *.myshopify.com domain. */
  shopDomain: string;
  /** `CommerceConnection.providerClientId` (NOT duplicated in metadata). */
  providerClientId: string | null;
  status: CommerceConnectionStatus;
  /** Canonical `CommerceConnection.grantedScopes`, normalized to a CSV string. */
  grantedScopes: string | null;
  authMode: string;
  accessToken: string | null;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
  /**
   * `CommerceConnection.providerMetadata.currencyCode` — the canonical
   * currency representation (see `CommerceConnectionSummary.currencyCode`).
   * Best-effort: `null` when the connection has no currency snapshot yet.
   * There is no `Brand.shopifyCurrencyCode` fallback (Phase 14C-A).
   */
  currencyCode: string | null;
};

export type LoadShopifyCredentialOutcome =
  | { outcome: "OK"; credential: ShopifyCredential }
  /** No `CommerceConnection` row for (brand, SHOPIFY) — treated as not connected. */
  | { outcome: "NO_CONNECTION" }
  /** Connection exists, no `CommerceConnectionSecret` — treated as not connected. */
  | {
      outcome: "NO_SECRET";
      connectionId: string;
      brandId: string;
      shopDomain: string;
      status: CommerceConnectionStatus;
    }
  /** Secret exists but is undecryptable/unparseable. Caller MUST fail closed. */
  | { outcome: "CORRUPT_SECRET"; connectionId: string; brandId: string };

/** The decrypted payload shape stored in `CommerceConnectionSecret.encryptedPayload`. */
type StoredSecretPayload = {
  accessToken?: unknown;
  accessTokenExpiresAt?: unknown;
  refreshToken?: unknown;
  refreshTokenExpiresAt?: unknown;
  authMode?: unknown;
};

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

function readStoredSecretPayload(encryptedPayload: string): StoredSecretPayload | null {
  try {
    const payload = JSON.parse(decryptSecret(encryptedPayload)) as StoredSecretPayload;
    return payload !== null && typeof payload === "object" ? payload : null;
  } catch {
    // Do not expose decrypt/parse details: callers receive a stable fail-closed
    // classification instead.
    return null;
  }
}

function readAuthMode(payload: StoredSecretPayload): string {
  return readString(payload.authMode) ?? "LEGACY_OFFLINE";
}

/** A credential-store projection that never exposes tokens or expiry values. */
export type ShopifyCredentialAuthModeOutcome =
  | { outcome: "OK"; authMode: string }
  | { outcome: "NO_SECRET" }
  | { outcome: "CORRUPT_SECRET" };

/**
 * Reads Shopify authentication semantics from the encrypted canonical
 * credential for one already-resolved connection. This is intentionally a
 * sanitized projection for status/embedded flows: providerMetadata must not
 * become a second mutable auth-mode authority.
 */
export async function getShopifyCredentialAuthMode(
  connectionId: string,
  deps?: ShopifyCredentialStoreDeps,
): Promise<ShopifyCredentialAuthModeOutcome> {
  const db = await getDb(deps);
  // Provider-bound at the query boundary: a caller can never make this
  // Shopify-specific projection inspect a Commerce7 credential by supplying
  // its connection id. The relation select also keeps this to one query.
  const connection = (await db.commerceConnection.findFirst({
    where: { id: connectionId, provider: CommerceProvider.SHOPIFY },
    select: { secret: { select: { encryptedPayload: true } } },
  })) as { secret: { encryptedPayload: string } | null } | null;

  if (!connection?.secret) return { outcome: "NO_SECRET" };
  const payload = readStoredSecretPayload(connection.secret.encryptedPayload);
  return payload
    ? { outcome: "OK", authMode: readAuthMode(payload) }
    : { outcome: "CORRUPT_SECRET" };
}

/**
 * Canonical `grantedScopes` is `Json?` (an array after Phase 1). The legacy
 * token-manager predicates (`hasSufficientScopes` etc.) take a CSV string, so
 * normalize once here rather than teaching every predicate a second shape.
 */
function normalizeScopes(value: unknown): string | null {
  if (Array.isArray(value)) {
    const scopes = value.filter((s): s is string => typeof s === "string" && s.trim() !== "");
    return scopes.length > 0 ? scopes.join(",") : null;
  }
  return readString(value);
}

/**
 * Picks the brand's Shopify connection using the SAME precedence as
 * `connection-resolver.pickPreferredConnectionRow` — primary first, then most
 * recently installed, then most recently created — so the credential path and
 * the read path can never disagree about which connection "the" one is.
 */
const CONNECTION_ORDER_BY = [
  { isPrimary: "desc" as const },
  { installedAt: "desc" as const },
  { createdAt: "desc" as const },
];

/**
 * Loads the canonical Shopify credential for a brand. Never falls back to
 * `Brand` itself — classification is returned to the caller, which owns the
 * (deliberately narrow) compatibility policy. See the FAIL-CLOSED block above.
 */
export async function loadShopifyCredential(
  brandId: string,
  deps?: ShopifyCredentialStoreDeps,
  connectionId?: string,
): Promise<LoadShopifyCredentialOutcome> {
  const db = await getDb(deps);

  type ConnectionRow = {
    id: string;
    brandId: string;
    status: CommerceConnectionStatus;
    externalAccountId: string;
    providerClientId: string | null;
    grantedScopes: unknown;
    providerMetadata: unknown;
    secret: { encryptedPayload: string } | null;
  };

  const connection = (await db.commerceConnection.findFirst({
    where: { brandId, provider: CommerceProvider.SHOPIFY, ...(connectionId ? { id: connectionId } : {}) },
    orderBy: CONNECTION_ORDER_BY,
    select: {
      id: true,
      brandId: true,
      status: true,
      externalAccountId: true,
      providerClientId: true,
      grantedScopes: true,
      providerMetadata: true,
      secret: { select: { encryptedPayload: true } },
    },
  })) as ConnectionRow | null;

  if (!connection) {
    return { outcome: "NO_CONNECTION" };
  }

  if (!connection.secret) {
    return {
      outcome: "NO_SECRET",
      connectionId: connection.id,
      brandId: connection.brandId,
      shopDomain: connection.externalAccountId,
      status: connection.status,
    };
  }

  const payload = readStoredSecretPayload(connection.secret.encryptedPayload);
  if (!payload) {
    return {
      outcome: "CORRUPT_SECRET",
      connectionId: connection.id,
      brandId: connection.brandId,
    };
  }

  return {
    outcome: "OK",
    credential: {
      connectionId: connection.id,
      brandId: connection.brandId,
      shopDomain: connection.externalAccountId,
      providerClientId: connection.providerClientId,
      status: connection.status,
      grantedScopes: normalizeScopes(connection.grantedScopes),
      authMode: readAuthMode(payload),
      accessToken: readString(payload.accessToken),
      accessTokenExpiresAt: readDate(payload.accessTokenExpiresAt),
      refreshToken: readString(payload.refreshToken),
      refreshTokenExpiresAt: readDate(payload.refreshTokenExpiresAt),
      currencyCode: extractCurrencyCodeFromProviderMetadata(
        connection.providerMetadata as Prisma.JsonValue | null,
      ),
    },
  };
}

// ---------------------------------------------------------------------------
// Refresh lease (compare-and-swap, arbitrated by Postgres)
// ---------------------------------------------------------------------------

/**
 * Attempts to acquire the refresh lease for a connection. Returns the lease id
 * iff THIS caller won, else null.
 *
 * Identical semantics to the legacy `acquireRefreshLock` on `Brand`: the
 * `OR[null, lt: now]` predicate means an expired lease (a crashed holder) is
 * freely takeable, so a crash can never deadlock a connection permanently.
 */
export async function acquireCredentialRefreshLease(
  connectionId: string,
  nowMs: number,
  lockDurationMs: number,
  deps?: ShopifyCredentialStoreDeps,
): Promise<string | null> {
  const db = await getDb(deps);
  const now = new Date(nowMs);
  const lockId = randomUUID();

  const result = await db.commerceConnectionSecret.updateMany({
    where: {
      connectionId,
      OR: [
        { refreshLockedUntil: null },
        { refreshLockedUntil: { lt: now } },
      ],
    },
    data: {
      refreshLockedUntil: new Date(nowMs + lockDurationMs),
      refreshLockId: lockId,
    },
  });

  return result.count === 1 ? lockId : null;
}

/**
 * Releases a lease the caller holds. The `refreshLockId` predicate is what
 * makes this safe: a caller whose lease was already taken over releases
 * NOTHING, so it can never free another caller's live lease.
 */
export async function releaseCredentialRefreshLease(
  connectionId: string,
  lockId: string,
  deps?: ShopifyCredentialStoreDeps,
): Promise<void> {
  const db = await getDb(deps);
  await db.commerceConnectionSecret.updateMany({
    where: { connectionId, refreshLockId: lockId },
    data: { refreshLockedUntil: null, refreshLockId: null },
  });
}

/** True while a live (unexpired) lease is held for this connection. */
export async function isCredentialRefreshLeaseHeld(
  connectionId: string,
  nowMs: number,
  deps?: ShopifyCredentialStoreDeps,
): Promise<boolean> {
  const db = await getDb(deps);
  const row = (await db.commerceConnectionSecret.findUnique({
    where: { connectionId },
    select: { refreshLockedUntil: true },
  })) as { refreshLockedUntil: Date | null } | null;
  return Boolean(row?.refreshLockedUntil && row.refreshLockedUntil.getTime() > nowMs);
}

// ---------------------------------------------------------------------------
// Canonical writes
// ---------------------------------------------------------------------------

export type ShopifyCredentialWrite = {
  authMode: string;
  accessToken: string;
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
};

function buildEncryptedPayload(write: ShopifyCredentialWrite): string {
  return encryptSecret(
    JSON.stringify({
      accessToken: write.accessToken,
      accessTokenExpiresAt: write.accessTokenExpiresAt?.toISOString() ?? null,
      refreshToken: write.refreshToken,
      refreshTokenExpiresAt: write.refreshTokenExpiresAt?.toISOString() ?? null,
      authMode: write.authMode,
    }),
  );
}

/**
 * Persists a ROTATED credential under the caller's lease, releasing the lease
 * in the SAME statement so the new access token and its new refresh token
 * become visible atomically — a reader can never observe one without the
 * other.
 *
 * Returns false when the lease was superseded (`count !== 1`). That is the
 * stale-writer rejection: a slow refresher whose lease was taken over writes
 * NOTHING and must go read the winner's token instead of clobbering it.
 */
export async function persistRotatedShopifyCredential(input: {
  connectionId: string;
  lockId: string;
  write: ShopifyCredentialWrite;
  grantedScopes: string | null;
}, deps?: ShopifyCredentialStoreDeps): Promise<boolean> {
  const db = await getDb(deps);

  return db.$transaction(async (tx) => {
    const result = await tx.commerceConnectionSecret.updateMany({
      where: { connectionId: input.connectionId, refreshLockId: input.lockId },
      data: {
        encryptedPayload: buildEncryptedPayload(input.write),
        rotatedAt: new Date(),
        expiresAt: input.write.accessTokenExpiresAt,
        // Released atomically with the rotation, exactly as the legacy
        // Brand-column write did.
        refreshLockedUntil: null,
        refreshLockId: null,
      },
    });

    if (result.count !== 1) {
      return false;
    }

    // Only the winner reaches here, so this cannot be written by a superseded
    // refresher. A successful rotation also proves the connection is healthy.
    await tx.commerceConnection.update({
      where: { id: input.connectionId },
      data: {
        status: "CONNECTED",
        ...(input.grantedScopes !== null
          ? { grantedScopes: input.grantedScopes.split(",").map((s) => s.trim()).filter(Boolean) }
          : {}),
      },
    });

    return true;
  });
}

/**
 * Permanent-failure path (invalid_grant / revoked): clears the canonical
 * credential and moves the connection to REQUIRES_RECONNECT, under the
 * caller's lease.
 *
 * CAS-guarded for the same reason as the rotation write: a superseded lease
 * holder must not be able to disconnect a merchant whose credential another
 * caller just refreshed successfully. Returns false if superseded.
 */
export async function markShopifyCredentialRequiresReconnect(input: {
  connectionId: string;
  lockId: string;
  /**
   * Runs inside the SAME transaction as the credential clear, and only when
   * the CAS actually won. The legacy Brand path recorded its connection-loss
   * event (which also deactivates the brand's reward offers) atomically with
   * clearing the token; this hook preserves that exact atomicity rather than
   * splitting it into a second, separately-failable write. Receives the
   * transaction client as `unknown` so this provider-neutral store never
   * takes a dependency on the legacy transition helpers' types.
   */
  onCleared?: (tx: unknown) => Promise<void>;
}, deps?: ShopifyCredentialStoreDeps): Promise<boolean> {
  const db = await getDb(deps);

  return db.$transaction(async (tx) => {
    const result = await tx.commerceConnectionSecret.deleteMany({
      where: { connectionId: input.connectionId, refreshLockId: input.lockId },
    });

    if (result.count !== 1) {
      return false;
    }

    await tx.commerceConnection.update({
      where: { id: input.connectionId },
      data: { status: "REQUIRES_RECONNECT" },
    });

    if (input.onCleared) {
      await input.onCleared(tx);
    }

    return true;
  });
}

export type InvalidateShopifyCredentialResult =
  | { outcome: "INVALIDATED"; connectionId: string; brandId: string }
  | { outcome: "NO_CONNECTION" }
  | { outcome: "STALE_EVENT_IGNORED"; connectionId: string; brandId: string };

/**
 * How the connection to invalidate is located.
 *
 * Provider WEBHOOKS are keyed on the shop, NOT on the brand, and the two can
 * legitimately diverge: `app/uninstalled` deliberately preserves
 * `Brand.shopifyShopDomain` for relink, so if the brand relinks to a different
 * shop before the first shop's terminal webhook arrives, no brand holds the
 * uninstalled domain any more. Selecting by `shopDomain` invalidates the right
 * canonical row in exactly that case, and never touches a sibling connection
 * for a different shop on the same brand.
 */
export type InvalidateShopifyCredentialSelector =
  | { brandId: string }
  | { shopDomain: string };

/**
 * PHASE 14B.3 — CANONICAL-FIRST credential invalidation, for every
 * credential-DESTRUCTION path (brand-admin disconnect, `app/uninstalled`,
 * `shop/redact`, relink cleanup).
 *
 * Ordering, in ONE transaction so a partial invalidation is impossible:
 *   A. transition `CommerceConnection.status` to the target terminal state;
 *   B. DELETE `CommerceConnectionSecret` (credential + any held lease);
 *   C. run `onInvalidated` (the caller's connection-loss event / reward-offer
 *      deactivation) while still inside that same transaction, preserving the
 *      existing business invariant's atomicity.
 *
 * Only AFTER this commits may a caller touch the legacy `Brand` mirror — and
 * a failure there can no longer resurrect anything, because
 * `resolveRuntimeCredential` refuses to fall back to `Brand` once the
 * canonical status is non-CONNECTED (see its DISCONNECT/UNINSTALL
 * RESURRECTION GUARD).
 *
 * No lease is required or honored here: revocation deliberately outranks an
 * in-flight rotation. A concurrent refresher's CAS will simply find its lease
 * gone and be rejected as a stale writer, which is the correct outcome — a
 * merchant who disconnected must not have a rotation land afterwards.
 *
 * PHASE 14B.3 P1 FIX — STALE TERMINAL-EVENT FENCE. `app/uninstalled` and
 * `shop/redact` are DELIVERED ASYNCHRONOUSLY: Shopify retries a failed
 * delivery up to 8 times over 4 hours, redelivering the ORIGINAL payload —
 * so a genuinely authentic, HMAC-verified terminal webhook can still arrive
 * well after the merchant reinstalled. Connections are upserted by shop
 * domain (`[provider, externalAccountId]`), so a reinstall reuses the SAME
 * row; without a freshness check, a delayed uninstall event would revoke the
 * fresh install it knows nothing about.
 *
 * `eventTriggeredAt` (from the `X-Shopify-Triggered-At` header — see
 * `verifyShopifyWebhookRequest`) is compared against the connection's
 * CURRENT `installedAt`, read fresh INSIDE this transaction (never the
 * pre-transaction read above, which could itself be stale by the time the
 * transaction starts). If the connection was (re)installed AFTER Shopify
 * triggered this event, the event is describing a state that no longer
 * exists — it is ignored rather than applied. Callers that have no
 * `eventTriggeredAt` (synchronous, non-webhook paths: brand-admin disconnect,
 * embedded disconnect) are unaffected — the fence only activates when the
 * caller supplies positive evidence of staleness; its absence is never
 * treated as evidence of freshness, so this can never make revocation MORE
 * skippable than before for those callers.
 */
export async function invalidateShopifyCredential(
  input: InvalidateShopifyCredentialSelector & {
    /** The canonical terminal state to record. */
    status: "DISCONNECTED" | "UNINSTALLED" | "REQUIRES_RECONNECT";
    /**
     * When Shopify triggered the event driving this call (`X-Shopify-Triggered-At`
     * on a webhook delivery). Omit for synchronous, non-webhook callers.
     */
    eventTriggeredAt?: Date | null;
    /** Runs inside the same transaction, only when a connection was found. */
    onInvalidated?: (
      tx: unknown,
      connection: { connectionId: string; brandId: string },
    ) => Promise<void>;
  },
  deps?: ShopifyCredentialStoreDeps,
): Promise<InvalidateShopifyCredentialResult> {
  const db = await getDb(deps);

  const existsCheck = (await db.commerceConnection.findFirst({
    where: {
      provider: CommerceProvider.SHOPIFY,
      ...("brandId" in input
        ? { brandId: input.brandId }
        : { externalAccountId: input.shopDomain }),
    },
    orderBy: CONNECTION_ORDER_BY,
    select: { id: true },
  })) as { id: string } | null;

  if (!existsCheck) {
    return { outcome: "NO_CONNECTION" };
  }

  return db.$transaction(async (tx) => {
    // Re-selected FRESH inside the transaction — not the pre-transaction
    // `existsCheck` above, which only proves a connection existed at some
    // earlier instant. `installedAt` here is read as close as possible to
    // the write below.
    const connection = (await tx.commerceConnection.findUnique({
      where: { id: existsCheck.id },
      select: { id: true, brandId: true, installedAt: true },
    })) as { id: string; brandId: string; installedAt: Date | null } | null;

    if (!connection) {
      return { outcome: "NO_CONNECTION" as const };
    }

    if (
      input.eventTriggeredAt &&
      connection.installedAt &&
      connection.installedAt > input.eventTriggeredAt
    ) {
      return {
        outcome: "STALE_EVENT_IGNORED" as const,
        connectionId: connection.id,
        brandId: connection.brandId,
      };
    }

    await tx.commerceConnection.update({
      where: { id: connection.id },
      data: {
        status: input.status,
        ...(input.status === "UNINSTALLED" ? { uninstalledAt: new Date() } : {}),
      },
    });

    // Unconditional delete (no lease predicate): revocation must not be
    // blockable by whoever happens to hold a refresh lease.
    await tx.commerceConnectionSecret.deleteMany({
      where: { connectionId: connection.id },
    });

    if (input.onInvalidated) {
      await input.onInvalidated(tx, {
        connectionId: connection.id,
        brandId: connection.brandId,
      });
    }

    return {
      outcome: "INVALIDATED" as const,
      connectionId: connection.id,
      brandId: connection.brandId,
    };
  });
}

/**
 * PHASE 14B.3 — canonical half of scope-drift healing.
 *
 * Compare-and-swaps the canonical connection from `REQUIRES_RECONNECT` back to
 * `CONNECTED`, and NOTHING else. Deliberately a targeted status write rather
 * than a rebuild from `Brand.shopify*`: healing changes a status flag, so
 * rebuilding would re-derive the canonical CREDENTIAL from the legacy mirror
 * and could overwrite a freshly rotated canonical token with a stale one.
 *
 * `false` means the row had already moved on (healed concurrently, or
 * disconnected/uninstalled since) — the CAS predicate makes this incapable of
 * resurrecting a status a more recent write chose.
 */
export async function healShopifyCredentialConnected(
  brandId: string,
  deps?: ShopifyCredentialStoreDeps,
  connectionId?: string,
): Promise<{ outcome: "HEALED" | "NOT_ELIGIBLE" | "NO_CONNECTION" }> {
  const db = await getDb(deps);

  const connection = (await db.commerceConnection.findFirst({
    where: {
      brandId,
      provider: CommerceProvider.SHOPIFY,
      ...(connectionId ? { id: connectionId } : {}),
    },
    orderBy: CONNECTION_ORDER_BY,
    select: { id: true },
  })) as { id: string } | null;

  if (!connection) {
    return { outcome: "NO_CONNECTION" };
  }

  const result = await db.commerceConnection.updateMany({
    where: { id: connection.id, status: "REQUIRES_RECONNECT" },
    data: { status: "CONNECTED" },
  });

  return { outcome: result.count === 1 ? "HEALED" : "NOT_ELIGIBLE" };
}

/**
 * Writes the canonical credential for an INSTALL / reconnect / token
 * exchange. No lease is involved: an install is itself the authoritative
 * event, and there is no earlier rotation it could be racing.
 *
 * Accepts an optional transaction client so a caller can make the canonical
 * credential write part of its own install transaction — canonical-first, per
 * the Phase-14 ordering rule.
 */
export async function writeShopifyCredential(
  input: {
    connectionId: string;
    write: ShopifyCredentialWrite;
  },
  tx?: TxClient,
  deps?: ShopifyCredentialStoreDeps,
): Promise<void> {
  const client = (tx as unknown as ShopifyCredentialStoreClient) ?? (await getDb(deps));
  const encryptedPayload = buildEncryptedPayload(input.write);

  // Same P1 fix as `applyShopifyConnectionSync` in connection-sync.ts: a
  // fresh credential write must clear any held refresh lease, or a lease
  // acquired against the PRIOR payload survives and its holder's stale-writer
  // CAS can still match and overwrite this write later.
  await client.commerceConnectionSecret.upsert({
    where: { connectionId: input.connectionId },
    create: {
      connectionId: input.connectionId,
      encryptedPayload,
      expiresAt: input.write.accessTokenExpiresAt,
    },
    update: {
      encryptedPayload,
      rotatedAt: new Date(),
      expiresAt: input.write.accessTokenExpiresAt,
      refreshLockId: null,
      refreshLockedUntil: null,
    },
  });
}
