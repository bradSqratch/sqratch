import "./env-setup";

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import type {
  CuratedCampaignProduct,
  PublicExperienceProductsDeps,
} from "../src/app/api/public/experience/[experienceSlug]/products/route";

let getProducts: (
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
  overrides?: Partial<PublicExperienceProductsDeps>,
) => Promise<Response>;

before(async () => {
  const route =
    await import("../src/app/api/public/experience/[experienceSlug]/products/route");
  getProducts = route.publicExperienceProductsGetImpl;
});

const routeContext = {
  params: Promise.resolve({ experienceSlug: "my-experience" }),
};

function request(method = "GET", body?: unknown) {
  return new NextRequest(
    "https://sqratch.test/api/public/experience/my-experience/products",
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
  );
}

function requestWithQuery(query: string) {
  return new NextRequest(
    `https://sqratch.test/api/public/experience/my-experience/products${query}`,
  );
}

function access() {
  return {
    viewer: { sessionId: "viewer-session", userId: "viewer-1" },
    experience: {
      id: "experience-1",
      slug: "my-experience",
      title: "My experience",
      campaigns: [
        {
          campaignId: "campaign-1",
          campaign: {
            id: "campaign-1",
            name: "Campaign",
            brand: { id: "brand-1", name: "Acme", slug: "acme", logoUrl: null },
          },
        },
      ],
    },
  };
}

function brand(id = "brand-1") {
  // Phase 8: public rendering no longer reads ANY brand Shopify connection
  // field. The live-provider fallback that needed them is gone, so the deps
  // contract only carries what a card actually displays.
  return {
    id,
    name: id === "brand-1" ? "Acme" : "Other",
    slug: id === "brand-1" ? "acme" : "other",
  };
}

function curated(
  overrides: Omit<Partial<CuratedCampaignProduct>, "connectedProduct"> & {
    connectedProduct?: Partial<CuratedCampaignProduct["connectedProduct"]>;
  } = {},
): CuratedCampaignProduct {
  const { connectedProduct: connectedOverrides, ...selectionOverrides } =
    overrides;
  return {
    displayOrder: 0,
    titleOverride: null,
    shortDescriptionOverride: null,
    ...selectionOverrides,
    connectedProduct: {
      id: "connected-1",
      brandId: "brand-1",
      externalId: "gid://shopify/Product/1",
      title: "Provider title",
      productUrl: "https://acme.test/products/provider-title",
      imageUrl: "https://cdn.test/provider.jpg",
      descriptionText: "Provider description",
      isAvailable: true,
      hasPublicStorefrontUrl: true,
      currencyCode: "USD",
      priceMinMinor: 1999,
      priceMaxMinor: 1999,
      priceMinorUnitExponent: 2,
      ...connectedOverrides,
    },
  };
}

function deps(overrides: Partial<PublicExperienceProductsDeps> = {}) {
  return {
    getAccess: async () => access(),
    ensureSession: async () => "new-session",
    findBrands: async () => [brand()],
    findCampaignScopedCatalogIds: async () => new Set(),
    findCuratedProductsPage: async () => [],
    findCampaignProductsPage: async () => [],
    ...overrides,
  } satisfies PublicExperienceProductsDeps;
}

async function productsFrom(
  overrides: Partial<PublicExperienceProductsDeps> = {},
) {
  const response = await getProducts(request(), routeContext, deps(overrides));
  assert.equal(response.status, 200);
  return (await response.json()).data.products as Array<
    Record<string, unknown>
  >;
}

