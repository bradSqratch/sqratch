/**
 * tests/commerce7-product-catalog.test.ts
 *
 * PHASE 16C1 — Commerce7 read-only product catalog: API client, cursor
 * pagination, normalization, availability/security mapping, the fail-closed
 * storefront-URL rule, adapter identity boundaries, and registry wiring.
 *
 * Behavioral, not source-text: every test drives the real production functions
 * with an injected fetch/connection dep. No network, no database.
 */

process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.COMMERCE7_APP_ID = "test-app-id";
process.env.COMMERCE7_APP_SECRET = "test-app-secret";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import {
  fetchCommerce7ProductPage,
  fetchAllCommerce7Products,
  normalizeCommerce7Product,
  computeCommerce7Availability,
  minorUnitsToDecimalString,
  type Commerce7Fetch,
} from "../src/lib/commerce/providers/commerce7-products";
import {
  Commerce7CommerceAdapter,
  type Commerce7CommerceConnectionRow,
} from "../src/lib/commerce/providers/commerce7-commerce-adapter";
import { ShopifyCommerceAdapter } from "../src/lib/commerce/providers/shopify-commerce-adapter";
import { defaultCommerceAdapterRegistry } from "../src/lib/commerce/default-registry";
import { CommerceProviderApiError, CommerceConnectionNotFoundError } from "../src/lib/commerce/errors";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

type Call = { url: string; headers: Record<string, string> };

function makeFetch(
  pages: Array<{ ok?: boolean; status?: number; body: unknown }>,
): { impl: Commerce7Fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;
  const impl: Commerce7Fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const page = pages[Math.min(index, pages.length - 1)];
    index += 1;
    return {
      ok: page.ok ?? true,
      status: page.status ?? 200,
      json: async () => page.body,
    };
  };
  return { impl, calls };
}

function c7Product(overrides: Record<string, unknown> = {}) {
  return {
    id: "prod-1",
    title: "Sample - 2015 Chardonnay",
    slug: "2015-chardonnay",
    webStatus: "Available",
    adminStatus: "Available",
    security: { availableTo: "Public" },
    variants: [{ id: "var-1", sku: "2015C", price: 4200 }],
    ...overrides,
  };
}

function connectionRow(
  overrides: Partial<Commerce7CommerceConnectionRow> = {},
): Commerce7CommerceConnectionRow {
  return {
    id: "conn-c7",
    brandId: "brand-1",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    displayName: "sqratch-inc",
    externalAccountId: "sqratch-inc",
    storefrontUrl: null,
    isPrimary: true,
    grantedScopes: null,
    installedAt: new Date("2026-01-01"),
    uninstalledAt: null,
    lastProductSyncAt: null,
    providerMetadata: null,
    ...overrides,
  };
}

function makeAdapter(
  row: Commerce7CommerceConnectionRow | null,
  fetchImpl?: Commerce7Fetch,
) {
  const marked: Array<{ connectionId: string; syncedAt: Date }> = [];
  const adapter = new Commerce7CommerceAdapter({
    loadConnection: async (id) => (row && row.id === id ? row : null),
    markProductSync: async (connectionId, syncedAt) => {
      marked.push({ connectionId, syncedAt });
    },
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return { adapter, marked };
}

// ===========================================================================
describe("Commerce7 API authentication and tenant binding", () => {
  test("6/7. Basic auth is base64(appId:appSecret) and the tenant header is exact", async () => {
    const { impl, calls } = makeFetch([{ body: { products: [c7Product()] } }]);

    await fetchCommerce7ProductPage({ tenant: "sqratch-inc" }, { fetchImpl: impl });

    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].headers.Authorization,
      `Basic ${Buffer.from("test-app-id:test-app-secret", "utf8").toString("base64")}`,
    );
    assert.equal(calls[0].headers.tenant, "sqratch-inc");
    assert.equal(calls[0].headers.Accept, "application/json");
    assert.match(calls[0].url, /^https:\/\/api\.commerce7\.com\/v1\/product\?cursor=/);
  });

  test("3/5. a missing app credential fails closed BEFORE any provider I/O", async () => {
    const original = process.env.COMMERCE7_APP_SECRET;
    delete process.env.COMMERCE7_APP_SECRET;
    try {
      const { impl, calls } = makeFetch([{ body: { products: [] } }]);
      await assert.rejects(
        () => fetchCommerce7ProductPage({ tenant: "sqratch-inc" }, { fetchImpl: impl }),
        (error: unknown) => {
          assert.ok(error instanceof CommerceProviderApiError);
          // Never names which variable is missing, never echoes a secret.
          assert.doesNotMatch(error.message, /test-app-|SECRET|APP_ID/i);
          return true;
        },
      );
      assert.equal(calls.length, 0, "no request may be attempted without credentials");
    } finally {
      process.env.COMMERCE7_APP_SECRET = original;
    }
  });

  test("an invalid tenant fails closed before any provider I/O", async () => {
    const { impl, calls } = makeFetch([{ body: { products: [] } }]);
    for (const tenant of ["", "bad tenant", "../evil", "a\nb"]) {
      await assert.rejects(() =>
        fetchCommerce7ProductPage({ tenant }, { fetchImpl: impl }),
      );
    }
    assert.equal(calls.length, 0);
  });

  test("4. no CommerceConnectionSecret is involved anywhere in the catalog path", async () => {
    const { impl } = makeFetch([{ body: { products: [c7Product()] } }]);
    const { adapter } = makeAdapter(connectionRow(), impl);
    // A secretless connection syncs successfully — proving no secret is required.
    const result = await adapter.syncProducts("conn-c7");
    assert.equal(result.productCount, 1);
  });
});

