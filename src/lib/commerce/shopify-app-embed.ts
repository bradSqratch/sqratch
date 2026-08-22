/**
 * Shopify Admin deep links: the Theme Editor app-embed link, and the Admin
 * App Home link used for Shopify's native managed-installation permission
 * approval screen.
 *
 * PURE MODULE. No I/O, no fetch, no Prisma, no `process.env` — every input is
 * passed in, so this is safe to unit-test and safe to call from a request
 * handler without any DB/network cost.
 *
 * WHY TWO SEPARATE DEEP LINKS.
 *   - `buildThemeEditorAppEmbedDeepLink`: a theme app extension's app-embed
 *     block ships with the app but is INACTIVE until the merchant enables it
 *     in the Theme Editor and presses Save. Nothing in this codebase can
 *     enable it on the merchant's behalf. Live observation is implemented
 *     separately in the Shopify provider theme-readiness module; this pure
 *     helper only builds the merchant-facing deep link into the Theme Editor
 *     with the SQRATCH block pre-selected.
 *   - `buildShopifyAdminAppHomeDeepLink`: opens SQRATCH's own embedded app
 *     inside Shopify Admin. Under Shopify-managed installation this is also
 *     how a merchant approves a newly-required scope — Shopify shows its own
 *     native "needs access to... / Update" screen at this URL when a scope
 *     approval is pending, before letting the merchant into the app. SQRATCH
 *     never constructs a scope-consent URL itself; it only ever points the
 *     merchant at Shopify's own app-home surface.
 *
 * SECURITY BOUNDARY. Both returned strings are embedded directly into an
 * `<a href>` / `window.open` target, so this module treats every component as
 * untrusted even though callers are expected to pass server-side values from
 * the canonical Shopify `CommerceConnection` row (`externalAccountId`,
 * `providerClientId`).
 * Each component is validated against a strict allowlist pattern BEFORE the
 * URL is assembled, and the assembled URL is then re-parsed and re-checked
 * against those same components. A corrupted row or a future refactor
 * therefore cannot turn either link into an open redirect to an attacker
 * host, and cannot smuggle extra query parameters into Shopify's admin.
 */

/**
 * The app-embed BLOCK handle, which Shopify derives from the block's FILENAME:
 * `extensions/sqratch-attribution/blocks/sqratch-attribution-embed.liquid`
 * (`extensions/sqratch-attribution/shopify.extension.toml` declares only
 * `name`/`type`, no explicit `handle`, so the filename is authoritative).
 *
 * KEEP IN SYNC: renaming or moving that `.liquid` file changes the handle and
 * silently breaks this deep link — Shopify would open the Theme Editor with
 * nothing pre-selected. Rename both together.
 */
export const SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE =
  "sqratch-attribution-embed";

/** The Theme Editor path that hosts the app-embed activation panel. */
const THEME_EDITOR_PATHNAME = "/admin/themes/current/editor";

/**
 * Canonical `*.myshopify.com` admin host. Deliberately case-SENSITIVE and
 * anchored, so it rejects a scheme, a port, a path, an embedded `@` (userinfo
 * host-spoofing), a protocol-relative `//evil.com`, any other TLD, uppercase,
 * whitespace/control characters, and percent-encoded host smuggling. This is
 * the open-redirect defense: the host of the emitted URL can only ever be a
 * shop's own Shopify admin domain.
 */
const SHOP_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

/**
 * Shape of a Shopify app client id ("API key"). Verified against this repo's
 * real values — `shopify.app.toml` and `shopify.app.custom.toml` both carry a
 * 32-character lowercase-hex `client_id` — so the pattern is exactly that.
 * A connection may have been installed under either app depending on the
 * environment, which is why callers pass its canonical provider client id
 * rather than a global env value.
 */
const API_KEY_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Light shape check for the block handle. In practice this is always the
 * module-level constant above (never user input), so this guards against a
 * future typo/refactor introducing something unsafe, not against an attacker.
 */
const BLOCK_HANDLE_PATTERN = /^[a-z0-9-]+$/;

/**
 * Defensive upper bound on the host length. Shopify shop domains are far
 * shorter; this only stops a pathological value from reaching the URL parser.
 */
const MAX_SHOP_DOMAIN_LENGTH = 255;

export type ThemeEditorAppEmbedDeepLinkInput = {
  /** The brand's own stored canonical shop domain, e.g. `acme.myshopify.com`. */
  shopDomain: string;
  /** The client id of the Shopify app the brand installed under. */
  apiKey: string;
  /** App-embed block handle; pass `SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE`. */
  blockHandle: string;
};

/**
 * Success carries a URL that has already been re-validated after assembly.
 * Failure carries a short, stable, value-free reason code — the rejected input
 * is never echoed back, so a bad value cannot ride this string into a log line
 * or a rendered page.
 */
export type ThemeEditorAppEmbedDeepLinkResult =
  { ok: true; url: string } | { ok: false; error: string };

/**
 * Builds the Shopify admin Theme Editor deep link that opens the merchant's
 * current theme with the SQRATCH app-embed block pre-selected:
 *
 *   https://<shop>.myshopify.com/admin/themes/current/editor?context=apps&activateAppId=<apiKey>/<blockHandle>
 *
 * Returns `{ ok: false }` — never throws, and never returns a partially
 * validated URL — for any input that fails the patterns documented above.
 */
