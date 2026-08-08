/**
 * tests/creator-lesson-product-routes-campaign-scoping.test.ts
 *
 * End-to-end coverage for the multi-campaign lesson product attach/replace
 * flow through the ACTUAL creator route implementations:
 *   src/app/api/creator/lessons/[lessonId]/products/route.ts (POST)
 *   src/app/api/creator/lessons/[lessonId]/products/[productLinkId]/route.ts
 *     (PATCH, DELETE)
 *
 * Unlike tests/campaign-product-curation.test.ts (which only injects
 * `getAccess`/`curationRepository` and exercises paths that return before any
 * Prisma write), these tests drive the routes all the way through their
 * `prisma.lessonProductLink` / `prisma.campaignLessonProduct` writes by
 * mocking the shared `prisma` singleton — the same pattern
 * tests/shopify-reward-adapter-cutover.test.ts uses for routes that are not
 * fully dependency-injected. `$transaction` is stubbed to just invoke its
 * callback with the mocked client, so the same mocked model methods observe
 * both the outer call and any writes made "inside" the transaction.
 *
 * No real DB connection or network call is made anywhere in this file.
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.NEXTAUTH_SECRET = "test-nextauth-secret";

import { before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import type {
  AuthorizedCatalogProduct,
  CampaignCurationRepository,
} from "../src/lib/commerce/campaign-product-curation";
import type { CreatorLessonProductMutationDeps } from "../src/app/api/creator/lessons/[lessonId]/products/route";
import type { CreatorLessonProductPatchDeps } from "../src/app/api/creator/lessons/[lessonId]/products/[productLinkId]/route";
import type { LessonProductManagementContext } from "../src/lib/lesson-product-links";

interface MockedPrismaClient {
  lessonProductLink: Record<string, (...args: unknown[]) => unknown>;
  connectedCommerceProduct: Record<string, (...args: unknown[]) => unknown>;
  brandCommerceProduct: Record<string, (...args: unknown[]) => unknown>;
  campaignLessonProduct: Record<string, (...args: unknown[]) => unknown>;
  $transaction: (...args: unknown[]) => unknown;
}

let prisma: MockedPrismaClient;
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
  const prismaModule = (await import("../src/lib/prisma")).default as unknown as Record<
    string,
    unknown
  >;

  const stub = (model: string, method: string) => async () => {
    throw new Error(`Unexpected call to prisma.${model}.${method} — mock it explicitly.`);
  };

  for (const model of ["lessonProductLink", "connectedCommerceProduct", "brandCommerceProduct", "campaignLessonProduct"]) {
    prismaModule[model] = {
      findFirst: stub(model, "findFirst"),
      findUnique: stub(model, "findUnique"),
      create: stub(model, "create"),
      update: stub(model, "update"),
      upsert: stub(model, "upsert"),
      delete: stub(model, "delete"),
    };
  }

  prismaModule.$transaction = (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => unknown)(prismaModule);
    }
    return Promise.resolve(null);
  };

  prisma = prismaModule as unknown as MockedPrismaClient;

  const postRoute = await import("../src/app/api/creator/lessons/[lessonId]/products/route");
  lessonProductsPost = postRoute.creatorLessonProductsPostImpl;
  const patchRoute = await import(
    "../src/app/api/creator/lessons/[lessonId]/products/[productLinkId]/route"
  );
  lessonProductPatch = patchRoute.creatorLessonProductPatchImpl;
});

beforeEach(() => {
  // Always-fail defaults; each test wires only the calls it expects.
  const fail = (model: string, method: string) => async () => {
    throw new Error(`Unmocked prisma.${model}.${method} in this test.`);
  };
  prisma.lessonProductLink.findFirst = fail("lessonProductLink", "findFirst");
  prisma.lessonProductLink.create = fail("lessonProductLink", "create");
  prisma.lessonProductLink.update = fail("lessonProductLink", "update");
  prisma.lessonProductLink.delete = fail("lessonProductLink", "delete");
  prisma.connectedCommerceProduct.findFirst = async () => null;
  prisma.brandCommerceProduct.findFirst = async () => null;
  prisma.campaignLessonProduct.findUnique = async () => null;
  prisma.campaignLessonProduct.upsert = async () => ({ id: "clp-mock" });
  prisma.campaignLessonProduct.update = async () => ({ id: "clp-mock" });
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function twoCampaignAccess(): { ok: true; data: LessonProductManagementContext } {
  const brandA = {
    id: "brand-a",
    name: "Brand A",
    slug: "brand-a",
    shopifyShopDomain: "brand-a.myshopify.com",
    shopifyConnectionStatus: "CONNECTED" as const,
    shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
    shopifyUninstalledAt: null,
    shopifyLastProductSyncAt: null,
    shopifyGrantedScopes: "read_products",
  };
  const brandB = {
    ...brandA,
    id: "brand-b",
    name: "Brand B",
    slug: "brand-b",
    shopifyShopDomain: "brand-b.myshopify.com",
  };

  return {
    ok: true,
    data: {
      actor: { userId: "creator-1", role: "CREATOR" },
      lesson: {
        id: "lesson-1",
        title: "Lesson",
        course: {
          id: "course-1",
          title: "Course",
          experience: { id: "experience-1", title: "Experience", slug: "experience-1", creatorUserId: "creator-1" },
        },
      },
      candidateBrands: [brandA, brandB],
      campaigns: [
        { id: "campaign-a", name: "Campaign A", brandId: "brand-a", brandName: "Brand A", sortOrder: 0, commerceProductCurationEnabled: true },
        { id: "campaign-b", name: "Campaign B", brandId: "brand-b", brandName: "Brand B", sortOrder: 1, commerceProductCurationEnabled: true },
      ],
      campaignContexts: [
        { campaignId: "campaign-a", campaignName: "Campaign A", brandId: "brand-a", brandName: "Brand A", curationEnabled: true, mode: "CURATED", sortOrder: 0 },
        { campaignId: "campaign-b", campaignName: "Campaign B", brandId: "brand-b", brandName: "Brand B", curationEnabled: true, mode: "CURATED", sortOrder: 1 },
      ],
    },
  };
}

function oneLegacyContextAccess(): { ok: true; data: LessonProductManagementContext } {
  const brand = {
    id: "brand-a",
    name: "Brand A",
    slug: "brand-a",
    shopifyShopDomain: "brand-a.myshopify.com",
    shopifyConnectionStatus: "CONNECTED" as const,
    shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
    shopifyUninstalledAt: null,
    shopifyLastProductSyncAt: null,
    shopifyGrantedScopes: "read_products",
  };
  return {
    ok: true,
    data: {
      actor: { userId: "creator-1", role: "CREATOR" },
      lesson: {
        id: "lesson-1",
        title: "Lesson",
        course: {
          id: "course-1",
          title: "Course",
          experience: { id: "experience-1", title: "Experience", slug: "experience-1", creatorUserId: "creator-1" },
        },
      },
      candidateBrands: [brand],
      campaigns: [
        { id: "campaign-legacy", name: "Legacy Campaign", brandId: "brand-a", brandName: "Brand A", sortOrder: 0, commerceProductCurationEnabled: false },
      ],
      campaignContexts: [
        { campaignId: "campaign-legacy", campaignName: "Legacy Campaign", brandId: "brand-a", brandName: "Brand A", curationEnabled: false, mode: "LEGACY", sortOrder: 0 },
      ],
    },
  };
}

function twoContextsOneCuratedOneLegacyAccess(): { ok: true; data: LessonProductManagementContext } {
  const brandA = {
    id: "brand-a",
    name: "Brand A",
    slug: "brand-a",
    shopifyShopDomain: "brand-a.myshopify.com",
    shopifyConnectionStatus: "CONNECTED" as const,
    shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
    shopifyUninstalledAt: null,
    shopifyLastProductSyncAt: null,
    shopifyGrantedScopes: "read_products",
  };
  const brandB = { ...brandA, id: "brand-b", name: "Brand B", slug: "brand-b", shopifyShopDomain: "brand-b.myshopify.com" };

  return {
    ok: true,
    data: {
      actor: { userId: "creator-1", role: "CREATOR" },
      lesson: {
        id: "lesson-1",
        title: "Lesson",
        course: {
          id: "course-1",
          title: "Course",
          experience: { id: "experience-1", title: "Experience", slug: "experience-1", creatorUserId: "creator-1" },
        },
      },
      candidateBrands: [brandA, brandB],
      campaigns: [
        { id: "campaign-curated", name: "Curated Campaign", brandId: "brand-a", brandName: "Brand A", sortOrder: 0, commerceProductCurationEnabled: true },
        { id: "campaign-legacy", name: "Legacy Campaign", brandId: "brand-b", brandName: "Brand B", sortOrder: 1, commerceProductCurationEnabled: false },
      ],
      campaignContexts: [
        { campaignId: "campaign-curated", campaignName: "Curated Campaign", brandId: "brand-a", brandName: "Brand A", curationEnabled: true, mode: "CURATED", sortOrder: 0 },
        { campaignId: "campaign-legacy", campaignName: "Legacy Campaign", brandId: "brand-b", brandName: "Brand B", curationEnabled: false, mode: "LEGACY", sortOrder: 1 },
      ],
    },
  };
}

function product(overrides: Partial<AuthorizedCatalogProduct> = {}): AuthorizedCatalogProduct {
  return {
    id: "catalog-1",
    brandCommerceProductId: "bcp-1",
    brandId: "brand-a",
    title: "Synced title",
    handle: "synced-title",
    productUrl: "https://brand-a.myshopify.com/products/synced-title",
    imageUrl: null,
    images: [],
    sku: null,
    currencyCode: "USD",
    priceMinMinor: 1200,
    priceMaxMinor: 1200,
    priceMinorUnitExponent: 2,
    ...overrides,
  };
}

function repoFor(products: AuthorizedCatalogProduct[]): CampaignCurationRepository {
  return {
    listAuthorizedProducts: async () => products.map((p) => ({ ...p, displayOrder: 0 })),
    findAuthorizedProduct: async ({ campaignId, brandId, catalogProductId }) =>
      products.find(
        (p) => p.id === catalogProductId && p.brandId === brandId && productBelongsToCampaign(p, campaignId),
      ) || null,
  };
}

// Fixture helper: in these tests, a product "belongs" to the campaign encoded
// in its id suffix (e.g. "catalog-a-1" belongs to "campaign-a"), modeling the
// real repository's campaignId-scoped WHERE clause (item 5).
function productBelongsToCampaign(p: AuthorizedCatalogProduct, campaignId: string) {
  return p.id.includes(campaignId) || !p.id.includes("campaign-");
}

const postContext = { params: Promise.resolve({ lessonId: "lesson-1" }) };
function postRequest(body: unknown) {
  return new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/products", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Item 4: attach Campaign A product and Campaign B product to the same lesson
// ---------------------------------------------------------------------------

describe("creator attach: two campaigns on the same lesson (item 4)", () => {
  test("sequential attaches under different campaignIds create two distinct LessonProductLink + CampaignLessonProduct rows", async () => {
    const productA = product({ id: "catalog-campaign-a-1", brandId: "brand-a", brandCommerceProductId: "bcp-a-1", productUrl: "https://brand-a.myshopify.com/products/a" });
    const productB = product({ id: "catalog-campaign-b-1", brandId: "brand-b", brandCommerceProductId: "bcp-b-1", productUrl: "https://brand-b.myshopify.com/products/b" });
    const repo = repoFor([productA, productB]);

    let createCalls = 0;
    prisma.lessonProductLink.findFirst = async () => null;
    prisma.lessonProductLink.create = async (args: unknown) => {
      createCalls += 1;
      const data = (args as { data: Record<string, unknown> }).data;
      return { id: `link-${createCalls}`, lessonId: "lesson-1", ...data, createdAt: new Date() };
    };
    const scopeCalls: Array<{ campaignId: string; brandCommerceProductId: string }> = [];
    prisma.campaignLessonProduct.upsert = async (args: unknown) => {
      const create = (args as { create: { campaignId: string; brandCommerceProductId: string } }).create;
      scopeCalls.push({ campaignId: create.campaignId, brandCommerceProductId: create.brandCommerceProductId });
      return { id: `clp-${scopeCalls.length}` };
    };

    const responseA = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-campaign-a-1", campaignId: "campaign-a" }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repo },
    );
    assert.equal(responseA.status, 201);

    const responseB = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-campaign-b-1", campaignId: "campaign-b" }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repo },
    );
    assert.equal(responseB.status, 201);

    assert.equal(createCalls, 2);
    assert.equal(scopeCalls.length, 2);
    assert.deepEqual(scopeCalls.map((c) => c.campaignId), ["campaign-a", "campaign-b"]);
    assert.notEqual(scopeCalls[0].brandCommerceProductId, scopeCalls[1].brandCommerceProductId);
  });
});

// ---------------------------------------------------------------------------
// Item 5: Campaign A cannot attach a Campaign-B-only product
// ---------------------------------------------------------------------------

describe("creator attach: campaign-scoped catalog isolation (item 5)", () => {
  test("a product assigned only to Campaign B is rejected when requested under Campaign A", async () => {
    const productB = product({ id: "catalog-campaign-b-1", brandId: "brand-b", brandCommerceProductId: "bcp-b-1" });
    const repo = repoFor([productB]);

    const response = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-campaign-b-1", campaignId: "campaign-a" }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repo },
    );

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Product is not available for this campaign.");
  });
});

// ---------------------------------------------------------------------------
// Item 6: cross-brand product ID rejected
// ---------------------------------------------------------------------------

describe("creator attach: cross-brand product id rejected (item 6)", () => {
  test("a catalogProductId whose brandId does not match the resolved campaign's brand is rejected", async () => {
    // Product genuinely belongs to brand-b, but campaign-a resolves to brand-a.
    let lookupArgs: unknown = null;
    const repo: CampaignCurationRepository = {
      listAuthorizedProducts: async () => [],
      findAuthorizedProduct: async (input) => {
        lookupArgs = input;
        // Mirrors defaultFindAuthorizedProduct's WHERE clause: brandId must
        // match, so a cross-brand id resolves to nothing.
        return null;
      },
    };

    const response = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-brand-b-product", campaignId: "campaign-a" }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repo },
    );

    assert.equal(response.status, 404);
    assert.deepEqual(lookupArgs, { campaignId: "campaign-a", brandId: "brand-a", catalogProductId: "catalog-brand-b-product" });
  });
});

// ---------------------------------------------------------------------------
// Item 7: forged provider URL rejected on legacy attach
// ---------------------------------------------------------------------------

describe("creator attach: legacy forged URL rejected (item 7)", () => {
  test("a legacy attach whose URL matches neither the brand domain nor its synced catalog is rejected with 400", async () => {
    prisma.connectedCommerceProduct.findFirst = async () => null;

    const response = await lessonProductsPost(
      postRequest({ productUrl: "https://competitor.example/products/steal-this", brandId: "brand-a" }),
      postContext,
      { getAccess: async () => oneLegacyContextAccess() },
    );

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /selected brand's store/);
  });

  test("a legacy attach whose URL matches the brand's own myshopify domain is accepted", async () => {
    prisma.connectedCommerceProduct.findFirst = async () => null;
    prisma.brandCommerceProduct.findFirst = async () => null; // no catalog match; fine with a single context
    prisma.lessonProductLink.findFirst = async () => null;
    prisma.lessonProductLink.create = async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      return { id: "link-legacy-1", lessonId: "lesson-1", ...data, createdAt: new Date() };
    };

    const response = await lessonProductsPost(
      postRequest({ productUrl: "https://brand-a.myshopify.com/products/genuine", brandId: "brand-a" }),
      postContext,
      { getAccess: async () => oneLegacyContextAccess() },
    );

    assert.equal(response.status, 201);
  });
});

// ---------------------------------------------------------------------------
// Item 8: forged campaign ID rejected, never a 500, never silent success
// ---------------------------------------------------------------------------

describe("creator attach: forged campaign id (item 8)", () => {
  test("an unrelated campaignId is rejected with a controlled 404, not a 500 or silent success", async () => {
    const response = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-1", campaignId: "campaign-does-not-exist" }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repoFor([]) },
    );
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Campaign is not available for this lesson.");
  });
});

// ---------------------------------------------------------------------------
// Item 10: legacy campaign retains compatibility even with a curated sibling
// ---------------------------------------------------------------------------

describe("creator attach: legacy sibling stays selectable next to a curated campaign (item 10)", () => {
  test("selecting the legacy context on a mixed Experience still accepts a client-supplied title/image, subject to the host-match gate", async () => {
    prisma.connectedCommerceProduct.findFirst = async () => ({ id: "ccp-owned" }); // proves catalog ownership for the domain gate
    // The Experience is ambiguous (2 eligible contexts), so mandatory scoping
    // applies: a catalog match is required to supply the CampaignLessonProduct
    // binding. Modeled by returning a match here (the URL IS in Brand B's
    // synced catalog), exactly as findBrandCommerceProductIdForProductUrl
    // would resolve it.
    prisma.brandCommerceProduct.findFirst = async () => ({ id: "bcp-legacy-match" });
    prisma.lessonProductLink.findFirst = async () => null;
    let createdData: Record<string, unknown> | null = null;
    prisma.lessonProductLink.create = async (args: unknown) => {
      createdData = (args as { data: Record<string, unknown> }).data;
      return { id: "link-legacy-mixed", lessonId: "lesson-1", ...createdData, createdAt: new Date() };
    };

    const response = await lessonProductsPost(
      postRequest({
        productUrl: "https://shop.brand-b-custom-domain.com/products/x",
        title: "Client title",
        imageUrl: "https://cdn.example/img.jpg",
        campaignId: "campaign-legacy",
        brandId: "brand-b",
      }),
      postContext,
      { getAccess: async () => twoContextsOneCuratedOneLegacyAccess() },
    );

    assert.equal(response.status, 201);
    assert.equal((createdData as unknown as { title: string }).title, "Client title");
  });
});

// ---------------------------------------------------------------------------
// Item 13: DELETE still works for pre-Phase-5 and Phase-5-scoped rows.
//
// The DELETE handler (unlike POST/PATCH) is not dependency-injected — it
// calls `getLessonProductManagementContext` directly, which calls next-auth's
// `getServerSession`, which calls `next/headers` `cookies()`. That throws
// "headers was called outside a request scope" when invoked outside a real
// Next.js request lifecycle (verified: it is NOT a Prisma-only dependency, so
// mocking the `prisma` singleton alone cannot make DELETE callable here).
// No test anywhere in this repo drives a route through a direct
// `getServerSession` call for this reason (see e.g.
// tests/points-activity-source-checks.test.ts, which uses source inspection
// for exactly this situation). This suite follows that established
// precedent: the transactional deactivate-on-delete BEHAVIOR is already
// fully covered against a fake tx in
// tests/lesson-product-links-scoping.test.ts ("detachCampaignLessonProductFromLink"),
// and the assertions below prove the DELETE route actually wires that
// behavior into its own transaction, in the correct order, exactly once.
// ---------------------------------------------------------------------------

describe("creator DELETE wiring (item 13, source inspection)", () => {
  const deleteRouteSource = readFileSync(
    join(process.cwd(), "src/app/api/creator/lessons/[lessonId]/products/[productLinkId]/route.ts"),
    "utf8",
  );

  test("DELETE calls detachCampaignLessonProductFromLink and lessonProductLink.delete inside the same $transaction", () => {
    const deleteFunctionSource = deleteRouteSource.slice(
      deleteRouteSource.indexOf("export async function DELETE("),
    );
    const transactionBlockMatch = deleteFunctionSource.match(
      /await prisma\.\$transaction\(async \(tx\) => \{([\s\S]*?)\n {4}\}\);/,
    );
    assert.ok(transactionBlockMatch, "DELETE must wrap its writes in prisma.$transaction");
    const block = transactionBlockMatch![1];
    assert.match(block, /detachCampaignLessonProductFromLink\(tx, \{/);
    assert.match(block, /tx\.lessonProductLink\.delete\(/);
    // Detach must run BEFORE delete so the scoping row is deactivated before
    // (or atomically with) the snapshot it points at disappears.
    const detachIndex = block.indexOf("detachCampaignLessonProductFromLink");
    const deleteIndex = block.indexOf("tx.lessonProductLink.delete");
    assert.ok(detachIndex >= 0 && deleteIndex >= 0 && detachIndex < deleteIndex);
  });

  test("DELETE never queries product eligibility (brandCommerceProduct/connectedCommerceProduct) before removing an existing link (item 17)", () => {
    const deleteFunctionMatch = deleteRouteSource.match(
      /export async function DELETE\(([\s\S]*?)\n\}\n/,
    );
    assert.ok(deleteFunctionMatch);
    const body = deleteFunctionMatch![1];
    assert.equal(/brandCommerceProduct\./.test(body), false);
    assert.equal(/connectedCommerceProduct\./.test(body), false);
    assert.equal(/isCampaignEligible/.test(body), false);
    assert.equal(/isAvailable/.test(body), false);
  });
});

// ---------------------------------------------------------------------------
// Item 9 / 15 / 16: zero-assignment / deactivated / ineligible product yields
// no new attachment (repository responsibility, exercised through the route)
// ---------------------------------------------------------------------------

describe("creator attach: fail-closed on unavailable products (items 9, 15, 16)", () => {
  test("a campaign with zero active assignments authorizes zero new products", async () => {
    const response = await lessonProductsPost(
      postRequest({ catalogProductId: "anything", campaignId: "campaign-a" }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repoFor([]) },
    );
    assert.equal(response.status, 404);
  });

  test("a deactivated CampaignCommerceProduct (repository returns null) blocks a new attach", async () => {
    const repo: CampaignCurationRepository = {
      listAuthorizedProducts: async () => [],
      findAuthorizedProduct: async () => null, // models isActive: false filtered out server-side
    };
    const response = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-1", campaignId: "campaign-a" }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repo },
    );
    assert.equal(response.status, 404);
  });

  test("an ineligible (isCampaignEligible: false) product blocks a new attach the same way", async () => {
    const repo: CampaignCurationRepository = {
      listAuthorizedProducts: async () => [],
      findAuthorizedProduct: async () => null, // models isCampaignEligible: false filtered out server-side
    };
    const response = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-1", campaignId: "campaign-a" }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repo },
    );
    assert.equal(response.status, 404);
  });
});

// Item 17 (an already-attached link survives ineligibility) is covered by the
// source-inspection assertion above ("DELETE never queries product
// eligibility...") plus the PATCH-side guarantee that an untouched existing
// row is never re-validated against current catalog state unless a
// replacement is explicitly requested (see
// tests/campaign-product-curation.test.ts's curated-replacement tests, which
// this file's own PATCH test below extends).

// ---------------------------------------------------------------------------
// PATCH: curated replacement also carries the authorizing campaign (item 14)
// and stays cross-brand-safe (item 6 analogue for replacement).
// ---------------------------------------------------------------------------

describe("creator PATCH replacement is campaign-scoped too", () => {
  const patchContext = { params: Promise.resolve({ lessonId: "lesson-1", productLinkId: "link-1" }) };

  test("a successful curated replacement upserts CampaignLessonProduct with the requesting campaign's id", async () => {
    const newProduct = product({ id: "catalog-campaign-a-2", brandId: "brand-a", brandCommerceProductId: "bcp-a-2" });
    const repo = repoFor([newProduct]);

    prisma.lessonProductLink.findFirst = async () => null; // no duplicate
    prisma.lessonProductLink.update = async (args: unknown) => {
      const data = (args as { data: Record<string, unknown> }).data;
      return { id: "link-1", lessonId: "lesson-1", ...data, createdAt: new Date() };
    };
    let scopeArgs: unknown = null;
    prisma.campaignLessonProduct.upsert = async (args: unknown) => {
      scopeArgs = args;
      return { id: "clp-1" };
    };

    const response = await lessonProductPatch(
      new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/products/link-1", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ catalogProductId: "catalog-campaign-a-2", campaignId: "campaign-a" }),
      }),
      patchContext,
      { getAccess: async () => twoCampaignAccess(), findExisting: async () => true, curationRepository: repo },
    );

    assert.equal(response.status, 200);
    const args = scopeArgs as { create: { campaignId: string; brandCommerceProductId: string } };
    assert.equal(args.create.campaignId, "campaign-a");
    assert.equal(args.create.brandCommerceProductId, "bcp-a-2");
  });
});
