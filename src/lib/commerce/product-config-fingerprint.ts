/**
 * src/lib/commerce/product-config-fingerprint.ts
 *
 * PHASE 16-18 REPAIR (P1-1): a deterministic, CONFIG-ONLY fingerprint of a
 * `CommerceConnection`'s configuration. This module exists because the prior
 * fingerprint source — `CommerceConnection.updatedAt` — is WRONG: Prisma's
 * `@updatedAt` bumps on ANY write to the row, including
 * `CommerceConnection.lastProductSyncAt`, which a normal successful product
 * sync writes to itself via `completeProductSync()`. Using `updatedAt` as
 * the "did configuration change" signal therefore made every successful
 * sync look like a configuration change relative to itself and
 * self-invalidate the money/public fields it had just written. This module
 * fixes that at the root by fingerprinting ONLY the fields that actually
 * influence derived product money/public-URL/publication authority — never
 * `updatedAt`, `lastProductSyncAt`, `installedAt`, `uninstalledAt`, or any
 * other operational/telemetry field.
 *
 * EXHAUSTIVE PER-PROVIDER FIELD LIST, NOT A GENERIC METADATA HASH: this
 * deliberately does not fingerprint "the whole `providerMetadata` blob",
 * because an unrelated key changing there would then falsely register as a
 * product-configuration change. Each provider case below names EXACTLY the
 * fields verified (by direct source inspection this round) to influence
 * derived product state:
 *
 *   - `CommerceConnection.storefrontUrl` (raw column). Commerce7: written by
 *     `configureCommerce7Storefront`
 *     (`./providers/commerce7-storefront-configuration.ts`). Shopify:
 *     written once at install/relink from the shop domain
 *     (`applyShopifyConnectionSyncFromInstall`, `./connection-sync.ts`) —
 *     genuinely part of configuration (a shop-domain change is a real
 *     config change), not an operational field.
 *   - `providerMetadata.currencyCode` (`extractCurrencyCodeFromProviderMetadata`)
 *     — the single canonical currency representation for BOTH providers.
 *   - `providerMetadata.productRoute` (`extractProductRouteFromProviderMetadata`)
 *     — Commerce7-only merchant-configured value; always `null` for Shopify
 *     today. Reading it unconditionally keeps this fingerprint computation
 *     itself provider-neutral (no Shopify-specific branch needed to omit
 *     it) rather than a correctness requirement — it never differs for
 *     Shopify, so including it changes nothing for that provider.
 *
 * A new `CommerceProvider` enum value fails to compile here (exhaustiveness
 * guard in the `switch`) rather than silently falling through to another
 * provider's field list.
 *
 * NOT a cryptographic hash — this is an equality-comparison fingerprint
 * only (two runs either produced the identical canonical JSON or they
 * didn't), so a deterministic `JSON.stringify` over a fixed key order is
 * sufficient; no collision-resistance property is needed.
 */

import { CommerceProvider, type Prisma } from "@prisma/client";
import {
  extractCurrencyCodeFromProviderMetadata,
  extractProductRouteFromProviderMetadata,
} from "./connection-resolver";

export type ProductConfigFingerprintInput = {
  provider: CommerceProvider;
  storefrontUrl: string | null;
  providerMetadata: Prisma.JsonValue | null;
};

export function deriveProductConfigurationFingerprint(
  input: ProductConfigFingerprintInput,
): string {
  const currencyCode = extractCurrencyCodeFromProviderMetadata(input.providerMetadata);
  const productRoute = extractProductRouteFromProviderMetadata(input.providerMetadata);

  switch (input.provider) {
    case CommerceProvider.SHOPIFY:
      return JSON.stringify({
        provider: "SHOPIFY",
        storefrontUrl: input.storefrontUrl,
        currencyCode,
        // No merchant-configured product route exists for Shopify today —
        // included for a stable, provider-neutral shape; always null.
        productRoute: null,
      });
    case CommerceProvider.COMMERCE7:
      return JSON.stringify({
        provider: "COMMERCE7",
        storefrontUrl: input.storefrontUrl,
        currencyCode,
        productRoute,
      });
    default: {
      // Exhaustiveness guard: a new CommerceProvider value fails to compile
      // here rather than silently inheriting another provider's field list.
      const exhaustive: never = input.provider;
      return exhaustive;
    }
  }
}

/** Extracts just the currency code from the same canonical extraction path this module uses — a convenience for callers that need both the fingerprint and the currency from one row read (see `product-sync.ts`'s config snapshot). */
export function deriveCurrencyCodeForFingerprint(
  providerMetadata: Prisma.JsonValue | null,
): string | null {
  return extractCurrencyCodeFromProviderMetadata(providerMetadata);
}