// ===========================================================================
describe("cursor pagination", () => {
  test("A/8. a single complete page terminates immediately with cursor=start", async () => {
    const { impl, calls } = makeFetch([{ body: { products: [c7Product()] } }]);

    const products = await fetchAllCommerce7Products(
      { tenant: "sqratch-inc" },
      { fetchImpl: impl },
    );

    assert.equal(products.length, 1);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /cursor=start$/);
  });

  test("B/9/10. several pages follow the returned cursor and stop when it is absent", async () => {
    const { impl, calls } = makeFetch([
      { body: { products: [c7Product({ id: "p1" })], cursor: "c2" } },
      { body: { products: [c7Product({ id: "p2" })], cursor: "c3" } },
      { body: { products: [c7Product({ id: "p3" })] } },
    ]);

    const products = await fetchAllCommerce7Products(
      { tenant: "sqratch-inc" },
      { fetchImpl: impl },
    );

    assert.deepEqual(products.map((p) => p.externalId), ["p1", "p2", "p3"]);
    assert.equal(calls.length, 3);
    assert.match(calls[0].url, /cursor=start$/);
    assert.match(calls[1].url, /cursor=c2$/);
    assert.match(calls[2].url, /cursor=c3$/);
  });

  test("C/11. a repeated cursor fails instead of looping forever", async () => {
    const { impl } = makeFetch([
      { body: { products: [c7Product({ id: "p1" })], cursor: "loop" } },
      { body: { products: [c7Product({ id: "p2" })], cursor: "loop" } },
    ]);

    await assert.rejects(
      () => fetchAllCommerce7Products({ tenant: "sqratch-inc" }, { fetchImpl: impl }),
      (error: unknown) => {
        assert.ok(error instanceof CommerceProviderApiError);
        assert.match(error.message, /repeated catalog cursor/i);
        return true;
      },
    );
  });

  test("D/12. provider 401 produces a sanitized error carrying the upstream status", async () => {
    const { impl } = makeFetch([{ ok: false, status: 401, body: {} }]);
    await assert.rejects(
      () => fetchCommerce7ProductPage({ tenant: "sqratch-inc" }, { fetchImpl: impl }),
      (error: unknown) => {
        assert.ok(error instanceof CommerceProviderApiError);
        assert.equal(error.httpStatus, 401);
        assert.equal(error.provider, CommerceProvider.COMMERCE7);
        assert.doesNotMatch(error.message, /Basic |test-app-secret/);
        return true;
      },
    );
  });

  test("E/13. provider 500 produces a sanitized error", async () => {
    const { impl } = makeFetch([{ ok: false, status: 500, body: {} }]);
    await assert.rejects(
      () => fetchCommerce7ProductPage({ tenant: "sqratch-inc" }, { fetchImpl: impl }),
      (error: unknown) => {
        assert.ok(error instanceof CommerceProviderApiError);
        assert.equal(error.httpStatus, 500);
        return true;
      },
    );
  });

  test("F/14. malformed payloads fail safely", async () => {
    for (const body of [null, "not-an-object", { products: "nope" }, {}]) {
      const { impl } = makeFetch([{ body }]);
      await assert.rejects(() =>
        fetchCommerce7ProductPage({ tenant: "sqratch-inc" }, { fetchImpl: impl }),
      );
    }

    // A product with no usable id rejects the page rather than persisting a partial.
    const { impl } = makeFetch([{ body: { products: [{ title: "no id" }] } }]);
    await assert.rejects(() =>
      fetchCommerce7ProductPage({ tenant: "sqratch-inc" }, { fetchImpl: impl }),
    );
  });

  test("26. a failed LATER page aborts the whole catalog — never a partial success", async () => {
    const { impl } = makeFetch([
      { body: { products: [c7Product({ id: "p1" })], cursor: "c2" } },
      { ok: false, status: 500, body: {} },
    ]);

    await assert.rejects(
      () => fetchAllCommerce7Products({ tenant: "sqratch-inc" }, { fetchImpl: impl }),
      CommerceProviderApiError,
    );
  });
});

