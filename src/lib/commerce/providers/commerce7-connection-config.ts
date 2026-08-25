/**
 * src/lib/commerce/providers/commerce7-connection-config.ts
 *
 * PHASE 16 BIG ROUND / SUBPHASE 1 — merchant-confirmed Commerce7 storefront
 * configuration: validation, canonical storage, and derived-state
 * invalidation.
 *
 * WHY THIS IS EXPLICIT MERCHANT INPUT, NEVER DERIVED:
 *   Commerce7's own merchant help documentation confirms the storefront host
 *   is a per-tenant, ADMIN-EDITABLE "Website URL" setting with no documented
 *   REST field exposing its current value (see the fail-closed note on
 *   `normalizeCommerce7Product` in `./commerce7-products.ts`, from the prior
 *   research phase). There is therefore no trustworthy way to derive it — a
 *   Brand Admin must state it explicitly, exactly as this module requires.
 *
 * CANONICAL STORAGE — no new table, no new Brand field:
 *   `CommerceConnection.storefrontUrl` (an existing scalar column) holds the
 *   validated origin.
 *   `CommerceConnection.providerMetadata.productRoute` holds the validated
 *   relative route, using the SAME merge-preserving read-modify-write
 *   discipline `recordCommerceConnectionCurrencyCode` already established in
 *   `../connection-service.ts` — every other key in that JSON blob (notably
 *   `currencyCode`) is read back and re-written untouched.
 *   `CommerceConnection.providerMetadata.currencyCode` is the EXISTING
 *   canonical currency field — this module writes it, never a second one.
 */

// ---------------------------------------------------------------------------
// Storefront URL
// ---------------------------------------------------------------------------

export type Commerce7ConfigValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

/**
 * IPv4 dotted-quad literal check for the private/loopback/link-local ranges
 * this module must reject. Deliberately string/regex based — this function
 * never resolves DNS and never makes a network call (an explicit requirement:
 * "Do NOT server-side fetch arbitrary supplied URLs as validation").
 */
function isPrivateOrLoopbackIPv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(hostname);
  if (!match) {
    return false;
  }
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((n) => n > 255)) {
    return false;
  }
  const [a, b] = octets;

  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 0) return true; // "this network"
  return false;
}

function isPrivateOrLoopbackHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return true;
  }
  // IPv6 loopback / unspecified, with or without the URL's bracket syntax
  // already stripped by WHATWG URL parsing.
  if (lower === "::1" || lower === "[::1]" || lower === "::" || lower === "[::]") {
    return true;
  }
  // IPv6 unique-local (fc00::/7) and link-local (fe80::/10) — coarse prefix
  // check, sufficient to reject the obviously-private literal without a full
  // IPv6 parser.
  if (/^\[?f[cd][0-9a-f]{2}:/i.test(lower) || /^\[?fe[89ab][0-9a-f]:/i.test(lower)) {
    return true;
  }
  return isPrivateOrLoopbackIPv4(lower);
}

/**
 * Validates a merchant-supplied storefront URL down to a normalized,
 * origin-only HTTPS URL string (no trailing slash, no path/query/fragment,
 * no embedded credentials).
 */
export function validateCommerce7StorefrontUrl(
  raw: string,
): Commerce7ConfigValidationResult<string> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { ok: false, error: "A storefront URL is required." };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: "Enter a valid URL." };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, error: "The storefront URL must use https://." };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "The storefront URL must include a hostname." };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "The storefront URL must not contain credentials." };
  }
  if (parsed.search) {
    return { ok: false, error: "The storefront URL must not contain a query string." };
  }
  if (parsed.hash) {
    return { ok: false, error: "The storefront URL must not contain a fragment." };
  }
  if (isPrivateOrLoopbackHostname(parsed.hostname)) {
    return { ok: false, error: "The storefront URL must be a public hostname." };
  }
  // Root-or-nothing path only — "https://x.com/some/prefix" is rejected here
  // so the origin is unambiguous; the PRODUCT ROUTE (validated separately) is
  // where any path prefix belongs.
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    return {
      ok: false,
      error: "The storefront URL must be the site's root address, with no path.",
    };
  }

  // Normalized origin, no trailing slash — matches `new URL(...).origin`,
  // which is what `validateDestination` in click-attribution.ts compares
  // against.
  return { ok: true, value: parsed.origin };
}

// ---------------------------------------------------------------------------
// Product route
// ---------------------------------------------------------------------------

/**
 * Validates a merchant-supplied product route: a relative path prefix like
 * `/product`, with no scheme, no host, no query/fragment, and no traversal.
 * Normalized to strip a trailing slash (except the bare root `/`, which is
 * rejected below — a product route must be a real, non-empty prefix).
 */
export function validateCommerce7ProductRoute(
  raw: string,
): Commerce7ConfigValidationResult<string> {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return { ok: false, error: "A product page route is required." };
  }
  if (!trimmed.startsWith("/")) {
    return { ok: false, error: "The product route must start with \"/\"." };
  }
  if (trimmed.includes("://")) {
    return { ok: false, error: "The product route must not include a scheme or host." };
  }
  if (trimmed.includes("?") || trimmed.includes("#")) {
    return {
      ok: false,
      error: "The product route must not include a query string or fragment.",
    };
  }
  // Reject `..` as a path SEGMENT specifically (not merely as a substring —
  // a product slug like "product-2..0" must remain a valid ROUTE prefix
  // candidate even though this function only ever validates the route
  // itself, never a slug).
  const segments = trimmed.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, error: "The product route must not contain \"..\"." };
  }
  if (segments.length === 0) {
    return { ok: false, error: "The product route must be a real path, not just \"/\"." };
  }
  // Reject whitespace/control characters and anything that is not a safe
  // path-prefix character. Deliberately conservative allowlist.
  if (!/^[A-Za-z0-9\-_./]+$/.test(trimmed)) {
    return { ok: false, error: "The product route contains characters that are not allowed." };
  }

  const normalized = `/${segments.join("/")}`;
  return { ok: true, value: normalized };
}

