/**
 * src/lib/commerce/default-registry.ts
 *
 * The production commerce adapter registry: wires
 * `SHOPIFY -> ShopifyCommerceAdapter` via `createCommerceAdapterRegistry`
 * (`./registry.ts`). `COMMERCE7` is deliberately left unregistered — calling
 * `defaultCommerceAdapterRegistry.get(CommerceProvider.COMMERCE7)` throws
 * `UnsupportedProviderError` until a real Commerce7 adapter exists. Do not
 * add a Commerce7 stub here.
 *
 * Nothing on the request path constructs or reads from this registry yet
 * (Phase 1 deliberately keeps existing routes untouched) — this module
 * exists purely as the DI wiring point a later phase will import.
 *
 * IMPORTANT: importing this module never opens a DB connection or requires
 * `DATABASE_URL`. `createCommerceAdapterRegistry` only stores the factory
 * function below without invoking it, and `ShopifyCommerceAdapter`'s
 * constructor only stores its (lazily-resolving) deps — `@/lib/prisma` is
 * only imported when an adapter method that needs it (e.g. `getConnection`,
 * `syncProducts`) actually runs.
 */

import { CommerceProvider } from "@prisma/client";
import { createCommerceAdapterRegistry } from "./registry";
import { ShopifyCommerceAdapter } from "./providers/shopify-commerce-adapter";

export const defaultCommerceAdapterRegistry = createCommerceAdapterRegistry({
  [CommerceProvider.SHOPIFY]: () => new ShopifyCommerceAdapter(),
});
