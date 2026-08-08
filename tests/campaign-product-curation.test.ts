import "./env-setup";

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import {
  resolveCampaignCuration,
  toCreatorCatalogProduct,
  type AuthorizedCatalogProduct,
  type CampaignCurationRepository,
} from "../src/lib/commerce/campaign-product-curation";
import type { CreatorAvailableProductsDeps } from "../src/app/api/creator/lessons/[lessonId]/available-products/route";
import type { CreatorLessonProductMutationDeps } from "../src/app/api/creator/lessons/[lessonId]/products/route";
import type { CreatorLessonProductPatchDeps } from "../src/app/api/creator/lessons/[lessonId]/products/[productLinkId]/route";

let availableProductsGet: (
  request: Request,
  context: { params: Promise<{ lessonId: string }> },
  overrides?: Partial<CreatorAvailableProductsDeps>,
) => Promise<Response>;
let lessonProductsPost: (
  request: NextRequest,
  context: { params: Promise<{ lessonId: string }> },
  overrides?: Partial<CreatorLessonProductMutationDeps>,
) => Promise<Response>;
let lessonProductPatch: (
  request: NextRequest,
  context: { params: Promise<{ lessonId: string; productLinkId: string }> },
  overrides?: Partial<CreatorLessonProductPatchDeps>,
) => Promise<Response>;

before(async () => {
  availableProductsGet = (
    await import("../src/app/api/creator/lessons/[lessonId]/available-products/route")
  ).creatorAvailableProductsGetImpl;
  lessonProductsPost = (
    await import("../src/app/api/creator/lessons/[lessonId]/products/route")
  ).creatorLessonProductsPostImpl;
  lessonProductPatch = (
    await import("../src/app/api/creator/lessons/[lessonId]/products/[productLinkId]/route")
  ).creatorLessonProductPatchImpl;
});

const product: AuthorizedCatalogProduct = {
  id: "catalog-1",
  brandCommerceProductId: "bcp-1",
  brandId: "brand-1",
  title: "Synced title",
  handle: "synced-title",
  productUrl: "https://store.example/products/synced-title",
  imageUrl: "https://cdn.example/synced.jpg",
  images: ["https://cdn.example/synced.jpg"],
  sku: "SKU-1",
  currencyCode: "USD",
  priceMinMinor: 1200,
  priceMaxMinor: 1200,
  priceMinorUnitExponent: 2,
};

// Phase 5's LessonCampaignContext additionally requires `brandName` and
// `sortOrder` (see src/lib/commerce/campaign-product-curation.ts). `sortOrder`
// defaults to each campaign's index in the input array, which reproduces this
// suite's original "declaration order" expectations exactly, since
// buildEligibleCampaignContexts's secondary tiebreak (campaignId) never
// activates when sortOrder values are already distinct.
function campaign(input: {
  id: string;
  name: string;
  brandId: string | null;
  commerceProductCurationEnabled: boolean;
  sortOrder?: number;
}) {
  return {
    id: input.id,
    name: input.name,
    brandId: input.brandId,
    brandName: input.brandId ? "Brand one" : null,
    sortOrder: input.sortOrder ?? 0,
    commerceProductCurationEnabled: input.commerceProductCurationEnabled,
  };
}

function access(campaigns: Array<{
  id: string;
  name: string;
  brandId: string | null;
  commerceProductCurationEnabled: boolean;
  sortOrder?: number;
}>) {
  return {
    ok: true as const,
    data: {
      actor: { userId: "creator-1", role: "CREATOR" as const },
      lesson: {
        id: "lesson-1",
        title: "Lesson",
        course: {
          id: "course-1",
          title: "Course",
          experience: {
            id: "experience-1",
            title: "Experience",
            slug: "experience-1",
            creatorUserId: "creator-1",
          },
        },
      },
      candidateBrands: [{
        id: "brand-1", name: "Brand one", slug: "brand-one",
        shopifyShopDomain: "store.example", shopifyConnectionStatus: "CONNECTED",
        shopifyInstalledAt: new Date(), shopifyUninstalledAt: null,
        shopifyLastProductSyncAt: null, shopifyGrantedScopes: "read_products",
      }],
      campaigns: campaigns.map((c, index) => campaign({ ...c, sortOrder: c.sortOrder ?? index })),
      // campaignContexts is the pre-computed eligible/ordered list — Phase 5
      // callers (the routes under test) derive their own resolution from
      // `campaigns` via resolveCampaignCuration, so this field is populated
      // the same way getLessonProductManagementContext computes it, purely
      // for shape completeness; no test in this file asserts on it directly.
      campaignContexts: [],
    },
  } as Awaited<ReturnType<CreatorAvailableProductsDeps["getAccess"]>>;
}

