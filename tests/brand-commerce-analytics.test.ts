/**
 * tests/brand-commerce-analytics.test.ts
 *
 * Coverage for the Phase 11 BRAND-side click analytics endpoint,
 * src/app/api/brand/analytics/commerce/route.ts, driven through the ACTUAL
 * handler (`brandCommerceAnalyticsGetImpl`) using its injectable deps — the
 * same pattern as
 * tests/creator-lesson-product-routes-campaign-scoping.test.ts and
 * src/app/api/creator/lessons/[lessonId]/available-products/route.ts.
 *
 * NO DATABASE AND NO NETWORK. The repository double below is a faithful
 * in-memory implementation of the scope predicate: it filters rows by
 * `scope.attributedBrandIds` and by the inclusive range, and THROWS on any scope
 * kind other than ATTRIBUTED_BRAND. That makes cross-brand isolation a real
 * behavioural assertion rather than a source-text one — if the route ever
 * scoped on `brandId`, on an entry/product campaign, or on a brand it was not
 * authorized for, these tests would return the wrong rows or throw.
 *
 * The one thing a double cannot prove is the shape of the emitted SQL, so the
 * "never summed" and "never reads abuse-control columns" invariants are pinned
 * with source-inspection tripwires in the style of
 * tests/commerce-click-attribution.test.ts.
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.NEXTAUTH_SECRET = "test-nextauth-secret";

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import type { BrandAdminContext } from "../src/lib/brand-auth";
import type {
  BrandCommerceAnalyticsData,
  BrandCommerceAnalyticsDeps,
} from "../src/app/api/brand/analytics/commerce/route";
import type {
  CommerceClickAnalyticsQuery,
  CommerceClickAnalyticsRepository,
  CommerceClickAnalyticsScope,
} from "../src/lib/commerce/commerce-click-analytics-repository";

let getImpl: (
  request: NextRequest,
  overrides?: Partial<BrandCommerceAnalyticsDeps>,
) => Promise<Response>;

const ROUTE_PATH = "src/app/api/brand/analytics/commerce/route.ts";
const PAGE_PATH = "src/app/(withSidebar)/dashboard/brand/analytics/page.tsx";

const routeSource = readFileSync(join(process.cwd(), ROUTE_PATH), "utf8");
const pageSource = readFileSync(join(process.cwd(), PAGE_PATH), "utf8");

before(async () => {
  const mod = await import("../src/app/api/brand/analytics/commerce/route");
  getImpl = mod.brandCommerceAnalyticsGetImpl;
});

/* ------------------------------------------------------------------ fixtures */

const BRAND_A = "brand-a";
const BRAND_B = "brand-b";

/** Fixed reference time so every default range is deterministic. */
const NOW = new Date("2026-03-15T12:00:00.000Z");

type ClickRow = {
  attributedBrandId: string;
  entryCampaignId: string | null;
  productCampaignId: string | null;
  entryCampaignContextResolved: boolean;
  surface: "BRAND_STOREFRONT" | "CAMPAIGN_PRODUCT" | "LESSON" | null;
  provider: "SHOPIFY" | "COMMERCE7" | null;
  brandCommerceProductId: string | null;
  connectedProductId: string | null;
  experienceId: string | null;
  lessonId: string | null;
  creatorProfileId: string | null;
  qrCodeId: string | null;
  sessionId: string | null;
  userId: string | null;
  createdAt: Date;
};

function click(overrides: Partial<ClickRow> = {}): ClickRow {
  return {
    attributedBrandId: BRAND_A,
    entryCampaignId: null,
    productCampaignId: null,
    entryCampaignContextResolved: false,
    surface: "BRAND_STOREFRONT",
    provider: "SHOPIFY",
    brandCommerceProductId: "bcp-a1",
    connectedProductId: "connected-a1",
    experienceId: "experience-1",
    lessonId: null,
    creatorProfileId: "creator-1",
    qrCodeId: null,
    sessionId: "session-1",
    userId: null,
    createdAt: new Date("2026-03-10T09:00:00.000Z"),
    ...overrides,
  };
}

/**
 * Campaign ownership as the live `Campaign` table would report it. Brand B's
 * campaigns are present here on purpose: the ownership READ is legitimate, and
 * the test's job is to prove nothing from those rows reaches Brand A's payload.
 */
