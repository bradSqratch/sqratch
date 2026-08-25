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
    findCuratedProducts: async () => [],
    findCampaignProducts: async () => [],
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
    const products = await productsFrom({ findCuratedProducts: async () => [] });

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
      source: "BRAND_STOREFRONT",
    });
  });

  test("an intentionally empty storefront stays empty", async () => {
    const products = await productsFrom({ findCuratedProducts: async () => [] });

    assert.deepEqual(products, []);
  });

  test("does not surface unavailable, cross-brand, or non-publicly-reachable curated products", async () => {
    const products = await productsFrom({
      findCuratedProducts: async () => [
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
    assert.equal(usages?.length, 2, "both catalog queries must apply the gate");
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

  test("every product is a canonical catalog card: generic brand storefront yields BRAND_STOREFRONT", async () => {
    const products = await productsFrom({
      findCuratedProducts: async () => [curated()],
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
      findCuratedProducts: async () => [],
      findCampaignProducts: async () => [
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
      findCampaignProducts: async () => [
        {
          id: "bcp-1",
          campaignAssignmentId: "assignment-1",
          displayOrder: 0,
          titleOverride: null,
          shortDescriptionOverride: null,
          connectedProduct: sharedConnectedProduct,
        },
      ],
      findCuratedProducts: async () => [
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
      findCuratedProducts: async () => [curated({ id: "bcp-1" })],
      findCampaignProducts: async () => [],
    });

    assert.equal(products.length, 1);
    assert.equal(products[0].source, "BRAND_STOREFRONT");
    assert.equal(products[0].productCampaign, undefined);
  });

  test("Matrix 2: isVisibleInShop=false, assignment active, isCampaignEligible=true, provider reachable -> CAMPAIGN_PRODUCT, productCampaign present", async () => {
    const products = await productsFrom({
      findCuratedProducts: async () => [],
      findCampaignProducts: async () => [
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
      findCampaignProducts: async () => [
        { ...sharedProduct, campaignAssignmentId: "assignment-1" },
      ],
      findCuratedProducts: async () => [sharedProduct],
    });

    assert.equal(products.length, 1);
    assert.equal(products[0].source, "CAMPAIGN_PRODUCT");
    assert.equal(products[0].campaignAssignmentId, "assignment-1");
  });

  test("Matrix 4: isVisibleInShop=false, assignment inactive -> hidden from storefront", async () => {
    const products = await productsFrom({
      findCuratedProducts: async () => [],
      findCampaignProducts: async () => [],
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
      findCampaignProducts: async () => [unpublishedProduct],
      findCuratedProducts: async () => [unpublishedProduct],
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
  assert.match(source, /description\?: string \| null/);
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