function fakeRepository(rows: Array<AuthorizedCatalogProduct & { displayOrder: number }> = []): CampaignCurationRepository {
  return {
    listAuthorizedProducts: async () => rows,
    findAuthorizedProduct: async ({ catalogProductId }) =>
      rows.find((row) => row.id === catalogProductId) || null,
  };
}

const context = { params: Promise.resolve({ lessonId: "lesson-1" }) };

describe("campaign curation context", () => {
  test("legacy-only campaigns retain compatibility mode", () => {
    const result = resolveCampaignCuration([
      campaign({ id: "legacy", name: "Legacy", brandId: "brand-1", commerceProductCurationEnabled: false }),
    ], null);
    assert.equal(result.kind, "legacy");
    if (result.kind === "legacy") {
      assert.equal(result.campaign.campaignId, "legacy");
    }
  });

  test("infers exactly one curated campaign but never the first of several", () => {
    const one = resolveCampaignCuration([
      campaign({ id: "one", name: "One", brandId: "brand-1", commerceProductCurationEnabled: true }),
    ], null);
    assert.equal(one.kind, "curated");

    const many = resolveCampaignCuration([
      campaign({ id: "one", name: "One", brandId: "brand-1", commerceProductCurationEnabled: true }),
      campaign({ id: "two", name: "Two", brandId: "brand-2", commerceProductCurationEnabled: true }),
    ], null);
    assert.equal(many.kind, "selection_required");
    if (many.kind === "selection_required") assert.deepEqual(many.campaigns.map((x) => x.id), ["one", "two"]);
  });

  test("rejects a campaign that is not linked to the lesson experience", () => {
    assert.deepEqual(resolveCampaignCuration([
      campaign({ id: "one", name: "One", brandId: "brand-1", commerceProductCurationEnabled: true }),
    ], "foreign"), { kind: "invalid_campaign" });
  });

  // BEHAVIOR CHANGE FROM THE PRE-PHASE-5E VERSION OF THIS TEST (flagged per
  // instructions, not a silent fixture-only edit): this scenario used to
  // assert `invalid_campaign` under a since-removed "curation-status ratchet"
  // that made a curated sibling's presence on the Experience block selecting
  // an explicitly-requested, independently-eligible LEGACY sibling. Phase 5E
  // deliberately removed that ratchet (see the header comment on
  // `resolveCampaignCuration` in src/lib/commerce/campaign-product-curation.ts):
  // every eligible context is selectable on its own terms regardless of a
  // sibling's curation mode, because authorization is fully self-contained
  // per context (a legacy context still has to pass
  // `assertProductUrlMatchesBrandDomain`; a curated context still has to pass
  // the full CampaignCommerceProduct chain). Selecting the legacy sibling
  // grants no access to the curated sibling's catalog. The correct current
  // behavior is therefore `{ kind: "legacy" }`, not `invalid_campaign`.
  test("a disabled (legacy) sibling remains independently selectable next to an enabled (curated) campaign — no cross-context ratchet", () => {
    const result = resolveCampaignCuration([
      campaign({ id: "curated", name: "Curated", brandId: "brand-1", commerceProductCurationEnabled: true }),
      campaign({ id: "legacy", name: "Legacy sibling", brandId: "brand-1", commerceProductCurationEnabled: false }),
    ], "legacy");
    assert.equal(result.kind, "legacy");
    if (result.kind === "legacy") {
      assert.equal(result.campaign.campaignId, "legacy");
    }
  });
});

