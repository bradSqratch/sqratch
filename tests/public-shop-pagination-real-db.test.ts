// ---------------------------------------------------------------------------
// PHASE 29 — real PostgreSQL proof for the bounded, cursor-paginated public
// Experience shop catalog (`GET /api/public/experience/[slug]/products`).
//
// A DI-mocked test (see `tests/public-experience-product-catalog.test.ts`
// and `tests/public-shop-pagination.test.ts`) can prove the pagination
// ALGORITHM is correct against fakes that reproduce a Prisma `where`/`take`
// contract by hand, but it cannot prove the REAL `findCuratedProductsPage`
// query in
// `src/app/api/public/experience/[experienceSlug]/products/route.ts`
// actually composes against genuine Postgres keyset predicates and nested
// relation filters. This file is that proof, for the count the audit named
// (101 products), walked to completion with no duplicates and no missing
// rows, plus real availability/publication gating enforced by the actual
// WHERE clause rather than by a fake that could silently diverge from it.
//
// SCOPE: this proof drives the storefront query
// (`prisma.brandCommerceProduct.findMany`, reproduced here with the SAME
// where/orderBy/select the route's `DEFAULT_DEPS.findCuratedProductsPage`
// uses) directly against a disposable database, rather than the full HTTP
// route handler. Routing the full handler would additionally require a real
// Campaign/CampaignExperience/Experience graph with a working
// `getExperienceAccessContext` (a next-auth + next/headers dependency that
// cannot run outside a genuine Next.js request — see
// `public-campaign-context-isolation.test.ts`'s header for the same
// constraint), which is orthogonal to what THIS proof is for: the storefront
// keyset query's real-Postgres correctness. The route-level union/dedup/
// campaign-block logic sitting on top of that query is already proven, with
// a real DI-fake harness, in `public-experience-product-catalog.test.ts` and
// `public-campaign-context-isolation.test.ts`.
//
// It never runs against the configured production/dev DATABASE_URL and is
// SKIPPED by default — see `tests/commerce-connection-lock.test.ts`'s header
// for the full disposable-Postgres setup ritual (identical here).
//
// ENVIRONMENT NOTE (reported, not worked around): at the time this file was
// written, no Postgres instance matching this repository's documented
// disposable-test convention (127.0.0.1:55432, a `..._test`-suffixed
// database) was reachable in the development environment. A DIFFERENT local
// Postgres instance was found listening on 127.0.0.1:55433, but it belongs
// to an unrelated project (its only database is `webmcp_forge_test`) and
// was correctly left untouched — repurposing another project's local
// database for this repository's tests would be an unrelated, unreviewed
// side effect outside this task's remit. This file is therefore committed
// SKIPPED, exactly like its precedents, ready to run once a real disposable
// Postgres for sqratch is provisioned:
//
//   createdb sqratch_shop_pagination_test
//   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/sqratch_shop_pagination_test \
//   DIRECT_URL=postgresql://postgres@127.0.0.1:55432/sqratch_shop_pagination_test \
//   PG_SSL_REJECT_UNAUTHORIZED=false \
//   ALLOW_REAL_DATABASE_TESTS=true \
//   PUBLIC_SHOP_PAGINATION_REAL_DB=true \
//   npx prisma migrate deploy && \
//   npx tsx --test tests/public-shop-pagination-real-db.test.ts
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { test } from "node:test";
import { CommerceConnectionStatus, CommerceProvider } from "@prisma/client";
import { canUseRealDatabaseUnderTest } from "../src/lib/db-safety";
import type { PublicShopBlockCursor } from "../src/lib/commerce/public-shop-pagination";

const realDbDecision = canUseRealDatabaseUnderTest({
  connectionString: process.env.DATABASE_URL ?? "",
  allowRealDatabaseTestsEnv: process.env.ALLOW_REAL_DATABASE_TESTS,
});

const ENABLED = process.env.PUBLIC_SHOP_PAGINATION_REAL_DB === "true" && realDbDecision.allowed;

const SKIP_REASON = realDbDecision.allowed
  ? "requires PUBLIC_SHOP_PAGINATION_REAL_DB=true and a real disposable Postgres (see file header)"
  : `requires PUBLIC_SHOP_PAGINATION_REAL_DB=true and the full db-safety opt-in (${realDbDecision.reason}) — see file header`;

