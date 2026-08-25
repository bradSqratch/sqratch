/**
 * PHASE 16 BIG ROUND / SUBPHASE 1 — Commerce7 storefront configuration.
 * Battery items 1-15: validation (1-8), providerMetadata merge + invalidation
 * (9-12), and the PUT route's auth/ownership/status mapping (13-15).
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import {
  buildCommerce7ProductDestinationUrl,
  validateCommerce7CurrencyCode,
  validateCommerce7ProductRoute,
  validateCommerce7StorefrontUrl,
} from "../src/lib/commerce/providers/commerce7-connection-config";
import {
  configureCommerce7Storefront,
  type Commerce7ConfigTransactionClient,
  type Commerce7ConnectionConfigRow,
} from "../src/lib/commerce/providers/commerce7-storefront-configuration";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../src/lib/commerce/errors";
import { commerce7ConfigurationPutImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/configuration/route";
import type { BrandAdminContext } from "../src/lib/brand-auth";

// ---------------------------------------------------------------------------
// 1-4. Storefront URL validation
// ---------------------------------------------------------------------------

describe("1-4. validateCommerce7StorefrontUrl", () => {
  test("1. accepts a normalized public https origin", () => {
    const result = validateCommerce7StorefrontUrl("https://shop.example.com");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, "https://shop.example.com");
  });

  test("2. rejects http (non-https) schemes", () => {
    const result = validateCommerce7StorefrontUrl("http://shop.example.com");
    assert.equal(result.ok, false);
  });

  test("3. rejects loopback/private/link-local literals", () => {
    for (const raw of [
      "https://localhost",
      "https://127.0.0.1",
      "https://[::1]",
      "https://10.0.0.5",
      "https://172.16.0.5",
      "https://192.168.1.1",
      "https://169.254.1.1",
    ]) {
      const result = validateCommerce7StorefrontUrl(raw);
      assert.equal(result.ok, false, `expected ${raw} to be rejected`);
    }
  });

  test("4. rejects credentials, query strings, fragments, and non-root paths", () => {
    for (const raw of [
      "https://user:pass@shop.example.com",
      "https://shop.example.com?x=1",
      "https://shop.example.com#frag",
      "https://shop.example.com/some/path",
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
    ]) {
      const result = validateCommerce7StorefrontUrl(raw);
      assert.equal(result.ok, false, `expected ${raw} to be rejected`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5-6. Product route validation
// ---------------------------------------------------------------------------

describe("5-6. validateCommerce7ProductRoute", () => {
  test("5. accepts a plain relative route and normalizes a trailing slash", () => {
    const a = validateCommerce7ProductRoute("/product");
    assert.equal(a.ok, true);
    assert.equal(a.ok && a.value, "/product");

    const b = validateCommerce7ProductRoute("/shop/product/");
    assert.equal(b.ok, true);
    assert.equal(b.ok && b.value, "/shop/product");
  });

  test("6. rejects traversal, scheme/host injection, query/fragment, and non-leading-slash", () => {
    for (const raw of [
      "product",
      "/../etc",
      "/product/../../admin",
      "https://evil.com/product",
      "/product?x=1",
      "/product#frag",
      "/product<script>",
    ]) {
      const result = validateCommerce7ProductRoute(raw);
      assert.equal(result.ok, false, `expected ${raw} to be rejected`);
    }
  });
});

// ---------------------------------------------------------------------------
// 7-8. Currency validation
// ---------------------------------------------------------------------------

describe("7-8. validateCommerce7CurrencyCode", () => {
  test("7. normalizes lowercase to uppercase and accepts a real 3-letter code", () => {
    const result = validateCommerce7CurrencyCode("cad");
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.value, "CAD");
  });

  test("8. rejects non-3-letter or non-alphabetic input; never inferred/defaulted", () => {
    for (const raw of ["", "US", "USDD", "12D", "$$$"]) {
      const result = validateCommerce7CurrencyCode(raw);
      assert.equal(result.ok, false, `expected "${raw}" to be rejected`);
    }
  });
});

// ---------------------------------------------------------------------------
// 9-12. configureCommerce7Storefront — merge-preserving persistence + invalidation
// ---------------------------------------------------------------------------

function makeConnectionRow(
  overrides: Partial<Commerce7ConnectionConfigRow> = {},
): Commerce7ConnectionConfigRow {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    storefrontUrl: null,
    providerMetadata: null,
    ...overrides,
  };
}

type FakeProductRow = {
  id: string;
  connectionId: string;
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
  hasPublicStorefrontUrl: boolean;
};

/**
 * PHASE 18 REPAIR (P1-2): a fake transactional store with REAL rollback
 * semantics — every read/write inside `runInTransaction`'s callback goes
 * through a STAGED copy of the connection/product state; the staged copy
 * only replaces the real state if the callback resolves without throwing.
 * If it throws, the staged copy is discarded entirely and the original
 * error re-thrown — exactly what `prisma.$transaction` guarantees for the
 * real implementation, without needing a real database to prove it.
 */