const CAMPAIGN_OWNERS = [
  { id: "campaign-a1", name: "Acme Spring Drop", brandId: BRAND_A },
  { id: "campaign-a2", name: "Acme Loyalty Push", brandId: BRAND_A },
  { id: "campaign-b1", name: "Rival Summer Push", brandId: BRAND_B },
  { id: "campaign-b2", name: "Rival Winter Push", brandId: BRAND_B },
  { id: "campaign-orphan", name: "Legacy Unbranded", brandId: null },
];

const PRODUCT_NAMES = [
  { id: "bcp-a1", brandId: BRAND_A, name: "Reserve Cabernet" },
  { id: "bcp-a2", brandId: BRAND_A, name: "Estate Rose" },
  { id: "bcp-b1", brandId: BRAND_B, name: "Rival Merlot" },
];

const EXPERIENCE_NAMES = [
  { id: "experience-1", name: "Cellar Tour" },
  { id: "experience-2", name: "Harvest Walk" },
];

const LESSON_NAMES = [{ id: "lesson-1", name: "Tasting Basics" }];

function brandContext(brandId: string): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [
      { id: brandId, name: "Acme", slug: "acme", membershipRole: "ADMIN" },
    ],
    membership: {
      id: "membership-1",
      role: "ADMIN",
      brand: {
        id: brandId,
        name: "Acme",
        slug: "acme",
        bio: null,
        websiteUrl: null,
        logoUrl: null,
        coverImageUrl: null,
        shopifyShopDomain: null,
        shopifyAdminAccessTokenEncrypted: null,
        shopifyInstalledAt: null,
        shopifyDisconnectedAt: null,
        shopifyUninstalledAt: null,
        shopifyConnectionStatus: "CONNECTED",
        shopifyLastProductSyncAt: null,
        shopifyCurrencyCode: null,
      },
    },
  };
}

/* --------------------------------------------------------- repository double */

type Recorder = { scopes: CommerceClickAnalyticsScope[] };

function buildRepositoryDouble(
  rows: readonly ClickRow[],
  recorder: Recorder,
): CommerceClickAnalyticsRepository {
  function inScope(query: CommerceClickAnalyticsQuery): ClickRow[] {
    // A brand read that is not scoped on the durable attribution snapshot is a
    // bug, not a variation. Fail loudly rather than quietly returning data.
    if (query.scope.kind !== "ATTRIBUTED_BRAND") {
      throw new Error(`Unexpected scope kind: ${query.scope.kind}`);
    }
    recorder.scopes.push(query.scope);

    const ids = new Set(query.scope.attributedBrandIds);
    return rows.filter(
      (row) =>
        ids.has(row.attributedBrandId) &&
        row.createdAt >= query.range.start &&
        row.createdAt <= query.range.end,
    );
  }

  function groupById(
    query: CommerceClickAnalyticsQuery,
    key: (row: ClickRow) => string | null,
  ) {
    const totals = new Map<string | null, number>();
    for (const row of inScope(query)) {
      const value = key(row);
      totals.set(value, (totals.get(value) ?? 0) + 1);
    }
    return [...totals.entries()].map(([id, count]) => ({ id, count }));
  }

  function distinct(
    query: CommerceClickAnalyticsQuery,
    key: (row: ClickRow) => string | null,
  ) {
    const values = new Set<string>();
    for (const row of inScope(query)) {
      const value = key(row);
      if (value !== null) values.add(value);
    }
    return { value: values.size, truncated: false };
  }

  return {
    async countClicks(query) {
      return inScope(query).length;
    },
    async countDistinctSessions(query) {
      return distinct(query, (row) => row.sessionId);
    },
    async countDistinctUsers(query) {
      return distinct(query, (row) => row.userId);
    },
    async countByEntryResolution(query) {
      const totals = new Map<boolean, number>();
      for (const row of inScope(query)) {
        totals.set(
          row.entryCampaignContextResolved,
          (totals.get(row.entryCampaignContextResolved) ?? 0) + 1,
        );
      }
      return [...totals.entries()].map(
        ([entryCampaignContextResolved, count]) => ({
          entryCampaignContextResolved,
          count,
        }),
      );
    },
    async groupBySurface(query) {
      const totals = new Map<ClickRow["surface"], number>();
      for (const row of inScope(query)) {
        totals.set(row.surface, (totals.get(row.surface) ?? 0) + 1);
      }
      return [...totals.entries()].map(([surface, count]) => ({ surface, count }));
    },
    async groupByProvider(query) {
      const totals = new Map<ClickRow["provider"], number>();
      for (const row of inScope(query)) {
        totals.set(row.provider, (totals.get(row.provider) ?? 0) + 1);
      }
      return [...totals.entries()].map(([provider, count]) => ({ provider, count }));
    },
    async groupByEntryCampaign(query) {
      return groupById(query, (row) => row.entryCampaignId);
    },
    async groupByProductCampaign(query) {
      return groupById(query, (row) => row.productCampaignId);
    },
    async groupByBrandCommerceProduct(query) {
      return groupById(query, (row) => row.brandCommerceProductId);
    },
    async groupByConnectedProduct(query) {
      return groupById(query, (row) => row.connectedProductId);
    },
    async groupByExperience(query) {
      return groupById(query, (row) => row.experienceId);
    },
    async groupByLesson(query) {
      return groupById(query, (row) => row.lessonId);
    },
    async groupByCreatorProfile(query) {
      return groupById(query, (row) => row.creatorProfileId);
    },
    async groupByQrCode(query) {
      return groupById(query, (row) => row.qrCodeId);
    },
    async listClickTimestamps(query) {
      return {
        timestamps: inScope(query)
          .map((row) => ({ createdAt: row.createdAt }))
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()),
        truncated: false,
      };
    },
  };
}

