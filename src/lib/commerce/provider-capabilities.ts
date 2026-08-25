/**
 * src/lib/commerce/provider-capabilities.ts
 *
 * PURE, synchronous, provider-keyed capability predicates for the
 * provider-NEUTRAL layer.
 *
 * ===========================================================================
 * WHY THIS EXISTS SEPARATELY FROM `CommerceAdapter.getCapabilities()`
 * ===========================================================================
 * `CommerceCapabilities` (`./types.ts`) describes what an adapter INSTANCE can
 * do for a resolved connection, and obtaining it requires constructing that
 * adapter (a DB-backed, async operation). Some provider-neutral code runs on
 * hot, security-sensitive paths where that is neither available nor
 * affordable — most notably `validateDestination` in `./click-attribution.ts`,
 * a pure function on the click-redirect path.
 *
 * Those call sites previously inlined `provider === "SHOPIFY"` directly in the
 * neutral layer. That is the exact provider-specific branching the commerce
 * abstraction exists to prevent: it silently makes every non-Shopify provider
 * take the "else" path by accident rather than by decision, and it hides a
 * real security policy behind an equality check on an enum.
 *
 * This module is the single source of truth for those decisions. Each
 * predicate is a TOTAL switch over `CommerceProvider`, so adding a provider to
 * the enum makes the compiler demand an explicit, reviewed answer here rather
 * than letting it inherit a default.
 *
 * NOTHING here performs I/O, reads a connection, or touches a credential.
 */

import { CommerceProvider } from "@prisma/client";

/**
 * Whether a storefront/product URL that the PROVIDER ITSELF supplied (and that
 * SQRATCH persisted with that provenance recorded) may be honored even when
 * its host differs from the connection's immutable account host.
 *
 * This is a SECURITY policy, not a convenience flag: the click-redirect path
 * turns a stored URL into a real outbound redirect, so a provider whose
 * supplied URLs are not proven trustworthy must stay host-pinned or the route
 * becomes a durable open redirect. See `validateDestination` in
 * `./click-attribution.ts` for the surrounding checks (HTTPS-only, plus the
 * separate provider-confirmed publication gate).
 *
 *   SHOPIFY   — true. Shopify's Admin API legitimately returns a merchant's
 *               primary CUSTOM-DOMAIN URL (`Product.onlineStoreUrl`) rather
 *               than the connection's `*.myshopify.com` account host, so
 *               host-pinning would reject valid destinations. Honored only
 *               when the synchronized row records that Shopify supplied the
 *               exact URL; a SQRATCH-synthesized fallback stays host-pinned.
 *
 *   COMMERCE7 — false, deliberately FAIL-CLOSED, and now ACTIVELY LOAD-BEARING.
 *               Commerce7's product object documents no canonical storefront
 *               URL, and Phase 16C2 specifically researched (and failed to
 *               find) an authoritative API source for a tenant's public site
 *               URL. PHASE 16 BIG ROUND / SUBPHASE 2 resolved that a
 *               different way: a Brand Admin explicitly configures the
 *               storefront URL and product route
 *               (`configureCommerce7Storefront`), and
 *               `computeCommerce7ProductDestination`
 *               (`./providers/commerce7-products.ts`) CONSTRUCTS
 *               `productUrl` from that merchant-confirmed config. So
 *               Commerce7 `productUrl` values are no longer always empty —
 *               but they are SQRATCH-constructed, never provider-supplied,
 *               which is exactly why this predicate must stay `false`:
 *               `normalizeCommerce7Product` also pins
 *               `hasProviderSuppliedStorefrontUrl` to `false`
 *               unconditionally, and `validateDestination` therefore
 *               re-validates every Commerce7 destination against the
 *               connection's own `storefrontUrl` via exact-origin pinning.
 *               That re-validation always succeeds for a legitimately
 *               constructed URL (it was built FROM that exact origin) and
 *               rejects anything else. Flipping this to `true` would
 *               silently disable that origin pin, so it stays `false` unless
 *               and until Commerce7 exposes a verified storefront source.
 */
export function providerTrustsSuppliedStorefrontUrl(
  provider: CommerceProvider,
): boolean {
  switch (provider) {
    case CommerceProvider.SHOPIFY:
      return true;
    case CommerceProvider.COMMERCE7:
      return false;
    default: {
      // Exhaustiveness guard: a newly added CommerceProvider must make an
      // explicit decision above. Failing closed here means the worst a
      // missed case can do is reject a redirect, never allow an unvetted
      // host through.
      const exhaustive: never = provider;
      void exhaustive;
      return false;
    }
  }
}