class FakeConfigStore {
  connections = new Map<string, Commerce7ConnectionConfigRow>();
  products = new Map<string, FakeProductRow>();
  currencyInvalidatedFor: string[] = [];
  publicInvalidatedFor: string[] = [];
  /** Set to force one of the two invalidation calls to throw, simulating a mid-transaction write failure. */
  failInvalidation: "currency" | "public" | null = null;

  async runInTransaction<T>(
    fn: (client: Commerce7ConfigTransactionClient) => Promise<T>,
  ): Promise<T> {
    const stagedConnections = new Map(
      [...this.connections.entries()].map(([id, row]) => [
        id,
        {
          ...row,
          providerMetadata:
            row.providerMetadata && typeof row.providerMetadata === "object"
              ? { ...(row.providerMetadata as Record<string, unknown>) }
              : row.providerMetadata,
        },
      ]),
    );
    const stagedProducts = new Map(
      [...this.products.entries()].map(([id, row]) => [id, { ...row }]),
    );

    const client: Commerce7ConfigTransactionClient = {
      findConnection: async (id) => stagedConnections.get(id) ?? null,
      updateConnectionConfiguration: async (id, data) => {
        const existing = stagedConnections.get(id);
        if (!existing) return;
        stagedConnections.set(id, {
          ...existing,
          storefrontUrl: data.storefrontUrl,
          providerMetadata: data.providerMetadata,
        });
      },
      invalidateCurrencyDerivedProductData: async (id) => {
        this.currencyInvalidatedFor.push(id);
        if (this.failInvalidation === "currency") {
          throw new Error("simulated currency invalidation failure");
        }
        for (const product of stagedProducts.values()) {
          if (product.connectionId === id) {
            product.currencyCode = null;
            product.priceMinMinor = null;
            product.priceMaxMinor = null;
            product.priceMinorUnitExponent = null;
          }
        }
      },
      invalidatePublicDestinationDerivedProductData: async (id) => {
        this.publicInvalidatedFor.push(id);
        if (this.failInvalidation === "public") {
          throw new Error("simulated public-destination invalidation failure");
        }
        for (const product of stagedProducts.values()) {
          if (product.connectionId === id) {
            product.hasPublicStorefrontUrl = false;
          }
        }
      },
    };

    // COMMIT only on success; ROLLBACK (discard the staged copy entirely)
    // on any throw — the real connection/product maps are never touched
    // until the callback has fully succeeded.
    const result = await fn(client);
    this.connections = stagedConnections;
    this.products = stagedProducts;
    return result;
  }
}

function configureFor(
  store: FakeConfigStore,
  overrides: Partial<{
    brandId: string;
    connectionId: string;
    storefrontUrl: string;
    productRoute: string;
    currencyCode: string;
  }> = {},
) {
  return configureCommerce7Storefront(
    {
      brandId: "brand-a",
      connectionId: "conn-1",
      storefrontUrl: "https://shop.example.com",
      productRoute: "/product",
      currencyCode: "USD",
      ...overrides,
    },
    { runInTransaction: (fn) => store.runInTransaction(fn) },
  );
}