/* -------------------------------------------------------------- test harness */

function deps(input: {
  rows?: readonly ClickRow[];
  recorder?: Recorder;
  overrides?: Partial<BrandCommerceAnalyticsDeps>;
} = {}): Partial<BrandCommerceAnalyticsDeps> {
  const recorder = input.recorder ?? { scopes: [] };

  return {
    getBrandContext: async () => brandContext(BRAND_A),
    repository: buildRepositoryDouble(input.rows ?? [], recorder),
    loadCampaignOwners: async (ids) =>
      CAMPAIGN_OWNERS.filter((campaign) => ids.includes(campaign.id)),
    loadBrandProducts: async ({ ids, brandId }) =>
      PRODUCT_NAMES.filter(
        (product) => ids.includes(product.id) && product.brandId === brandId,
      ).map((product) => ({ id: product.id, name: product.name })),
    loadExperiences: async (ids) =>
      EXPERIENCE_NAMES.filter((entity) => ids.includes(entity.id)),
    loadLessons: async (ids) => LESSON_NAMES.filter((entity) => ids.includes(entity.id)),
    now: () => NOW,
    ...input.overrides,
  };
}

function request(search = "") {
  return new NextRequest(
    `https://sqratch.test/api/brand/analytics/commerce${search}`,
  );
}

async function call(input: {
  rows?: readonly ClickRow[];
  recorder?: Recorder;
  overrides?: Partial<BrandCommerceAnalyticsDeps>;
  search?: string;
} = {}) {
  const response = await getImpl(request(input.search ?? ""), deps(input));
  const body = (await response.json()) as
    | { data: BrandCommerceAnalyticsData }
    | { error: string; code?: string };
  return { response, body };
}

function expectData(body: unknown): BrandCommerceAnalyticsData {
  assert.ok(
    body !== null && typeof body === "object" && "data" in body,
    `Expected a data payload, received ${JSON.stringify(body)}`,
  );
  return (body as { data: BrandCommerceAnalyticsData }).data;
}

/* ------------------------------------------------------------------- 1. auth */

describe("authorization", () => {
  test("an unauthenticated or wrong-role caller is refused with 403 and no analytics", async () => {
    const { response, body } = await call({
      overrides: { getBrandContext: async () => null },
    });

    assert.equal(response.status, 403);
    assert.deepEqual(body, { error: "Brand admin access required." });
    assert.ok(!("data" in body));
  });

  test("an administrator with no active brand selected is refused with 409", async () => {
    const { response, body } = await call({
      overrides: {
        getBrandContext: async () => ({
          userId: "user-1",
          selectionRequired: true,
          brands: [],
          membership: null,
        }),
      },
    });

    assert.equal(response.status, 409);
    assert.deepEqual(body, {
      error: "Select an active brand before continuing.",
      code: "ACTIVE_BRAND_REQUIRED",
    });
  });

  test("the scope is always the session's brand; a brandId query parameter is ignored", async () => {
    const recorder: Recorder = { scopes: [] };
    const { response } = await call({
      rows: [click(), click({ attributedBrandId: BRAND_B })],
      recorder,
      search: `?brandId=${BRAND_B}`,
    });

    assert.equal(response.status, 200);
    assert.ok(recorder.scopes.length > 0);
    for (const scope of recorder.scopes) {
      assert.equal(scope.kind, "ATTRIBUTED_BRAND");
      assert.deepEqual(
        scope.kind === "ATTRIBUTED_BRAND" ? [...scope.attributedBrandIds] : null,
        [BRAND_A],
      );
    }
    // The route never reads a caller-supplied brand id at all.
    assert.doesNotMatch(routeSource, /searchParams\.get\(\s*"brandId"\s*\)/);
  });
});