describe("creator available-products curated path", () => {
  test("returns only active authorized persisted catalog products and never calls Shopify", async () => {
    let legacyCalls = 0;
    const response = await availableProductsGet(
      new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/available-products"),
      context,
      {
        getAccess: async () => access([
          { id: "campaign-1", name: "Campaign", brandId: "brand-1", commerceProductCurationEnabled: true },
        ]),
        curationRepository: fakeRepository([{ ...product, displayOrder: 2 }]),
        fetchLegacyProducts: async () => { legacyCalls += 1; throw new Error("must not fetch provider"); },
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(legacyCalls, 0);
    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.items[0].catalogProductId, "catalog-1");
    assert.equal(body.data.items[0].title, "Synced title");
    assert.equal("providerMetadata" in body.data.items[0], false);
    assert.equal("encryptedPayload" in body.data.items[0], false);
  });

  test("zero valid assignments is an empty successful curated catalog, never legacy fallback", async () => {
    let legacyCalls = 0;
    const response = await availableProductsGet(
      new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/available-products"),
      context,
      {
        getAccess: async () => access([
          { id: "campaign-1", name: "Campaign", brandId: "brand-1", commerceProductCurationEnabled: true },
        ]),
        curationRepository: fakeRepository(),
        fetchLegacyProducts: async () => { legacyCalls += 1; throw new Error("must not fetch provider"); },
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.items, []);
    assert.equal(legacyCalls, 0);
  });

  test("multiple curated campaigns return an additive selector rather than leaking a catalog", async () => {
    const response = await availableProductsGet(
      new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/available-products"),
      context,
      {
        getAccess: async () => access([
          { id: "one", name: "One", brandId: "brand-1", commerceProductCurationEnabled: true },
          { id: "two", name: "Two", brandId: "brand-2", commerceProductCurationEnabled: true },
        ]),
        curationRepository: fakeRepository([{ ...product, displayOrder: 0 }]),
        fetchLegacyProducts: async () => { throw new Error("must not fetch provider"); },
      },
    );
    const body = await response.json();
    assert.deepEqual(body.data.items, []);
    assert.equal(body.data.curation.requiresCampaignSelection, true);
    assert.deepEqual(body.data.curation.campaigns.map((x: { id: string }) => x.id), ["one", "two"]);
  });
});

test("creator catalog serialization uses only synchronized safe fields", () => {
  const serialized = toCreatorCatalogProduct({
    ...product,
    // Extra properties model hostile/inappropriate data from a persistence
    // layer; the serializer must never spread it into a browser response.
    providerMetadata: { token: "secret" },
    titleOverride: "Public storefront title",
    shortDescriptionOverride: "Public storefront description",
  } as AuthorizedCatalogProduct);
  assert.equal(serialized.catalogProductId, "catalog-1");
  assert.equal(serialized.title, "Synced title");
  assert.equal(serialized.priceText, "$12.00");
  assert.equal("providerMetadata" in serialized, false);
  assert.equal("titleOverride" in serialized, false);
});

test("curated attachment fails closed for an unavailable, cross-brand, or unassigned catalog id", async () => {
  let lookup: unknown = null;
  const response = await lessonProductsPost(
    new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogProductId: "foreign-or-inactive", campaignId: "campaign-1" }),
    }),
    context,
    {
      getAccess: async () => access([
        { id: "campaign-1", name: "Campaign", brandId: "brand-1", commerceProductCurationEnabled: true },
      ]),
      curationRepository: {
        listAuthorizedProducts: async () => [],
        findAuthorizedProduct: async (input) => {
          lookup = input;
          // The fake represents every disqualifier identically. The route
          // must not distinguish cross-brand existence from unavailable or
          // inactive assignment status.
          return null;
        },
      },
    },
  );
  assert.equal(response.status, 404);
  assert.deepEqual(lookup, {
    campaignId: "campaign-1", brandId: "brand-1", catalogProductId: "foreign-or-inactive",
  });
  assert.equal((await response.json()).error, "Product is not available for this campaign.");
});

test("curated replacement is server-authorized too, not only POST attachments", async () => {
  const response = await lessonProductPatch(
    new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/products/link-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ catalogProductId: "inactive", campaignId: "campaign-1" }),
    }),
    { params: Promise.resolve({ lessonId: "lesson-1", productLinkId: "link-1" }) },
    {
      getAccess: async () => access([
        { id: "campaign-1", name: "Campaign", brandId: "brand-1", commerceProductCurationEnabled: true },
      ]),
      findExisting: async () => true,
      curationRepository: {
        listAuthorizedProducts: async () => [],
        findAuthorizedProduct: async () => null,
      },
    },
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error, "Product is not available for this campaign.");
});
