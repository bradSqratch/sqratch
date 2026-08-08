import "./env-setup";

/**
 * tests/lesson-product-links-scoping.test.ts
 *
 * Coverage for the CANONICAL CampaignLessonProduct lifecycle helpers in
 * src/lib/lesson-product-links.ts:
 *  - upsertCampaignLessonProductScope (tuple-keyed create/reactivate)
 *  - deactivateCampaignLessonProduct (lesson-scoped, fail-closed removal)
 *
 * PHASE 8 DELETIONS (tests removed with the surfaces they covered, not
 * weakened):
 *  - assertProductUrlMatchesBrandDomain / productUrlMatchesShopDomain: the
 *    free-form legacy attach they gated no longer exists. A creator can no
 *    longer supply a productUrl at all, so there is no URL left to forge. The
 *    replacement guarantee — a client-supplied productUrl/title/brandId cannot
 *    influence authorization or persisted data — is asserted directly against
 *    the route in tests/creator-lesson-product-routes-campaign-scoping.test.ts.
 *  - parseLessonProductInput's allowedBrandIds enforcement: the routes never
 *    read a client brandId now; brandId comes only from the server-resolved
 *    campaign context. Same replacement assertions as above.
 *  - findBrandCommerceProductIdForProductUrl: existed only to bind a legacy
 *    attach to a catalog row by URL. A canonical attach starts from the catalog
 *    id, so there is nothing to resolve.
 *  - resolveSourceShopDomainForBrand: its only consumers were the legacy
 *    attaches; nothing stamps a source shop domain anymore.
 *
 * The prisma calls these functions make are mocked by replacing methods on the
 * imported `prisma` singleton, the same dependency-injection idiom
 * tests/shopify-reward-adapter-cutover.test.ts and
 * tests/integration-coverage.test.ts use for modules that are not fully DI'd.
 * No real DB connection is made; DATABASE_URL is pinned to the
 * deliberately-unreachable blocked placeholder.
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.NEXTAUTH_SECRET = "test-nextauth-secret";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

import {
  deactivateCampaignLessonProduct,
  upsertCampaignLessonProductScope,
} from "../src/lib/lesson-product-links";

// A minimal fake transaction client. Only the model namespace these helpers
// touch is implemented; casting through `unknown` to
// `Prisma.TransactionClient` mirrors the existing MockedPrismaClient pattern
// used across this test suite (see tests/shopify-reward-adapter-cutover.test.ts)
// rather than reaching for `any`.
function fakeTx(overrides: {
  upsert?: (args: unknown) => unknown;
  updateMany?: (args: unknown) => unknown;
}): Prisma.TransactionClient {
  return {
    campaignLessonProduct: {
      upsert:
        overrides.upsert ??
        (async () => ({
          id: "clp-1",
          lessonId: "lesson-1",
          displayOrder: 0,
          createdAt: new Date("2026-08-08T00:00:00Z"),
        })),
      updateMany: overrides.updateMany ?? (async () => ({ count: 1 })),
    },
  } as unknown as Prisma.TransactionClient;
}

describe("upsertCampaignLessonProductScope (canonical, tuple-keyed)", () => {
  test("keys the upsert on (campaignId, lessonId, brandCommerceProductId) and never writes legacyLessonProductLinkId", async () => {
    let upsertArgs: unknown = null;
    const tx = fakeTx({
      upsert: async (args) => {
        upsertArgs = args;
        return {
          id: "clp-new",
          lessonId: "lesson-1",
          displayOrder: 0,
          createdAt: new Date("2026-08-08T00:00:00Z"),
        };
      },
    });

    const row = await upsertCampaignLessonProductScope(tx, {
      campaignId: "campaign-a",
      brandId: "brand-1",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-1",
    });

    assert.equal(row.id, "clp-new");

    const args = upsertArgs as {
      where: { campaignId_lessonId_brandCommerceProductId: Record<string, string> };
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    assert.deepEqual(args.where.campaignId_lessonId_brandCommerceProductId, {
      campaignId: "campaign-a",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-1",
    });
    assert.equal(args.create.campaignId, "campaign-a");
    // brandId is written because both composite FKs include it, which is what
    // makes a cross-brand attachment impossible at the database level.
    assert.equal(args.create.brandId, "brand-1");
    assert.equal(args.create.isActive, true);
    // The legacy snapshot bridge is never read or written by the canonical path.
    assert.equal("legacyLessonProductLinkId" in args.create, false);
    assert.equal("legacyLessonProductLinkId" in args.update, false);
  });

  test("two independent campaigns attaching the same brandCommerceProductId under the same lesson produce two distinct upserts, never merged", async () => {
    const calls: string[] = [];
    const tx = fakeTx({
      upsert: async (args) => {
        const a = args as { create: { campaignId: string } };
        calls.push(a.create.campaignId);
        return {
          id: `clp-${calls.length}`,
          lessonId: "lesson-1",
          displayOrder: 0,
          createdAt: new Date("2026-08-08T00:00:00Z"),
        };
      },
    });

    await upsertCampaignLessonProductScope(tx, {
      campaignId: "campaign-a",
      brandId: "brand-1",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-shared",
    });
    await upsertCampaignLessonProductScope(tx, {
      campaignId: "campaign-b",
      brandId: "brand-1",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-shared",
    });

    assert.deepEqual(calls, ["campaign-a", "campaign-b"]);
  });

  test("the update branch reactivates a previously deactivated attachment rather than duplicating it", async () => {
    let updateData: unknown = null;
    const tx = fakeTx({
      upsert: async (args) => {
        updateData = (args as { update: unknown }).update;
        return {
          id: "clp-1",
          lessonId: "lesson-1",
          displayOrder: 0,
          createdAt: new Date("2026-08-08T00:00:00Z"),
        };
      },
    });

    await upsertCampaignLessonProductScope(tx, {
      campaignId: "campaign-a",
      brandId: "brand-1",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-1",
    });

    const data = updateData as { isActive: boolean; deactivatedAt: unknown };
    assert.equal(data.isActive, true);
    assert.equal(data.deactivatedAt, null);
    assert.equal("displayOrder" in data, false);
  });

  test("displayOrder is written only when supplied, so a reactivation never silently reorders an existing row", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const tx = fakeTx({
      upsert: async (args) => {
        captured.push((args as { update: Record<string, unknown> }).update);
        return {
          id: "clp-1",
          lessonId: "lesson-1",
          displayOrder: 7,
          createdAt: new Date("2026-08-08T00:00:00Z"),
        };
      },
    });

    await upsertCampaignLessonProductScope(tx, {
      campaignId: "campaign-a",
      brandId: "brand-1",
      lessonId: "lesson-1",
      brandCommerceProductId: "bcp-1",
      displayOrder: 7,
    });

    assert.equal(captured[0].displayOrder, 7);
  });
});

describe("deactivateCampaignLessonProduct (lesson-scoped, fail-closed)", () => {
  test("deactivates (never deletes) the addressed row, always scoped by lessonId in the same predicate", async () => {
    let updateArgs: unknown = null;
    const tx = fakeTx({
      updateMany: async (args) => {
        updateArgs = args;
        return { count: 1 };
      },
    });

    const removed = await deactivateCampaignLessonProduct(tx, {
      lessonId: "lesson-1",
      campaignLessonProductId: "clp-1",
    });

    assert.equal(removed, true);
    const args = updateArgs as {
      where: { id: string; lessonId: string; isActive: boolean };
      data: { isActive: boolean; deactivatedAt: unknown };
    };
    assert.equal(args.where.id, "clp-1");
    assert.equal(args.where.lessonId, "lesson-1");
    assert.equal(args.where.isActive, true);
    assert.equal(args.data.isActive, false);
    assert.notEqual(args.data.deactivatedAt, null);
  });

  test("a foreign id (another lesson's attachment) matches nothing and reports false — indistinguishable from a nonexistent id", async () => {
    const tx = fakeTx({ updateMany: async () => ({ count: 0 }) });

    const removed = await deactivateCampaignLessonProduct(tx, {
      lessonId: "lesson-1",
      campaignLessonProductId: "clp-owned-by-another-lesson",
    });

    assert.equal(removed, false);
  });

  test("an injected clock is used for deactivatedAt when supplied", async () => {
    const now = new Date("2026-08-08T12:00:00Z");
    let captured: unknown = null;
    const tx = fakeTx({
      updateMany: async (args) => {
        captured = (args as { data: { deactivatedAt: Date } }).data.deactivatedAt;
        return { count: 1 };
      },
    });

    await deactivateCampaignLessonProduct(tx, {
      lessonId: "lesson-1",
      campaignLessonProductId: "clp-1",
      now,
    });

    assert.deepEqual(captured, now);
  });
});