/* -------------------------------------------------- 2. cross-brand isolation */

describe("cross-brand isolation", () => {
  test("Brand A never sees clicks attributed to Brand B", async () => {
    const { response, body } = await call({
      rows: [
        click({ createdAt: new Date("2026-03-01T00:00:00.000Z") }),
        click({ createdAt: new Date("2026-03-02T00:00:00.000Z") }),
        click({
          attributedBrandId: BRAND_B,
          brandCommerceProductId: "bcp-b1",
          experienceId: "experience-2",
          createdAt: new Date("2026-03-03T00:00:00.000Z"),
        }),
        click({
          attributedBrandId: BRAND_B,
          brandCommerceProductId: "bcp-b1",
          createdAt: new Date("2026-03-04T00:00:00.000Z"),
        }),
      ],
    });

    assert.equal(response.status, 200);
    const data = expectData(body);

    assert.equal(data.totals.clicks, 2);
    assert.deepEqual(
      data.topProducts.map((row) => row.id),
      ["bcp-a1"],
    );
    assert.deepEqual(
      data.topExperiences.map((row) => row.id),
      ["experience-1"],
    );

    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /bcp-b1/);
    assert.doesNotMatch(serialized, /Rival Merlot/);
    assert.doesNotMatch(serialized, /experience-2/);
  });

  test("a product name is only ever resolved from the authorized brand's own catalog", async () => {
    const seen: Array<{ ids: readonly string[]; brandId: string }> = [];
    await call({
      rows: [click(), click({ brandCommerceProductId: "bcp-a2" })],
      overrides: {
        loadBrandProducts: async (input) => {
          seen.push({ ids: [...input.ids], brandId: input.brandId });
          return [];
        },
      },
    });

    assert.equal(seen.length, 1);
    assert.equal(seen[0].brandId, BRAND_A);
    // Belt and braces: the query itself is brand-scoped in the default deps.
    assert.match(routeSource, /prisma\.brandCommerceProduct\.findMany\(/);
    assert.match(routeSource, /where: \{ id: \{ in: \[\.\.\.ids\] \}, brandId \}/);
  });
});

/* --------------------------------------- 3. MULTI-SPONSOR PRIVACY (critical) */

