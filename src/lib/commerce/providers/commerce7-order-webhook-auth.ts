/**
 * src/lib/commerce/providers/commerce7-order-webhook-auth.ts
 *
 * PHASE 16 BIG ROUND / SUBPHASE 4 — Basic-auth verification for the
 * Commerce7 ORDER webhook subscription.
 *
 * WHY BASIC AUTH, AND WHY THIS IS SAFE TO IMPLEMENT (not invented):
 *   Commerce7's generic webhooks documentation (`webhooks.md`) carries no
 *   authentication information at all. Its App Dev Center webhook
 *   SUBSCRIPTION configuration page (`app-apis-webhooks.md`) DOES document
 *   an optional "Username and Password... to secure the webhook" under an
 *   "Advanced" section — the exact same HTTP Basic Auth mechanism already
 *   implemented and tested for the install/uninstall callbacks
 *   (`./commerce7-callback-auth.ts`). This is a genuine, officially
 *   documented mechanism, not a guess — structurally weaker than a
 *   cryptographic body signature (Commerce7 itself calls it optional, and
 *   its strength is only as good as the operator's own configuration
 *   choice), a caveat repeated in the final round report rather than hidden.
 *
 * Uses a SEPARATE credential (`getCommerce7OrderWebhookConfig`) from the
 * install/uninstall callback's — see that function's doc comment in
 * `./commerce7.ts` for why.
 *
 * Same fixed-sanitized-body-on-every-failure discipline as
 * `verifyCommerce7CallbackAuth`: a caller cannot distinguish "no header"
 * from "wrong username" from "wrong password", and neither the supplied nor
 * the expected credential is ever logged or echoed. Comparison is
 * constant-time via `timingSafeEqualString`.
 *
 * ===========================================================================
 * PHASE 22 (live webhook 401 diagnosis) — SAFE, NON-SECRET FAILURE LOGGING
 * ===========================================================================
 * A live Commerce7-originated request has been observed returning 401 while
 * a manual `curl` using the believed-same credentials against the exact
 * same URL returns 200. Code inspection (this round) found the auth logic
 * itself correct and behavior-identical to the working install/uninstall
 * callback auth, and confirmed `src/middleware.ts`'s matcher does not even
 * include `/api/commerce7/*` (so middleware cannot be involved), and
 * `next.config.ts` defines no redirects/rewrites. The remaining plausible
 * causes (a Vercel-account-level domain redirect stripping `Authorization`
 * on a cross-host hop before axios's `follow-redirects` re-sends it, or a
 * credential value mismatch introduced when the operator entered the
 * password into Commerce7's own Dev Center field) cannot be distinguished
 * from source alone.
 *
 * `logOrderWebhookAuthFailure` below is called ONLY on a failed
 * authentication attempt (never on success — a success is already visible
 * via the normal webhook outcome log downstream) and logs ONLY boolean
 * facts plus non-secret request metadata:
 *   authorizationHeaderPresent, authorizationSchemeIsBasic,
 *   decodedBasicCredentialsValidShape, usernameMatchesConfiguredUsername,
 *   passwordMatchesConfiguredPassword, configuredUsernamePresent,
 *   configuredPasswordPresent, host, pathname, userAgent, environment.
 *
 * NEVER logged, under any circumstance: the raw `Authorization` header, the
 * base64 payload, the decoded username/password pair, the actual configured
 * password, any password prefix/suffix/length, or the Commerce7 App Secret.
 * Every boolean below is computed via `timingSafeEqualString` exactly as the
 * real auth decision is — the log can never reveal MORE than "matched" or
 * "did not match" for each half.
 */

import { NextResponse } from "next/server";
import { timingSafeEqualString } from "@/lib/security/timing-safe-equal";
import { getCommerce7OrderWebhookConfig } from "./commerce7";

export type Commerce7OrderWebhookAuthResult =
  | { ok: true }
  | { ok: false; response: NextResponse };

/**
 * Minimal structural request shape this module needs: header lookup plus
 * `url` (present on both the Fetch API `Request` tests construct and the
 * real `NextRequest` a route handler receives) so `host`/`pathname` can be
 * derived identically in both contexts without requiring a full `NextRequest`.
 */
export type Commerce7OrderWebhookAuthRequest = {
  headers: { get(name: string): string | null };
  url: string;
};

/** ONLY non-secret booleans and request metadata — see this file's header for the hard boundary. */
export type Commerce7OrderWebhookAuthDiagnostics = {
  authorizationHeaderPresent: boolean;
  authorizationSchemeIsBasic: boolean;
  decodedBasicCredentialsValidShape: boolean;
  usernameMatchesConfiguredUsername: boolean;
  passwordMatchesConfiguredPassword: boolean;
  configuredUsernamePresent: boolean;
  configuredPasswordPresent: boolean;
  host: string | null;
  pathname: string | null;
  userAgent: string | null;
  environment: string | null;
};

