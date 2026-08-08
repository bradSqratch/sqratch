/**
 * tests/lesson-product-links-scoping.test.ts
 *
 * Coverage for the Phase 5 additions to src/lib/lesson-product-links.ts:
 *  - assertProductUrlMatchesBrandDomain (host-matching gate for legacy attach)
 *  - parseLessonProductInput's allowedBrandIds enforcement
 *  - upsertCampaignLessonProductScope / detachCampaignLessonProductFromLink
 *    (the CampaignLessonProduct lifecycle helpers)
 *  - findBrandCommerceProductIdForProductUrl
 *
 * The prisma calls these functions make are mocked by replacing methods on
 * the imported `prisma` singleton, the same dependency-injection idiom
 * tests/shopify-reward-adapter-cutover.test.ts and
 * tests/integration-coverage.test.ts use for modules that are not
 * fully DI'd. No real DB connection is made; DATABASE_URL is pinned to the
 * deliberately-unreachable blocked placeholder.
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.NEXTAUTH_SECRET = "test-nextauth-secret";

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

import {
  assertProductUrlMatchesBrandDomain,
  detachCampaignLessonProductFromLink,
  findBrandCommerceProductIdForProductUrl,
  parseLessonProductInput,
  productUrlMatchesShopDomain,
  resolveSourceShopDomainForBrand,
  upsertCampaignLessonProductScope,
  type CandidateBrand,
} from "../src/lib/lesson-product-links";

interface MockedPrismaClient {
  connectedCommerceProduct: Record<string, (...args: unknown[]) => unknown>;
  brandCommerceProduct: Record<string, (...args: unknown[]) => unknown>;
  campaignLessonProduct: Record<string, (...args: unknown[]) => unknown>;
}

let prisma: MockedPrismaClient;

before(async () => {
  const prismaModule = (await import("../src/lib/prisma")).default as unknown as Record<
    string,
    unknown
  >;

  const stub = (model: string, method: string) => async () => {
    throw new Error(`Unexpected call to prisma.${model}.${method} — mock it explicitly.`);
  };

  for (const model of ["connectedCommerceProduct", "brandCommerceProduct", "campaignLessonProduct"]) {
    prismaModule[model] = {
      findFirst: stub(model, "findFirst"),
      findUnique: stub(model, "findUnique"),
      upsert: stub(model, "upsert"),
      update: stub(model, "update"),
    };
  }

  prisma = prismaModule as unknown as MockedPrismaClient;
});

function brand(overrides: Partial<CandidateBrand> = {}): CandidateBrand {
  return {
    id: "brand-1",
    name: "Acme",
    slug: "acme",
    shopifyShopDomain: "acme-store.myshopify.com",
    shopifyConnectionStatus: "CONNECTED",
    shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
    shopifyUninstalledAt: null,
    shopifyLastProductSyncAt: null,
    shopifyGrantedScopes: "read_products",
    ...overrides,
  };
}

describe("resolveSourceShopDomainForBrand / productUrlMatchesShopDomain", () => {
  test("resolves and lowercases the brand's myshopify domain", () => {
    const domain = resolveSourceShopDomainForBrand([brand()], "brand-1");
    assert.equal(domain, "acme-store.myshopify.com");
  });

  test("null brandId resolves to null", () => {
    assert.equal(resolveSourceShopDomainForBrand([brand()], null), null);
  });

  test("a non-myshopify custom domain does not resolve as the source domain", () => {
    const domain = resolveSourceShopDomainForBrand(
      [brand({ shopifyShopDomain: "shop.acme.com" })],
      "brand-1",
    );
    assert.equal(domain, null);
  });

  test("hostname match is case-insensitive and strips a leading www.", () => {
    assert.equal(
      productUrlMatchesShopDomain(
        "https://WWW.Acme-Store.MyShopify.com/products/x",
        "acme-store.myshopify.com",
      ),
      true,
    );
  });
});

describe("assertProductUrlMatchesBrandDomain (item 7: forged provider URL rejected)", () => {
  test("brandId null is always allowed — nothing to impersonate", async () => {
    const result = await assertProductUrlMatchesBrandDomain({
      productUrl: "https://anywhere.example/products/x",
      brandId: null,
      candidateBrands: [],
    });
    assert.deepEqual(result, { ok: true });
  });

  test("URL hostname matching the brand's Shopify domain is accepted without a catalog lookup", async () => {
    let called = false;
    prisma.connectedCommerceProduct.findFirst = async () => {
      called = true;
      return null;
    };
    const result = await assertProductUrlMatchesBrandDomain({
      productUrl: "https://acme-store.myshopify.com/products/x",
      brandId: "brand-1",
      candidateBrands: [brand()],
    });
    assert.deepEqual(result, { ok: true });
    assert.equal(called, false);
  });

  test("a URL on the brand's own synced catalog is accepted even off-domain (custom storefront domain)", async () => {
    prisma.connectedCommerceProduct.findFirst = async (args: unknown) => {
      const where = (args as { where: { brandId: string; productUrl: string } }).where;
      assert.equal(where.brandId, "brand-1");
      assert.equal(where.productUrl, "https://shop.acme.com/products/x");
      return { id: "ccp-1" };
    };
    const result = await assertProductUrlMatchesBrandDomain({
      productUrl: "https://shop.acme.com/products/x",
      brandId: "brand-1",
      candidateBrands: [brand()],
    });
    assert.deepEqual(result, { ok: true });
  });

  test("a forged/competitor URL that matches neither the domain nor the synced catalog is rejected", async () => {
    prisma.connectedCommerceProduct.findFirst = async () => null;
    const result = await assertProductUrlMatchesBrandDomain({
      productUrl: "https://competitor.example/products/steal-this",
      brandId: "brand-1",
      candidateBrands: [brand()],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /selected brand's store/);
    }
  });

  test("a brand with no connected domain and no synced catalog match has nothing to verify against, so it is allowed (pre-existing behavior preserved)", async () => {
    prisma.connectedCommerceProduct.findFirst = async () => null;
    const result = await assertProductUrlMatchesBrandDomain({
      productUrl: "https://anywhere.example/products/x",
      brandId: "brand-1",
      candidateBrands: [brand({ shopifyShopDomain: null })],
    });
    assert.deepEqual(result, { ok: true });
  });
});

describe("parseLessonProductInput allowedBrandIds (empty list rejects, not disables)", () => {
  test("an empty allowedBrandIds list rejects a client-supplied brandId rather than accepting it", () => {
    const result = parseLessonProductInput(
      { productUrl: "https://acme-store.myshopify.com/products/x", brandId: "brand-1" },
      { allowedBrandIds: [] },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.error, /not available for this lesson/);
    }
  });

  test("a brandId within allowedBrandIds is accepted", () => {
    const result = parseLessonProductInput(
      { productUrl: "https://acme-store.myshopify.com/products/x", brandId: "brand-1" },
      { allowedBrandIds: ["brand-1", "brand-2"] },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.brandId, "brand-1");
    }
  });

  test("a brandId outside allowedBrandIds is rejected (cross-brand forgery attempt, item 6 legacy analogue)", () => {
    const result = parseLessonProductInput(
      { productUrl: "https://acme-store.myshopify.com/products/x", brandId: "brand-9-forged" },
      { allowedBrandIds: ["brand-1"] },
    );
    assert.equal(result.ok, false);
  });

  test("no client brandId falls back to defaultBrandId, not an implicit allow-all", () => {
    const result = parseLessonProductInput(
      { productUrl: "https://acme-store.myshopify.com/products/x" },
      { allowedBrandIds: [], defaultBrandId: "brand-default" },
    );
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.brandId, "brand-default");
    }
  });
});

describe("findBrandCommerceProductIdForProductUrl", () => {
  test("resolves the brand's own catalog row id for an exact URL match", async () => {
    prisma.brandCommerceProduct.findFirst = async (args: unknown) => {
      const where = (args as { where: { brandId: string; connectedProduct: { brandId: string; productUrl: string } } }).where;
      assert.equal(where.brandId, "brand-1");
      assert.equal(where.connectedProduct.brandId, "brand-1");
      assert.equal(where.connectedProduct.productUrl, "https://acme-store.myshopify.com/products/x");
      return { id: "bcp-1" };
    };
    const id = await findBrandCommerceProductIdForProductUrl({
      brandId: "brand-1",
      productUrl: "https://acme-store.myshopify.com/products/x",
    });
    assert.equal(id, "bcp-1");
  });

  test("returns null when the brand has not synced that product", async () => {
    prisma.brandCommerceProduct.findFirst = async () => null;
    const id = await findBrandCommerceProductIdForProductUrl({
      brandId: "brand-1",
      productUrl: "https://acme-store.myshopify.com/products/unsynced",
    });
    assert.equal(id, null);
  });
});

// A minimal fake transaction client. Only the two model namespaces these
// helpers touch are implemented; casting through `unknown` to
// `Prisma.TransactionClient` mirrors the existing MockedPrismaClient pattern
// used across this test suite (see tests/shopify-reward-adapter-cutover.test.ts)
// rather than reaching for `any`.
function fakeTx(overrides: {
  findUnique?: (args: unknown) => unknown;
  upsert?: (args: unknown) => unknown;
  update?: (args: unknown) => unknown;
}): Prisma.TransactionClient {
  return {
    campaignLessonProduct: {
      findUnique: overrides.findUnique ?? (async () => null),
      upsert: overrides.upsert ?? (async () => ({ id: "clp-1" })),
      update: overrides.update ?? (async () => ({ id: "clp-1" })),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("upsertCampaignLessonProductScope (items 4, 14, 21)", () => {
  test("creates a new scoping row carrying the authorizing campaign's id (item 14)", async () => {
    let createArgs: unknown = null;
    const tx = fakeTx({
      findUnique: async () => null,
      upsert: async (args) => {
        createArgs = args;
        return { id: "clp-new" };
      },
    });

    await upsertCampaignLessonProductScope(tx, {
      campaignId: "campaign-a",
      brandId: "brand-1",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-1",
      legacyLessonProductLinkId: "link-1",
    });

    const args = createArgs as {
      where: { campaignId_lessonId_brandCommerceProductId: Record<string, string> };
      create: Record<string, unknown>;
    };
    assert.equal(args.where.campaignId_lessonId_brandCommerceProductId.campaignId, "campaign-a");
    assert.equal(args.create.campaignId, "campaign-a");
    assert.equal(args.create.legacyLessonProductLinkId, "link-1");
  });

  test("two independent campaigns attaching the same brandCommerceProductId under the same lesson produce two distinct upserts, never merged (item 21)", async () => {
    const calls: Array<{ campaignId: string; legacyLessonProductLinkId: string | null }> = [];
    const tx = fakeTx({
      findUnique: async () => null,
      upsert: async (args) => {
        const a = args as { create: { campaignId: string; legacyLessonProductLinkId: string | null } };
        calls.push({
          campaignId: a.create.campaignId,
          legacyLessonProductLinkId: a.create.legacyLessonProductLinkId,
        });
        return { id: `clp-${calls.length}` };
      },
    });

    await upsertCampaignLessonProductScope(tx, {
      campaignId: "campaign-a",
      brandId: "brand-1",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-shared",
      legacyLessonProductLinkId: "link-a",
    });
    await upsertCampaignLessonProductScope(tx, {
      campaignId: "campaign-b",
      brandId: "brand-1",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-shared",
      legacyLessonProductLinkId: "link-b",
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].campaignId, "campaign-a");
    assert.equal(calls[1].campaignId, "campaign-b");
    assert.notEqual(calls[0].campaignId, calls[1].campaignId);
  });

  test("a snapshot already claimed by a DIFFERENT tuple is rejected so callers create a separate scoped snapshot", async () => {
    const tx = fakeTx({
      findUnique: async () => ({
        campaignId: "campaign-other",
        lessonId: "lesson-1",
        brandCommerceProductId: "bcp-other",
      }),
      upsert: async () => ({ id: "must-not-run" }),
    });

    await assert.rejects(() => upsertCampaignLessonProductScope(tx, {
      campaignId: "campaign-a",
      brandId: "brand-1",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-1",
      legacyLessonProductLinkId: "link-shared",
    }), /already scoped/);
  });

  test("reactivation on the update branch reactivates isActive/deactivatedAt without clearing an existing binding as a side effect", async () => {
    let updateData: unknown = null;
    const tx = fakeTx({
      findUnique: async () => null,
      upsert: async (args) => {
        const a = args as { update: unknown };
        updateData = a.update;
        return { id: "clp-1" };
      },
    });

    await upsertCampaignLessonProductScope(tx, {
      campaignId: "campaign-a",
      brandId: "brand-1",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-1",
      legacyLessonProductLinkId: null,
    });

    const data = updateData as { isActive: boolean; deactivatedAt: unknown };
    assert.equal(data.isActive, true);
    assert.equal(data.deactivatedAt, null);
    assert.equal("legacyLessonProductLinkId" in data, false);
  });
});

describe("detachCampaignLessonProductFromLink (item 13: DELETE still deactivates the scoping row)", () => {
  test("no-op when there is no scoping row for this snapshot (pre-Phase-5 unscoped link)", async () => {
    let updateCalled = false;
    const tx = fakeTx({
      findUnique: async () => null,
      update: async () => {
        updateCalled = true;
        return {};
      },
    });

    await detachCampaignLessonProductFromLink(tx, {
      legacyLessonProductLinkId: "link-unscoped",
      keep: null,
    });

    assert.equal(updateCalled, false);
  });

  test("deactivates (not deletes) the scoping row for a scoped snapshot, preserving attribution history", async () => {
    let updateArgs: unknown = null;
    const tx = fakeTx({
      findUnique: async () => ({
        id: "clp-1",
        campaignId: "campaign-a",
        lessonId: "lesson-1",
        brandCommerceProductId: "bcp-1",
      }),
      update: async (args) => {
        updateArgs = args;
        return {};
      },
    });

    await detachCampaignLessonProductFromLink(tx, {
      legacyLessonProductLinkId: "link-scoped",
      keep: null,
    });

    const args = updateArgs as { where: { id: string }; data: { isActive: boolean; deactivatedAt: unknown; legacyLessonProductLinkId: unknown } };
    assert.equal(args.where.id, "clp-1");
    assert.equal(args.data.isActive, false);
    assert.notEqual(args.data.deactivatedAt, null);
    assert.equal(args.data.legacyLessonProductLinkId, null);
  });

  test("a legitimate self-replacement (`keep` matches the existing tuple) is left untouched", async () => {
    let updateCalled = false;
    const tx = fakeTx({
      findUnique: async () => ({
        id: "clp-1",
        campaignId: "campaign-a",
        lessonId: "lesson-1",
        brandCommerceProductId: "bcp-1",
      }),
      update: async () => {
        updateCalled = true;
        return {};
      },
    });

    await detachCampaignLessonProductFromLink(tx, {
      legacyLessonProductLinkId: "link-1",
      keep: { campaignId: "campaign-a", lessonId: "lesson-1", brandCommerceProductId: "bcp-1" },
    });

    assert.equal(updateCalled, false);
  });
});
