/**
 * src/lib/commerce/registry.ts
 *
 * A small dependency-injected registry that maps a `CommerceProvider` to a
 * lazily-constructed, memoized `CommerceAdapter`. Built for testability
 * before any concrete adapter exists: callers supply a
 * `Partial<Record<CommerceProvider, CommerceAdapterFactory>>`, so tests can
 * register fake adapters without touching real provider SDKs or the network.
 *
 * NOTE: This file intentionally does NOT import the Shopify adapter (or any
 * other concrete provider). A later agent adds
 * `src/lib/commerce/default-registry.ts`, which wires
 * `SHOPIFY -> ShopifyCommerceAdapter` using `createCommerceAdapterRegistry`
 * from this file. Keeping that wiring out of `registry.ts` is what lets this
 * module — and its tests — exist independently of the Shopify adapter.
 */

import type { CommerceProvider } from "@prisma/client";
import type { CommerceAdapter } from "./adapter";
import { UnsupportedProviderError } from "./errors";

/** Lazily constructs a `CommerceAdapter`. Invoked at most once per registry instance. */
export type CommerceAdapterFactory = () => CommerceAdapter;

export class CommerceAdapterRegistry {
  private readonly factories: Partial<Record<CommerceProvider, CommerceAdapterFactory>>;
  private readonly instances = new Map<CommerceProvider, CommerceAdapter>();

  constructor(factories: Partial<Record<CommerceProvider, CommerceAdapterFactory>>) {
    // Copy defensively so later mutation of the caller's object can't change
    // this registry's behavior after construction.
    this.factories = { ...factories };
  }

  /**
   * Returns the adapter for `provider`, constructing it via the registered
   * factory on first access and memoizing the result so adapters (and any
   * API clients they own) are created once per registry, not once per call.
   *
   * Throws `UnsupportedProviderError` if no factory is registered for
   * `provider` (Commerce7 today). Never returns `undefined` or `null`, and
   * never itself performs a network call — that's the adapter's job, not
   * the registry's.
   */
  get(provider: CommerceProvider): CommerceAdapter {
    const cached = this.instances.get(provider);
    if (cached) {
      return cached;
    }

    const factory = this.factories[provider];
    if (!factory) {
      throw new UnsupportedProviderError(provider);
    }

    const adapter = factory();
    this.instances.set(provider, adapter);
    return adapter;
  }

  /** Non-throwing variant of `get`: returns `null` instead of throwing when unsupported. */
  tryGet(provider: CommerceProvider): CommerceAdapter | null {
    try {
      return this.get(provider);
    } catch (error) {
      if (error instanceof UnsupportedProviderError) {
        return null;
      }
      throw error;
    }
  }
}

/** Convenience constructor mirroring the class constructor. */
export function createCommerceAdapterRegistry(
  factories: Partial<Record<CommerceProvider, CommerceAdapterFactory>>,
): CommerceAdapterRegistry {
  return new CommerceAdapterRegistry(factories);
}