// ---------------------------------------------------------------------------
// Currency
// ---------------------------------------------------------------------------

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** Normalizes `cad` -> `CAD` and requires exactly three letters. Never inferred. */
export function validateCommerce7CurrencyCode(
  raw: string,
): Commerce7ConfigValidationResult<string> {
  const normalized = raw?.trim().toUpperCase();
  if (!normalized) {
    return { ok: false, error: "A currency code is required." };
  }
  if (!CURRENCY_CODE_PATTERN.test(normalized)) {
    return { ok: false, error: "Enter a valid 3-letter currency code, e.g. CAD." };
  }
  return { ok: true, value: normalized };
}

// ---------------------------------------------------------------------------
// Product destination URL construction (Subphase 2 consumer)
// ---------------------------------------------------------------------------

/**
 * Builds a Commerce7 product destination URL from ALREADY-VALIDATED
 * configuration plus a provider-reported slug. Returns `null` — never a
 * partial or guessed URL — for any input that is not already in its
 * validated canonical form, or for a slug that cannot be safely encoded as a
 * single path segment.
 *
 * `storefrontUrl` MUST already be exactly the normalized origin
 * `validateCommerce7StorefrontUrl` produces (no path/query/fragment).
 * `productRoute` MUST already be exactly the normalized form
 * `validateCommerce7ProductRoute` produces (leading `/`, no trailing slash,
 * no traversal). This function re-validates neither — it is the caller's
 * job to pass canonical, already-persisted values, never raw request input.
 *
 * The slug is treated as an OPAQUE path segment: `encodeURIComponent`, then
 * re-checked that the resulting URL's origin is EXACTLY the configured
 * storefront origin — the actual enforcement of "no slash tricks that escape
 * the configured route".
 */
export function buildCommerce7ProductDestinationUrl(
  storefrontUrl: string,
  productRoute: string,
  slug: string,
): string | null {
  const trimmedSlug = slug?.trim();
  if (!trimmedSlug) {
    return null;
  }
  // A slug containing a literal "/" could otherwise escape the configured
  // route prefix once URL-joined (e.g. "../evil" or "x/../../y"). Rejecting
  // any slash (encoded or not) up front is simpler and strictly safer than
  // trying to prove every encoding is inert.
  if (trimmedSlug.includes("/") || trimmedSlug.includes("\\")) {
    return null;
  }
  // PHASE 18 REPAIR (P2-4E): a slug that is EXACTLY "." or ".." is a real
  // RFC 3986 dot-segment even with no slash in it — `encodeURIComponent`
  // does not encode "." (it is not in the reserved set), so
  // `new URL(origin + "/product/..")` NORMALIZES away both the ".." AND the
  // preceding "/product" segment, silently landing on the site ROOT rather
  // than any product page (verified directly: `new URL("https://x/p/..")`
  // -> `"https://x/"`). This does not escape the configured ORIGIN (so the
  // origin-equality check below would not catch it), but it silently
  // produces a URL that is not "under productRoute" at all — a real
  // data-integrity defect, not merely a cosmetic one. Any OTHER slug value
  // containing literal "." characters (e.g. "2015-chardonnay.reserve") is
  // an ordinary segment name with no special meaning and is unaffected.
  if (trimmedSlug === "." || trimmedSlug === "..") {
    return null;
  }

  let origin: URL;
  try {
    origin = new URL(storefrontUrl);
  } catch {
    return null;
  }
  if (origin.protocol !== "https:" || origin.pathname !== "/" || origin.search || origin.hash) {
    // Defense in depth: storefrontUrl was supposed to already be canonical.
    return null;
  }
  if (!productRoute.startsWith("/") || productRoute.includes("..")) {
    return null;
  }

  const encodedSlug = encodeURIComponent(trimmedSlug);
  const candidate = `${origin.origin}${productRoute}/${encodedSlug}`;

  let final: URL;
  try {
    final = new URL(candidate);
  } catch {
    return null;
  }

  // THE enforcement: the final destination's origin must be byte-identical
  // to the configured storefront origin. Nothing above should be able to
  // violate this, but the check is the actual safety property, not the
  // individual steps that are expected to uphold it.
  if (final.origin !== origin.origin || final.protocol !== "https:") {
    return null;
  }
  // PHASE 18 REPAIR (P2-4E): a SECOND, independent enforcement — the final
  // pathname must still literally start with the configured route prefix.
  // This is defense in depth on top of the explicit "."/".." rejection
  // above: it does not depend on enumerating every dangerous slug value,
  // only on the actual invariant this function promises ("the product lives
  // under productRoute"). Any future WHATWG URL normalization behavior this
  // file's author did not anticipate would be caught here rather than
  // silently producing a same-origin URL that is not actually a product
  // page.
  if (!final.pathname.startsWith(`${productRoute}/`)) {
    return null;
  }

  return final.toString();
}