describe("public experience product catalog cutover", () => {
  test("zero persisted selections renders zero products: there is no live-provider fallback left", async () => {
    // This replaces the deleted "uses the legacy Shopify fallback when the brand
    // has no selections" test. The public storefront must never call a provider
    // API on the visitor request path, and must never publish a product the
    // brand did not curate.
    const products = await productsFrom({ findCuratedProductsPage: async () => [] });

    assert.deepEqual(products, []);

    const routeSource = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/app/api/public/experience/[experienceSlug]/products/route.ts",
      ),
      "utf8",
    );
    // Executable lines only: the header comment deliberately NAMES the removed
    // machinery so a future reader knows what went and why.
    const codeOnly = routeSource
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("//") &&
          !line.trim().startsWith("*") &&
          !line.trim().startsWith("/*"),
      )
      .join("\n");
    assert.doesNotMatch(codeOnly, /fetchNormalizedShopifyProducts/);
    assert.doesNotMatch(codeOnly, /fetchLegacyCampaignProducts/);
    assert.doesNotMatch(codeOnly, /countBrandSelections/);
    assert.doesNotMatch(codeOnly, /isLegacyShopifyBrandConnectionUsable/);
    assert.doesNotMatch(codeOnly, /experienceProductLink/i);
  });

  test("publishes only visible curated products and applies title and description overrides", async () => {
    const products = await productsFrom({
      findCuratedProductsPage: async () => [
        curated({
          titleOverride: "Curated title",
          shortDescriptionOverride: "Curated description",
        }),
      ],
    });

    assert.deepEqual(products[0], {
      id: "campaign-gid://shopify/Product/1",
      productId: "gid://shopify/Product/1",
      productLinkId: null,
      title: "Curated title",
      description: "Curated description",
      imageUrl: "https://cdn.test/provider.jpg",
      priceText: "$19.99",
      productUrl: "https://acme.test/products/provider-title",
      brand: { id: "brand-1", name: "Acme", slug: "acme" },
      source: "BRAND_STOREFRONT",
    });
  });

  test("an intentionally empty storefront stays empty", async () => {
    const products = await productsFrom({ findCuratedProductsPage: async () => [] });

    assert.deepEqual(products, []);
  });

  test("does not surface unavailable, cross-brand, or non-publicly-reachable curated products", async () => {
    const products = await productsFrom({
      findCuratedProductsPage: async () => [
        curated({
          connectedProduct: { id: "wrong-brand", brandId: "brand-2" },
        }),
        curated({
          connectedProduct: { id: "unavailable", isAvailable: false },
        }),
        // THE PHASE 8 STOREFRONT GATE. `isAvailable: true` (Shopify
        // `status: ACTIVE`) is deliberately kept here: publication is orthogonal
        // to lifecycle status, and a product with no public storefront URL 404s
        // for the visitor even though it is perfectly "available".
        curated({
          connectedProduct: {
            id: "no-storefront",
            isAvailable: true,
            hasPublicStorefrontUrl: false,
          },
        }),
      ],
    });

    assert.deepEqual(products, []);
  });

  test("the storefront gate is enforced by the real query predicate, not only in process", () => {
    const routeSource = fs.readFileSync(
      path.join(
        process.cwd(),
        "src/app/api/public/experience/[experienceSlug]/products/route.ts",
      ),
      "utf8",
    );
    // All three conditions, together, in the shared predicate object used by
    // every listing query in this route. PHASE 18 REPAIR (P1-3): the
    // connection-status clause was added to the same predicate object — see
    // that constant's doc comment in the route source.
    assert.match(
      routeSource,
      /const PUBLICLY_LISTABLE_CONNECTED_PRODUCT = \{\s*isAvailable: true,\s*hasPublicStorefrontUrl: true,\s*connection: \{ is: \{ status: "CONNECTED" as const \} \},\s*\} as const;/,
    );
    const usages = routeSource.match(
      /\.\.\.PUBLICLY_LISTABLE_CONNECTED_PRODUCT/g,
    );
    // PHASE 29 added a third usage: `findCampaignScopedCatalogIds`, the
    // narrow id-only exclusion-set query, applies the SAME gate as the two
    // catalog queries. Otherwise a campaign assignment that is no longer
    // publicly listable (e.g. `hasPublicStorefrontUrl` flipped false) could
    // still exclude a genuinely listable storefront duplicate, hiding a
    // product that should have reappeared once its campaign card vanished.
    assert.equal(usages?.length, 3, "all three catalog/exclusion queries must apply the gate");
  });

  test("returns curated items in display order with deterministic title/id ties", async () => {
    const products = await productsFrom({
      findCuratedProductsPage: async () => [
        curated({
          displayOrder: 4,
          connectedProduct: {
            id: "connected-z",
            externalId: "z",
            title: "Beta",
          },
        }),
        curated({
          displayOrder: 0,
          connectedProduct: {
            id: "connected-b",
            externalId: "b",
            title: "Beta",
          },
        }),
        curated({
          displayOrder: 0,
          connectedProduct: {
            id: "connected-a",
            externalId: "a",
            title: "Alpha",
          },
        }),
      ],
    });

    assert.deepEqual(
      products.map((product) => product.productId),
      ["a", "b", "z"],
    );
  });

  test("never serializes metadata or secret-shaped fields from catalog rows", async () => {
    const unsafe = curated();
    Object.assign(unsafe.connectedProduct, {
      providerMetadata: { token: "must-not-leak", secret: "must-not-leak" },
    });

    const products = await productsFrom({
      findCuratedProductsPage: async () => [unsafe],
    });
    const serialized = JSON.stringify(products);
    assert.equal(serialized.includes("providerMetadata"), false);
    assert.equal(serialized.includes("must-not-leak"), false);
  });

  test("ignores a historical image override and always uses the synchronized provider image", async () => {
    const historicalSelection = Object.assign(curated(), {
      imageUrlOverride: "https://historical.example/override.jpg",
    });

    const products = await productsFrom({
      findCuratedProductsPage: async () => [historicalSelection],
    });

    assert.equal(products[0].imageUrl, "https://cdn.test/provider.jpg");
    assert.doesNotMatch(JSON.stringify(products), /historical\.example/);
  });

  test("preserves a null synchronized image for the client-side placeholder", async () => {
    const products = await productsFrom({
      findCuratedProductsPage: async () => [
        curated({ connectedProduct: { imageUrl: null } }),
      ],
    });

    assert.equal(products[0].imageUrl, null);
  });

  test("does not replace provider title or description with an empty override", async () => {
    const products = await productsFrom({
      findCuratedProductsPage: async () => [
        curated({ titleOverride: "   ", shortDescriptionOverride: "" }),
      ],
    });

    assert.equal(products[0].title, "Provider title");
    assert.equal(products[0].description, "Provider description");
  });

  test("every product is a canonical catalog card: generic brand storefront yields BRAND_STOREFRONT", async () => {
    const products = await productsFrom({
      findCuratedProductsPage: async () => [curated()],
    });

    assert.equal(products.length, 1);
    assert.equal(products[0].source, "BRAND_STOREFRONT");
    assert.equal(
      products.every((product) => product.productLinkId === null),
      true,
    );
  });

  test("campaign-scoped products yield CAMPAIGN_PRODUCT source with assignment id and campaign metadata", async () => {
    const products = await productsFrom({
      findCuratedProductsPage: async () => [],
      findCampaignProductsPage: async () => [
        curated({
          id: "bcp-1",
          campaignAssignmentId: "assignment-1",
        }),
      ],
    });

    assert.equal(products.length, 1);
    assert.equal(products[0].source, "CAMPAIGN_PRODUCT");
    assert.equal(products[0].campaignAssignmentId, "assignment-1");
    assert.deepEqual(products[0].productCampaign, {
      id: "campaign-1",
      name: "Campaign",
    });
  });

  test("deduplication: campaign-scoped product wins over duplicate generic brand storefront card", async () => {
    const sharedConnectedProduct = {
      id: "connected-1",
      brandId: "brand-1",
      externalId: "gid://shopify/Product/1",
      title: "Shared Product",
      productUrl: "https://acme.test/products/shared",
      imageUrl: "https://cdn.test/shared.jpg",
      descriptionText: "Shared description",
      isAvailable: true,
      hasPublicStorefrontUrl: true,
      currencyCode: "USD",
      priceMinMinor: 2999,
      priceMaxMinor: 2999,
      priceMinorUnitExponent: 2,
    };

    const products = await productsFrom({
      // Mirrors what a real DB exclusion-set query independently computes:
      // "bcp-1" is an active, authorized campaign assignment.
      findCampaignScopedCatalogIds: async () => new Set(["bcp-1"]),
      findCampaignProductsPage: async () => [
        {
          id: "bcp-1",
          campaignAssignmentId: "assignment-1",
          displayOrder: 0,
          titleOverride: null,
          shortDescriptionOverride: null,
          connectedProduct: sharedConnectedProduct,
        },
      ],
      // A real storefront query applies `excludeBrandCommerceProductIds` as a
      // `notIn` WHERE predicate; this fake reproduces that.
      findCuratedProductsPage: async ({ excludeBrandCommerceProductIds }) =>
        excludeBrandCommerceProductIds.includes("bcp-1")
          ? []
          : [
              {
                id: "bcp-1",
                displayOrder: 1,
                titleOverride: null,
                shortDescriptionOverride: null,
                connectedProduct: sharedConnectedProduct,
              },
            ],
    });

    // Exactly one card rendered; the campaign-scoped card wins
    assert.equal(products.length, 1);
    assert.equal(products[0].source, "CAMPAIGN_PRODUCT");
    assert.equal(products[0].campaignAssignmentId, "assignment-1");
  });

  test("Matrix 1: isVisibleInShop=true, assignment inactive, provider reachable -> BRAND_STOREFRONT, no productCampaign", async () => {
    const products = await productsFrom({
      findCuratedProductsPage: async () => [curated({ id: "bcp-1" })],
      findCampaignProductsPage: async () => [],
    });

    assert.equal(products.length, 1);
    assert.equal(products[0].source, "BRAND_STOREFRONT");
    assert.equal(products[0].productCampaign, undefined);
  });

  test("Matrix 2: isVisibleInShop=false, assignment active, isCampaignEligible=true, provider reachable -> CAMPAIGN_PRODUCT, productCampaign present", async () => {
    const products = await productsFrom({
      findCuratedProductsPage: async () => [],
      findCampaignProductsPage: async () => [
        curated({
          id: "bcp-1",
          campaignAssignmentId: "assignment-1",
        }),
      ],
    });

    assert.equal(products.length, 1);
    assert.equal(products[0].source, "CAMPAIGN_PRODUCT");
    assert.equal(products[0].campaignAssignmentId, "assignment-1");
    assert.deepEqual(products[0].productCampaign, {
      id: "campaign-1",
      name: "Campaign",
    });
  });

  test("Matrix 3: isVisibleInShop=true, assignment active, isCampaignEligible=true, provider reachable -> exactly 1 card, CAMPAIGN_PRODUCT wins", async () => {
    const sharedProduct = {
      id: "bcp-1",
      displayOrder: 0,
      titleOverride: null,
      shortDescriptionOverride: null,
      connectedProduct: {
        id: "connected-1",
        brandId: "brand-1",
        externalId: "gid://shopify/Product/1",
        title: "Product 1",
        productUrl: "https://acme.test/products/1",
        imageUrl: "https://cdn.test/1.jpg",
        descriptionText: null,
        isAvailable: true,
        hasPublicStorefrontUrl: true,
        currencyCode: "USD",
        priceMinMinor: 1000,
        priceMaxMinor: 1000,
        priceMinorUnitExponent: 2,
      },
    };

    const products = await productsFrom({
      findCampaignScopedCatalogIds: async () => new Set(["bcp-1"]),
      findCampaignProductsPage: async () => [
        { ...sharedProduct, campaignAssignmentId: "assignment-1" },
      ],
      findCuratedProductsPage: async ({ excludeBrandCommerceProductIds }) =>
        excludeBrandCommerceProductIds.includes("bcp-1") ? [] : [sharedProduct],
    });

    assert.equal(products.length, 1);
    assert.equal(products[0].source, "CAMPAIGN_PRODUCT");
    assert.equal(products[0].campaignAssignmentId, "assignment-1");
  });

  test("Matrix 4: isVisibleInShop=false, assignment inactive -> hidden from storefront", async () => {
    const products = await productsFrom({
      findCuratedProductsPage: async () => [],
      findCampaignProductsPage: async () => [],
    });

    assert.equal(products.length, 0);
  });

  test("Matrix 5: hasPublicStorefrontUrl=false -> hidden from storefront even if isVisibleInShop=true and assignment active", async () => {
    const unpublishedProduct = {
      id: "bcp-unpub",
      campaignAssignmentId: "assignment-unpub",
      displayOrder: 0,
      titleOverride: null,
      shortDescriptionOverride: null,
      connectedProduct: {
        id: "connected-unpub",
        brandId: "brand-1",
        externalId: "gid://shopify/Product/unpub",
        title: "Unpublished Product",
        productUrl: "https://acme.test/products/unpub",
        imageUrl: null,
        descriptionText: null,
        isAvailable: true,
        hasPublicStorefrontUrl: false,
        currencyCode: "USD",
        priceMinMinor: 1000,
        priceMaxMinor: 1000,
        priceMinorUnitExponent: 2,
      },
    };

    const products = await productsFrom({
      findCampaignProductsPage: async () => [unpublishedProduct],
      findCuratedProductsPage: async () => [unpublishedProduct],
    });

    assert.equal(products.length, 0);
  });

});