async function cleanup(
  prisma: typeof import("../src/lib/prisma").default,
  brandIds: string[],
  connectionIds: string[],
) {
  await prisma.brandCommerceProduct.deleteMany({ where: { brandId: { in: brandIds } } });
  await prisma.connectedCommerceProduct.deleteMany({ where: { brandId: { in: brandIds } } });
  await prisma.commerceConnection.deleteMany({ where: { id: { in: connectionIds } } });
  await prisma.brand.deleteMany({ where: { id: { in: brandIds } } });
}

/**
 * The EXACT where/orderBy/select `DEFAULT_DEPS.findCuratedProductsPage` in
 * the route uses, reproduced here so this file exercises real Postgres
 * without importing the route's non-exported `DEFAULT_DEPS`. Any drift
 * between this copy and the route's real query is a real risk this test
 * cannot catch by construction — see `public-experience-product-catalog.test.ts`
 * for the DI-fake proof that the ROUTE actually calls a function with this
 * exact contract.
 */
async function findCuratedProductsPage(
  prisma: typeof import("../src/lib/prisma").default,
  options: { brandId: string; cursor: PublicShopBlockCursor | null; limit: number },
) {
  const { brandId, cursor, limit } = options;
  const rows = await prisma.brandCommerceProduct.findMany({
    where: {
      brandId,
      isVisibleInShop: true,
      connectedProduct: {
        brandId,
        isAvailable: true,
        hasPublicStorefrontUrl: true,
        connection: { is: { status: "CONNECTED" } },
      },
      ...(cursor
        ? {
            AND: [
              {
                OR: [
                  { displayOrder: { gt: cursor.displayOrder } },
                  { displayOrder: cursor.displayOrder, connectedProduct: { title: { gt: cursor.sortKey } } },
                  {
                    displayOrder: cursor.displayOrder,
                    connectedProduct: { title: cursor.sortKey },
                    connectedProductId: { gt: cursor.catalogId },
                  },
                ],
              },
            ],
          }
        : {}),
    },
    orderBy: [{ displayOrder: "asc" }, { connectedProduct: { title: "asc" } }, { connectedProductId: "asc" }],
    take: limit,
    select: { id: true, displayOrder: true, connectedProduct: { select: { id: true, title: true } } },
  });
  return rows.map((row) => ({
    displayOrder: row.displayOrder,
    sortKey: row.connectedProduct.title,
    catalogId: row.connectedProduct.id,
    item: row.connectedProduct.id,
  }));
}

