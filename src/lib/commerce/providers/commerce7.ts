/**
 * src/lib/commerce/providers/commerce7.ts
 *
 * PHASE 16B — Commerce7 provider primitives: tenant normalization, app-level
 * API authentication, and account-token verification.
 *
 * CREDENTIAL MODEL (deliberately unlike Shopify):
 *   Commerce7's App Secret is APP-GLOBAL — it authenticates SQRATCH-the-app to
 *   Commerce7, not one winery to Commerce7. It is therefore read from backend
 *   environment configuration on every call and is NEVER persisted per tenant.
 *   In particular this module never reads or writes `CommerceConnectionSecret`,
 *   and nothing here ever stores a per-tenant credential. Copying the global
 *   secret into one encrypted row per tenant would multiply the blast radius of
 *   a leak for zero benefit.
 *
 * LOGGING: no function here logs an App Secret, a callback credential, or an
 * account token. Errors are returned as narrow discriminated results so callers
 * can respond with sanitized messages instead of echoing provider output.
 */

const COMMERCE7_API_BASE = "https://api.commerce7.com/v1";

/**
 * Commerce7 tenant ids are lowercase slugs (the `sqratch-inc` in
 * `https://sqratch-inc.commerce7.com`). Validated strictly rather than passed
 * through: the tenant is used as `externalAccountId`, i.e. as an identity key,
 * and is sent as a request header — so it must never carry whitespace, a path
 * separator, or a header-injection character.
 */
export function normalizeCommerce7Tenant(
  value: string | null | undefined,
): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();

  if (!/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(normalized)) {
    return null;
  }

  return normalized;
}

export type Commerce7AppConfig = {
  appId: string;
  appSecret: string;
};

export type Commerce7CallbackConfig = {
  username: string;
  password: string;
};

/**
 * Backend-only Commerce7 app credentials. Returns null (never throws, never
 * logs) when unset so routes can answer with a fixed sanitized 500 rather than
 * leaking which variable is missing.
 */
export function getCommerce7AppConfig(): Commerce7AppConfig | null {
  const appId = process.env.COMMERCE7_APP_ID;
  const appSecret = process.env.COMMERCE7_APP_SECRET;

  if (!appId || !appSecret) {
    return null;
  }

  return { appId, appSecret };
}

/**
 * Backend-only credentials for the Basic auth Commerce7 presents on its
 * install/uninstall callbacks. These are configured in the Commerce7 App Dev
 * Center and are distinct from the App ID/Secret used for outbound API calls.
 */
export function getCommerce7CallbackConfig(): Commerce7CallbackConfig | null {
  const username = process.env.COMMERCE7_INSTALL_USERNAME;
  const password = process.env.COMMERCE7_INSTALL_PASSWORD;

  if (!username || !password) {
    return null;
  }

  return { username, password };
}

/**
 * Basic auth header for outbound Commerce7 app API calls:
 * username = App ID, password = App Secret (verified against the real sandbox).
 */
export function buildCommerce7AppAuthorizationHeader(
  config: Commerce7AppConfig,
): string {
  const encoded = Buffer.from(
    `${config.appId}:${config.appSecret}`,
    "utf8",
  ).toString("base64");

  return `Basic ${encoded}`;
}

export type Commerce7AccountUser = {
  id: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  /**
   * The `role` string exactly as Commerce7 returned it, with only surrounding
   * whitespace trimmed. Deliberately NOT case-folded and NOT split into a list:
   * `GET /v1/account/user` documents a single `"role"` string (e.g.
   * `"Admin Owner"`), and inventing alternate shapes here would mean guessing
   * at role semantics the provider never promised.
   */
  role: string | null;
};

export type Commerce7AccountVerification =
  | { ok: true; user: Commerce7AccountUser }
  | { ok: false; reason: "UNAUTHORIZED" | "PROVIDER_ERROR" };

/**
 * The ONLY Commerce7 role permitted to link a tenant to a SQRATCH Brand.
 *
 * Commerce7's `GET /v1/account/user` is the documented, authoritative way to
 * verify an App Extension user, and an authorized response carries exactly
 * `"role": "Admin Owner"`.
 */
