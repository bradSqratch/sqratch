/**
 * PHASE 16 BIG ROUND / SUBPHASE 2 — Commerce7 public product destinations.
 * Battery items 16-27: eligibility gate (16-19, 25-26), safe URL construction
 * / origin pinning (20, 23-24), provider-supplied-URL provenance (21-22), and
 * adapter/capability wiring (27).
 */
import "./env-setup";

process.env.COMMERCE7_APP_ID = "test-app-id";
process.env.COMMERCE7_APP_SECRET = "test-app-secret";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import { normalizeCommerce7Product } from "../src/lib/commerce/providers/commerce7-products";
import { providerTrustsSuppliedStorefrontUrl } from "../src/lib/commerce/provider-capabilities";
import {
  Commerce7CommerceAdapter,
  type Commerce7CommerceConnectionRow,
} from "../src/lib/commerce/providers/commerce7-commerce-adapter";
import type { Commerce7Fetch } from "../src/lib/commerce/providers/commerce7-products";

const STOREFRONT_CONFIG = {
  storefrontUrl: "https://shop.example.com",
  productRoute: "/product",
};

function c7Product(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "prod-1",
    title: "2021 Malbec",
    slug: "2021-malbec",
    webStatus: "Available",
    adminStatus: "Available",
    security: { availableTo: "Public" },
    variants: [{ id: "var-1", price: 2500, sku: "MALBEC-21" }],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 16-19, 25-26. Eligibility gate
// ---------------------------------------------------------------------------

describe("16-19, 25-26. normalizeCommerce7Product public-destination eligibility", () => {
  test("16. a fully eligible product with full config gets a real public destination", () => {
    const product = normalizeCommerce7Product(c7Product(), STOREFRONT_CONFIG)!;
    assert.equal(product.productUrl, "https://shop.example.com/product/2021-malbec");
    assert.equal(product.hasProviderStorefrontPublication, true);
  });

  test("17. no config at all -> no destination, even for an otherwise-eligible product", () => {
    const product = normalizeCommerce7Product(c7Product())!;
    assert.equal(product.productUrl, "");
    assert.equal(product.hasProviderStorefrontPublication, false);
  });

  test("17b. config present but storefrontUrl not yet set -> no destination", () => {
    const product = normalizeCommerce7Product(c7Product(), {
      storefrontUrl: null,
      productRoute: "/product",
    })!;
    assert.equal(product.productUrl, "");
    assert.equal(product.hasProviderStorefrontPublication, false);
  });

  test("17c. config present but productRoute not yet set -> no destination", () => {
    const product = normalizeCommerce7Product(c7Product(), {
      storefrontUrl: "https://shop.example.com",
      productRoute: null,
    })!;
    assert.equal(product.productUrl, "");
    assert.equal(product.hasProviderStorefrontPublication, false);
  });

  test("18. missing/empty slug -> no destination even with full config", () => {
    const product = normalizeCommerce7Product(c7Product({ slug: null }), STOREFRONT_CONFIG)!;
    assert.equal(product.productUrl, "");
    assert.equal(product.hasProviderStorefrontPublication, false);
  });

  test("19. a slug containing a literal slash never escapes the configured route", () => {
    for (const slug of ["../../evil", "a/b", "a\\b"]) {
      const product = normalizeCommerce7Product(
        c7Product({ slug }),
        STOREFRONT_CONFIG,
      )!;
      assert.equal(product.productUrl, "", `slug "${slug}" must not produce a URL`);
      assert.equal(product.hasProviderStorefrontPublication, false);
    }
  });

  test("19b. a pre-encoded slug (e.g. containing a literal %2F) stays a single safe path segment", () => {
    // encodeURIComponent turns the literal "%" into "%25", so the resulting
    // path segment single-decodes back to the ORIGINAL text, never to a "/" —
    // this is not a traversal escape, just unusual-looking product data.
    const product = normalizeCommerce7Product(
      c7Product({ slug: "..%2Fevil" }),
      STOREFRONT_CONFIG,
    )!;
    assert.ok(product.productUrl.startsWith("https://shop.example.com/product/"));
    const url = new URL(product.productUrl);
    assert.equal(url.origin, "https://shop.example.com");
    assert.equal(decodeURIComponent(url.pathname), "/product/..%2Fevil");
  });

  test("25. Retired/Hidden/Not Available products never get a public destination, even with full config", () => {
    for (const overrides of [
      { webStatus: "Retired" },
      { adminStatus: "Hidden" },
      { webStatus: "Not Available" },
      { adminStatus: "Not Available" },
    ]) {
      const product = normalizeCommerce7Product(
        c7Product(overrides),
        STOREFRONT_CONFIG,
      )!;
      assert.equal(product.productUrl, "", JSON.stringify(overrides));
      assert.equal(product.hasProviderStorefrontPublication, false);
    }
  });

  test("26. Allocation/Group/Club security tiers never get a public destination, even with full config", () => {
    for (const availableTo of ["Allocation", "Group", "Club"]) {
      const product = normalizeCommerce7Product(
        c7Product({ security: { availableTo } }),
        STOREFRONT_CONFIG,
      )!;
      assert.equal(product.productUrl, "", availableTo);
      assert.equal(product.hasProviderStorefrontPublication, false);
    }
  });
});

// ---------------------------------------------------------------------------
// 20-22. Origin pinning + provenance
// ---------------------------------------------------------------------------

describe("20-22. origin pinning and provenance", () => {
  test("20. the destination's origin is always exactly the configured storefront origin", () => {
    const product = normalizeCommerce7Product(c7Product(), STOREFRONT_CONFIG)!;
    assert.ok(product.productUrl.startsWith("https://shop.example.com/"));
    const url = new URL(product.productUrl);
    assert.equal(url.origin, "https://shop.example.com");
  });

  test("21. hasProviderSuppliedStorefrontUrl is ALWAYS false for Commerce7, eligible or not", () => {
    const eligible = normalizeCommerce7Product(c7Product(), STOREFRONT_CONFIG)!;
    assert.equal(eligible.hasProviderSuppliedStorefrontUrl, false);

    const ineligible = normalizeCommerce7Product(c7Product())!;
    assert.equal(ineligible.hasProviderSuppliedStorefrontUrl, false);
  });

  test("22. providerTrustsSuppliedStorefrontUrl(COMMERCE7) remains false (Subphase 2 must not flip it)", () => {
    assert.equal(providerTrustsSuppliedStorefrontUrl(CommerceProvider.COMMERCE7), false);
  });
});

// ---------------------------------------------------------------------------
// 23-24. Malformed/inconsistent stored config never produces a URL
// ---------------------------------------------------------------------------

describe("23-24. defensive re-validation of stored config", () => {
  test("23. an http (non-https) storefrontUrl persisted somehow is rejected, not trusted", () => {
    const product = normalizeCommerce7Product(c7Product(), {
      storefrontUrl: "http://shop.example.com",
      productRoute: "/product",
    })!;
    assert.equal(product.productUrl, "");
  });

  test("24. a productRoute containing traversal persisted somehow is rejected, not trusted", () => {
    const product = normalizeCommerce7Product(c7Product(), {
      storefrontUrl: "https://shop.example.com",
      productRoute: "/../admin",
    })!;
    assert.equal(product.productUrl, "");
  });
});

// ---------------------------------------------------------------------------
// 27. Adapter-level wiring: connection row -> normalized products
// ---------------------------------------------------------------------------

describe("27. Commerce7CommerceAdapter wires connection storefront config into normalized products", () => {
  function connectionRow(
    overrides: Partial<Commerce7CommerceConnectionRow> = {},
  ): Commerce7CommerceConnectionRow {
    return {
      id: "conn-1",
      brandId: "brand-a",
      provider: CommerceProvider.COMMERCE7,
      status: "CONNECTED",
      displayName: "Acme Winery",
      externalAccountId: "acme-tenant",
      storefrontUrl: "https://shop.example.com",
      isPrimary: true,
      grantedScopes: null,
      installedAt: new Date(),
      uninstalledAt: null,
      lastProductSyncAt: null,
      providerMetadata: { currencyCode: "USD", productRoute: "/product" },
      ...overrides,
    };
  }

  function makeFetch(products: unknown[]): Commerce7Fetch {
    return (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ products, cursor: null }),
    })) as unknown as Commerce7Fetch;
  }

  test("syncProducts produces a real productUrl when the connection is configured", async () => {
    const row = connectionRow();
    const adapter = new Commerce7CommerceAdapter({
      loadConnection: async () => row,
      markProductSync: async () => {},
      fetchImpl: makeFetch([c7Product()]),
    });

    const result = await adapter.syncProducts("conn-1");
    assert.equal(result.products.length, 1);
    assert.equal(result.products[0].productUrl, "https://shop.example.com/product/2021-malbec");
    assert.equal(result.products[0].hasProviderStorefrontPublication, true);
  });

  test("syncProducts yields empty productUrl when the connection has no storefront config yet", async () => {
    const row = connectionRow({ storefrontUrl: null, providerMetadata: { currencyCode: "USD" } });
    const adapter = new Commerce7CommerceAdapter({
      loadConnection: async () => row,
      markProductSync: async () => {},
      fetchImpl: makeFetch([c7Product()]),
    });

    const result = await adapter.syncProducts("conn-1");
    assert.equal(result.products[0].productUrl, "");
    assert.equal(result.products[0].hasProviderStorefrontPublication, false);
  });

  test("fetchProductPage also wires the same storefront config through", async () => {
    const row = connectionRow();
    const adapter = new Commerce7CommerceAdapter({
      loadConnection: async () => row,
      markProductSync: async () => {},
      fetchImpl: makeFetch([c7Product()]),
    });

    const page = await adapter.fetchProductPage("conn-1", {});
    assert.equal(page.products[0].productUrl, "https://shop.example.com/product/2021-malbec");
  });

  test("getCapabilities reports publicDestinations: true", () => {
    const adapter = new Commerce7CommerceAdapter({
      loadConnection: async () => connectionRow(),
      markProductSync: async () => {},
    });
    assert.equal(adapter.getCapabilities().products.publicDestinations, true);
  });
});