// ===========================================================================
describe("tenant isolation", () => {
  test("G/H/I. each connection uses only its own tenant; X cannot fetch Y", async () => {
    const { impl, calls } = makeFetch([{ body: { products: [c7Product()] } }]);

    const x = makeAdapter(
      connectionRow({ id: "conn-x", externalAccountId: "tenant-x" }),
      impl,
    );
    const y = makeAdapter(
      connectionRow({ id: "conn-y", externalAccountId: "tenant-y" }),
      impl,
    );

    await x.adapter.syncProducts("conn-x");
    await y.adapter.syncProducts("conn-y");

    assert.equal(calls[0].headers.tenant, "tenant-x");
    assert.equal(calls[1].headers.tenant, "tenant-y");

    // Connection X's adapter cannot resolve connection Y's id at all.
    await assert.rejects(
      () => x.adapter.syncProducts("conn-y"),
      CommerceConnectionNotFoundError,
    );
  });

  test("J/23. a Shopify connection id fails in the Commerce7 adapter BEFORE provider I/O", async () => {
    const { impl, calls } = makeFetch([{ body: { products: [] } }]);
    const shopifyRow = connectionRow({
      id: "conn-shopify",
      provider: CommerceProvider.SHOPIFY,
      externalAccountId: "store.myshopify.com",
    });
    const { adapter } = makeAdapter(shopifyRow, impl);

    await assert.rejects(
      () => adapter.syncProducts("conn-shopify"),
      CommerceConnectionNotFoundError,
    );
    assert.equal(calls.length, 0, "no Commerce7 request may be issued for a Shopify row");

    const result = await adapter.getConnection("conn-shopify");
    assert.deepEqual(result, { ok: false, reason: "NOT_FOUND" });
  });

  test("22. a Commerce7 connection cannot enter the Shopify adapter", async () => {
    const shopify = new ShopifyCommerceAdapter({
      loadConnection: async () =>
        ({
          ...connectionRow(),
          provider: CommerceProvider.COMMERCE7,
        }) as never,
    });

    const result = await shopify.getConnection("conn-c7");
    assert.deepEqual(result, { ok: false, reason: "NOT_FOUND" });
  });

  test("1. getConnection requires CONNECTED status", async () => {
    const { adapter } = makeAdapter(connectionRow({ status: "UNINSTALLED" }));
    assert.deepEqual(await adapter.getConnection("conn-c7"), {
      ok: false,
      reason: "NOT_CONNECTED",
    });
  });

  test("2. the tenant comes from externalAccountId, never from the caller", async () => {
    const { impl, calls } = makeFetch([{ body: { products: [] } }]);
    const { adapter } = makeAdapter(
      connectionRow({ externalAccountId: "real-tenant" }),
      impl,
    );

    // The only caller-supplied value is a connection id.
    await adapter.fetchProductPage("conn-c7", { cursor: null });
    assert.equal(calls[0].headers.tenant, "real-tenant");
  });
});

