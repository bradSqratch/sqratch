/**
 * src/lib/commerce/default-registry.ts
 *
 * The production commerce adapter registry: wires
 * `SHOPIFY -> ShopifyCommerceAdapter` and (Phase 16C1)
 * `COMMERCE7 -> Commerce7CommerceAdapter` via `createCommerceAdapterRegistry`
 * (`./registry.ts`).
 *
 * The Commerce7 adapter is READ-ONLY CATALOG ONLY: its `getCapabilities()`
 * reports `products.sync: true`, `products.publicDestinations: false`, and
 * every reward capability `false`. Registering it does NOT grant it reward,
 * order, or public-destination behavior — the neutral layer still refuses
 * those via `UnsupportedCapabilityError`.
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
import { Commerce7CommerceAdapter } from "./providers/commerce7-commerce-adapter";

export const defaultCommerceAdapterRegistry = createCommerceAdapterRegistry({
  [CommerceProvider.SHOPIFY]: () => new ShopifyCommerceAdapter(),
  [CommerceProvider.COMMERCE7]: () => new Commerce7CommerceAdapter(),
});