describe("multi-sponsor entry-campaign privacy", () => {
  /**
   * The scenario this endpoint exists to get right: a visitor is acquired by a
   * COMPETITOR's campaign, lands on a shared Experience, and clicks THIS
   * brand's product. The click belongs to this brand and must be counted in
   * full. The competitor's campaign identity must not appear anywhere.
   */
  const rows = [
    // Own acquisition.
    click({
      entryCampaignId: "campaign-a1",
      entryCampaignContextResolved: true,
      createdAt: new Date("2026-03-05T00:00:00.000Z"),
    }),
    // Acquired by Brand B's campaign, clicked Brand A's product.
    click({
      entryCampaignId: "campaign-b1",
      entryCampaignContextResolved: true,
      surface: "CAMPAIGN_PRODUCT",
      createdAt: new Date("2026-03-06T00:00:00.000Z"),
    }),
    click({
      entryCampaignId: "campaign-b1",
      entryCampaignContextResolved: true,
      surface: "CAMPAIGN_PRODUCT",
      createdAt: new Date("2026-03-06T01:00:00.000Z"),
    }),
    // A second, different competitor campaign.
    click({
      entryCampaignId: "campaign-b2",
      entryCampaignContextResolved: true,
      surface: "LESSON",
      lessonId: "lesson-1",
      createdAt: new Date("2026-03-07T00:00:00.000Z"),
    }),
  ];

  test("competitor-acquired clicks are counted in full", async () => {
    const { response, body } = await call({ rows });
    assert.equal(response.status, 200);
    const data = expectData(body);

    assert.equal(data.totals.clicks, 4);
    assert.equal(data.totals.campaignEntryClicks, 4);
    assert.equal(data.totals.directEntryClicks, 0);
    assert.equal(data.surfaceBreakdown.BRAND_STOREFRONT, 1);
    assert.equal(data.surfaceBreakdown.CAMPAIGN_PRODUCT, 2);
    assert.equal(data.surfaceBreakdown.LESSON, 1);
  });

  test("a competitor's entry campaign is never named, never identified, and is collapsed into ONE bucket", async () => {
    const { body } = await call({ rows });
    const data = expectData(body);

    const own = data.entryCampaignBreakdown.filter(
      (row) => row.disclosure === "OWN",
    );
    assert.deepEqual(
      own.map((row) => ({ id: row.campaignId, clicks: row.clicks })),
      [{ id: "campaign-a1", clicks: 1 }],
    );

    const other = data.entryCampaignBreakdown.filter(
      (row) => row.disclosure === "OTHER_CAMPAIGN",
    );
    // ONE row, not two. Two anonymous rows would still disclose that exactly
    // two distinct competitor campaigns sent traffic.
    assert.equal(other.length, 1);
    assert.equal(other[0].clicks, 3);
    assert.equal(other[0].campaignId, null);
    assert.equal(other[0].campaignName, null);
    assert.equal(other[0].label, "OTHER_CAMPAIGN");

    // The whole payload is searched, not just the breakdown: no competitor
    // campaign id, campaign name or brand id may appear anywhere at all.
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /campaign-b1/);
    assert.doesNotMatch(serialized, /campaign-b2/);
    assert.doesNotMatch(serialized, /Rival Summer Push/);
    assert.doesNotMatch(serialized, /Rival Winter Push/);
    assert.doesNotMatch(serialized, new RegExp(BRAND_B));
  });

  test("an entry campaign with no owning brand is bucketed, never named", async () => {
    const { body } = await call({
      rows: [
        click({
          entryCampaignId: "campaign-orphan",
          entryCampaignContextResolved: true,
        }),
      ],
    });
    const data = expectData(body);

    assert.equal(data.entryCampaignBreakdown.length, 1);
    assert.equal(data.entryCampaignBreakdown[0].disclosure, "NONE");
    assert.equal(data.entryCampaignBreakdown[0].campaignId, null);
    assert.doesNotMatch(JSON.stringify(body), /Legacy Unbranded/);
  });

  test("an entry campaign whose owner cannot be resolved fails CLOSED to the generic bucket", async () => {
    const { body } = await call({
      rows: [
        click({
          entryCampaignId: "campaign-deleted",
          entryCampaignContextResolved: true,
        }),
      ],
    });
    const data = expectData(body);

    assert.equal(data.entryCampaignBreakdown.length, 1);
    assert.equal(data.entryCampaignBreakdown[0].disclosure, "OTHER_CAMPAIGN");
    assert.doesNotMatch(JSON.stringify(body), /campaign-deleted/);
  });

  test("the route applies the shared disclosure helper rather than hand-rolling redaction", () => {
    assert.match(routeSource, /discloseEntryCampaign\(\{/);
    assert.match(routeSource, /authorizedBrandId: input\.authorizedBrandId/);
    assert.match(routeSource, /entryCampaignBrandId: owner\.brandId/);
  });
});

/* ------------------------------- 4. product-campaign drift defense-in-depth */

describe("product-campaign disclosure", () => {
  test("own product campaigns are named; a campaign that has drifted to another brand is bucketed", async () => {
    const { body } = await call({
      rows: [
        click({ productCampaignId: "campaign-a1" }),
        click({ productCampaignId: "campaign-a1" }),
        // Drift: an administrator reassigned this campaign to Brand B after the
        // click was recorded. The stale name is now neither correct nor ours.
        click({ productCampaignId: "campaign-b1" }),
      ],
    });
    const data = expectData(body);

    assert.deepEqual(
      data.productCampaignBreakdown.map((row) => ({
        disclosure: row.disclosure,
        campaignId: row.campaignId,
        campaignName: row.campaignName,
        clicks: row.clicks,
      })),
      [
        {
          disclosure: "OWN",
          campaignId: "campaign-a1",
          campaignName: "Acme Spring Drop",
          clicks: 2,
        },
        {
          disclosure: "OTHER_CAMPAIGN",
          campaignId: null,
          campaignName: null,
          clicks: 1,
        },
      ],
    );
    assert.doesNotMatch(JSON.stringify(body), /Rival Summer Push/);
  });
});

/* -------------------------------------- 5. entry vs product are never summed */

describe("entry and product campaign breakdowns stay separate", () => {
  test("one click carrying both campaign kinds is reported once per breakdown and never added", async () => {
    const { body } = await call({
      rows: [
        click({
          entryCampaignId: "campaign-a1",
          productCampaignId: "campaign-a2",
          entryCampaignContextResolved: true,
        }),
      ],
    });
    const data = expectData(body);

    // The same single click appears in both breakdowns...
    assert.equal(
      data.entryCampaignBreakdown.reduce((sum, row) => sum + row.clicks, 0),
      1,
    );
    assert.equal(
      data.productCampaignBreakdown.reduce((sum, row) => sum + row.clicks, 0),
      1,
    );
    // ...and the headline total is still 1, not 2.
    assert.equal(data.totals.clicks, 1);

    // Two separate keys, two separate discriminants, no merged key.
    assert.ok(Array.isArray(data.entryCampaignBreakdown));
    assert.ok(Array.isArray(data.productCampaignBreakdown));
    for (const row of data.entryCampaignBreakdown) {
      assert.equal(row.kind, "ENTRY_CAMPAIGN");
    }
    for (const row of data.productCampaignBreakdown) {
      assert.equal(row.kind, "PRODUCT_CAMPAIGN");
    }
    assert.ok(!("campaignBreakdown" in data));
  });

  test("tripwire: no source expression combines the two breakdowns", () => {
    assert.doesNotMatch(routeSource, /entryCampaign\w*\s*\+\s*productCampaign/i);
    assert.doesNotMatch(routeSource, /productCampaign\w*\s*\+\s*entryCampaign/i);
    assert.doesNotMatch(
      routeSource,
      /\.\.\.entryCampaignBreakdown[\s\S]{0,80}\.\.\.productCampaignBreakdown/,
    );
    assert.doesNotMatch(
      routeSource,
      /\.\.\.productCampaignBreakdown[\s\S]{0,80}\.\.\.entryCampaignBreakdown/,
    );
    assert.doesNotMatch(routeSource, /entryCampaignBreakdown\.concat\(/);
    assert.doesNotMatch(routeSource, /productCampaignBreakdown\.concat\(/);
    // Two distinct repository reads, never one reused for both meanings.
    assert.match(routeSource, /groupByEntryCampaign\(query\)/);
    assert.match(routeSource, /groupByProductCampaign\(query\)/);
  });
});

/* ------------------------------------------------------------ 6. empty state */

describe("empty brand", () => {
  test("a brand with no clicks gets a clean zeroed 200, never a 404 or 500", async () => {
    const { response, body } = await call({ rows: [] });

    assert.equal(response.status, 200);
    const data = expectData(body);

    assert.equal(data.totals.clicks, 0);
    assert.deepEqual(data.totals.uniqueSessions, { value: 0, truncated: false });
    assert.deepEqual(data.totals.uniqueUsers, { value: 0, truncated: false });
    assert.equal(data.totals.campaignEntryClicks, 0);
    assert.equal(data.totals.directEntryClicks, 0);
    assert.deepEqual(data.surfaceBreakdown, {
      BRAND_STOREFRONT: 0,
      CAMPAIGN_PRODUCT: 0,
      LESSON: 0,
      UNKNOWN: 0,
    });
    assert.deepEqual(data.providerBreakdown, []);
    assert.deepEqual(data.entryCampaignBreakdown, []);
    assert.deepEqual(data.productCampaignBreakdown, []);
    assert.deepEqual(data.topProducts, []);
    assert.deepEqual(data.topExperiences, []);
    assert.deepEqual(data.topLessons, []);
    // A zero-filled 30-day series, not an empty array: a gap-free chart cannot
    // interpolate a quiet week into a busy one.
    assert.equal(data.timeSeries.length, 30);
    assert.equal(
      data.timeSeries.every((point) => point.clicks === 0),
      true,
    );
    assert.equal(data.timeSeriesTruncated, false);
  });
});

/* ---------------------------------------------------- 7. totals correctness */

describe("totals and breakdowns over a constructed fixture", () => {
  const rows = [
    click({
      sessionId: "s1",
      userId: "u1",
      entryCampaignId: "campaign-a1",
      entryCampaignContextResolved: true,
      surface: "CAMPAIGN_PRODUCT",
      provider: "SHOPIFY",
      brandCommerceProductId: "bcp-a1",
      experienceId: "experience-1",
      createdAt: new Date("2026-03-10T01:00:00.000Z"),
    }),
    click({
      sessionId: "s1",
      userId: "u1",
      surface: null,
      provider: null,
      brandCommerceProductId: "bcp-a1",
      experienceId: "experience-1",
      createdAt: new Date("2026-03-10T02:00:00.000Z"),
    }),
    click({
      sessionId: "s2",
      userId: null,
      surface: "LESSON",
      lessonId: "lesson-1",
      provider: "COMMERCE7",
      brandCommerceProductId: "bcp-a2",
      experienceId: "experience-2",
      createdAt: new Date("2026-03-11T03:00:00.000Z"),
    }),
    click({
      sessionId: null,
      userId: "u2",
      surface: "LESSON",
      lessonId: "lesson-1",
      provider: "COMMERCE7",
      brandCommerceProductId: "bcp-a2",
      experienceId: "experience-2",
      createdAt: new Date("2026-03-11T04:00:00.000Z"),
    }),
  ];

  test("headline totals, splits and buckets match the fixture exactly", async () => {
    const { body } = await call({ rows });
    const data = expectData(body);

    assert.equal(data.totals.clicks, 4);
    // s1 twice, s2 once, one null session that is not a visitor.
    assert.deepEqual(data.totals.uniqueSessions, { value: 2, truncated: false });
    assert.deepEqual(data.totals.uniqueUsers, { value: 2, truncated: false });
    assert.equal(data.totals.campaignEntryClicks, 1);
    assert.equal(data.totals.directEntryClicks, 3);

    assert.deepEqual(data.surfaceBreakdown, {
      BRAND_STOREFRONT: 0,
      CAMPAIGN_PRODUCT: 1,
      LESSON: 2,
      // A null surface is reported honestly as unknown, never inferred.
      UNKNOWN: 1,
    });

    assert.deepEqual(data.providerBreakdown, [
      { provider: "COMMERCE7", clicks: 2 },
      { provider: "SHOPIFY", clicks: 1 },
      { provider: "UNKNOWN", clicks: 1 },
    ]);

    assert.deepEqual(data.topProducts, [
      { id: "bcp-a1", name: "Reserve Cabernet", clicks: 2 },
      { id: "bcp-a2", name: "Estate Rose", clicks: 2 },
    ]);
    assert.deepEqual(data.topExperiences, [
      { id: "experience-1", name: "Cellar Tour", clicks: 2 },
      { id: "experience-2", name: "Harvest Walk", clicks: 2 },
    ]);
    assert.deepEqual(data.topLessons, [
      { id: "lesson-1", name: "Tasting Basics", clicks: 2 },
    ]);
  });

  test("the daily series buckets in UTC, fills gaps with zero, and sums to the total", async () => {
    const { body } = await call({
      rows,
      search: "?dateFrom=2026-03-09&dateTo=2026-03-12",
    });
    const data = expectData(body);

    assert.deepEqual(data.timeSeries, [
      { date: "2026-03-09", clicks: 0 },
      { date: "2026-03-10", clicks: 2 },
      { date: "2026-03-11", clicks: 2 },
      { date: "2026-03-12", clicks: 0 },
    ]);
    assert.equal(
      data.timeSeries.reduce((sum, point) => sum + point.clicks, 0),
      data.totals.clicks,
    );
    assert.equal(data.range.start, "2026-03-09T00:00:00.000Z");
    assert.equal(data.range.end, "2026-03-12T23:59:59.999Z");
  });

  test("a truncated distinct count and a truncated series are surfaced, not hidden", async () => {
    const recorder: Recorder = { scopes: [] };
    const base = buildRepositoryDouble(rows, recorder);
    const { body } = await call({
      rows,
      overrides: {
        repository: {
          ...base,
          countDistinctSessions: async () => ({ value: 100_000, truncated: true }),
          listClickTimestamps: async (query) => ({
            ...(await base.listClickTimestamps(query)),
            truncated: true,
          }),
        },
      },
    });
    const data = expectData(body);

    assert.deepEqual(data.totals.uniqueSessions, {
      value: 100_000,
      truncated: true,
    });
    assert.equal(data.timeSeriesTruncated, true);
  });
});

/* -------------------------------------------------------- 8. parameter rules */

describe("query parameter validation", () => {
  test("a malformed date is a 400 with a clear message, not a silent default", async () => {
    const { response, body } = await call({ search: "?dateFrom=2026-13-01" });
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "dateFrom must be a valid YYYY-MM-DD date." });
  });

  test("an inverted range is a 400 rather than being silently swapped", async () => {
    const { response, body } = await call({
      search: "?dateFrom=2026-03-10&dateTo=2026-03-01",
    });
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "dateTo must not be earlier than dateFrom." });
  });

  test("an over-wide range is refused rather than quietly clamped", async () => {
    const { response, body } = await call({
      search: "?dateFrom=2020-01-01&dateTo=2026-01-01",
    });
    assert.equal(response.status, 400);
    assert.match(
      (body as { error: string }).error,
      /the maximum is 400\.$/,
    );
  });

  test("a non-numeric limit is a 400", async () => {
    const { response, body } = await call({ search: "?limit=abc" });
    assert.equal(response.status, 400);
    assert.deepEqual(body, { error: "limit must be a positive whole number." });
  });

  test("limit is honoured, and an oversized limit is clamped rather than trusted", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      click({
        brandCommerceProductId: `bcp-${String(index).padStart(2, "0")}`,
      }),
    );

    const small = await call({ rows: many, search: "?limit=3" });
    assert.equal(expectData(small.body).topProducts.length, 3);

    const clamped = await call({ rows: many, search: "?limit=9999" });
    assert.equal(expectData(clamped.body).limit, 50);
    assert.equal(expectData(clamped.body).topProducts.length, 12);
  });

  test("the default top-N applies when no limit is supplied", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      click({
        brandCommerceProductId: `bcp-${String(index).padStart(2, "0")}`,
      }),
    );
    const { body } = await call({ rows: many });
    assert.equal(expectData(body).limit, 10);
    assert.equal(expectData(body).topProducts.length, 10);
  });
});