function unauthorized(): NextResponse {
  return new NextResponse(null, { status: 401 });
}

function readRequestMetadata(
  request: Commerce7OrderWebhookAuthRequest,
): { host: string | null; pathname: string | null } {
  try {
    const parsed = new URL(request.url);
    return { host: parsed.host, pathname: parsed.pathname };
  } catch {
    return { host: null, pathname: null };
  }
}

/**
 * Computes the full sanitized diagnostics for ONE request, independent of
 * whether the overall auth decision would already be known to fail —
 * every field is derived on its own so a single log line is maximally
 * informative regardless of WHERE the request diverges from a valid one.
 * Pure/no I/O beyond reading `process.env` — never throws.
 */
export function computeCommerce7OrderWebhookAuthDiagnostics(
  request: Commerce7OrderWebhookAuthRequest,
): Commerce7OrderWebhookAuthDiagnostics {
  const config = getCommerce7OrderWebhookConfig();
  const { host, pathname } = readRequestMetadata(request);

  const header = request.headers.get("authorization");
  const authorizationHeaderPresent = header !== null && header !== "";
  const authorizationSchemeIsBasic =
    authorizationHeaderPresent && header!.toLowerCase().startsWith("basic ");

  let decodedBasicCredentialsValidShape = false;
  let username: string | null = null;
  let password: string | null = null;
  if (authorizationSchemeIsBasic) {
    try {
      const decoded = Buffer.from(header!.slice(6).trim(), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      if (separator >= 0) {
        decodedBasicCredentialsValidShape = true;
        username = decoded.slice(0, separator);
        password = decoded.slice(separator + 1);
      }
    } catch {
      decodedBasicCredentialsValidShape = false;
    }
  }

  return {
    authorizationHeaderPresent,
    authorizationSchemeIsBasic,
    decodedBasicCredentialsValidShape,
    // Both comparisons always run against a real (possibly empty) string —
    // never short-circuited on the header being absent/malformed — so the
    // comparison itself is always constant-time and never throws.
    usernameMatchesConfiguredUsername: config
      ? timingSafeEqualString(username ?? "", config.username)
      : false,
    passwordMatchesConfiguredPassword: config
      ? timingSafeEqualString(password ?? "", config.password)
      : false,
    configuredUsernamePresent: config !== null,
    configuredPasswordPresent: config !== null,
    host,
    pathname,
    userAgent: request.headers.get("user-agent"),
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? null,
  };
}

/** Logs the diagnostics computed above — call ONLY on a failed authentication attempt. */
export function logOrderWebhookAuthFailure(
  diagnostics: Commerce7OrderWebhookAuthDiagnostics,
): void {
  console.warn(
    JSON.stringify({
      event: "commerce7_order_webhook_auth_failed",
      ...diagnostics,
    }),
  );
}

/**
 * Verifies `Authorization: Basic <base64(user:pass)>` against backend-only
 * configuration. Returns a ready-to-send response on failure so the route
 * cannot accidentally continue past a failed check.
 *
 * A MISSING configuration is deliberately NOT "open" — it fails closed with
 * a 500, exactly like `verifyCommerce7CallbackAuth`. The order webhook route
 * stays fail-closed until an operator has actually configured this
 * credential pair in both SQRATCH's environment and Commerce7's Dev Center.
 *
 * On ANY failure (missing config, missing/malformed header, wrong
 * username, wrong password) this logs sanitized diagnostics via
 * `logOrderWebhookAuthFailure` before returning — see this file's header.
 */
export function verifyCommerce7OrderWebhookAuth(
  request: Commerce7OrderWebhookAuthRequest,
): Commerce7OrderWebhookAuthResult {
  const diagnostics = computeCommerce7OrderWebhookAuthDiagnostics(request);

  const ok =
    diagnostics.configuredUsernamePresent &&
    diagnostics.configuredPasswordPresent &&
    diagnostics.authorizationHeaderPresent &&
    diagnostics.authorizationSchemeIsBasic &&
    diagnostics.decodedBasicCredentialsValidShape &&
    diagnostics.usernameMatchesConfiguredUsername &&
    diagnostics.passwordMatchesConfiguredPassword;

  if (!ok) {
    logOrderWebhookAuthFailure(diagnostics);
    // A missing configuration is the one failure mode that must answer 500
    // (fail closed, not "unauthenticated is fine") — every other failure
    // answers the same generic 401 regardless of which check tripped.
    if (!diagnostics.configuredUsernamePresent || !diagnostics.configuredPasswordPresent) {
      return { ok: false, response: new NextResponse(null, { status: 500 }) };
    }
    return { ok: false, response: unauthorized() };
  }

  return { ok: true };
}