test(
  "PHASE 29: real Postgres — 101 storefront products page to completion with no duplicates, no missing rows, stable order, real availability gating",
  { skip: !ENABLED && SKIP_REASON },
  async () => {
    const { default: prisma } = await import("../src/lib/prisma");
    const { resolvePublicShopPage } = await import("../src/lib/commerce/public-shop-pagination");

    const unique = Date.now();
    const brand = await prisma.brand.create({
      data: { name: `Shop Pagination Test Brand ${unique}`, slug: `shop-pagination-test-${unique}` },
    });
    const connection = await prisma.commerceConnection.create({
      data: {
        brandId: brand.id,
        provider: CommerceProvider.SHOPIFY,
        status: CommerceConnectionStatus.CONNECTED,
        displayName: "Pagination Fixture Store",
        externalAccountId: `pagination-fixture-${unique}`,
      },
    });
    const brandIds = [brand.id];
    const connectionIds = [connection.id];

    try {
      const TOTAL = 101;
      const connectedProducts = await Promise.all(
        Array.from({ length: TOTAL }, (_, i) =>
          prisma.connectedCommerceProduct.create({
            data: {
              connectionId: connection.id,
              brandId: brand.id,
              provider: CommerceProvider.SHOPIFY,
              externalKey: `pagination-fixture-${i}`,
              externalId: `gid://shopify/Product/${i}`,
              title: `Fixture Product ${String(i).padStart(3, "0")}`,
              productUrl: `https://fixture.test/products/${i}`,
              isAvailable: true,
              hasPublicStorefrontUrl: true,
            },
          }),
        ),
      );
      await Promise.all(
        connectedProducts.map((cp, i) =>
          prisma.brandCommerceProduct.create({
            data: {
              brandId: brand.id,
              connectedProductId: cp.id,
              isVisibleInShop: true,
              isCampaignEligible: false,
              displayOrder: i,
            },
          }),
        ),
      );

      const seen: string[] = [];
      let cursor: PublicShopBlockCursor | null = null;
      let pages = 0;
      let guard = 0;
      while (guard++ < 20) {
        const page: Awaited<ReturnType<typeof resolvePublicShopPage<string>>> = await resolvePublicShopPage(
          { cursor, limit: 24 },
          {
            blockCount: 1,
            fetchBlockPage: (_blockIndex, blockCursor, limit) =>
              findCuratedProductsPage(prisma, { brandId: brand.id, cursor: blockCursor, limit }),
          },
        );
        pages++;
        seen.push(...page.items);
        if (!page.hasNextPage) break;
        cursor = page.nextCursor;
      }

      assert.equal(seen.length, TOTAL, "every real product must be returned exactly once across all pages");
      assert.deepEqual(seen, Array.from(new Set(seen)), "no duplicates across real DB pages");
      assert.ok(pages >= 5, `101 products over a 24-item page should take at least 5 pages, took ${pages}`);
      // Stable order preserved end to end: fixtures were created with
      // displayOrder 0..100 in title order, so the concatenated pages must
      // reproduce that exact sequence, not merely the same SET of ids.
      assert.deepEqual(
        seen,
        connectedProducts.map((cp) => cp.id),
        "cross-page order must match displayOrder/title exactly, not just set membership",
      );

      // Availability/publication gating, enforced by the REAL WHERE clause
      // (not a fake that could silently diverge from it).
      const unavailable = await prisma.connectedCommerceProduct.create({
        data: {
          connectionId: connection.id,
          brandId: brand.id,
          provider: CommerceProvider.SHOPIFY,
          externalKey: "pagination-fixture-unavailable",
          externalId: "gid://shopify/Product/unavailable",
          title: "Zzz Unavailable",
          productUrl: "https://fixture.test/products/unavailable",
          isAvailable: false,
          hasPublicStorefrontUrl: true,
        },
      });
      await prisma.brandCommerceProduct.create({
        data: {
          brandId: brand.id,
          connectedProductId: unavailable.id,
          isVisibleInShop: true,
          isCampaignEligible: false,
          displayOrder: 9999,
        },
      });
      const finalPage = await findCuratedProductsPage(prisma, { brandId: brand.id, cursor: null, limit: 200 });
      assert.equal(
        finalPage.some((row) => row.catalogId === unavailable.id),
        false,
        "an unavailable product must never appear even at a bounded, unfiltered take",
      );

      const unpublished = await prisma.connectedCommerceProduct.create({
        data: {
          connectionId: connection.id,
          brandId: brand.id,
          provider: CommerceProvider.SHOPIFY,
          externalKey: "pagination-fixture-unpublished",
          externalId: "gid://shopify/Product/unpublished",
          title: "Zzy Unpublished",
          productUrl: "https://fixture.test/products/unpublished",
          isAvailable: true,
          hasPublicStorefrontUrl: false,
        },
      });
      await prisma.brandCommerceProduct.create({
        data: {
          brandId: brand.id,
          connectedProductId: unpublished.id,
          isVisibleInShop: true,
          isCampaignEligible: false,
          displayOrder: 9998,
        },
      });
      const finalPage2 = await findCuratedProductsPage(prisma, { brandId: brand.id, cursor: null, limit: 200 });
      assert.equal(
        finalPage2.some((row) => row.catalogId === unpublished.id),
        false,
        "a product with no public storefront URL must never appear even though it is 'available'",
      );

      await prisma.commerceConnection.update({
        where: { id: connection.id },
        data: { status: CommerceConnectionStatus.DISCONNECTED },
      });
      const finalPage3 = await findCuratedProductsPage(prisma, { brandId: brand.id, cursor: null, limit: 200 });
      assert.equal(
        finalPage3.length,
        0,
        "a DISCONNECTED connection must delist every one of its products, even previously-available ones",
      );
    } finally {
      await cleanup(prisma, brandIds, connectionIds);
    }
  },
);
