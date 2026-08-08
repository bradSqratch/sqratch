/**
 * tests/creator-lesson-product-routes-campaign-scoping.test.ts
 *
 * End-to-end coverage for the CANONICAL multi-campaign lesson product
 * attach/replace flow through the ACTUAL creator route implementations:
 *   src/app/api/creator/lessons/[lessonId]/products/route.ts (POST)
 *   src/app/api/creator/lessons/[lessonId]/products/[campaignLessonProductId]/route.ts
 *     (PATCH, DELETE)
 *
 * Unlike tests/campaign-product-curation.test.ts (which only injects
 * `getAccess`/`curationRepository` and exercises paths that return before any
 * Prisma write), these tests drive the routes all the way through their
 * `prisma.campaignLessonProduct` writes by mocking the shared `prisma`
 * singleton — the same pattern tests/shopify-reward-adapter-cutover.test.ts
 * uses for routes that are not fully dependency-injected. `$transaction` is
 * stubbed to just invoke its callback with the mocked client, so the same
 * mocked model methods observe both the outer call and any writes made "inside"
 * the transaction.
 *
 * `prisma.lessonProductLink` is deliberately stubbed to THROW on every method:
 * the canonical routes must never touch the legacy snapshot table again, and
 * any regression that reintroduces such a write fails here loudly.
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
import type { CreatorLessonProductPatchDeps } from "../src/app/api/creator/lessons/[lessonId]/products/[campaignLessonProductId]/route";
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
  context: { params: Promise<{ lessonId: string; campaignLessonProductId: string }> },
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
      findMany: stub(model, "findMany"),
      findUnique: stub(model, "findUnique"),
      create: stub(model, "create"),
      update: stub(model, "update"),
      updateMany: stub(model, "updateMany"),
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
    "../src/app/api/creator/lessons/[lessonId]/products/[campaignLessonProductId]/route"
  );
  lessonProductPatch = patchRoute.creatorLessonProductPatchImpl;
});

beforeEach(() => {
  // Always-fail defaults; each test wires only the calls it expects. The legacy
  // snapshot table stays failing in EVERY test on purpose.
  const fail = (model: string, method: string) => async () => {
    throw new Error(`Unmocked prisma.${model}.${method} in this test.`);
  };
  for (const method of ["findFirst", "findMany", "create", "update", "updateMany", "delete", "upsert"]) {
    prisma.lessonProductLink[method] = fail("lessonProductLink", method);
  }
  prisma.connectedCommerceProduct.findFirst = fail("connectedCommerceProduct", "findFirst");
  prisma.brandCommerceProduct.findFirst = fail("brandCommerceProduct", "findFirst");
  prisma.campaignLessonProduct.findFirst = async () => null;
  prisma.campaignLessonProduct.updateMany = async () => ({ count: 1 });
  prisma.campaignLessonProduct.upsert = async () => ({
    id: "clp-mock",
    lessonId: "lesson-1",
    displayOrder: 0,
    createdAt: new Date("2026-08-08T00:00:00Z"),
  });
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
        { id: "campaign-a", name: "Campaign A", brandId: "brand-a", brandName: "Brand A", sortOrder: 0 },
        { id: "campaign-b", name: "Campaign B", brandId: "brand-b", brandName: "Brand B", sortOrder: 1 },
      ],
      campaignContexts: [
        { campaignId: "campaign-a", campaignName: "Campaign A", brandId: "brand-a", brandName: "Brand A", sortOrder: 0 },
        { campaignId: "campaign-b", campaignName: "Campaign B", brandId: "brand-b", brandName: "Brand B", sortOrder: 1 },
      ],
    },
  };
}

function oneCuratedContextAccess(): { ok: true; data: LessonProductManagementContext } {
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
        { id: "campaign-a", name: "Campaign A", brandId: "brand-a", brandName: "Brand A", sortOrder: 0 },
      ],
      campaignContexts: [
        { campaignId: "campaign-a", campaignName: "Campaign A", brandId: "brand-a", brandName: "Brand A", sortOrder: 0 },
      ],
    },
  };
}

/** An Experience with no brand-owning campaign at all: never a commerce context. */
function brandlessAccess(): { ok: true; data: LessonProductManagementContext } {
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
      candidateBrands: [],
      campaigns: [
        { id: "campaign-brandless", name: "Brandless", brandId: null, brandName: null, sortOrder: 0 },
      ],
      campaignContexts: [],
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
    titleOverride: null,
    shortDescriptionOverride: null,
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
  test("sequential attaches under different campaignIds create two distinct CampaignLessonProduct rows and no snapshot rows", async () => {
    const productA = product({ id: "catalog-campaign-a-1", brandId: "brand-a", brandCommerceProductId: "bcp-a-1", productUrl: "https://brand-a.myshopify.com/products/a" });
    const productB = product({ id: "catalog-campaign-b-1", brandId: "brand-b", brandCommerceProductId: "bcp-b-1", productUrl: "https://brand-b.myshopify.com/products/b" });
    const repo = repoFor([productA, productB]);

    const scopeCalls: Array<{ campaignId: string; brandId: string; brandCommerceProductId: string }> = [];
    prisma.campaignLessonProduct.upsert = async (args: unknown) => {
      const create = (args as { create: { campaignId: string; brandId: string; brandCommerceProductId: string } }).create;
      scopeCalls.push({
        campaignId: create.campaignId,
        brandId: create.brandId,
        brandCommerceProductId: create.brandCommerceProductId,
      });
      return {
        id: `clp-${scopeCalls.length}`,
        lessonId: "lesson-1",
        displayOrder: 0,
        createdAt: new Date("2026-08-08T00:00:00Z"),
      };
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

    assert.equal(scopeCalls.length, 2);
    assert.deepEqual(scopeCalls.map((c) => c.campaignId), ["campaign-a", "campaign-b"]);
    assert.deepEqual(scopeCalls.map((c) => c.brandId), ["brand-a", "brand-b"]);
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
// Phase 8 replacement for the deleted legacy free-form attach coverage
// (previously "item 7: forged provider URL rejected" and
// parseLessonProductInput's allowedBrandIds enforcement).
//
// A creator can no longer supply a productUrl, title, price, brandId, provider
// GID or shop domain at all. These tests prove those fields cannot influence
// EITHER authorization or persisted data.
// ---------------------------------------------------------------------------

describe("creator attach: client-supplied product/brand fields are inert (Phase 8)", () => {
  test("a hostile productUrl/title/priceText/currency/brandId/shopDomain/GID payload is ignored; authorization uses only the resolved campaign's brand, and nothing client-supplied is persisted", async () => {
    const authorized = product({
      id: "catalog-1",
      brandId: "brand-a",
      brandCommerceProductId: "bcp-1",
      title: "Synced title",
      productUrl: "https://brand-a.myshopify.com/products/synced-title",
    });
    let lookupArgs: unknown = null;
    const repo: CampaignCurationRepository = {
      listAuthorizedProducts: async () => [],
      findAuthorizedProduct: async (input) => {
        lookupArgs = input;
        return input.catalogProductId === "catalog-1" && input.brandId === "brand-a"
          ? authorized
          : null;
      },
    };

    let writtenCreate: Record<string, unknown> | null = null;
    prisma.campaignLessonProduct.upsert = async (args: unknown) => {
      writtenCreate = (args as { create: Record<string, unknown> }).create;
      return {
        id: "clp-1",
        lessonId: "lesson-1",
        displayOrder: 0,
        createdAt: new Date("2026-08-08T00:00:00Z"),
      };
    };

    const response = await lessonProductsPost(
      postRequest({
        catalogProductId: "catalog-1",
        campaignId: "campaign-a",
        // Every one of these must be inert.
        productUrl: "https://competitor.example/products/steal-this",
        title: "Client title",
        imageUrl: "https://cdn.evil.example/img.jpg",
        priceText: "$0.01",
        currency: "XXX",
        brandId: "brand-b",
        sourceShopDomain: "competitor.myshopify.com",
        shopifyProductGid: "gid://shopify/Product/999",
      }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repo },
    );

    assert.equal(response.status, 201);

    // Authorization used the campaign's OWN brand, never the client's brandId.
    assert.deepEqual(lookupArgs, {
      campaignId: "campaign-a",
      brandId: "brand-a",
      catalogProductId: "catalog-1",
    });

    // The persisted row carries only server-derived identifiers.
    const create = writtenCreate as unknown as Record<string, unknown>;
    assert.equal(create.brandId, "brand-a");
    assert.equal(create.campaignId, "campaign-a");
    assert.equal(create.brandCommerceProductId, "bcp-1");
    assert.deepEqual(
      Object.keys(create).sort(),
      ["brandCommerceProductId", "brandId", "campaignId", "isActive", "lessonId"],
    );

    // The response echoes server-derived display data, not the client's.
    const body = await response.json();
    assert.equal(body.data.title, "Synced title");
    assert.equal(body.data.productUrl, "https://brand-a.myshopify.com/products/synced-title");
    assert.equal(body.data.priceText, "$12.00");
    assert.equal(body.data.currency, "USD");
    assert.equal(body.data.brandId, "brand-a");
    // No provider or internal catalog identifier is ever echoed back.
    assert.equal("brandCommerceProductId" in body.data, false);
    assert.equal("connectedProductId" in body.data, false);
    assert.equal("catalogProductId" in body.data, false);
    assert.equal("sourceShopDomain" in body.data, false);
  });

  test("a client-supplied brandId cannot claim another brand's campaign: the campaign's own brand is used and the cross-brand product resolves to nothing", async () => {
    const response = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-1", campaignId: "campaign-a", brandId: "brand-b" }),
      postContext,
      {
        getAccess: async () => twoCampaignAccess(),
        curationRepository: {
          listAuthorizedProducts: async () => [],
          findAuthorizedProduct: async ({ brandId }) =>
            brandId === "brand-b" ? product({ brandId: "brand-b" }) : null,
        },
      },
    );

    assert.equal(response.status, 404);
  });

  test("a request with no catalogProductId is rejected — there is no free-form attach to fall back to", async () => {
    const response = await lessonProductsPost(
      postRequest({ campaignId: "campaign-a", productUrl: "https://brand-a.myshopify.com/products/x", title: "T" }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repoFor([]) },
    );

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /catalogProductId is required/);
  });

  test("an Experience whose only campaign is brandless is never a commerce context", async () => {
    const response = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-1" }),
      postContext,
      { getAccess: async () => brandlessAccess(), curationRepository: repoFor([product()]) },
    );

    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /no sponsoring campaign/);
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

  test("an ambiguous Experience with no campaign chosen requires explicit selection rather than guessing", async () => {
    const response = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-1" }),
      postContext,
      { getAccess: async () => twoCampaignAccess(), curationRepository: repoFor([product()]) },
    );
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.match(body.error, /Select a campaign/);
    assert.deepEqual(body.campaigns.map((c: { id: string }) => c.id), ["campaign-a", "campaign-b"]);
  });
});

// ---------------------------------------------------------------------------
// Idempotent re-attach: the unique tuple reactivates rather than duplicating
// ---------------------------------------------------------------------------

describe("creator attach: reactivate-don't-duplicate", () => {
  test("re-attaching the same product under the same campaign upserts the same tuple with isActive/deactivatedAt reset", async () => {
    let upsertArgs: unknown = null;
    prisma.campaignLessonProduct.upsert = async (args: unknown) => {
      upsertArgs = args;
      return {
        id: "clp-existing",
        lessonId: "lesson-1",
        displayOrder: 0,
        createdAt: new Date("2026-08-08T00:00:00Z"),
      };
    };

    const response = await lessonProductsPost(
      postRequest({ catalogProductId: "catalog-1", campaignId: "campaign-a" }),
      postContext,
      { getAccess: async () => oneCuratedContextAccess(), curationRepository: repoFor([product()]) },
    );

    assert.equal(response.status, 201);
    const args = upsertArgs as {
      where: { campaignId_lessonId_brandCommerceProductId: Record<string, string> };
      update: { isActive: boolean; deactivatedAt: unknown };
    };
    assert.deepEqual(args.where.campaignId_lessonId_brandCommerceProductId, {
      campaignId: "campaign-a",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-1",
    });
    assert.equal(args.update.isActive, true);
    assert.equal(args.update.deactivatedAt, null);
    assert.equal((await response.json()).data.id, "clp-existing");
  });
});

// ---------------------------------------------------------------------------
// Item 13 / 17: DELETE still works and never re-checks product eligibility.
//
// The DELETE handler (unlike POST/PATCH) is not dependency-injected — it calls
// `getLessonProductManagementContext` directly, which calls next-auth's
// `getServerSession`, which calls `next/headers` `cookies()`. That throws
// "headers was called outside a request scope" when invoked outside a real
// Next.js request lifecycle (verified: it is NOT a Prisma-only dependency, so
// mocking the `prisma` singleton alone cannot make DELETE callable here). No
// test anywhere in this repo drives a route through a direct `getServerSession`
// call for this reason (see e.g. tests/points-activity-source-checks.test.ts,
// which uses source inspection for exactly this situation). This suite follows
// that established precedent: the deactivation BEHAVIOR is fully covered
// against a fake tx in tests/lesson-product-links-scoping.test.ts
// ("deactivateCampaignLessonProduct"), and the assertions below prove the
// DELETE route wires that behavior in, inside a transaction, and consults no
// eligibility state.
// ---------------------------------------------------------------------------

describe("creator DELETE wiring (items 13, 17 — source inspection)", () => {
  const deleteRouteSource = readFileSync(
    join(process.cwd(), "src/app/api/creator/lessons/[lessonId]/products/[campaignLessonProductId]/route.ts"),
    "utf8",
  );

  test("DELETE deactivates the CampaignLessonProduct inside a transaction and never deletes a row", () => {
    const deleteFunctionSource = deleteRouteSource.slice(
      deleteRouteSource.indexOf("export async function DELETE("),
    );
    assert.match(deleteFunctionSource, /prisma\.\$transaction\(async \(tx\) =>\s*\n?\s*deactivateCampaignLessonProduct\(tx, \{/);
    // The lesson scope travels with the id, so a foreign id fails closed.
    assert.match(deleteFunctionSource, /lessonId,\n\s*campaignLessonProductId,/);
    assert.equal(/\.delete\(/.test(deleteFunctionSource), false);
    assert.equal(/lessonProductLink/.test(deleteFunctionSource), false);
  });

  test("DELETE never queries product eligibility before removing an existing attachment (item 17)", () => {
    const deleteFunctionSource = deleteRouteSource.slice(
      deleteRouteSource.indexOf("export async function DELETE("),
    );
    assert.equal(/brandCommerceProduct\./.test(deleteFunctionSource), false);
    assert.equal(/connectedCommerceProduct\./.test(deleteFunctionSource), false);
    assert.equal(/isCampaignEligible/.test(deleteFunctionSource), false);
    assert.equal(/isAvailable/.test(deleteFunctionSource), false);
    assert.equal(/findAuthorizedProduct/.test(deleteFunctionSource), false);
  });

  test("the GET/list projection filters only on isActive, so an already-attached product stays visible after becoming ineligible (item 17)", () => {
    const curationSource = readFileSync(
      join(process.cwd(), "src/lib/commerce/campaign-product-curation.ts"),
      "utf8",
    );
    const select = curationSource.slice(
      curationSource.indexOf("export const CANONICAL_ATTACHMENT_SELECT"),
      curationSource.indexOf("export function projectCanonicalAttachment"),
    );
    assert.ok(select.length > 0);
    assert.equal(/isCampaignEligible/.test(select), false);
    assert.equal(/isAvailable/.test(select), false);
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

// ---------------------------------------------------------------------------
// PATCH: canonical replacement is campaign-scoped and lesson-scoped
// ---------------------------------------------------------------------------

describe("creator PATCH replacement is campaign-scoped too", () => {
  const patchContext = { params: Promise.resolve({ lessonId: "lesson-1", campaignLessonProductId: "clp-1" }) };

  function patchRequest(body: unknown) {
    return new NextRequest("https://sqratch.test/api/creator/lessons/lesson-1/products/clp-1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("a successful replacement upserts CampaignLessonProduct with the requesting campaign's id and retires the replaced row", async () => {
    const newProduct = product({ id: "catalog-campaign-a-2", brandId: "brand-a", brandCommerceProductId: "bcp-a-2" });
    const repo = repoFor([newProduct]);

    let scopeArgs: unknown = null;
    prisma.campaignLessonProduct.upsert = async (args: unknown) => {
      scopeArgs = args;
      return {
        id: "clp-2",
        lessonId: "lesson-1",
        displayOrder: 0,
        createdAt: new Date("2026-08-08T00:00:00Z"),
      };
    };
    let deactivateArgs: unknown = null;
    prisma.campaignLessonProduct.updateMany = async (args: unknown) => {
      deactivateArgs = args;
      return { count: 1 };
    };

    const response = await lessonProductPatch(
      patchRequest({ catalogProductId: "catalog-campaign-a-2", campaignId: "campaign-a" }),
      patchContext,
      { getAccess: async () => twoCampaignAccess(), findExisting: async () => true, curationRepository: repo },
    );

    assert.equal(response.status, 200);
    const args = scopeArgs as { create: { campaignId: string; brandCommerceProductId: string } };
    assert.equal(args.create.campaignId, "campaign-a");
    assert.equal(args.create.brandCommerceProductId, "bcp-a-2");

    const retired = deactivateArgs as { where: { id: string; lessonId: string } };
    assert.equal(retired.where.id, "clp-1");
    assert.equal(retired.where.lessonId, "lesson-1");
    assert.equal((await response.json()).data.id, "clp-2");
  });

  test("replacing a product with itself is a no-op: the reactivated row is the addressed row, so nothing is deactivated", async () => {
    prisma.campaignLessonProduct.upsert = async () => ({
      id: "clp-1",
      lessonId: "lesson-1",
      displayOrder: 0,
      createdAt: new Date("2026-08-08T00:00:00Z"),
    });
    let deactivateCalled = false;
    prisma.campaignLessonProduct.updateMany = async () => {
      deactivateCalled = true;
      return { count: 1 };
    };

    const response = await lessonProductPatch(
      patchRequest({ catalogProductId: "catalog-1", campaignId: "campaign-a" }),
      patchContext,
      {
        getAccess: async () => oneCuratedContextAccess(),
        findExisting: async () => true,
        curationRepository: repoFor([product()]),
      },
    );

    assert.equal(response.status, 200);
    assert.equal(deactivateCalled, false);
  });

  test("a foreign or nonexistent attachment id yields the same generic 404 and never reaches a write", async () => {
    let findExistingArgs: [string, string] | null = null;
    const response = await lessonProductPatch(
      patchRequest({ catalogProductId: "catalog-1", campaignId: "campaign-a" }),
      patchContext,
      {
        getAccess: async () => oneCuratedContextAccess(),
        findExisting: async (lessonId, id) => {
          findExistingArgs = [lessonId, id];
          return false;
        },
        curationRepository: repoFor([product()]),
      },
    );

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "Lesson product link not found.");
    assert.deepEqual(findExistingArgs, ["lesson-1", "clp-1"]);
  });

  test("a hostile PATCH payload cannot repoint the attachment at client-supplied data", async () => {
    let writtenCreate: Record<string, unknown> | null = null;
    prisma.campaignLessonProduct.upsert = async (args: unknown) => {
      writtenCreate = (args as { create: Record<string, unknown> }).create;
      return {
        id: "clp-1",
        lessonId: "lesson-1",
        displayOrder: 0,
        createdAt: new Date("2026-08-08T00:00:00Z"),
      };
    };

    const response = await lessonProductPatch(
      patchRequest({
        catalogProductId: "catalog-1",
        campaignId: "campaign-a",
        productUrl: "https://competitor.example/products/steal-this",
        title: "Client title",
        brandId: "brand-b",
      }),
      patchContext,
      {
        getAccess: async () => oneCuratedContextAccess(),
        findExisting: async () => true,
        curationRepository: repoFor([product()]),
      },
    );

    assert.equal(response.status, 200);
    const create = writtenCreate as unknown as Record<string, unknown>;
    assert.equal(create.brandId, "brand-a");
    const body = await response.json();
    assert.equal(body.data.title, "Synced title");
    assert.equal(body.data.productUrl, "https://brand-a.myshopify.com/products/synced-title");
  });
});