/* --------------------------------------------- 9. boundary / vocabulary pins */

describe("response boundary tripwires", () => {
  test("no abuse-control or destination column is read or serialized", () => {
    for (const forbidden of [
      "ipHash",
      "tokenHash",
      "tokenPrefix",
      "destinationUrl",
      "destinationHost",
      "userAgent",
      "referrer",
    ]) {
      assert.doesNotMatch(
        routeSource,
        new RegExp(forbidden),
        `${ROUTE_PATH} must never mention ${forbidden}`,
      );
    }

    // Session and user identity exist here only as pre-computed distinct counts.
    assert.doesNotMatch(routeSource, /\bsessionId\b/);
    assert.doesNotMatch(routeSource, /\buserId\b/);
    assert.match(routeSource, /countDistinctSessions\(query\)/);
    assert.match(routeSource, /countDistinctUsers\(query\)/);
  });

  test("no order relation or post-click outcome vocabulary appears in the route", () => {
    for (const forbidden of [
      /\brevenue\b/i,
      /\bsales\b/i,
      /\bconversions?\b/i,
      /\bROAS\b/i,
      /\bpurchases?\b/i,
      /\bcommissions?\b/i,
      /commerceOrder/i,
      /order value/i,
    ]) {
      assert.doesNotMatch(routeSource, forbidden, `${ROUTE_PATH} matched ${forbidden}`);
    }
  });

  test("the brand dashboard shows the click-only note and no outcome metric", () => {
    assert.match(
      pageSource,
      /Commerce analytics currently measures outbound product clicks\. Order and\s*\n?\s*revenue attribution are not enabled\./,
    );

    // Everything except that one mandated sentence must be free of outcome
    // vocabulary, so the disclaimer is the ONLY place those words can appear.
    const withoutNote = pageSource.replace(
      /Commerce analytics currently measures outbound product clicks\.[\s\S]{0,80}?not enabled\./,
      "",
    );
    for (const forbidden of [
      /\brevenue\b/i,
      /\bsales\b/i,
      /\bconversions?\b/i,
      /\bROAS\b/i,
      /\bpurchases?\b/i,
      /\bcommissions?\b/i,
      /\border(s| value)\b/i,
    ]) {
      assert.doesNotMatch(withoutNote, forbidden, `${PAGE_PATH} matched ${forbidden}`);
    }
  });

  test("the dashboard labels entry and product campaigns distinctly", () => {
    assert.match(pageSource, /Entry campaign/);
    assert.match(pageSource, /Product campaign/);
    assert.match(pageSource, /entryCampaignBreakdown/);
    assert.match(pageSource, /productCampaignBreakdown/);
  });
});

/* ------------------------------------ 10. the pre-existing route is untouched */

describe("the existing brand analytics route is unaffected", () => {
  test("its narrow shopClicks metric still keys on the trusted entry campaign", () => {
    const existing = readFileSync(
      join(process.cwd(), "src/app/api/brand/analytics/route.ts"),
      "utf8",
    );
    assert.match(existing, /by: \["entryCampaignId"\]/);
    assert.match(existing, /shopClicks/);
    // The new endpoint is additive: it does not import, wrap or re-export the
    // old one. (The old path appears in this file's header comment only, as the
    // documented rationale for a sibling route — never in an import.)
    assert.doesNotMatch(routeSource, /from\s+"[^"]*brand\/analytics\/route"/);
    assert.doesNotMatch(routeSource, /import\([^)]*brand\/analytics\/route/);
  });
});