// ===========================================================================
describe("price and variant mapping", () => {
  test("16. cents convert to decimal strings with integer math only", () => {
    assert.equal(minorUnitsToDecimalString(4200), "42.00");
    assert.equal(minorUnitsToDecimalString(5), "0.05");
    assert.equal(minorUnitsToDecimalString(0), "0.00");
    assert.equal(minorUnitsToDecimalString(999999), "9999.99");
    // Values that a float divide would corrupt round-trip exactly.
    assert.equal(minorUnitsToDecimalString(1105), "11.05");
    assert.equal(minorUnitsToDecimalString(70), "0.70");
    assert.equal(minorUnitsToDecimalString(-250), "-2.50");
    assert.equal(minorUnitsToDecimalString(1.5), null);
  });

  test("15. a single variant produces an exact min=max range", () => {
    const product = normalizeCommerce7Product(c7Product())!;
    assert.deepEqual(product.priceRangeRaw, { min: "42.00", max: "42.00" });
    assert.deepEqual(product.externalVariantIds, ["var-1"]);
    assert.equal(product.sku, "2015C");
  });

  test("15. multiple variants with different prices produce a real range", () => {
    const product = normalizeCommerce7Product(
      c7Product({
        variants: [
          { id: "v1", sku: "A", price: 4200 },
          { id: "v2", sku: "B", price: 12500 },
          { id: "v3", sku: "C", price: 999 },
        ],
      }),
    )!;

    assert.deepEqual(product.priceRangeRaw, { min: "9.99", max: "125.00" });
    assert.deepEqual(product.externalVariantIds, ["v1", "v2", "v3"]);
    // Ambiguous product-level SKU is left null rather than picking one arbitrarily.
    assert.equal(product.sku, null);
  });

  test("comparePrice is never mistaken for the sell price", () => {
    const product = normalizeCommerce7Product(
      c7Product({
        variants: [{ id: "v1", price: 4200, comparePrice: 9900 }],
      }),
    )!;
    assert.deepEqual(product.priceRangeRaw, { min: "42.00", max: "42.00" });
  });

  test("a zero-price product is preserved as 0.00, not treated as missing", () => {
    const product = normalizeCommerce7Product(
      c7Product({ variants: [{ id: "v1", price: 0 }] }),
    )!;
    assert.deepEqual(product.priceRangeRaw, { min: "0.00", max: "0.00" });
  });

  test("a product with no variants yields a NULL price — never a fabricated zero", () => {
    for (const variants of [[], undefined, "nope"]) {
      const product = normalizeCommerce7Product(c7Product({ variants }))!;
      assert.deepEqual(product.priceRangeRaw, { min: null, max: null });
      assert.deepEqual(product.priceRange, { min: null, max: null });
      assert.deepEqual(product.externalVariantIds, []);
    }
  });

  test("a non-integer provider price is ignored rather than rounded", () => {
    const product = normalizeCommerce7Product(
      c7Product({ variants: [{ id: "v1", price: 42.5 }] }),
    )!;
    assert.deepEqual(product.priceRangeRaw, { min: null, max: null });
  });
});

// ===========================================================================
describe("availability and security mapping", () => {
  test("17. only webStatus + adminStatus Available yields the ACTIVE catalog token", () => {
    const available = computeCommerce7Availability({
      webStatus: "Available",
      adminStatus: "Available",
      security: { availableTo: "Public" },
    });
    assert.equal(available.isCatalogAvailable, true);
    assert.equal(available.statusToken, "ACTIVE");

    for (const [webStatus, adminStatus] of [
      ["Not Available", "Available"],
      ["Retired", "Available"],
      ["Available", "Not Available"],
      ["Available", "Hidden"],
      [undefined, "Available"],
      ["Available", undefined],
    ] as const) {
      const result = computeCommerce7Availability({
        webStatus,
        adminStatus,
        security: { availableTo: "Public" },
      });
      assert.equal(result.isCatalogAvailable, false, `${webStatus}/${adminStatus}`);
      assert.notEqual(
        result.statusToken,
        "ACTIVE",
        "a non-available product must never carry the ACTIVE token",
      );
    }
  });

  test("18. Public is public-eligible; Allocation/Group/Club are not", () => {
    for (const availableTo of ["Public"]) {
      const result = computeCommerce7Availability({
        webStatus: "Available",
        adminStatus: "Available",
        security: { availableTo },
      });
      assert.equal(result.isPublicEligible, true);
    }

    for (const availableTo of ["Allocation", "Group", "Club", "Unknown", undefined]) {
      const result = computeCommerce7Availability({
        webStatus: "Available",
        adminStatus: "Available",
        security: availableTo === undefined ? undefined : { availableTo },
      });
      assert.equal(
        result.isPublicEligible,
        false,
        `${String(availableTo)} must never be public-eligible`,
      );
      // Still a live catalog entry — access tier is not lifecycle.
      assert.equal(result.isCatalogAvailable, true);
    }
  });

  test("a webStatus != Available product can never be publicly eligible", () => {
    const result = computeCommerce7Availability({
      webStatus: "Retired",
      adminStatus: "Available",
      security: { availableTo: "Public" },
    });
    assert.equal(result.isPublicEligible, false);
    assert.equal(result.statusToken, "RETIRED");
  });
});

