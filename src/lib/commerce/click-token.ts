/**
 * Commerce click-token crypto.
 *
 * Structure and discipline are copied deliberately from
 * `src/lib/auth/email-verification-crypto.ts`, which is this codebase's
 * established pattern for bearer secrets: a peppered HMAC-SHA-256 over a
 * versioned, domain-separated input, with only the hash persisted and the
 * plaintext never written to a column or a log. This module is not a new
 * crypto scheme; it is that scheme applied to a second secret.
 *
 * ENTROPY. A click token travels in a URL and is the sole bearer of attribution
 * identity, so it carries more entropy than a session id
 * (`src/lib/session.ts` uses 24 random bytes): 32 random bytes = 256 bits,
 * base64url-encoded to 43 unpadded, natively URL-safe characters.
 *
 * DOMAIN SEPARATION. Two distinct prefixes are used so a token hash and an IP
 * hash produced under the same pepper can never collide or be substituted for
 * one another.
 *
 * FAIL CLOSED. `getPepper` throws when `COMMERCE_CLICK_TOKEN_PEPPER` is absent
 * rather than falling back to a weak default. Callers on the commerce path are
 * responsible for treating that throw as "record no attribution" and still
 * serving the visitor; they must never treat it as "hash without a pepper".
 */

import crypto from "node:crypto";

/** 32 bytes of randomness, base64url-encoded, is exactly 43 characters. */
const CLICK_TOKEN_BYTES = 32;
const CLICK_TOKEN_LENGTH = 43;
const CLICK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Length of the non-secret leading slice stored in
 * `CommerceClickAttribution.tokenPrefix` for operator triage. 8 base64url
 * characters is 48 bits of the token — enough to correlate a support report to
 * a row, far too little to brute-force the remaining 208 bits.
 */
const CLICK_TOKEN_PREFIX_LENGTH = 8;

function getPepper(): string {
  const pepper = process.env.COMMERCE_CLICK_TOKEN_PEPPER?.trim();
  if (!pepper) {
    throw new Error("COMMERCE_CLICK_TOKEN_PEPPER is not configured");
  }
  return pepper;
}

/** A fresh 256-bit click token. Never persist the return value. */
export function generateClickToken(): string {
  return crypto.randomBytes(CLICK_TOKEN_BYTES).toString("base64url");
}

/** Format-only check. It proves nothing about authenticity. */
export function isValidClickToken(value: unknown): value is string {
  return typeof value === "string" && CLICK_TOKEN_PATTERN.test(value);
}

/**
 * The value stored in `CommerceClickAttribution.tokenHash`.
 *
 * Throws when the token is malformed or when the pepper is unconfigured. Both
 * are programming/deployment errors, never visitor-controlled outcomes.
 */
export function hashClickToken(token: string): string {
  if (!isValidClickToken(token)) {
    throw new Error("Click token must be 43 base64url characters");
  }

  return crypto
    .createHmac("sha256", getPepper())
    .update(`sqratch-commerce-click:v1:${token}`)
    .digest("hex");
}

/**
 * The non-secret triage slice stored in
 * `CommerceClickAttribution.tokenPrefix`.
 */
export function clickTokenPrefix(token: string): string {
  if (!isValidClickToken(token)) {
    throw new Error("Click token must be 43 base64url characters");
  }

  return token.slice(0, CLICK_TOKEN_PREFIX_LENGTH);
}

/**
 * Peppered, domain-separated hash of a request IP for
 * `CommerceClickAttribution.ipHash`.
 *
 * The raw address is never stored or logged. This lives here rather than in the
 * click route so that every use of the pepper is in one auditable module, and
 * it uses a different domain prefix from `hashClickToken` so the two hash
 * spaces are disjoint.
 *
 * Returns null for an absent or unknown IP (`getRequestIp` yields the literal
 * string "unknown" when no proxy header is present), so a placeholder is never
 * hashed into something that looks like a real address.
 */
export function hashClickIp(ip: string | null | undefined): string | null {
  const value = ip?.trim();
  if (!value || value === "unknown") {
    return null;
  }

  return crypto
    .createHmac("sha256", getPepper())
    .update(`sqratch-commerce-click-ip:v1:${value}`)
    .digest("hex");
}

/** SQRATCH-namespaced public transport key; never collides with merchant `ref`. */
export const CLICK_TOKEN_QUERY_PARAM = "sqratch_ref";
/**
 * Shopify cart/order attribute written by the Theme App Extension.
 *
 * Deliberately NOT the same string as `CLICK_TOKEN_QUERY_PARAM`. The single
 * leading underscore is Shopify's convention for a cart attribute that stays
 * out of the merchant-facing presentation while remaining fully readable via
 * the Ajax Cart API and the order webhooks this system normalizes. A double
 * underscore is reserved for Shopify's own internal use and must not be used
 * here.
 */
export const CLICK_TOKEN_CART_ATTRIBUTE = "_sqratch_ref";
export const CLICK_TOKEN_CHAR_LENGTH = CLICK_TOKEN_LENGTH;
