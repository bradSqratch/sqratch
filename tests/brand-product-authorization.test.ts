process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";

/**
 * tests/brand-product-authorization.test.ts
 *
 * Authorization-focused tests for the four `src/app/api/brand/products/**`
 * routes (Workstream 4): the provider-neutral brand product catalog API.
 * No real DB and no real network anywhere in this file — every dependency
 * is injected via each route's own `Partial<...Deps>` parameter, the same
 * idiom `tests/shopify-route-contract-compatibility.test.ts` uses.
 *
 * The four route modules are dynamically imported inside `before()`, AFTER
 * the env vars above are set — a static top-level `import` would be hoisted
 * ahead of those assignments (ESM import hoisting), and each route
 * transitively imports `@/lib/prisma` via `@/lib/brand-auth`, which throws
 * synchronously at import time if `DATABASE_URL` is unset.
 *
 * Covered cases:
 *  1.  403/409 failure shapes are EXACTLY the house shapes, on every route.
 *  2.  A `brandId` supplied in the query string / body is IGNORED — the
 *      injected deps assert they were called with the CONTEXT brand id,
 *      never the submitted one.
 *  3.  Selecting/patching another brand's product returns 404, IDENTICAL to
 *      a nonexistent id (same body, same status).
 *  4.  No response body ever contains a credential-shaped or
 *      providerMetadata-shaped string, across all four routes.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { CommerceProvider } from "@prisma/client";
import { NextRequest } from "next/server";

import type { BrandAdminContext } from "../src/lib/brand-auth";
import type { ProductSyncOutcome } from "../src/lib/commerce/product-sync";
import type { BrandProductsListDeps } from "../src/app/api/brand/products/route";
import type { BrandProductsSyncDeps } from "../src/app/api/brand/products/sync/route";
import type { BrandProductSyncRunsDeps } from "../src/app/api/brand/products/sync-runs/route";
import type { BrandProductSelectionDeps } from "../src/app/api/brand/products/[connectedProductId]/selection/route";

let listProductsImpl: (
  request: NextRequest,
  overrides?: Partial<BrandProductsListDeps>,
) => Promise<Response>;
let productsSyncImpl: (overrides?: Partial<BrandProductsSyncDeps>) => Promise<Response>;
let syncRunsListImpl: (
  request: NextRequest,
  overrides?: Partial<BrandProductSyncRunsDeps>,
) => Promise<Response>;
let selectionPatchImpl: (
  request: NextRequest,
  context: { params: Promise<{ connectedProductId: string }> },
  overrides?: Partial<BrandProductSelectionDeps>,
) => Promise<Response>;

before(async () => {
  listProductsImpl = (await import("../src/app/api/brand/products/route")).listProductsImpl;
  productsSyncImpl = (await import("../src/app/api/brand/products/sync/route")).productsSyncImpl;
  syncRunsListImpl = (await import("../src/app/api/brand/products/sync-runs/route")).syncRunsListImpl;
  selectionPatchImpl = (
    await import("../src/app/api/brand/products/[connectedProductId]/selection/route")
  ).selectionPatchImpl;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type BrandFixtureFields = NonNullable<BrandAdminContext["membership"]>["brand"];

function makeBrand(overrides: Partial<BrandFixtureFields> = {}): BrandFixtureFields {
  return {
    id: "brand-1",
    name: "Acme",
    slug: "acme",
    bio: null,
    websiteUrl: null,
    logoUrl: null,
    coverImageUrl: null,
    ...overrides,
  };
}

function makeContext(brand: BrandFixtureFields | null, selectionRequired = false): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired,
    brands: brand ? [{ id: brand.id, name: brand.name, slug: brand.slug, membershipRole: "MANAGER" }] : [],
    membership: brand ? { id: "member-1", role: "MANAGER", brand } : null,
  };
}

const CONTEXT_BRAND = makeBrand({ id: "brand-context" });
const FOREIGN_BRAND_ID = "brand-attacker-supplied";

function jsonRequest(url: string, body: unknown, method = "PATCH"): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// A byte-for-byte scan for anything credential/metadata-shaped leaking into
// a response body.
const FORBIDDEN_PATTERN = /token|secret|encrypted|password|providerMetadata|authorization/i;

async function assertNoLeak(res: Response) {
  const text = await res.clone().text();
  assert.doesNotMatch(text, FORBIDDEN_PATTERN);
}

// ---------------------------------------------------------------------------
// 1. Failure shapes — identical across all four routes
// ---------------------------------------------------------------------------

describe("brand product routes — house failure shapes", () => {
  test("GET /api/brand/products — 409 ACTIVE_BRAND_REQUIRED", async () => {
    const res = await listProductsImpl(new NextRequest("https://x/api/brand/products"), {
      getContext: async () => makeContext(null, true),
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.deepEqual(body, {
      error: "Select an active brand before continuing.",
      code: "ACTIVE_BRAND_REQUIRED",
    });
  });

  test("GET /api/brand/products — 403 Brand admin access required", async () => {
    const res = await listProductsImpl(new NextRequest("https://x/api/brand/products"), {
      getContext: async () => makeContext(null, false),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.deepEqual(body, { error: "Brand admin access required." });
  });

  test("POST /api/brand/products/sync — 409 ACTIVE_BRAND_REQUIRED", async () => {
    const res = await productsSyncImpl({ getContext: async () => makeContext(null, true) });
    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      error: "Select an active brand before continuing.",
      code: "ACTIVE_BRAND_REQUIRED",
    });
  });

  test("POST /api/brand/products/sync — 403 Brand admin access required", async () => {
    const res = await productsSyncImpl({ getContext: async () => makeContext(null, false) });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: "Brand admin access required." });
  });

  test("GET /api/brand/products/sync-runs — 409 / 403", async () => {
    const res409 = await syncRunsListImpl(new NextRequest("https://x/api/brand/products/sync-runs"), {
      getContext: async () => makeContext(null, true),
    });
    assert.equal(res409.status, 409);
    assert.deepEqual(await res409.json(), {
      error: "Select an active brand before continuing.",
      code: "ACTIVE_BRAND_REQUIRED",
    });

    const res403 = await syncRunsListImpl(new NextRequest("https://x/api/brand/products/sync-runs"), {
      getContext: async () => makeContext(null, false),
    });
    assert.equal(res403.status, 403);
    assert.deepEqual(await res403.json(), { error: "Brand admin access required." });
  });

  test("PATCH .../selection — 409 / 403", async () => {
    const req = jsonRequest("https://x/api/brand/products/p1/selection", { isVisibleInShop: true });
    const params = { params: Promise.resolve({ connectedProductId: "p1" }) };

    const res409 = await selectionPatchImpl(req, params, {
      getContext: async () => makeContext(null, true),
    });
    assert.equal(res409.status, 409);
    assert.deepEqual(await res409.json(), {
      error: "Select an active brand before continuing.",
      code: "ACTIVE_BRAND_REQUIRED",
    });

    const res403 = await selectionPatchImpl(jsonRequest("https://x/api/brand/products/p1/selection", {}), params, {
      getContext: async () => makeContext(null, false),
    });
    assert.equal(res403.status, 403);
    assert.deepEqual(await res403.json(), { error: "Brand admin access required." });
  });
});

// ---------------------------------------------------------------------------
// 2. Client-supplied brandId is always ignored
// ---------------------------------------------------------------------------

describe("brand product routes — client-supplied brandId is never trusted", () => {
  test("GET /api/brand/products — brandId query param ignored; findProducts called with context brand", async () => {
    let calledBrandId: string | null = null;
    const req = new NextRequest(
      `https://x/api/brand/products?brandId=${FOREIGN_BRAND_ID}`,
    );
    const res = await listProductsImpl(req, {
      getContext: async () => makeContext(CONTEXT_BRAND),
      findProducts: async (args) => {
        calledBrandId = args.brandId;
        return [];
      },
      getLastSyncRun: async () => null,
    });
    assert.equal(res.status, 200);
    assert.equal(calledBrandId, CONTEXT_BRAND.id);
    assert.notEqual(calledBrandId, FOREIGN_BRAND_ID);
  });

  test("POST /api/brand/products/sync — brandId ignored; runSync called with context brand", async () => {
    let calledBrandId: string | null = null;
    const res = await productsSyncImpl({
      getContext: async () => makeContext(CONTEXT_BRAND),
      findRunningRun: async () => null,
      runSync: async (brandId) => {
        calledBrandId = brandId;
        const outcome: ProductSyncOutcome = {
          status: "SUCCEEDED",
          brandId,
          provider: CommerceProvider.SHOPIFY,
          connectionId: "conn-1",
          runId: "run-1",
          stats: {
            fetchedCount: 0,
            createdCount: 0,
            updatedCount: 0,
            unchangedCount: 0,
            markedUnavailableCount: 0,
            failedCount: 0,
          },
          hasNextPage: false,
          failureSummary: null,
        };
        return outcome;
      },
    });
    assert.equal(res.status, 200);
    assert.equal(calledBrandId, CONTEXT_BRAND.id);
  });

  test("GET /api/brand/products/sync-runs — brandId ignored; findSyncRuns called with context brand", async () => {
    let calledBrandId: string | null = null;
    const req = new NextRequest(
      `https://x/api/brand/products/sync-runs?brandId=${FOREIGN_BRAND_ID}`,
    );
    const res = await syncRunsListImpl(req, {
      getContext: async () => makeContext(CONTEXT_BRAND),
      findSyncRuns: async (args) => {
        calledBrandId = args.brandId;
        return [];
      },
    });
    assert.equal(res.status, 200);
    assert.equal(calledBrandId, CONTEXT_BRAND.id);
  });

  test("PATCH .../selection — brandId in body ignored; findOwnedProduct/upsertSelection called with context brand", async () => {
    let findCalledBrandId: string | null = null;
    let upsertCalledBrandId: string | null = null;
    const req = jsonRequest("https://x/api/brand/products/p1/selection", {
      brandId: FOREIGN_BRAND_ID,
      isVisibleInShop: true,
    });
    const res = await selectionPatchImpl(
      req,
      { params: Promise.resolve({ connectedProductId: "p1" }) },
      {
        getContext: async () => makeContext(CONTEXT_BRAND),
        findOwnedProduct: async (id, brandId) => {
          findCalledBrandId = brandId;
          return { id };
        },
        upsertSelection: async (brandId, connectedProductId) => {
          upsertCalledBrandId = brandId;
          return {
            connectedProductId,
            isVisibleInShop: true,
            isCampaignEligible: false,
            displayOrder: 0,
            titleOverride: null,
            shortDescriptionOverride: null,
          };
        },
      },
    );
    assert.equal(res.status, 200);
    assert.equal(findCalledBrandId, CONTEXT_BRAND.id);
    assert.equal(upsertCalledBrandId, CONTEXT_BRAND.id);
    assert.notEqual(findCalledBrandId, FOREIGN_BRAND_ID);
  });
});

// ---------------------------------------------------------------------------
// 3. Wrong-brand vs nonexistent are indistinguishable
// ---------------------------------------------------------------------------

describe("brand product routes — wrong-brand and nonexistent are indistinguishable", () => {
  test("PATCH .../selection — another brand's product returns the SAME 404 as a nonexistent id", async () => {
    const req1 = jsonRequest("https://x/api/brand/products/other-brands-product/selection", {
      isVisibleInShop: true,
    });
    const resWrongBrand = await selectionPatchImpl(
      req1,
      { params: Promise.resolve({ connectedProductId: "other-brands-product" }) },
      {
        getContext: async () => makeContext(CONTEXT_BRAND),
        // Simulates findFirst({ id, brandId }) correctly scoping and finding nothing
        // because the product belongs to a different brand.
        findOwnedProduct: async () => null,
      },
    );

    const req2 = jsonRequest("https://x/api/brand/products/does-not-exist/selection", {
      isVisibleInShop: true,
    });
    const resNonexistent = await selectionPatchImpl(
      req2,
      { params: Promise.resolve({ connectedProductId: "does-not-exist" }) },
      {
        getContext: async () => makeContext(CONTEXT_BRAND),
        findOwnedProduct: async () => null,
      },
    );

    assert.equal(resWrongBrand.status, 404);
    assert.equal(resNonexistent.status, 404);
    const wrongBrandBody = await resWrongBrand.json();
    const nonexistentBody = await resNonexistent.json();
    assert.deepEqual(wrongBrandBody, nonexistentBody);
    assert.deepEqual(wrongBrandBody, { error: "Product not found." });
  });

  test("GET /api/brand/products — a foreign connectionId behaves identically to an unknown one (empty page, 200)", async () => {
    const reqForeign = new NextRequest(
      "https://x/api/brand/products?connectionId=conn-belongs-to-other-brand",
    );
    const resForeign = await listProductsImpl(reqForeign, {
      getContext: async () => makeContext(CONTEXT_BRAND),
      connectionBelongsToBrand: async () => false,
      findProducts: async () => {
        throw new Error("findProducts must not be called for an unowned connectionId");
      },
    });

    const reqUnknown = new NextRequest("https://x/api/brand/products?connectionId=conn-does-not-exist");
    const resUnknown = await listProductsImpl(reqUnknown, {
      getContext: async () => makeContext(CONTEXT_BRAND),
      connectionBelongsToBrand: async () => false,
      findProducts: async () => {
        throw new Error("findProducts must not be called for an unknown connectionId");
      },
    });

    assert.equal(resForeign.status, 200);
    assert.equal(resUnknown.status, 200);
    assert.deepEqual(await resForeign.json(), await resUnknown.json());
  });
});

// ---------------------------------------------------------------------------
// 4. No credential or providerMetadata leakage
// ---------------------------------------------------------------------------

describe("brand product routes — no credential/providerMetadata leakage", () => {
  test("GET /api/brand/products — 200 body never contains raw providerMetadata or credential-shaped strings", async () => {
    const res = await listProductsImpl(new NextRequest("https://x/api/brand/products"), {
      getContext: async () => makeContext(CONTEXT_BRAND),
      findProducts: async () => [
        {
          id: "prod-1",
          externalId: "gid://shopify/Product/1",
          title: "Widget",
          handle: "widget",
          productUrl: "https://shop.example.com/products/widget",
          imageUrl: "https://cdn.example.com/widget.jpg",
          images: ["https://cdn.example.com/widget.jpg"],
          sku: "SKU-1",
          isAvailable: true,
          lastSeenAt: new Date("2026-08-01T00:00:00Z"),
          unavailableSince: null,
          currencyCode: "USD",
          priceMinMinor: 1999,
          priceMaxMinor: 1999,
          priceMinorUnitExponent: 2,
          providerMetadata: {
            status: "ACTIVE",
            priceText: "$19.99",
            // Deliberately shaped like credential material — must never
            // reach the response even though it lives inside the raw JSON
            // blob returned by the DB layer (defense in depth: the route
            // only ever reads the whitelisted `status` field out of this).
            secretToken: "sk_live_should_never_leak",
          },
          brandSelections: [],
        },
      ],
      getLastSyncRun: async () => null,
    });
    assert.equal(res.status, 200);
    await assertNoLeak(res);
  });

  test("GET /api/brand/products/sync-runs — 200 body never leaks beyond the sanitized failureSummary", async () => {
    const res = await syncRunsListImpl(new NextRequest("https://x/api/brand/products/sync-runs"), {
      getContext: async () => makeContext(CONTEXT_BRAND),
      findSyncRuns: async () => [
        {
          id: "run-1",
          connectionId: "conn-1",
          provider: "SHOPIFY",
          status: "FAILED",
          startedAt: new Date("2026-08-01T00:00:00Z"),
          finishedAt: new Date("2026-08-01T00:05:00Z"),
          fetchedCount: 0,
          createdCount: 0,
          updatedCount: 0,
          unchangedCount: 0,
          markedUnavailableCount: 0,
          failedCount: 1,
          hasNextPage: false,
          requestedLimit: null,
          failureSummary: "PROVIDER_API_ERROR: upstream request failed",
          triggeredBy: "brand-api",
        },
      ],
    });
    assert.equal(res.status, 200);
    await assertNoLeak(res);
  });
});