export function buildThemeEditorAppEmbedDeepLink(
  input: ThemeEditorAppEmbedDeepLinkInput,
): ThemeEditorAppEmbedDeepLinkResult {
  const { shopDomain, apiKey, blockHandle } = input;

  // `typeof` guards, not just the patterns: this module is called with values
  // that originate in nullable DB columns, and a non-string must fail closed
  // rather than be coerced into the URL by template interpolation.
  if (
    typeof shopDomain !== "string" ||
    shopDomain.length > MAX_SHOP_DOMAIN_LENGTH
  ) {
    return { ok: false, error: "invalid_shop_domain" };
  }
  if (!SHOP_DOMAIN_PATTERN.test(shopDomain)) {
    return { ok: false, error: "invalid_shop_domain" };
  }
  if (typeof apiKey !== "string" || !API_KEY_PATTERN.test(apiKey)) {
    return { ok: false, error: "invalid_api_key" };
  }
  if (
    typeof blockHandle !== "string" ||
    !BLOCK_HANDLE_PATTERN.test(blockHandle)
  ) {
    return { ok: false, error: "invalid_block_handle" };
  }

  const activateAppId = `${apiKey}/${blockHandle}`;

  let url: URL;
  try {
    url = new URL(THEME_EDITOR_PATHNAME, `https://${shopDomain}`);
  } catch {
    // Unreachable given the host pattern above; failing closed keeps that
    // assumption from becoming a thrown exception in a request handler.
    return { ok: false, error: "invalid_shop_domain" };
  }

  // The `/` inside `activateAppId` is left literal because that is the form
  // Shopify's Theme Editor deep link documents and expects, and `/` is a legal
  // query character (RFC 3986 allows `/` in a query). Each component around it
  // is still percent-encoded on the way in — an identity transform under the
  // allowlists validated above, and a hard stop on any future loosening of
  // them, so no component can break out of its own query value.
  url.search =
    `?context=apps&activateAppId=` +
    `${encodeURIComponent(apiKey)}/${encodeURIComponent(blockHandle)}`;

  // Post-assembly invariants. Re-parsing the finished string and comparing it
  // back to the inputs is what makes component injection structurally
  // impossible rather than merely unlikely.
  const parsed = new URL(url.toString());
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== shopDomain ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== THEME_EDITOR_PATHNAME ||
    parsed.searchParams.get("context") !== "apps" ||
    parsed.searchParams.get("activateAppId") !== activateAppId ||
    [...parsed.searchParams.keys()].length !== 2 ||
    parsed.hash !== ""
  ) {
    return { ok: false, error: "url_invariant_violation" };
  }

  return { ok: true, url: url.toString() };
}

/** The Shopify Admin path that opens an installed app's embedded UI. */
const ADMIN_APP_HOME_PATHNAME_PREFIX = "/admin/apps/";

export type ShopifyAdminAppHomeDeepLinkInput = {
  /** The brand's own stored canonical shop domain, e.g. `acme.myshopify.com`. */
  shopDomain: string;
  /** The client id of the Shopify app the brand installed under. */
  apiKey: string;
};

export type ShopifyAdminAppHomeDeepLinkResult =
  { ok: true; url: string } | { ok: false; error: string };

/**
 * Builds the Shopify Admin "App Home" deep link that opens SQRATCH inside a
 * shop's Shopify Admin:
 *
 *   https://<shop>.myshopify.com/admin/apps/<apiKey>
 *
 * WHY THIS URL, AND NOT AN OAUTH/CONSENT LINK BUILT BY SQRATCH. Under
 * Shopify-managed installation (see `shopify-scopes_update`'s route header),
 * SQRATCH cannot construct a URL that grants a scope — only Shopify decides
 * that, and it decides it by showing its OWN native "needs access to... /
 * Update" interstitial whenever a merchant opens an app whose declared scopes
 * have changed since they last approved it. Opening this exact URL is
 * therefore sufficient and correct: if new scopes are pending, Shopify shows
 * its native permission screen before letting the merchant into the app; if
 * nothing is pending, it opens the app directly. There is no separate "scope
 * approval" URL to construct, and this module never attempts to fabricate
 * one.
 *
 * Same security posture as `buildThemeEditorAppEmbedDeepLink`: every
 * component is validated against the exact same allowlists (see
 * `SHOP_DOMAIN_PATTERN` / `API_KEY_PATTERN` above) BEFORE assembly, and the
 * assembled URL is re-parsed and re-checked against those same components
 * afterward, so a corrupted stored value can never turn this into an open
 * redirect or a smuggled extra path/query component.
 */
export function buildShopifyAdminAppHomeDeepLink(
  input: ShopifyAdminAppHomeDeepLinkInput,
): ShopifyAdminAppHomeDeepLinkResult {
  const { shopDomain, apiKey } = input;

  if (
    typeof shopDomain !== "string" ||
    shopDomain.length > MAX_SHOP_DOMAIN_LENGTH
  ) {
    return { ok: false, error: "invalid_shop_domain" };
  }
  if (!SHOP_DOMAIN_PATTERN.test(shopDomain)) {
    return { ok: false, error: "invalid_shop_domain" };
  }
  if (typeof apiKey !== "string" || !API_KEY_PATTERN.test(apiKey)) {
    return { ok: false, error: "invalid_api_key" };
  }

  const pathname = `${ADMIN_APP_HOME_PATHNAME_PREFIX}${apiKey}`;

  let url: URL;
  try {
    url = new URL(pathname, `https://${shopDomain}`);
  } catch {
    // Unreachable given the host pattern above; failing closed keeps that
    // assumption from becoming a thrown exception in a request handler.
    return { ok: false, error: "invalid_shop_domain" };
  }

  const parsed = new URL(url.toString());
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== shopDomain ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== pathname ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    return { ok: false, error: "url_invariant_violation" };
  }

  return { ok: true, url: url.toString() };
}