describe("9-12. configureCommerce7Storefront", () => {
  test("9. preserves unrelated providerMetadata keys on write (read-modify-write, never blind overwrite)", async () => {
    const store = new FakeConfigStore();
    store.connections.set(
      "conn-1",
      makeConnectionRow({
        providerMetadata: { authMode: "app-global", someOtherFact: "keep-me" },
      }),
    );

    const result = await configureFor(store, { currencyCode: "usd" });

    assert.equal(result.ok, true);
    const persisted = store.connections.get("conn-1")!;
    const metadata = persisted.providerMetadata as Record<string, unknown>;
    assert.equal(metadata.someOtherFact, "keep-me");
    assert.equal(metadata.authMode, "app-global");
    assert.equal(metadata.currencyCode, "USD");
    assert.equal(metadata.productRoute, "/product");
    assert.equal(persisted.storefrontUrl, "https://shop.example.com");
  });

  test("10. currency change invalidates ONLY currency/price fields on the exact connection", async () => {
    const store = new FakeConfigStore();
    store.connections.set(
      "conn-1",
      makeConnectionRow({
        storefrontUrl: "https://shop.example.com",
        providerMetadata: { currencyCode: "USD", productRoute: "/product" },
      }),
    );

    const result = await configureFor(store, { currencyCode: "CAD" });

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.requiresProductSync, true);
    assert.deepEqual(store.currencyInvalidatedFor, ["conn-1"]);
    assert.deepEqual(store.publicInvalidatedFor, []);
  });

  test("11. storefront/route change invalidates ONLY public-destination fields, not currency", async () => {
    const store = new FakeConfigStore();
    store.connections.set(
      "conn-1",
      makeConnectionRow({
        storefrontUrl: "https://old.example.com",
        providerMetadata: { currencyCode: "USD", productRoute: "/product" },
      }),
    );

    const result = await configureFor(store, { storefrontUrl: "https://new.example.com" });

    assert.equal(result.ok, true);
    assert.deepEqual(store.publicInvalidatedFor, ["conn-1"]);
    assert.deepEqual(store.currencyInvalidatedFor, []);
  });

  test("12. no-op save (identical values) invalidates nothing and reports requiresProductSync: false", async () => {
    const store = new FakeConfigStore();
    store.connections.set(
      "conn-1",
      makeConnectionRow({
        storefrontUrl: "https://shop.example.com",
        providerMetadata: { currencyCode: "USD", productRoute: "/product" },
      }),
    );

    const result = await configureFor(store);

    assert.equal(result.ok, true);
    assert.equal(result.ok && result.requiresProductSync, false);
    assert.deepEqual(store.currencyInvalidatedFor, []);
    assert.deepEqual(store.publicInvalidatedFor, []);
  });

  test("12b. a foreign-brand connectionId throws CommerceConnectionNotFoundError, indistinguishable from missing", async () => {
    const store = new FakeConfigStore();
    store.connections.set("conn-1", makeConnectionRow({ brandId: "brand-OTHER" }));
    await assert.rejects(() => configureFor(store), CommerceConnectionNotFoundError);
  });

  test("12c. a non-Commerce7 connection throws CommerceConnectionMismatchError", async () => {
    const store = new FakeConfigStore();
    store.connections.set("conn-1", makeConnectionRow({ provider: CommerceProvider.SHOPIFY }));
    await assert.rejects(() => configureFor(store), CommerceConnectionMismatchError);
  });

  test("12d. a non-CONNECTED Commerce7 connection throws CommerceConnectionNotReadyError", async () => {
    const store = new FakeConfigStore();
    store.connections.set("conn-1", makeConnectionRow({ status: "REQUIRES_RECONNECT" }));
    await assert.rejects(() => configureFor(store), CommerceConnectionNotReadyError);
  });

  test("12e. an invalid field is rejected before any write occurs (and before any transaction opens)", async () => {
    const store = new FakeConfigStore();
    store.connections.set("conn-1", makeConnectionRow());
    let transactionOpened = false;
    const originalRunInTransaction = store.runInTransaction.bind(store);
    store.runInTransaction = (fn) => {
      transactionOpened = true;
      return originalRunInTransaction(fn);
    };

    const result = await configureCommerce7Storefront(
      {
        brandId: "brand-a",
        connectionId: "conn-1",
        storefrontUrl: "http://not-https.example.com",
        productRoute: "/product",
        currencyCode: "USD",
      },
      { runInTransaction: (fn) => store.runInTransaction(fn) },
    );

    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.field, "storefrontUrl");
    assert.equal(transactionOpened, false, "a validation failure must never open a transaction");
  });

  // -------------------------------------------------------------------
  // PHASE 18 REPAIR — P1-2: the write and every invalidation must be
  // ATOMIC. A failure partway through must roll back the configuration
  // write too, and a retry must be safe/idempotent afterward.
  // -------------------------------------------------------------------

  test("P1-2a. a forced invalidation failure rolls back the configuration write too — nothing is left half-applied", async () => {
    const store = new FakeConfigStore();
    store.connections.set(
      "conn-1",
      makeConnectionRow({
        storefrontUrl: "https://old.example.com",
        providerMetadata: { currencyCode: "USD", productRoute: "/product" },
      }),
    );
    store.failInvalidation = "public";

    await assert.rejects(() =>
      configureFor(store, { storefrontUrl: "https://new.example.com" }),
    );

    // The connection row must be EXACTLY as it was before the attempt — the
    // configuration write itself must have rolled back, not merely the
    // invalidation that failed.
    const row = store.connections.get("conn-1")!;
    assert.equal(row.storefrontUrl, "https://old.example.com");
    assert.equal((row.providerMetadata as Record<string, unknown>).productRoute, "/product");
  });

  test("P1-2b. retry after a rolled-back failure succeeds and commits cleanly", async () => {
    const store = new FakeConfigStore();
    store.connections.set(
      "conn-1",
      makeConnectionRow({
        storefrontUrl: "https://old.example.com",
        providerMetadata: { currencyCode: "USD", productRoute: "/product" },
      }),
    );
    store.failInvalidation = "public";

    await assert.rejects(() =>
      configureFor(store, { storefrontUrl: "https://new.example.com" }),
    );

    store.failInvalidation = null;
    const result = await configureFor(store, { storefrontUrl: "https://new.example.com" });

    assert.equal(result.ok, true);
    const row = store.connections.get("conn-1")!;
    assert.equal(row.storefrontUrl, "https://new.example.com");
    // The invalidation call was ATTEMPTED on both the failed try and the
    // retry (once each) — the retry re-runs the whole transaction from
    // scratch, it does not "resume" a half-applied one.
    assert.deepEqual(store.publicInvalidatedFor, ["conn-1", "conn-1"]);
  });

  test("P1-2c. a currency-invalidation failure ALSO rolls back the whole transaction, including any public-destination invalidation already staged", async () => {
    const store = new FakeConfigStore();
    store.connections.set(
      "conn-1",
      makeConnectionRow({
        storefrontUrl: "https://old.example.com",
        providerMetadata: { currencyCode: "USD", productRoute: "/product" },
      }),
    );
    store.products.set("p1", {
      id: "p1",
      connectionId: "conn-1",
      currencyCode: "USD",
      priceMinMinor: 1000,
      priceMaxMinor: 1000,
      priceMinorUnitExponent: 2,
      hasPublicStorefrontUrl: true,
    });
    // Both currency AND storefront/route change in this one save, so BOTH
    // invalidations would fire — currency fails, so the whole thing (the
    // config write, and the public-destination invalidation that already
    // ran before the currency one failed) must roll back together.
    store.failInvalidation = "currency";

    await assert.rejects(() =>
      configureFor(store, { storefrontUrl: "https://new.example.com", currencyCode: "CAD" }),
    );

    const product = store.products.get("p1")!;
    assert.equal(product.currencyCode, "USD", "must remain untouched — the whole transaction rolled back");
    assert.equal(product.hasPublicStorefrontUrl, true, "must remain untouched too — same transaction");
  });

  test("P1-2d. an unchanged (no-op) config save is idempotent across repeated calls", async () => {
    const store = new FakeConfigStore();
    store.connections.set(
      "conn-1",
      makeConnectionRow({
        storefrontUrl: "https://shop.example.com",
        providerMetadata: { currencyCode: "USD", productRoute: "/product" },
      }),
    );

    const first = await configureFor(store);
    const second = await configureFor(store);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.ok && first.requiresProductSync, false);
    assert.equal(second.ok && second.requiresProductSync, false);
    assert.deepEqual(store.currencyInvalidatedFor, []);
    assert.deepEqual(store.publicInvalidatedFor, []);
  });

  test("P1-2e. Commerce7 connection X's invalidation never touches Commerce7 connection Z's product data", async () => {
    const store = new FakeConfigStore();
    store.connections.set(
      "conn-X",
      makeConnectionRow({
        id: "conn-X",
        storefrontUrl: "https://x.example.com",
        providerMetadata: { currencyCode: "USD", productRoute: "/product" },
      }),
    );
    store.products.set("p-x", {
      id: "p-x",
      connectionId: "conn-X",
      currencyCode: "USD",
      priceMinMinor: 1000,
      priceMaxMinor: 1000,
      priceMinorUnitExponent: 2,
      hasPublicStorefrontUrl: true,
    });
    store.products.set("p-z", {
      id: "p-z",
      connectionId: "conn-Z",
      currencyCode: "CAD",
      priceMinMinor: 2000,
      priceMaxMinor: 2000,
      priceMinorUnitExponent: 2,
      hasPublicStorefrontUrl: true,
    });

    const result = await configureCommerce7Storefront(
      {
        brandId: "brand-a",
        connectionId: "conn-X",
        storefrontUrl: "https://x.example.com",
        productRoute: "/product",
        currencyCode: "CAD",
      },
      { runInTransaction: (fn) => store.runInTransaction(fn) },
    );

    assert.equal(result.ok, true);
    assert.equal(store.products.get("p-x")!.currencyCode, null, "X's own product must be invalidated");
    assert.equal(store.products.get("p-z")!.currencyCode, "CAD", "Z (a different Commerce7 connection) must be untouched");
  });

  test("P1-2f. Commerce7 connection X's invalidation never touches a Shopify connection Y's product data", async () => {
    const store = new FakeConfigStore();
    store.connections.set(
      "conn-X",
      makeConnectionRow({
        id: "conn-X",
        storefrontUrl: "https://x.example.com",
        providerMetadata: { currencyCode: "USD", productRoute: "/product" },
      }),
    );
    store.products.set("p-x", {
      id: "p-x",
      connectionId: "conn-X",
      currencyCode: "USD",
      priceMinMinor: 1000,
      priceMaxMinor: 1000,
      priceMinorUnitExponent: 2,
      hasPublicStorefrontUrl: true,
    });
    store.products.set("p-y-shopify", {
      id: "p-y-shopify",
      connectionId: "conn-Y-shopify",
      currencyCode: "USD",
      priceMinMinor: 3000,
      priceMaxMinor: 3000,
      priceMinorUnitExponent: 2,
      hasPublicStorefrontUrl: true,
    });

    const result = await configureCommerce7Storefront(
      {
        brandId: "brand-a",
        connectionId: "conn-X",
        storefrontUrl: "https://new-x.example.com",
        productRoute: "/product",
        currencyCode: "USD",
      },
      { runInTransaction: (fn) => store.runInTransaction(fn) },
    );

    assert.equal(result.ok, true);
    assert.equal(
      store.products.get("p-y-shopify")!.hasPublicStorefrontUrl,
      true,
      "a Shopify connection's product must never be invalidated by a Commerce7 connection's own config save",
    );
  });
});

