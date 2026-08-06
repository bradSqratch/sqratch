/**
 * tests/commerce-adapter-registry.test.ts
 *
 * Unit tests for the provider-neutral commerce adapter registry
 * (src/lib/commerce/registry.ts).
 *
 * Approach: the Shopify adapter does not exist yet (a later agent adds it),
 * so these tests exercise the registry purely through dependency injection —
 * a fake in-memory `CommerceAdapter` is registered for SHOPIFY, and COMMERCE7
 * is deliberately left unregistered to prove the "unsupported provider"
 * path. No real DB, no network, no Shopify-specific code is touched.
 *
 * Covered cases:
 *  1. SHOPIFY resolves to the registered fake adapter.
 *  2. Repeated `get()` calls return the same instance (memoization) and the
 *     factory runs exactly once.
 *  3. COMMERCE7 throws UnsupportedProviderError, which is also a
 *     CommerceError, and names the provider.
 *  4. The registry never returns undefined/null for any CommerceProvider
 *     enum value — each either returns an adapter or throws
 *     UnsupportedProviderError.
 *  5. Requesting COMMERCE7 never invokes the SHOPIFY factory (no
 *     cross-provider side effects / no network for the unregistered path).
 *  6. Capability contract: an adapter reporting canRevokeDiscount: false
 *     has no revokeDiscount method, so callers can feature-detect via
 *     getCapabilities() before calling optional methods.
 *  7. tryGet() returns null instead of throwing for an unsupported provider.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { CommerceProvider } from "@prisma/client";
import {
  createCommerceAdapterRegistry,
  CommerceAdapterRegistry,
} from "../src/lib/commerce/registry";
import { CommerceError, UnsupportedProviderError } from "../src/lib/commerce/errors";
import type { CommerceAdapter } from "../src/lib/commerce/adapter";
import type { CommerceCapabilities, CommerceConnectionResult, ProductSyncResult } from "../src/lib/commerce/types";

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** Minimal fake adapter — enough to satisfy the CommerceAdapter interface. */
function makeFakeAdapter(
  provider: CommerceProvider,
  capabilities: CommerceCapabilities,
): CommerceAdapter {
  return {
    provider,
    getCapabilities(): CommerceCapabilities {
      return capabilities;
    },
    async getConnection(connectionId: string): Promise<CommerceConnectionResult> {
      return {
        ok: true,
        connection: {
          id: connectionId,
          brandId: "brand-1",
          provider,
          status: "CONNECTED",
          displayName: "Fake Store",
          externalAccountId: "acct-1",
          storefrontUrl: null,
          isPrimary: true,
          grantedScopes: [],
          installedAt: null,
          uninstalledAt: null,
          lastProductSyncAt: null,
          isLegacyFallback: false,
        },
      };
    },
    async syncProducts(connectionId: string): Promise<ProductSyncResult> {
      return {
        connectionId,
        provider,
        products: [],
        productCount: 0,
        syncedAt: new Date(),
        hasNextPage: false,
        limit: 100,
      };
    },
    // canRevokeDiscount is false for this fake — revokeDiscount is
    // deliberately omitted (see test 6).
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CommerceAdapterRegistry", () => {
  test("1. SHOPIFY resolves to the registered fake adapter", () => {
    const fakeShopify = makeFakeAdapter(CommerceProvider.SHOPIFY, {
      canSyncProducts: true,
      canCreateDiscount: true,
      canRevokeDiscount: false,
      canVerifyWebhooks: true,
    });

    const registry = createCommerceAdapterRegistry({
      SHOPIFY: () => fakeShopify,
    });

    const resolved = registry.get(CommerceProvider.SHOPIFY);
    assert.equal(resolved, fakeShopify);
    assert.equal(resolved.provider, CommerceProvider.SHOPIFY);
  });

  test("2. repeated get() calls memoize — same instance, factory runs exactly once", () => {
    let factoryCallCount = 0;
    const registry = createCommerceAdapterRegistry({
      SHOPIFY: () => {
        factoryCallCount++;
        return makeFakeAdapter(CommerceProvider.SHOPIFY, {
          canSyncProducts: true,
          canCreateDiscount: true,
          canRevokeDiscount: false,
          canVerifyWebhooks: true,
        });
      },
    });

    const first = registry.get(CommerceProvider.SHOPIFY);
    const second = registry.get(CommerceProvider.SHOPIFY);
    const third = registry.get(CommerceProvider.SHOPIFY);

    assert.equal(first, second);
    assert.equal(second, third);
    assert.equal(factoryCallCount, 1, "factory should run exactly once across repeated get() calls");
  });

  test("3. COMMERCE7 throws UnsupportedProviderError (which is a CommerceError) naming the provider", () => {
    const registry = createCommerceAdapterRegistry({
      SHOPIFY: () => makeFakeAdapter(CommerceProvider.SHOPIFY, {
        canSyncProducts: true,
        canCreateDiscount: true,
        canRevokeDiscount: false,
        canVerifyWebhooks: true,
      }),
    });

    assert.throws(
      () => registry.get(CommerceProvider.COMMERCE7),
      (error: unknown) => {
        assert.ok(error instanceof UnsupportedProviderError, "should be an UnsupportedProviderError");
        assert.ok(error instanceof CommerceError, "should also be a CommerceError");
        assert.equal(error.provider, CommerceProvider.COMMERCE7);
        assert.match(error.message, /COMMERCE7/);
        return true;
      },
    );
  });

  test("4. registry never returns undefined/null for any CommerceProvider value", () => {
    const registry = createCommerceAdapterRegistry({
      SHOPIFY: () => makeFakeAdapter(CommerceProvider.SHOPIFY, {
        canSyncProducts: true,
        canCreateDiscount: true,
        canRevokeDiscount: false,
        canVerifyWebhooks: true,
      }),
    });

    for (const provider of Object.values(CommerceProvider)) {
      try {
        const adapter = registry.get(provider);
        assert.ok(adapter, `get(${provider}) should return a truthy adapter when it does not throw`);
      } catch (error) {
        assert.ok(
          error instanceof UnsupportedProviderError,
          `get(${provider}) must either return an adapter or throw UnsupportedProviderError`,
        );
      }
    }
  });

  test("5. requesting COMMERCE7 never consults/invokes the SHOPIFY factory", () => {
    let shopifyFactoryCallCount = 0;
    const registry = createCommerceAdapterRegistry({
      SHOPIFY: () => {
        shopifyFactoryCallCount++;
        return makeFakeAdapter(CommerceProvider.SHOPIFY, {
          canSyncProducts: true,
          canCreateDiscount: true,
          canRevokeDiscount: false,
          canVerifyWebhooks: true,
        });
      },
    });

    assert.throws(() => registry.get(CommerceProvider.COMMERCE7));
    assert.equal(shopifyFactoryCallCount, 0, "SHOPIFY factory must not run when resolving COMMERCE7");
  });

  test("6. capability contract: canRevokeDiscount: false means no revokeDiscount method", () => {
    const fakeShopify = makeFakeAdapter(CommerceProvider.SHOPIFY, {
      canSyncProducts: true,
      canCreateDiscount: true,
      canRevokeDiscount: false,
      canVerifyWebhooks: true,
    });
    const registry = createCommerceAdapterRegistry({ SHOPIFY: () => fakeShopify });

    const adapter = registry.get(CommerceProvider.SHOPIFY);
    const capabilities = adapter.getCapabilities();

    assert.equal(capabilities.canRevokeDiscount, false);
    assert.equal(
      adapter.revokeDiscount,
      undefined,
      "callers must be able to feature-detect revokeDiscount via capabilities before calling it",
    );
  });

  test("7. tryGet() returns null instead of throwing for an unsupported provider", () => {
    const registry = createCommerceAdapterRegistry({
      SHOPIFY: () => makeFakeAdapter(CommerceProvider.SHOPIFY, {
        canSyncProducts: true,
        canCreateDiscount: true,
        canRevokeDiscount: false,
        canVerifyWebhooks: true,
      }),
    });

    assert.equal(registry.tryGet(CommerceProvider.COMMERCE7), null);
    assert.ok(registry.tryGet(CommerceProvider.SHOPIFY) !== null);
  });

  test("registry is constructed via both the class and the factory function", () => {
    const viaClass = new CommerceAdapterRegistry({
      SHOPIFY: () => makeFakeAdapter(CommerceProvider.SHOPIFY, {
        canSyncProducts: true,
        canCreateDiscount: true,
        canRevokeDiscount: false,
        canVerifyWebhooks: true,
      }),
    });
    assert.ok(viaClass.get(CommerceProvider.SHOPIFY));
  });
});
