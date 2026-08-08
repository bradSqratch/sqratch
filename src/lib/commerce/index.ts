/**
 * src/lib/commerce/index.ts
 *
 * Barrel re-exporting the public surface of the provider-neutral commerce
 * abstraction layer. Concrete provider adapters (e.g. Shopify) and the
 * default wired-up registry live in separate files that import from here —
 * this module must never import a concrete provider itself.
 *
 * `defaultCommerceAdapterRegistry` (from `./default-registry`) is included
 * below because importing it does not force a prisma connection at module
 * load time: `ShopifyCommerceAdapter`'s dependencies (shopify-products.ts,
 * shopify-discounts.ts, shopify-token-manager.ts, shopify.ts) all import
 * `@/lib/prisma` lazily, never at their own module top level.
 */

export type { CommerceAdapter } from "./adapter";

export {
  CommerceAdapterRegistry,
  createCommerceAdapterRegistry,
  type CommerceAdapterFactory,
} from "./registry";

export { defaultCommerceAdapterRegistry } from "./default-registry";

export {
  CommerceError,
  UnsupportedProviderError,
  UnsupportedCapabilityError,
  CommerceConnectionNotFoundError,
  CommerceProviderApiError,
} from "./errors";

export type {
  CommerceCapabilities,
  CommerceConnectionSummary,
  CommerceConnectionResult,
  CommerceProduct,
  ProductSyncResult,
  ProductSyncPageRequest,
  ProductSyncPreparationRequest,
  ProductSyncPageResult,
  CreateDiscountInput,
  CreateDiscountOptions,
  ProviderDiscount,
  WebhookRequestInput,
  CommerceWebhookEventType,
  NormalizedWebhookEvent,
} from "./types";
