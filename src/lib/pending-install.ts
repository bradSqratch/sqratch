/**
 * src/lib/pending-install.ts
 *
 * Single source of truth for the Shopify pending-install payload shape.
 *
 * Pure module — no DB, no IO, no logging of tokens or secrets.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LegacyPendingInstallPayload = {
  shape: "LEGACY";
  shop: string;
  encryptedToken: string;
};

export type ExpiringPendingInstallPayload = {
  shape: "EXPIRING";
  shop: string;
  authMode: "EXPIRING_OFFLINE";
  clientId: string;
  encryptedAccessToken: string;
  accessTokenExpiresAt: string;
  encryptedRefreshToken: string;
  refreshTokenExpiresAt: string;
  grantedScopes: string;
};

export type PendingInstallPayload =
  | LegacyPendingInstallPayload
  | ExpiringPendingInstallPayload;

// ---------------------------------------------------------------------------
// Parser — dual-shape validation, JSON.parse in try/catch
// ---------------------------------------------------------------------------

/**
 * Parse and validate a pending-install token string (stored JSON).
 * Returns null on any invalid/unknown shape rather than throwing.
 * Never logs the token value.
 */
export function parsePendingInstall(token: string): PendingInstallPayload | null {
  try {
    const raw = JSON.parse(token) as Record<string, unknown>;

    if (!raw.shop || typeof raw.shop !== "string") {
      return null;
    }

    if (typeof raw.encryptedAccessToken === "string" && raw.encryptedAccessToken) {
      // EXPIRING shape (public app / token-exchange)
      if (
        typeof raw.authMode !== "string" ||
        typeof raw.clientId !== "string" ||
        typeof raw.accessTokenExpiresAt !== "string" ||
        typeof raw.encryptedRefreshToken !== "string" ||
        typeof raw.refreshTokenExpiresAt !== "string" ||
        typeof raw.grantedScopes !== "string"
      ) {
        return null;
      }
      return {
        shape: "EXPIRING",
        shop: raw.shop,
        authMode: "EXPIRING_OFFLINE",
        clientId: raw.clientId as string,
        encryptedAccessToken: raw.encryptedAccessToken,
        accessTokenExpiresAt: raw.accessTokenExpiresAt as string,
        encryptedRefreshToken: raw.encryptedRefreshToken as string,
        refreshTokenExpiresAt: raw.refreshTokenExpiresAt as string,
        grantedScopes: raw.grantedScopes as string,
      };
    }

    if (typeof raw.encryptedToken === "string" && raw.encryptedToken) {
      // LEGACY shape (custom app / OAuth)
      return {
        shape: "LEGACY",
        shop: raw.shop,
        encryptedToken: raw.encryptedToken,
      };
    }

    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Builder — typed constructor for the EXPIRING payload so callers never
// hand-craft the JSON keys.  The resulting object is JSON-serializable;
// callers should use JSON.stringify() when writing to the token store.
// ---------------------------------------------------------------------------

export type BuildExpiringPayloadOptions = {
  shop: string;
  clientId: string;
  encryptedAccessToken: string;
  accessTokenExpiresAt: string;
  encryptedRefreshToken: string;
  refreshTokenExpiresAt: string;
  grantedScopes: string;
};

/**
 * Build a validated ExpiringPendingInstallPayload from its component parts.
 * The returned object carries the `shape` discriminant for TypeScript consumers.
 * Use `serializeExpiringPendingInstall` when writing to the token store so the
 * stored JSON contains exactly the same keys as before (no `shape` field on
 * the wire — `shape` is derived by the parser, not stored).
 */
export function buildExpiringPendingInstall(
  opts: BuildExpiringPayloadOptions,
): ExpiringPendingInstallPayload {
  return {
    shape: "EXPIRING",
    shop: opts.shop,
    authMode: "EXPIRING_OFFLINE",
    clientId: opts.clientId,
    encryptedAccessToken: opts.encryptedAccessToken,
    accessTokenExpiresAt: opts.accessTokenExpiresAt,
    encryptedRefreshToken: opts.encryptedRefreshToken,
    refreshTokenExpiresAt: opts.refreshTokenExpiresAt,
    grantedScopes: opts.grantedScopes,
  };
}

/**
 * Serialize an ExpiringPendingInstallPayload to a JSON string for storage in
 * the token store.  The `shape` discriminant is a TypeScript-only property and
 * is intentionally omitted from the wire format so the stored JSON is
 * byte-identical to what parsePendingInstall expects (same 8 keys as the
 * original implementation).
 */
export function serializeExpiringPendingInstall(
  payload: ExpiringPendingInstallPayload,
): string {
  // Destructure to exclude `shape` from the serialized JSON.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { shape: _shape, ...wire } = payload;
  return JSON.stringify(wire);
}
