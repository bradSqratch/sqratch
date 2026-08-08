import "./env-setup";

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";

import type {
  CuratedCampaignProduct,
  PublicExperienceProductsDeps,
  PublicExperienceProductsPostDeps,
} from "../src/app/api/public/experience/[experienceSlug]/products/route";

let getProducts: (
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
  overrides?: Partial<PublicExperienceProductsDeps>,
) => Promise<Response>;
let postProductClick: (
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
  overrides?: Partial<PublicExperienceProductsPostDeps>,
) => Promise<Response>;

before(async () => {
  const route =
    await import("../src/app/api/public/experience/[experienceSlug]/products/route");
  getProducts = route.publicExperienceProductsGetImpl;
  postProductClick = route.publicExperienceProductsPostImpl;
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
  return {
    id,
    name: id === "brand-1" ? "Acme" : "Other",
    slug: id === "brand-1" ? "acme" : "other",
    shopifyShopDomain: "acme.myshopify.com",
    shopifyConnectionStatus: "CONNECTED",
    shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
    shopifyUninstalledAt: null,
    shopifyLastProductSyncAt: null,
    shopifyGrantedScopes: "read_products",
    shopifyCurrencyCode: "USD",
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
    findProductLinks: async () => [],
    findBrands: async () => [brand()],
    countBrandSelections: async () => 1,
    findCuratedProducts: async () => [],
    findCampaignProducts: async () => [],
    fetchLegacyCampaignProducts: async () => ({
      ok: true as const,
      items: [
        {
          id: "legacy-1",
          shopifyProductGid: "legacy-1",
          title: "Legacy product",
          handle: "legacy-product",
          productUrl: "https://acme.test/products/legacy-product",
          images: [],
          imageUrl: null,
          priceRange: { min: 10, max: 10 },
          priceText: "$10.00",
          currency: "USD",
          variantIds: [],
          priceRangeRaw: { min: "10.00", max: "10.00" },
          descriptionText: null,
          status: "ACTIVE",
          providerCreatedAt: null,
          providerUpdatedAt: null,
          sku: null,
        },
      ],
      hasNextPage: false,
      limit: 100,
      endCursor: null,
    }),
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
  test("uses the legacy Shopify fallback when the brand has no selections", async () => {
    let legacyCalls = 0;
    const products = await productsFrom({
      countBrandSelections: async () => 0,
      fetchLegacyCampaignProducts: async (options) => {
        legacyCalls += 1;
        assert.equal(options.brandId, "brand-1");
        return deps().fetchLegacyCampaignProducts(options);
      },
    });

    assert.equal(legacyCalls, 1);
    assert.equal(products.length, 1);
    assert.equal(products[0].title, "Legacy product");
  });

  test("publishes only visible curated products and applies title and description overrides", async () => {
    const products = await productsFrom({
      findCuratedProducts: async () => [
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
      source: "CAMPAIGN",
    });
  });

  test("selection presence is authoritative, including an intentionally empty storefront", async () => {
    let legacyCalls = 0;
    const products = await productsFrom({
      findCuratedProducts: async () => [],
      fetchLegacyCampaignProducts: async (options) => {
        legacyCalls += 1;
        return deps().fetchLegacyCampaignProducts(options);
      },
    });

    assert.deepEqual(products, []);
    assert.equal(legacyCalls, 0);
  });

  test("does not surface unavailable or cross-brand curated products", async () => {
    const products = await productsFrom({
      findCuratedProducts: async () => [
        curated({
          connectedProduct: { id: "wrong-brand", brandId: "brand-2" },
        }),
        curated({
          connectedProduct: { id: "unavailable", isAvailable: false },
        }),
      ],
    });

    assert.deepEqual(products, []);
  });

  test("returns curated items in display order with deterministic title/id ties", async () => {
    const products = await productsFrom({
      findCuratedProducts: async () => [
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
      findCuratedProducts: async () => [unsafe],
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
      findCuratedProducts: async () => [historicalSelection],
    });

    assert.equal(products[0].imageUrl, "https://cdn.test/provider.jpg");
    assert.doesNotMatch(JSON.stringify(products), /historical\.example/);
  });

  test("preserves a null synchronized image for the client-side placeholder", async () => {
    const products = await productsFrom({
      findCuratedProducts: async () => [
        curated({ connectedProduct: { imageUrl: null } }),
      ],
    });

    assert.equal(products[0].imageUrl, null);
  });

  test("does not replace provider title or description with an empty override", async () => {
    const products = await productsFrom({
      findCuratedProducts: async () => [
        curated({ titleOverride: "   ", shortDescriptionOverride: "" }),
      ],
    });

    assert.equal(products[0].title, "Provider title");
    assert.equal(products[0].description, "Provider description");
  });

  test("current direct ExperienceProductLinks remain first while curation stays available", async () => {
    let selectionCountCalls = 0;
    const products = await productsFrom({
      findProductLinks: async () => [
        {
          id: "link-1",
          productUrl: "https://acme.test/products/direct",
          title: "Direct product",
          imageUrl: null,
          priceText: "$5.00",
          currency: "USD",
          brandId: "brand-1",
          sourceShopDomain: "acme.myshopify.com",
        },
      ],
      countBrandSelections: async () => {
        selectionCountCalls += 1;
        return 1;
      },
      findCuratedProducts: async () => [curated()],
    });

    assert.equal(selectionCountCalls, 1);
    assert.equal(products.length, 2);
    assert.equal(products[0].source, "LINKED");
    assert.equal(products[0].title, "Direct product");
    assert.equal(products[0].description, undefined);
    assert.equal(products[1].source, "CAMPAIGN");
  });

  test("records shop click analytics without accepting a client-supplied product URL", async () => {
    const received: {
      event: { name: string; data?: Record<string, unknown> } | null;
    } = {
      event: null,
    };
    const response = await postProductClick(
      request("POST", {
        productId: "gid://shopify/Product/1",
        productLinkId: null,
        productUrl: "https://attacker.example/not-a-validated-product",
      }),
      routeContext,
      {
        getAccess: async () => access(),
        ensureSession: async () => "new-session",
        findViewerSession: async () => ({
          qrCodeId: "qr-1",
          qrCode: { batchId: "batch-1" },
        }),
        createAnalyticsEvent: async (options) => {
          received.event = options;
        },
      },
    );

    assert.equal(response.status, 200);
    assert.equal(received.event?.name, "shop_click");
    assert.deepEqual(received.event?.data, {
      productId: "gid://shopify/Product/1",
      productLinkId: null,
      batchId: "batch-1",
    });
  });
});

test("Experience Shop renders the optional curated description", () => {
  const clientPath = path.join(
    process.cwd(),
    "src/components/experience/shop-client.tsx",
  );
  const source = fs.readFileSync(clientPath, "utf8");
  assert.match(source, /description\?: string \| null/);
  assert.match(source, /product\.description &&/);
  assert.match(source, /\{product\.description\}/);
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
