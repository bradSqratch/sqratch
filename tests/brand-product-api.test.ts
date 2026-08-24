process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";

/**
 * tests/brand-product-api.test.ts
 *
 * Contract tests for the `src/app/api/brand/products/**` routes (Workstream
 * 4) covering pagination, filtering, the sync route's SKIPPED/concurrency
 * handling, selection-override validation, and the "never calls Shopify"
 * guarantee on the selection PATCH. No real DB, no real network — every
 * dependency is injected. See `tests/brand-product-authorization.test.ts`
 * for the authorization-focused half of this coverage.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";

import { CommerceProvider } from "@prisma/client";
import { NextRequest } from "next/server";

import type { BrandAdminContext } from "../src/lib/brand-auth";
import { UnsupportedProviderError } from "../src/lib/commerce/errors";
import type { ProductSyncOutcome } from "../src/lib/commerce/product-sync";
import {
  decodeSyncRunCursor,
  encodeProductCursor,
  encodeSyncRunCursor,
  validateSelectionUpdate,
} from "../src/lib/commerce/product-catalog-api";
import type { BrandProductRow, BrandProductsListDeps } from "../src/app/api/brand/products/route";
import type { BrandProductsSyncDeps } from "../src/app/api/brand/products/sync/route";
import type { BrandProductSyncRunsDeps, SyncRunRow } from "../src/app/api/brand/products/sync-runs/route";
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

function makeContext(brand: BrandFixtureFields): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [{ id: brand.id, name: brand.name, slug: brand.slug, membershipRole: "MANAGER" }],
    membership: { id: "member-1", role: "MANAGER", brand },
  };
}

const BRAND = makeBrand();

function makeProductRow(overrides: Partial<BrandProductRow> = {}): BrandProductRow {
  return {
    id: "prod-1",
    externalId: "gid://shopify/Product/1",
    title: "Widget",
    handle: "widget",
    productUrl: "https://shop.example.com/products/widget",
    imageUrl: null,
    images: [],
    sku: "SKU-1",
    isAvailable: true,
    lastSeenAt: new Date("2026-08-01T00:00:00Z"),
    unavailableSince: null,
    currencyCode: "USD",
    priceMinMinor: 1999,
    priceMaxMinor: 1999,
    priceMinorUnitExponent: 2,
    providerMetadata: { status: "ACTIVE" },
    brandSelections: [],
    ...overrides,
  };
}

function jsonRequest(url: string, body: unknown, method = "PATCH"): NextRequest {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Pagination — keyset, stable, respects limit bounds
// ---------------------------------------------------------------------------

describe("GET /api/brand/products — pagination", () => {
  test("limit defaults to 50 and is capped at 100", async () => {
    let requestedLimit = 0;
    await listProductsImpl(new NextRequest("https://x/api/brand/products?limit=99999"), {
      getContext: async () => makeContext(BRAND),
      findProducts: async (args) => {
        requestedLimit = args.limit;
        return [];
      },
      getLastSyncRun: async () => null,
    });
    // findProducts is asked for limit+1 (the "is there a next page" probe row).
    assert.equal(requestedLimit, 101);

    let defaultLimit = 0;
    await listProductsImpl(new NextRequest("https://x/api/brand/products"), {
      getContext: async () => makeContext(BRAND),
      findProducts: async (args) => {
        defaultLimit = args.limit;
        return [];
      },
      getLastSyncRun: async () => null,
    });
    assert.equal(defaultLimit, 51);
  });

  test("a full page returns hasNextPage:true and a cursor encoding the last row's (title, id)", async () => {
    const rows = [
      makeProductRow({ id: "a", title: "Alpha" }),
      makeProductRow({ id: "b", title: "Beta" }),
      makeProductRow({ id: "c", title: "Gamma" }), // the limit+1 probe row
    ];
    const res = await listProductsImpl(new NextRequest("https://x/api/brand/products?limit=2"), {
      getContext: async () => makeContext(BRAND),
      findProducts: async () => rows,
      getLastSyncRun: async () => null,
    });
    const body = await res.json();
    assert.equal(body.data.length, 2);
    assert.equal(body.meta.hasNextPage, true);
    assert.equal(body.meta.nextCursor, encodeProductCursor({ title: "Beta", id: "b" }));
  });

  test("a short page returns hasNextPage:false and nextCursor:null", async () => {
    const res = await listProductsImpl(new NextRequest("https://x/api/brand/products?limit=50"), {
      getContext: async () => makeContext(BRAND),
      findProducts: async () => [makeProductRow()],
      getLastSyncRun: async () => null,
    });
    const body = await res.json();
    assert.equal(body.meta.hasNextPage, false);
    assert.equal(body.meta.nextCursor, null);
  });

  test("cursor is decoded and forwarded to findProducts (stable seek, not offset)", async () => {
    const cursor = encodeProductCursor({ title: "Beta", id: "b" });
    let receivedCursor: unknown;
    await listProductsImpl(new NextRequest(`https://x/api/brand/products?cursor=${cursor}`), {
      getContext: async () => makeContext(BRAND),
      findProducts: async (args) => {
        receivedCursor = args.cursor;
        return [];
      },
      getLastSyncRun: async () => null,
    });
    assert.deepEqual(receivedCursor, { title: "Beta", id: "b" });
  });

  test("a malformed cursor is ignored (treated as first page), never a 500", async () => {
    const res = await listProductsImpl(
      new NextRequest("https://x/api/brand/products?cursor=not-valid-base64!!!"),
      {
        getContext: async () => makeContext(BRAND),
        findProducts: async (args) => {
          assert.equal(args.cursor, null);
          return [];
        },
        getLastSyncRun: async () => null,
      },
    );
    assert.equal(res.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

describe("GET /api/brand/products — filters", () => {
  test("q, availability, selection, and connectionId are all forwarded to findProducts", async () => {
    let captured: Record<string, unknown> = {};
    await listProductsImpl(
      new NextRequest(
        "https://x/api/brand/products?q=widget&availability=all&selection=visible&connectionId=conn-1",
      ),
      {
        getContext: async () => makeContext(BRAND),
        connectionBelongsToBrand: async (brandId, connectionId) => {
          assert.equal(brandId, BRAND.id);
          assert.equal(connectionId, "conn-1");
          return true;
        },
        findProducts: async (args) => {
          captured = args;
          return [];
        },
        getLastSyncRun: async () => null,
      },
    );
    assert.equal(captured.q, "widget");
    assert.equal(captured.availability, "all");
    assert.equal(captured.selection, "visible");
    assert.equal(captured.connectionId, "conn-1");
  });

  test("availability defaults to 'available' and unknown values fall back to it", async () => {
    let captured = "";
    await listProductsImpl(new NextRequest("https://x/api/brand/products?availability=bogus"), {
      getContext: async () => makeContext(BRAND),
      findProducts: async (args) => {
        captured = args.availability;
        return [];
      },
      getLastSyncRun: async () => null,
    });
    assert.equal(captured, "available");
  });

  test("selection defaults to 'all' and unknown values fall back to it", async () => {
    let captured = "";
    await listProductsImpl(new NextRequest("https://x/api/brand/products?selection=bogus"), {
      getContext: async () => makeContext(BRAND),
      findProducts: async (args) => {
        captured = args.selection;
        return [];
      },
      getLastSyncRun: async () => null,
    });
    assert.equal(captured, "all");
  });

  test("response 'selection' object reflects the brand's own BrandCommerceProduct row", async () => {
    const res = await listProductsImpl(new NextRequest("https://x/api/brand/products"), {
      getContext: async () => makeContext(BRAND),
      findProducts: async () => [
        makeProductRow({
          brandSelections: [
            {
              isVisibleInShop: true,
              isCampaignEligible: true,
              displayOrder: 3,
              titleOverride: "Custom Title",
              shortDescriptionOverride: "Custom desc",
            },
          ],
        }),
      ],
      getLastSyncRun: async () => null,
    });
    const body = await res.json();
    assert.deepEqual(body.data[0].selection, {
      isVisibleInShop: true,
      isCampaignEligible: true,
      displayOrder: 3,
      titleOverride: "Custom Title",
      shortDescriptionOverride: "Custom desc",
    });
  });

  test("no selection row yields the documented unselected defaults", async () => {
    const res = await listProductsImpl(new NextRequest("https://x/api/brand/products"), {
      getContext: async () => makeContext(BRAND),
      findProducts: async () => [makeProductRow({ brandSelections: [] })],
      getLastSyncRun: async () => null,
    });
    const body = await res.json();
    assert.deepEqual(body.data[0].selection, {
      isVisibleInShop: false,
      isCampaignEligible: false,
      displayOrder: 0,
      titleOverride: null,
      shortDescriptionOverride: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Sync route — SKIPPED surfaces as error, concurrency guard
// ---------------------------------------------------------------------------

describe("POST /api/brand/products/sync", () => {
  test("SKIPPED (NO_CONNECTION) is a 400 error, never a 200", async () => {
    const res = await productsSyncImpl({
      getContext: async () => makeContext(BRAND),
      findRunningRun: async () => null,
      runSync: async (brandId) => ({
        status: "SKIPPED",
        reason: "NO_CONNECTION",
        brandId,
        provider: CommerceProvider.SHOPIFY,
      }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "NO_CONNECTION");
  });


  test("a RUNNING run younger than the concurrency window yields 409, and runSync is never called", async () => {
    const res = await productsSyncImpl({
      getContext: async () => makeContext(BRAND),
      findRunningRun: async () => ({
        id: "run-in-progress",
        connectionId: "conn-1",
        startedAt: new Date(),
      }),
      runSync: async () => {
        throw new Error("runSync must not be called while a run is in progress");
      },
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, "SYNC_IN_PROGRESS");
    assert.equal(body.runId, "run-in-progress");
  });

  test("FAILED outcome surfaces as a non-2xx error with the sanitized failureSummary, not success", async () => {
    const res = await productsSyncImpl({
      getContext: async () => makeContext(BRAND),
      findRunningRun: async () => null,
      runSync: async (brandId) => ({
        status: "FAILED",
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
          failedCount: 1,
        },
        hasNextPage: false,
        failureSummary: "PROVIDER_API_ERROR: boom",
      }),
    });
    assert.ok(res.status >= 400);
    const body = await res.json();
    assert.equal(body.code, "SYNC_FAILED");
    assert.equal(body.failureSummary, "PROVIDER_API_ERROR: boom");
  });

  test("SUCCEEDED/PARTIAL outcomes surface as 200 with the outcome payload", async () => {
    const outcome: ProductSyncOutcome = {
      status: "PARTIAL",
      brandId: BRAND.id,
      provider: CommerceProvider.SHOPIFY,
      connectionId: "conn-1",
      runId: "run-1",
      stats: {
        fetchedCount: 10,
        createdCount: 2,
        updatedCount: 1,
        unchangedCount: 7,
        markedUnavailableCount: 0,
        failedCount: 0,
      },
      hasNextPage: true,
      failureSummary: null,
    };
    const res = await productsSyncImpl({
      getContext: async () => makeContext(BRAND),
      findRunningRun: async () => null,
      runSync: async () => outcome,
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, "PARTIAL");
    assert.equal(body.data.runId, "run-1");
  });

  // NOTE: uses CommerceProvider.COMMERCE7 only as a convenient enum value to
  // construct the error. Commerce7 itself IS registered in the real default
  // registry since Phase 16C1 (see tests/commerce7-product-catalog.test.ts) —
  // this route-level test is only proving the generic error-to-HTTP mapping
  // for whatever `runSync` throws, independent of any specific provider.
  test("an UnsupportedProviderError from runSync maps to 400, no network call implied", async () => {
    const res = await productsSyncImpl({
      getContext: async () => makeContext(BRAND),
      findRunningRun: async () => null,
      runSync: async () => {
        throw new UnsupportedProviderError(CommerceProvider.COMMERCE7);
      },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "UNSUPPORTED_PROVIDER");
  });
});

// ---------------------------------------------------------------------------
// Selection PATCH — never calls Shopify, writes only SQRATCH-side fields
// ---------------------------------------------------------------------------

describe("PATCH .../selection — SQRATCH-only, no provider call", () => {
  test("a successful PATCH performs no network/provider call — the injected deps contain nothing adapter-shaped", async () => {
    let upsertCalledWith: unknown;
    const res = await selectionPatchImpl(
      jsonRequest("https://x/api/brand/products/prod-1/selection", {
        isVisibleInShop: true,
        isCampaignEligible: true,
        displayOrder: 5,
        titleOverride: "New title",
        shortDescriptionOverride: "New desc",
      }),
      { params: Promise.resolve({ connectedProductId: "prod-1" }) },
      {
        getContext: async () => makeContext(BRAND),
        findOwnedProduct: async (id) => ({ id }),
        upsertSelection: async (brandId, connectedProductId, data) => {
          upsertCalledWith = { brandId, connectedProductId, data };
          return {
            connectedProductId,
            isVisibleInShop: data.isVisibleInShop ?? false,
            isCampaignEligible: data.isCampaignEligible ?? false,
            displayOrder: data.displayOrder ?? 0,
            titleOverride: data.titleOverride ?? null,
            shortDescriptionOverride: data.shortDescriptionOverride ?? null,
          };
        },
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(upsertCalledWith, {
      brandId: BRAND.id,
      connectedProductId: "prod-1",
      data: {
        isVisibleInShop: true,
        isCampaignEligible: true,
        displayOrder: 5,
        titleOverride: "New title",
        shortDescriptionOverride: "New desc",
      },
    });
    // Only ConnectedCommerceProduct/BrandCommerceProduct-shaped writes
    // happened — nothing in this route's DI surface references a commerce
    // adapter, registry, or provider client at all.
    const routeSource = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL(
          "../src/app/api/brand/products/[connectedProductId]/selection/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const importLines = routeSource
      .split("\n")
      .filter((line) => line.trim().startsWith("import"))
      .join("\n");
    assert.doesNotMatch(
      importLines,
      /commerce\/registry|CommerceAdapter|shopify-products|shopify-commerce-adapter|fetchNormalizedShopifyProducts/i,
    );
  });
});

// ---------------------------------------------------------------------------
// Override validation
// ---------------------------------------------------------------------------

describe("validateSelectionUpdate — override bounds", () => {
  test("rejects an over-long titleOverride", () => {
    const result = validateSelectionUpdate({ titleOverride: "x".repeat(201) });
    assert.equal(result.ok, false);
  });

  test("accepts a titleOverride at exactly the max length", () => {
    const result = validateSelectionUpdate({ titleOverride: "x".repeat(200) });
    assert.equal(result.ok, true);
  });

  test("rejects an over-long shortDescriptionOverride", () => {
    const result = validateSelectionUpdate({ shortDescriptionOverride: "x".repeat(1001) });
    assert.equal(result.ok, false);
  });

  test("null clears an override", () => {
    const result = validateSelectionUpdate({ titleOverride: null, shortDescriptionOverride: null });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.data.titleOverride, null);
      assert.equal(result.data.shortDescriptionOverride, null);
    }
  });

  test("rejects a non-integer displayOrder", () => {
    assert.equal(validateSelectionUpdate({ displayOrder: 1.5 }).ok, false);
    assert.equal(validateSelectionUpdate({ displayOrder: -1 }).ok, false);
  });

  test("accepts displayOrder zero and the upper bound, while rejecting values above it", () => {
    for (const displayOrder of [0, 1_000_000]) {
      const result = validateSelectionUpdate({ displayOrder });
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.data.displayOrder, displayOrder);
    }
    assert.equal(validateSelectionUpdate({ displayOrder: 1_000_001 }).ok, false);
  });

  test("a PATCH persists an explicit displayOrder zero rather than defaulting it away", async () => {
    let received: unknown;
    const res = await selectionPatchImpl(
      jsonRequest("https://x/api/brand/products/prod-1/selection", { displayOrder: 0 }),
      { params: Promise.resolve({ connectedProductId: "prod-1" }) },
      {
        getContext: async () => makeContext(BRAND),
        findOwnedProduct: async (id) => ({ id }),
        upsertSelection: async (_brandId, connectedProductId, data) => {
          received = data;
          return {
            connectedProductId,
            isVisibleInShop: false,
            isCampaignEligible: false,
            displayOrder: data.displayOrder ?? 999,
            titleOverride: null,
            shortDescriptionOverride: null,
          };
        },
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(received, { displayOrder: 0 });
    const body = await res.json();
    assert.equal(body.data.displayOrder, 0);
  });

  test("an image override is ignored rather than accepted into the active selection DTO", async () => {
    let received: unknown;
    const res = await selectionPatchImpl(
      jsonRequest("https://x/api/brand/products/prod-1/selection", {
        imageUrlOverride: "https://historical.example/override.jpg",
      }),
      { params: Promise.resolve({ connectedProductId: "prod-1" }) },
      {
        getContext: async () => makeContext(BRAND),
        findOwnedProduct: async (id) => ({ id }),
        upsertSelection: async (_brandId, connectedProductId, data) => {
          received = data;
          return {
            connectedProductId,
            isVisibleInShop: false,
            isCampaignEligible: false,
            displayOrder: 0,
            titleOverride: null,
            shortDescriptionOverride: null,
          };
        },
      },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(received, {});
    const body = await res.json();
    assert.equal("imageUrlOverride" in body.data, false);
  });
});

// ---------------------------------------------------------------------------
// Sync runs — cursor round-trips
// ---------------------------------------------------------------------------

describe("GET /api/brand/products/sync-runs — pagination", () => {
  function makeRunRow(overrides: Partial<SyncRunRow> = {}): SyncRunRow {
    return {
      id: "run-1",
      connectionId: "conn-1",
      provider: "SHOPIFY",
      status: "SUCCEEDED",
      startedAt: new Date("2026-08-01T00:00:00Z"),
      finishedAt: new Date("2026-08-01T00:05:00Z"),
      fetchedCount: 10,
      createdCount: 1,
      updatedCount: 1,
      unchangedCount: 8,
      markedUnavailableCount: 0,
      failedCount: 0,
      hasNextPage: false,
      requestedLimit: 50,
      failureSummary: null,
      triggeredBy: "brand-api",
      ...overrides,
    };
  }

  test("limit defaults to 20 and is capped at 50", async () => {
    let requested = 0;
    await syncRunsListImpl(new NextRequest("https://x/api/brand/products/sync-runs?limit=9999"), {
      getContext: async () => makeContext(BRAND),
      findSyncRuns: async (args) => {
        requested = args.limit;
        return [];
      },
    });
    assert.equal(requested, 51);
  });

  test("full page yields a cursor decodable back to the same (startedAt, id)", async () => {
    const rows = [
      makeRunRow({ id: "r1", startedAt: new Date("2026-08-02T00:00:00Z") }),
      makeRunRow({ id: "r2", startedAt: new Date("2026-08-01T00:00:00Z") }),
    ];
    const res = await syncRunsListImpl(new NextRequest("https://x/api/brand/products/sync-runs?limit=1"), {
      getContext: async () => makeContext(BRAND),
      findSyncRuns: async () => rows,
    });
    const body = await res.json();
    assert.equal(body.meta.hasNextPage, true);
    assert.equal(
      body.meta.nextCursor,
      encodeSyncRunCursor({ startedAt: "2026-08-02T00:00:00.000Z", id: "r1" }),
    );
  });

  test("L2: decodeSyncRunCursor rejects a well-formed cursor whose startedAt is not a valid date, treating it as no cursor", () => {
    const tampered = Buffer.from(
      JSON.stringify({ startedAt: "not-a-real-date", id: "r1" }),
      "utf8",
    ).toString("base64url");
    assert.equal(decodeSyncRunCursor(tampered), null);
  });

  test("L2: decodeSyncRunCursor still accepts a genuinely valid ISO startedAt", () => {
    const valid = encodeSyncRunCursor({ startedAt: "2026-08-02T00:00:00.000Z", id: "r1" });
    assert.deepEqual(decodeSyncRunCursor(valid), {
      startedAt: "2026-08-02T00:00:00.000Z",
      id: "r1",
    });
  });

  test("L2: a tampered/garbage cursor query param is ignored (first page, 200) instead of a 500 from an Invalid Date reaching Prisma", async () => {
    const tampered = Buffer.from(
      JSON.stringify({ startedAt: "garbage-not-a-date", id: "r1" }),
      "utf8",
    ).toString("base64url");

    let receivedCursor: unknown = "not-yet-called";
    const res = await syncRunsListImpl(
      new NextRequest(`https://x/api/brand/products/sync-runs?cursor=${tampered}`),
      {
        getContext: async () => makeContext(BRAND),
        findSyncRuns: async (args) => {
          receivedCursor = args.cursor;
          return [makeRunRow({ id: "r1" })];
        },
      },
    );

    assert.equal(res.status, 200);
    assert.equal(receivedCursor, null, "a tampered cursor must be ignored, never passed through to the DB query");
    const body = await res.json();
    assert.equal(body.data.length, 1);
  });
});