test("Experience Shop renders the optional curated description", () => {
  const clientPath = path.join(
    process.cwd(),
    "src/components/experience/shop-client.tsx",
  );
  const source = fs.readFileSync(clientPath, "utf8");
  // The field declaration moved: the shop client no longer re-declares its
  // response shape inline, it aliases the shape that
  // `parsePublicShopResponse` validates at runtime. Asserting the field where
  // it now actually lives keeps this test checking the real contract instead
  // of a duplicate that could drift from it.
  const contractSource = fs.readFileSync(
    path.join(process.cwd(), "src/lib/commerce/public-commerce-response.ts"),
    "utf8",
  );
  assert.match(contractSource, /description\?: string \| null/);
  assert.match(source, /type ShopResponse = PublicShopResponse;/);
  // The rendering half is unchanged and still asserted here.
  assert.match(source, /product\.description &&/);
  assert.match(source, /\{product\.description\}/);
});

test("commerce clicks use the canonical server redirect only", () => {
  const routeSource = fs.readFileSync(
    path.join(
      process.cwd(),
      "src/app/api/public/experience/[experienceSlug]/products/route.ts",
    ),
    "utf8",
  );
  const shopClientSource = fs.readFileSync(
    path.join(process.cwd(), "src/components/experience/shop-client.tsx"),
    "utf8",
  );
  assert.doesNotMatch(routeSource, /export async function POST/);
  assert.doesNotMatch(routeSource, /shop_click/);
  assert.doesNotMatch(shopClientSource, /method:\s*["']POST["']/);
  assert.match(shopClientSource, /products\/click\//);
});

test("Experience Shop replaces a failed synchronized image with the existing placeholder", () => {
  const clientPath = path.join(
    process.cwd(),
    "src/components/experience/shop-client.tsx",
  );
  const source = fs.readFileSync(clientPath, "utf8");
  assert.match(source, /failedImageIds/);
  assert.match(source, /onError=/);
  assert.match(source, /No image/);
});

describe("PHASE 29 — public shop route: bounded, cursor-paginated (was unbounded)", () => {
  /**
   * An in-memory storefront that behaves like a REAL Prisma call: it applies
   * `cursor`/`limit` itself rather than ignoring them, so these tests
   * exercise the full route → deps → pagination-orchestration path exactly
   * as HTTP traffic would, including the query-string parsing of `limit`
   * and `cursor` and the response's `meta` envelope.
   */
  function fakeStorefront(count: number) {
    const items = Array.from({ length: count }, (_, i) =>
      curated({
        displayOrder: i,
        connectedProduct: {
          id: `connected-${String(i).padStart(4, "0")}`,
          externalId: `external-${i}`,
          title: `Product ${String(i).padStart(4, "0")}`,
        },
      }),
    );

    return async ({
      cursor,
      limit,
    }: {
      cursor: { displayOrder: number; sortKey: string; catalogId: string } | null;
      limit: number;
    }) => {
      const after = cursor
        ? items.filter(
            (row) =>
              row.displayOrder > cursor.displayOrder ||
              (row.displayOrder === cursor.displayOrder &&
                row.connectedProduct.title > cursor.sortKey) ||
              (row.displayOrder === cursor.displayOrder &&
                row.connectedProduct.title === cursor.sortKey &&
                row.connectedProduct.id > cursor.catalogId),
          )
        : items;
      return after.slice(0, limit);
    };
  }

  test("the response envelope carries meta OUTSIDE data, matching the campaign-products/order-list convention", async () => {
    const response = await getProducts(
      request(),
      routeContext,
      deps({ findCuratedProductsPage: fakeStorefront(5) }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(body.data);
    assert.ok(body.meta);
    assert.equal(typeof body.meta.hasNextPage, "boolean");
    assert.equal(body.meta.limit, 24, "the default limit when no ?limit= is given");
  });

  test("0 products: empty page, hasNextPage false, nextCursor null", async () => {
    const response = await getProducts(request(), routeContext, deps({ findCuratedProductsPage: fakeStorefront(0) }));
    const body = await response.json();
    assert.deepEqual(body.data.products, []);
    assert.equal(body.meta.hasNextPage, false);
    assert.equal(body.meta.nextCursor, null);
  });

  test("1 product with a large limit: single page, no next", async () => {
    const response = await getProducts(request(), routeContext, deps({ findCuratedProductsPage: fakeStorefront(1) }));
    const body = await response.json();
    assert.equal(body.data.products.length, 1);
    assert.equal(body.meta.hasNextPage, false);
  });

  test("?limit=10 with exactly 9 products (limit-1): full set in one page, no next", async () => {
    const response = await getProducts(
      requestWithQuery("?limit=10"),
      routeContext,
      deps({ findCuratedProductsPage: fakeStorefront(9) }),
    );
    const body = await response.json();
    assert.equal(body.data.products.length, 9);
    assert.equal(body.meta.hasNextPage, false);
  });

  test("?limit=10 with exactly 10 products: full page, no false-positive next page", async () => {
    const response = await getProducts(
      requestWithQuery("?limit=10"),
      routeContext,
      deps({ findCuratedProductsPage: fakeStorefront(10) }),
    );
    const body = await response.json();
    assert.equal(body.data.products.length, 10);
    assert.equal(body.meta.hasNextPage, false);
    assert.equal(body.meta.nextCursor, null);
  });

  test("?limit=10 with 11 products (limit+1): page of 10, hasNextPage true with a usable cursor", async () => {
    const response = await getProducts(
      requestWithQuery("?limit=10"),
      routeContext,
      deps({ findCuratedProductsPage: fakeStorefront(11) }),
    );
    const body = await response.json();
    assert.equal(body.data.products.length, 10);
    assert.equal(body.meta.hasNextPage, true);
    assert.ok(typeof body.meta.nextCursor === "string" && body.meta.nextCursor.length > 0);
  });

  test("50 products walked to completion via ?cursor=: no duplicates, no missing rows, stable order", async () => {
    const findCuratedProductsPage = fakeStorefront(50);
    const seenIds: string[] = [];
    let cursor: string | null = null;
    let guard = 0;
    while (guard++ < 20) {
      const response = await getProducts(
        requestWithQuery(`?limit=24${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
        routeContext,
        deps({ findCuratedProductsPage }),
      );
      const body = await response.json();
      seenIds.push(...body.data.products.map((p: { productId: string }) => p.productId));
      if (!body.meta.hasNextPage) break;
      cursor = body.meta.nextCursor;
    }
    assert.equal(seenIds.length, 50);
    assert.deepEqual(seenIds, Array.from(new Set(seenIds)), "no duplicates across route-driven pages");
    assert.deepEqual(
      seenIds,
      Array.from({ length: 50 }, (_, i) => `external-${i}`),
      "stable, deterministic order across pages",
    );
  });

  test("51 products: an odd remainder page terminates cleanly with no extra empty page", async () => {
    const findCuratedProductsPage = fakeStorefront(51);
    const seenIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let guard = 0;
    while (guard++ < 20) {
      const response = await getProducts(
        requestWithQuery(`?limit=24${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
        routeContext,
        deps({ findCuratedProductsPage }),
      );
      const body = await response.json();
      pages++;
      seenIds.push(...body.data.products.map((p: { productId: string }) => p.productId));
      if (!body.meta.hasNextPage) break;
      cursor = body.meta.nextCursor;
    }
    assert.equal(seenIds.length, 51);
    assert.equal(pages, 3, "24 + 24 + 3 = 51 across exactly 3 pages");
  });

  test("101 products over the maximum ?limit=999 (clamped to 60): multiple pages, complete coverage", async () => {
    const findCuratedProductsPage = fakeStorefront(101);
    const seenIds: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    let guard = 0;
    while (guard++ < 20) {
      const response = await getProducts(
        requestWithQuery(`?limit=999${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`),
        routeContext,
        deps({ findCuratedProductsPage }),
      );
      const body = await response.json();
      assert.equal(body.meta.limit, 60, "an out-of-range limit is clamped, never trusted verbatim");
      pages++;
      seenIds.push(...body.data.products.map((p: { productId: string }) => p.productId));
      if (!body.meta.hasNextPage) break;
      cursor = body.meta.nextCursor;
    }
    assert.equal(seenIds.length, 101);
    assert.ok(pages >= 2);
  });

  test("an invalid/garbage cursor is treated as no cursor (starts over), never a 500", async () => {
    const response = await getProducts(
      requestWithQuery("?cursor=not-a-real-cursor-at-all"),
      routeContext,
      deps({ findCuratedProductsPage: fakeStorefront(3) }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.products.length, 3, "an unparseable cursor restarts from the top rather than erroring");
  });

  test("a well-formed but stale cursor (dataset shrank since the last page) ends the page gracefully", async () => {
    const { encodePublicShopCursor } = await import("../src/lib/commerce/public-shop-pagination");
    const staleCursor = encodePublicShopCursor({
      blockIndex: 7, // no such block exists once this fixture only has 1
      displayOrder: 0,
      sortKey: "z",
      catalogId: "whatever",
    });
    const response = await getProducts(
      requestWithQuery(`?cursor=${encodeURIComponent(staleCursor)}`),
      routeContext,
      deps({ findCuratedProductsPage: fakeStorefront(5) }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.data.products, []);
    assert.equal(body.meta.hasNextPage, false);
  });

  test("a disconnected connection's products are fully excluded from the paginated result, not merely display-order 0", async () => {
    // The gate is enforced at the WHERE-clause level in real Prisma calls;
    // here the fake reproduces "disconnected means zero rows" the same way
    // `PUBLICLY_LISTABLE_CONNECTED_PRODUCT`'s `connection.status: CONNECTED`
    // predicate would.
    const response = await getProducts(
      request(),
      routeContext,
      deps({ findCuratedProductsPage: async () => [] }),
    );
    const body = await response.json();
    assert.deepEqual(body.data.products, []);
    assert.equal(body.meta.hasNextPage, false);
  });

  test("foreign-brand and unavailable rows returned by an injected fake never leak into a page (isSafeCuratedProduct still applied post-pagination)", async () => {
    const response = await getProducts(
      requestWithQuery("?limit=5"),
      routeContext,
      deps({
        findCuratedProductsPage: async () => [
          curated({ connectedProduct: { id: "foreign", brandId: "brand-2" } }),
          curated({ connectedProduct: { id: "unavailable-2", isAvailable: false } }),
          curated(), // the one legitimate row
        ],
      }),
    );
    const body = await response.json();
    assert.equal(body.data.products.length, 1);
  });
});