// ===========================================================================
describe("19. storefront URL — fail closed", () => {
  test("the exact sandbox product NEVER manufactures a v2-template URL", () => {
    const product = normalizeCommerce7Product(
      c7Product({ id: "prod-x", slug: "2015-chardonnay" }),
    )!;

    const serialized = JSON.stringify(product);
    assert.ok(
      !serialized.includes("sqratch-inc.v2-template.commerce7.com"),
      "must never synthesize the sandbox storefront host",
    );
    assert.ok(!serialized.includes("commerce7.com/product"), "no product path guessed");
    assert.ok(!/https?:\/\//.test(product.productUrl), "productUrl must not be a URL");

    assert.equal(product.productUrl, "", "canonical absence");
    assert.equal(product.hasProviderStorefrontPublication, false);
    assert.equal(product.hasProviderSuppliedStorefrontUrl, false);
    // The slug is still carried as neutral catalog data — it is simply never
    // combined with a host.
    assert.equal(product.handle, "2015-chardonnay");
  });

  test("no Commerce7 source file builds a URL from tenant + slug", async () => {
    const { readFileSync } = await import("node:fs");

    // Strip comments first: these files deliberately DISCUSS the sandbox
    // template host in prose to explain why it is never used, which a naive
    // substring scan would flag. Only executable code is inspected.
    const stripComments = (source: string) =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((line) => !line.trim().startsWith("//"))
        .join("\n");

    for (const file of [
      "src/lib/commerce/providers/commerce7-products.ts",
      "src/lib/commerce/providers/commerce7-commerce-adapter.ts",
    ]) {
      const code = stripComments(readFileSync(file, "utf8"));
      assert.doesNotMatch(code, /v2-template/, `${file} must not reference the template host`);
      assert.doesNotMatch(
        code,
        /commerce7\.com\/product/,
        `${file} must not build a storefront product path`,
      );
      assert.doesNotMatch(
        code,
        /https?:\/\/\$\{/,
        `${file} must never interpolate anything into a URL literal`,
      );
    }
  });
});

// ===========================================================================
describe("normalization contract", () => {
  test("core Commerce7 fields map onto the canonical neutral product", () => {
    const product = normalizeCommerce7Product(
      c7Product({
        id: "prod-9",
        title: "Sample - 2015 Chardonnay",
        teaser: "Crisp and bright.",
        content: "<p>Long form</p>",
        image: "https://images.example/primary.jpg",
        images: [{ url: "https://images.example/second.jpg" }],
        createdAt: "2026-01-02T03:04:05.000Z",
        updatedAt: "2026-02-03T04:05:06.000Z",
      }),
    )!;

    assert.equal(product.externalId, "prod-9");
    assert.equal(product.title, "Sample - 2015 Chardonnay");
    assert.equal(product.handle, "2015-chardonnay");
    assert.equal(product.imageUrl, "https://images.example/primary.jpg");
    assert.deepEqual(product.images, [
      "https://images.example/primary.jpg",
      "https://images.example/second.jpg",
    ]);
    // Prefers the short teaser over raw HTML content.
    assert.equal(product.descriptionText, "Crisp and bright.");
    assert.equal(product.status, "ACTIVE");
    assert.equal(product.providerCreatedAt?.toISOString(), "2026-01-02T03:04:05.000Z");
    assert.equal(product.providerUpdatedAt?.toISOString(), "2026-02-03T04:05:06.000Z");
    // Currency is resolved from the CONNECTION by the neutral layer, never guessed here.
    assert.equal(product.currency, "");
  });

  test("a product with no id normalizes to null", () => {
    assert.equal(normalizeCommerce7Product({ title: "x" }), null);
    assert.equal(normalizeCommerce7Product(null), null);
    assert.equal(normalizeCommerce7Product("nope"), null);
  });
});

// ===========================================================================
describe("20/21. adapter capabilities and registry wiring", () => {
  test("Commerce7 capabilities report catalog-only support", () => {
    const { adapter } = makeAdapter(connectionRow());
    const capabilities = adapter.getCapabilities();

    assert.equal(capabilities.products.sync, true);
    assert.equal(
      capabilities.products.publicDestinations,
      false,
      "no verified storefront destination exists in this phase",
    );
    for (const [name, value] of Object.entries(capabilities.rewards)) {
      assert.equal(value, false, `rewards.${name} must not be claimed`);
    }
  });

  test("the registry resolves each provider to its own adapter", () => {
    const shopify = defaultCommerceAdapterRegistry.get(CommerceProvider.SHOPIFY);
    const commerce7 = defaultCommerceAdapterRegistry.get(CommerceProvider.COMMERCE7);

    assert.ok(shopify instanceof ShopifyCommerceAdapter);
    assert.ok(commerce7 instanceof Commerce7CommerceAdapter);
    assert.equal(shopify.provider, CommerceProvider.SHOPIFY);
    assert.equal(commerce7.provider, CommerceProvider.COMMERCE7);
    assert.notEqual(shopify, commerce7);
  });

  test("21. Shopify capabilities are unchanged by this phase", () => {
    const shopify = defaultCommerceAdapterRegistry.get(CommerceProvider.SHOPIFY);
    assert.deepEqual(shopify.getCapabilities(), {
      products: { sync: true, publicDestinations: true },
      rewards: {
        create: true,
        lookup: true,
        usageLookup: true,
        revoke: false,
        fixedAmount: true,
        percentage: true,
        minimumSubtotal: true,
        productSpecific: true,
        singleUse: true,
      },
    });
  });

  test("the Commerce7 adapter exposes no reward methods at all", () => {
    const { adapter } = makeAdapter(connectionRow());
    const surface = adapter as unknown as Record<string, unknown>;
    for (const method of ["createDiscount", "getDiscount", "revokeDiscount"]) {
      assert.equal(surface[method], undefined, `${method} must not exist`);
    }
  });
});

// ===========================================================================
describe("adapter page contract", () => {
  test("fetchProductPage reports an opaque cursor and completion honestly", async () => {
    const { impl } = makeFetch([
      { body: { products: [c7Product({ id: "p1" })], cursor: "next-1" } },
    ]);
    const { adapter } = makeAdapter(connectionRow(), impl);

    const page = await adapter.fetchProductPage("conn-c7", { cursor: null });
    assert.equal(page.nextCursor, "next-1");
    assert.equal(page.isComplete, false);
    assert.equal(page.products.length, 1);

    const { impl: lastImpl } = makeFetch([
      { body: { products: [c7Product({ id: "p2" })] } },
    ]);
    const last = makeAdapter(connectionRow(), lastImpl);
    const finalPage = await last.adapter.fetchProductPage("conn-c7", {
      cursor: "next-1",
    });
    assert.equal(finalPage.nextCursor, null);
    assert.equal(
      finalPage.isComplete,
      true,
      "a complete page must report isComplete with a null cursor",
    );
  });

  test("24. repeated syncs are idempotent at the adapter boundary and stamp lastProductSyncAt", async () => {
    const { impl } = makeFetch([{ body: { products: [c7Product()] } }]);
    const { adapter, marked } = makeAdapter(connectionRow(), impl);

    const first = await adapter.syncProducts("conn-c7");
    const second = await adapter.syncProducts("conn-c7");

    assert.deepEqual(
      first.products.map((p) => p.externalId),
      second.products.map((p) => p.externalId),
      "the same catalog normalizes identically on resync",
    );
    assert.equal(marked.length, 2);
    assert.equal(marked[0].connectionId, "conn-c7");
  });
});
