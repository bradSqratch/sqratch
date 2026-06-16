/**
 * src/lib/shopify-session-token.ts
 *
 * Centralised, server-side verifier for Shopify App Bridge session tokens.
 *
 * A session token is a compact JWT (header.payload.signature) signed with
 * HMAC-SHA256 using the app's client secret.  The implementation deliberately
 * verifies the HMAC signature BEFORE parsing or trusting any claims.
 *
 * Nothing sensitive (token, payload body, secret) is ever logged or returned.
 */

import crypto from "crypto";
import { isValidShopDomain } from "@/lib/shopify";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SessionTokenPayload {
  /** The app's client ID (audience claim). */
  aud: string;
  /** Destination shop URL, e.g. "https://shop.myshopify.com". */
  dest: string;
  /** Issuer — the shop's admin URL, e.g. "https://shop.myshopify.com/admin". */
  iss: string;
  /** Subject — Shopify user ID. */
  sub: string;
  /** JWT ID (optional). */
  jti?: string;
  /** Expiry (seconds since epoch). */
  exp: number;
  /** Not-before (seconds since epoch). */
  nbf: number;
  /** Issued-at (seconds since epoch). */
  iat: number;
  /** Any additional claims Shopify may add. */
  [key: string]: unknown;
}

export type SessionTokenResult =
  | { ok: true; shop: string; payload: SessionTokenPayload }
  | { ok: false; status: 401 | 403; reason: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Clock-skew tolerance in seconds. */
const CLOCK_SKEW_S = 5;

/**
 * Decode a base64url string to a UTF-8 string.
 * Tolerates both standard base64 padding and the unpadded base64url form.
 */
function base64urlDecode(input: string): string {
  // Normalise: replace base64url chars with standard base64 chars, then pad.
  const base64 = input
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(input.length + ((4 - (input.length % 4)) % 4), "=");
  return Buffer.from(base64, "base64").toString("utf8");
}

/**
 * Compute the expected HMAC-SHA256 signature for `<header>.<payload>` using
 * the provided secret and return it as an unpadded base64url string.
 */
function computeHmacBase64url(secret: string, message: string): string {
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(message)
    .digest("base64");
  // Convert standard base64 → base64url (no padding).
  return hmac.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/**
 * Constant-time comparison of two base64url strings.
 * Pads both buffers to the same length before comparing so the comparison
 * itself does not short-circuit (length guard is still applied separately to
 * detect actual mismatches).
 */
function timingSafeBase64urlEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  // Lengths must match for the tokens to be equal.
  if (bufA.length !== bufB.length) {
    // Still perform a dummy comparison to avoid timing differences from early
    // return being detectable across many requests.
    crypto.timingSafeEqual(
      Buffer.alloc(bufA.length),
      Buffer.alloc(bufA.length),
    );
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Core verifier (pure — injectable now, apiKey, apiSecret)
// ---------------------------------------------------------------------------

export function verifySessionToken(input: {
  token: string;
  apiKey: string;
  apiSecret: string;
  /** Current time in seconds since epoch.  Defaults to Date.now()/1000. */
  now?: number;
}): SessionTokenResult {
  const { token, apiKey, apiSecret } = input;
  const nowSec = input.now ?? Date.now() / 1000;

  // -------------------------------------------------------------------------
  // Step 1: Split into three segments.
  // -------------------------------------------------------------------------
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, status: 401, reason: "malformed token" };
  }
  const [headerSeg, payloadSeg, signatureSeg] = parts;

  // -------------------------------------------------------------------------
  // Step 2: Verify the HMAC-SHA256 signature BEFORE touching the claims.
  //         This prevents any parsing of attacker-controlled payload data
  //         before authentication.
  // -------------------------------------------------------------------------
  const expectedSig = computeHmacBase64url(
    apiSecret,
    `${headerSeg}.${payloadSeg}`,
  );
  if (!timingSafeBase64urlEqual(expectedSig, signatureSeg)) {
    return { ok: false, status: 401, reason: "invalid signature" };
  }

  // -------------------------------------------------------------------------
  // Step 3: Parse the payload NOW that the signature is verified.
  // -------------------------------------------------------------------------
  let payload: SessionTokenPayload;
  try {
    const raw = base64urlDecode(payloadSeg);
    payload = JSON.parse(raw) as SessionTokenPayload;
  } catch {
    return { ok: false, status: 401, reason: "malformed token" };
  }

  // -------------------------------------------------------------------------
  // Step 4: Audience check — aud must equal the app's client ID (apiKey).
  // -------------------------------------------------------------------------
  if (payload.aud !== apiKey) {
    return { ok: false, status: 403, reason: "wrong audience" };
  }

  // -------------------------------------------------------------------------
  // Step 5: Time-based claim validation (allow ±CLOCK_SKEW_S seconds).
  // -------------------------------------------------------------------------
  const { exp, nbf, iat } = payload;

  if (typeof exp !== "number" || exp < nowSec - CLOCK_SKEW_S) {
    return { ok: false, status: 401, reason: "token expired" };
  }
  if (typeof nbf !== "number" || nbf > nowSec + CLOCK_SKEW_S) {
    return { ok: false, status: 401, reason: "token not yet valid" };
  }
  if (typeof iat !== "number" || iat > nowSec + CLOCK_SKEW_S) {
    return { ok: false, status: 401, reason: "token not yet valid" };
  }

  // -------------------------------------------------------------------------
  // Step 6: Validate dest and iss, and ensure the shop domain is legitimate.
  // -------------------------------------------------------------------------
  let destHost: string;
  let issHost: string;

  try {
    destHost = new URL(payload.dest).hostname;
    issHost = new URL(payload.iss).hostname;
  } catch {
    return { ok: false, status: 401, reason: "invalid destination" };
  }

  if (destHost !== issHost) {
    return { ok: false, status: 401, reason: "invalid destination" };
  }

  if (!isValidShopDomain(destHost)) {
    return { ok: false, status: 401, reason: "invalid destination" };
  }

  // -------------------------------------------------------------------------
  // Step 7: Require sub (user ID) to be present.
  // -------------------------------------------------------------------------
  if (!payload.sub) {
    return { ok: false, status: 401, reason: "missing subject" };
  }

  // -------------------------------------------------------------------------
  // Step 8: Success — return only the shop hostname and the validated payload.
  //         The raw token is never included in the result.
  // -------------------------------------------------------------------------
  return { ok: true, shop: destHost, payload };
}

// ---------------------------------------------------------------------------
// Request-level wrapper
// ---------------------------------------------------------------------------

/**
 * Extracts a Shopify App Bridge session token from the `Authorization` header
 * of the given `Request` and verifies it using the app credentials configured
 * via environment variables.
 *
 * Returns a {@link SessionTokenResult}.  On misconfiguration (missing env vars)
 * a generic error is logged server-side and a 401 is returned without leaking
 * which variable is absent.
 */
export function verifySessionTokenFromRequest(
  req: Request,
): SessionTokenResult {
  const apiKey = process.env.SHOPIFY_API_KEY;
  const apiSecret = process.env.SHOPIFY_API_SECRET;

  if (!apiKey || !apiSecret) {
    // Log a generic message without disclosing which variable is missing or
    // any of their values.
    console.error(
      "[shopify-session-token] Session token verification is misconfigured.",
    );
    return { ok: false, status: 401, reason: "authentication unavailable" };
  }

  const authHeader = req.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    return { ok: false, status: 401, reason: "missing token" };
  }

  const token = authHeader.slice("Bearer ".length).trim();
  if (!token) {
    return { ok: false, status: 401, reason: "missing token" };
  }

  return verifySessionToken({ token, apiKey, apiSecret });
}
