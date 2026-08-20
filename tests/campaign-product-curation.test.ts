import "./env-setup";

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import {
  resolveCampaignCuration,
  toCreatorCatalogProduct,
  type AuthorizedCatalogProduct,
  type CampaignCurationRepository,
} from "../src/lib/commerce/campaign-product-curation";
import type { CreatorAvailableProductsDeps } from "../src/app/api/creator/lessons/[lessonId]/available-products/route";
import type { CreatorLessonProductMutationDeps } from "../src/app/api/creator/lessons/[lessonId]/products/route";
import type { CreatorLessonProductPatchDeps } from "../src/app/api/creator/lessons/[lessonId]/products/[campaignLessonProductId]/route";

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
  context: { params: Promise<{ lessonId: string; campaignLessonProductId: string }> },
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
    await import("../src/app/api/creator/lessons/[lessonId]/products/[campaignLessonProductId]/route")
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
  titleOverride: null,
  shortDescriptionOverride: null,
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
  sortOrder?: number;
}) {
  return {
    id: input.id,
    name: input.name,
    brandId: input.brandId,
    brandName: input.brandId ? "Brand one" : null,
    sortOrder: input.sortOrder ?? 0,
  };
}

function access(campaigns: Array<{
  id: string;
  name: string;
  brandId: string | null;
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
  // PHASE 8: there is no longer a curated/legacy mode distinction, and
  // `commerceProductCurationEnabled` is no longer part of `LessonCampaignContext`
  // at all — a brand-owned campaign resolves the same way regardless of that
  // historical (never-backfilled, DEFAULT false) flag. See the landmine-fix
  // test in tests/campaign-assignment-catalog-authorization.test.ts for the
  // authorization-layer half of this guarantee.
  test("a single eligible campaign resolves regardless of any historical curation state", () => {
    const result = resolveCampaignCuration([
      campaign({ id: "only", name: "Only", brandId: "brand-1" }),
    ], null);
    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") {
      assert.equal(result.campaign.campaignId, "only");
    }
  });

  test("infers exactly one eligible campaign but never the first of several", () => {
    const one = resolveCampaignCuration([
      campaign({ id: "one", name: "One", brandId: "brand-1" }),
    ], null);
    assert.equal(one.kind, "resolved");

    const many = resolveCampaignCuration([
      campaign({ id: "one", name: "One", brandId: "brand-1" }),
      campaign({ id: "two", name: "Two", brandId: "brand-2" }),
    ], null);
    assert.equal(many.kind, "selection_required");
    if (many.kind === "selection_required") assert.deepEqual(many.campaigns.map((x) => x.id), ["one", "two"]);
  });

  test("rejects a campaign that is not linked to the lesson experience", () => {
    assert.deepEqual(resolveCampaignCuration([
      campaign({ id: "one", name: "One", brandId: "brand-1" }),
    ], "foreign"), { kind: "invalid_campaign" });
  });

  test("every eligible sibling is independently selectable by explicit request — no cross-context ratchet", () => {
    const result = resolveCampaignCuration([
      campaign({ id: "campaign-a", name: "Campaign A", brandId: "brand-1" }),
      campaign({ id: "campaign-b", name: "Campaign B sibling", brandId: "brand-1" }),
    ], "campaign-b");
    assert.equal(result.kind, "resolved");
    if (result.kind === "resolved") {
      assert.equal(result.campaign.campaignId, "campaign-b");
    }
  });
});

describe("creator available-products curated path", () => {
  test("returns only active authorized persisted catalog products and never calls Shopify", async () => {
    const response = await availableProductsGet(
      new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/available-products"),
      context,
      {
        getAccess: async () => access([
          { id: "campaign-1", name: "Campaign", brandId: "brand-1" },
        ]),
        curationRepository: fakeRepository([{ ...product, displayOrder: 2 }]),
      },
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.items.length, 1);
    assert.equal(body.data.items[0].catalogProductId, "catalog-1");
    assert.equal(body.data.items[0].title, "Synced title");
    assert.equal("providerMetadata" in body.data.items[0], false);
    assert.equal("encryptedPayload" in body.data.items[0], false);
  });

  test("zero valid assignments is an empty successful curated catalog, never legacy fallback", async () => {
    const response = await availableProductsGet(
      new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/available-products"),
      context,
      {
        getAccess: async () => access([
          { id: "campaign-1", name: "Campaign", brandId: "brand-1" },
        ]),
        curationRepository: fakeRepository(),
      },
    );
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.items, []);
  });

  test("multiple curated campaigns return an additive selector rather than leaking a catalog", async () => {
    const response = await availableProductsGet(
      new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/available-products"),
      context,
      {
        getAccess: async () => access([
          { id: "one", name: "One", brandId: "brand-1" },
          { id: "two", name: "Two", brandId: "brand-2" },
        ]),
        curationRepository: fakeRepository([{ ...product, displayOrder: 0 }]),
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
        { id: "campaign-1", name: "Campaign", brandId: "brand-1" },
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
    { params: Promise.resolve({ lessonId: "lesson-1", campaignLessonProductId: "clp-1" }) },
    {
      getAccess: async () => access([
        { id: "campaign-1", name: "Campaign", brandId: "brand-1" },
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

// ---------------------------------------------------------------------------
// Phase 8: no creator surface may reach live Shopify at all.
// ---------------------------------------------------------------------------

test("the creator available-products route imports nothing from the live Shopify product client", () => {
  const source = readFileSync(
    join(process.cwd(), "src/app/api/creator/lessons/[lessonId]/available-products/route.ts"),
    "utf8",
  );
  // Import statements only — the module's own prose may legitimately mention
  // the client it deliberately does NOT import.
  const importLines = source
    .split("\n")
    .filter((line) => /^\s*import\b/.test(line) || /\bfrom\s+"/.test(line));
  assert.equal(importLines.some((line) => /shopify-products/.test(line)), false);
  assert.equal(/fetchNormalizedShopifyProducts\(/.test(source), false);
  assert.equal(/fetchLegacyProducts/.test(source), false);
});

// PHASE 8 LANDMINE FIX: `commerceProductCurationEnabled` is DEFAULT false and
// was never backfilled on existing campaigns. Before this change, the
// repository's WHERE clause required it true, so a campaign that never
// ticked the checkbox authorized ZERO products — a live fail-closed
// regression for most real campaigns. This test replaces the old assertion
// (which proved that broken behavior) with the fixed one: a brand-owned
// campaign's active, eligible assignments ARE returned, with no dependency on
// that historical flag at all (the fixture below doesn't even have the field
// any more — see `access()`/`campaign()` above).
test("a brand-owned campaign returns its active authorized catalog regardless of any historical curation flag", async () => {
  const response = await availableProductsGet(
    new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/available-products"),
    context,
    {
      getAccess: async () => access([
        { id: "campaign-1", name: "Campaign", brandId: "brand-1" },
      ]),
      curationRepository: fakeRepository([{ ...product, displayOrder: 0 }]),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.items.length, 1);
  assert.equal(body.data.items[0].catalogProductId, "catalog-1");
  assert.equal(body.data.curation.enabled, true);
  assert.equal(body.data.curation.requiresCampaignSelection, false);
});

test("an Experience with no brand-owning campaign returns a controlled empty picker", async () => {
  const response = await availableProductsGet(
    new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/available-products"),
    context,
    {
      getAccess: async () => access([
        { id: "brandless", name: "Brandless", brandId: null },
      ]),
      curationRepository: fakeRepository(),
    },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.brand, null);
  assert.deepEqual(body.data.items, []);
  assert.equal(body.data.connected, false);
});