// ---------------------------------------------------------------------------
// 13-15. PUT route — auth / ownership / status mapping
// ---------------------------------------------------------------------------

function makeContext(): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [{ id: "brand-a", name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
    membership: {
      id: "member-1",
      role: "ADMIN",
      brand: {
        id: "brand-a",
        name: "Acme",
        slug: "acme",
        bio: null,
        websiteUrl: null,
        logoUrl: null,
        coverImageUrl: null,
      },
    },
  };
}

describe("13-15. commerce7ConfigurationPutImpl", () => {
  test("13. unauthenticated caller never reaches configure()", async () => {
    let called = false;
    const res = await commerce7ConfigurationPutImpl(
      {
        getContext: async () => null,
        configure: async () => {
          called = true;
          return {
            ok: true,
            storefrontUrl: "https://shop.example.com",
            productRoute: "/product",
            currencyCode: "USD",
            requiresProductSync: true,
          };
        },
      },
      "conn-1",
      { storefrontUrl: "https://shop.example.com", productRoute: "/product", currencyCode: "USD" },
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("14. a CommerceConnectionNotFoundError maps to 404 (foreign/missing indistinguishable)", async () => {
    const res = await commerce7ConfigurationPutImpl(
      {
        getContext: async () => makeContext(),
        configure: async () => {
          throw new CommerceConnectionNotFoundError("conn-1");
        },
      },
      "conn-1",
      { storefrontUrl: "https://shop.example.com", productRoute: "/product", currencyCode: "USD" },
    );
    assert.equal(res.status, 404);
  });

  test("15. a CommerceConnectionNotReadyError maps to 409, and missing body fields map to 400", async () => {
    const notReady = await commerce7ConfigurationPutImpl(
      {
        getContext: async () => makeContext(),
        configure: async () => {
          throw new CommerceConnectionNotReadyError("conn-1", CommerceProvider.COMMERCE7, "UNINSTALLED");
        },
      },
      "conn-1",
      { storefrontUrl: "https://shop.example.com", productRoute: "/product", currencyCode: "USD" },
    );
    assert.equal(notReady.status, 409);

    const missingBody = await commerce7ConfigurationPutImpl(
      { getContext: async () => makeContext() },
      "conn-1",
      { storefrontUrl: "https://shop.example.com" },
    );
    assert.equal(missingBody.status, 400);
  });
});

// ---------------------------------------------------------------------------
// Bonus: buildCommerce7ProductDestinationUrl origin-pinning (feeds Subphase 2)
// ---------------------------------------------------------------------------

describe("buildCommerce7ProductDestinationUrl", () => {
  test("builds a safe destination URL from canonical config + slug", () => {
    const url = buildCommerce7ProductDestinationUrl(
      "https://shop.example.com",
      "/product",
      "malbec-2021",
    );
    assert.equal(url, "https://shop.example.com/product/malbec-2021");
  });

  test("rejects a slug containing a slash (path-escape attempt)", () => {
    const url = buildCommerce7ProductDestinationUrl(
      "https://shop.example.com",
      "/product",
      "../../evil",
    );
    assert.equal(url, null);
  });

  test("never returns a URL whose origin differs from the configured storefront origin", () => {
    const url = buildCommerce7ProductDestinationUrl(
      "https://shop.example.com",
      "/product",
      "x@evil.com",
    );
    assert.ok(url === null || url.startsWith("https://shop.example.com/"));
  });

  // -------------------------------------------------------------------
  // PHASE 18 REPAIR — P2-4E: a bare "." or ".." slug is a real RFC 3986
  // dot-segment even though it contains no slash — `encodeURIComponent`
  // does not encode ".", so it survives into the URL parser, which
  // NORMALIZES it away along with the preceding route segment (verified:
  // `new URL("https://x/product/..")` -> `"https://x/"`).
  // -------------------------------------------------------------------
  test("25. rejects a slug that is exactly '.'", () => {
    const url = buildCommerce7ProductDestinationUrl("https://shop.example.com", "/product", ".");
    assert.equal(url, null);
  });

  test("26. rejects a slug that is exactly '..'", () => {
    const url = buildCommerce7ProductDestinationUrl("https://shop.example.com", "/product", "..");
    assert.equal(url, null);
  });

  test("26b. a slug merely CONTAINING dots (not equal to '.' or '..') is a perfectly ordinary segment", () => {
    const url = buildCommerce7ProductDestinationUrl(
      "https://shop.example.com",
      "/product",
      "2015-chardonnay.reserve",
    );
    assert.equal(url, "https://shop.example.com/product/2015-chardonnay.reserve");
  });

  test("27. the final pathname must still literally start with the configured route prefix (second, independent enforcement)", () => {
    // Any slug that produced a final path NOT under `/product/` must be
    // rejected, regardless of which specific character sequence caused it
    // — this is deliberately not an enumerated blocklist.
    for (const slug of [".", "..", "../../etc", "a/../.."]) {
      const url = buildCommerce7ProductDestinationUrl("https://shop.example.com", "/product", slug);
      if (url !== null) {
        assert.ok(new URL(url).pathname.startsWith("/product/"), `unsafe path for slug "${slug}": ${url}`);
      }
    }
  });

  test("27b. a percent-encoded traversal attempt in the slug never decodes to an actual path escape", () => {
    // encodeURIComponent turns the literal "%" into "%25", so a slug like
    // "%2e%2e" (percent-encoded "..") single-decodes back to the literal
    // text "%2e%2e" in the final path, never to an actual ".." segment.
    for (const slug of ["%2e%2e", "%2E%2E", "%2e%2e%2fevil"]) {
      const url = buildCommerce7ProductDestinationUrl("https://shop.example.com", "/product", slug);
      if (url !== null) {
        const parsed = new URL(url);
        assert.equal(parsed.origin, "https://shop.example.com");
        assert.ok(parsed.pathname.startsWith("/product/"));
      }
    }
  });
});