const COMMERCE7_LINK_ROLE = "Admin Owner";

/**
 * EXACT, CASE-SENSITIVE match against the documented role string.
 *
 * Deliberately fail-closed and deliberately NOT fuzzy. `"Admin"`, `"Owner"`,
 * `"admin owner"`, `"ADMIN OWNER"`, `"admin-owner"`, any other role, and a
 * missing/null role are all rejected. Near-match acceptance would be a guess
 * about Commerce7's role semantics, and guessing wrong here grants a
 * lower-privileged provider user the ability to permanently bind a winery's
 * tenant to a SQRATCH Brand.
 *
 * Surrounding whitespace is trimmed (see `readRole`) because it carries no role
 * meaning and cannot turn one role into another; nothing else is normalized.
 */
export function commerce7RoleCanLink(role: string | null | undefined): boolean {
  return role === COMMERCE7_LINK_ROLE;
}

/** Reads the documented singular `role` string. Anything else yields null. */
function readRole(record: Record<string, unknown>): string | null {
  const raw = record.role;
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export type Commerce7Fetch = (
  input: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Verifies an Admin Extension account token by asking Commerce7 who it belongs
 * to. Commerce7's `/account/user` response is the ONLY authority here — the
 * token is deliberately never decoded locally, because a locally-parsed JWT
 * proves nothing about whether the token is still valid, was issued for this
 * tenant, or carries the role it claims.
 *
 * The token is forwarded verbatim as `Authorization` and the tenant verbatim as
 * `tenant`; neither is logged. Any non-2xx answer fails closed.
 */
export async function verifyCommerce7AccountToken(
  input: { tenant: string; accountToken: string },
  deps: { fetchImpl?: Commerce7Fetch } = {},
): Promise<Commerce7AccountVerification> {
  const tenant = normalizeCommerce7Tenant(input.tenant);

  if (!tenant || !input.accountToken) {
    return { ok: false, reason: "UNAUTHORIZED" };
  }

  const fetchImpl = (deps.fetchImpl ??
    (globalThis.fetch as unknown as Commerce7Fetch)) as Commerce7Fetch;

  let response: Awaited<ReturnType<Commerce7Fetch>>;
  try {
    response = await fetchImpl(`${COMMERCE7_API_BASE}/account/user`, {
      method: "GET",
      headers: {
        tenant,
        Authorization: input.accountToken,
        Accept: "application/json",
      },
    });
  } catch {
    // Never surface the underlying error: it can contain request headers.
    return { ok: false, reason: "PROVIDER_ERROR" };
  }

  if (response.status === 401 || response.status === 403) {
    return { ok: false, reason: "UNAUTHORIZED" };
  }

  if (!response.ok) {
    return { ok: false, reason: "PROVIDER_ERROR" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, reason: "PROVIDER_ERROR" };
  }

  if (!payload || typeof payload !== "object") {
    return { ok: false, reason: "PROVIDER_ERROR" };
  }

  const record = payload as Record<string, unknown>;
  const id = readString(record, "id");

  if (!id) {
    return { ok: false, reason: "PROVIDER_ERROR" };
  }

  return {
    ok: true,
    user: {
      id,
      email: readString(record, "email"),
      firstName: readString(record, "firstName"),
      lastName: readString(record, "lastName"),
      role: readRole(record),
    },
  };
}

/**
 * Frame-ancestors CSP for the Commerce7 Admin Extension page. This RESTRICTS
 * embedding to Commerce7's admin origins — SQRATCH sets no global
 * X-Frame-Options/CSP today, so this is a tightening of the extension route
 * only and changes nothing anywhere else in the app.
 */
export function buildCommerce7FrameAncestorsCsp(
  tenant: string | null | undefined,
): string {
  const normalized = normalizeCommerce7Tenant(tenant);
  const origins = [
    "https://admin.platform.commerce7.com",
    "https://dev-center.platform.commerce7.com",
  ];

  if (normalized) {
    origins.push(`https://${normalized}.commerce7.com`);
  }

  return `frame-ancestors ${origins.join(" ")};`;
}
