/**
 * tests/creator-commerce-analytics.test.ts
 *
 * Phase 11 coverage for the CREATOR-side commerce click analytics endpoint:
 *   src/app/api/creator/analytics/commerce/route.ts
 *
 * The route is driven through its exported `creatorCommerceAnalyticsGetImpl`,
 * with `getCreatorContext`, the analytics repository and the three name-lookup
 * functions supplied as injected doubles — the same `overrides?: Partial<Deps>`
 * pattern the creator lesson-product routes already use. No Prisma client is
 * instantiated by these tests and no query is ever issued: the repository
 * double records the scopes it was asked for, which is exactly what the
 * cross-creator isolation assertions inspect.
 *
 * The forbidden-field and entry-split-source checks are SOURCE INSPECTION over
 * the route file (noted per test), because "this column is never read" and
 * "this split is not a null-check" are properties of the code, not of any one
 * fixture.
 */
import "./env-setup";

// PHASE 16/17 REPAIR: see the identical note in commerce7-lifecycle-gate.test.ts —
// `env-setup` must be the FIRST import so DATABASE_URL is set before any
// transitively-imported module reads it at import time.
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.NEXTAUTH_SECRET = "test-nextauth-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import {
  creatorCommerceAnalyticsGetImpl,
  type CreatorCommerceAnalyticsDeps,
  type CreatorCommerceAnalyticsResponse,
} from "../src/app/api/creator/analytics/commerce/route";
import type { CreatorContext } from "../src/lib/creator-auth";
import type {
  CommerceClickAnalyticsQuery,
  CommerceClickAnalyticsRepository,
} from "../src/lib/commerce/commerce-click-analytics-repository";

const ROUTE_PATH = join(
  process.cwd(),
  "src/app/api/creator/analytics/commerce/route.ts",
);
const ROUTE_SOURCE = readFileSync(ROUTE_PATH, "utf8");

const EXISTING_ROUTE_PATH = join(
  process.cwd(),
  "src/app/api/creator/analytics/route.ts",
);

/** A fixed reference time so every default range is deterministic. */
const NOW = new Date("2026-08-08T12:34:56.000Z");

type ClickFixture = {
  experienceId: string;
  lessonId: string | null;
  brandCommerceProductId: string | null;
  provider: "SHOPIFY" | "COMMERCE7" | null;
  surface: "BRAND_STOREFRONT" | "CAMPAIGN_PRODUCT" | "LESSON" | null;
  /** The authoritative campaign-entry flag. NOT derived from any campaign id. */
  entryCampaignContextResolved: boolean;
  /**
   * Present only so a fixture can encode the divergent case: a click whose
   * entry campaign was deleted (id nulled) while the resolved flag stays true.
   * The route must never read it.
   */
  entryCampaignId: string | null;
  sessionId: string | null;
  userId: string | null;
  createdAt: Date;
};

function click(overrides: Partial<ClickFixture> = {}): ClickFixture {
  return {
    experienceId: "exp-a1",
    lessonId: null,
    brandCommerceProductId: null,
    provider: "SHOPIFY",
    surface: "LESSON",
    entryCampaignContextResolved: false,
    entryCampaignId: null,
    sessionId: "sess-1",
    userId: null,
    createdAt: new Date("2026-08-05T10:00:00.000Z"),
    ...overrides,
  };
}

type RecordingRepository = CommerceClickAnalyticsRepository & {
  /** Every scope the route asked for, in call order. */
  scopes: Array<CommerceClickAnalyticsQuery["scope"]>;
};

/**
 * An in-memory repository over a click fixture list.
 *
 * It filters by the SAME rule the real Prisma repository does — the scope's id
 * list plus the inclusive range — so a route that widened its scope would
 * genuinely pull in the other creator's rows here rather than being masked by
 * a hand-stubbed return value.
 */
function buildRepository(clicks: readonly ClickFixture[]): RecordingRepository {
  const scopes: Array<CommerceClickAnalyticsQuery["scope"]> = [];

  const rowsFor = (query: CommerceClickAnalyticsQuery): ClickFixture[] => {
    scopes.push(query.scope);

    if (query.scope.kind !== "EXPERIENCE") {
      throw new Error(
        `Creator analytics must only ever use the EXPERIENCE scope; saw ${query.scope.kind}.`,
      );
    }

    const allowed = new Set(query.scope.experienceIds);
    if (allowed.size === 0) {
      throw new Error(
        "The route must short-circuit an empty scope instead of querying.",
      );
    }

    return clicks.filter(
      (row) =>
        allowed.has(row.experienceId) &&
        row.createdAt >= query.range.start &&
        row.createdAt <= query.range.end,
    );
  };

  const groupBy = <K extends keyof ClickFixture>(
    query: CommerceClickAnalyticsQuery,
    key: K,
  ) => {
    const counts = new Map<ClickFixture[K], number>();
    for (const row of rowsFor(query)) {
      counts.set(row[key], (counts.get(row[key]) ?? 0) + 1);
    }
    return [...counts.entries()];
  };

  const distinct = (
    query: CommerceClickAnalyticsQuery,
    key: "sessionId" | "userId",
  ) => {
    const values = new Set<string>();
    for (const row of rowsFor(query)) {
      const value = row[key];
      if (value !== null) values.add(value);
    }
    return { value: values.size, truncated: false };
  };

  return {
    scopes,

    async countClicks(query) {
      return rowsFor(query).length;
    },
    async countDistinctSessions(query) {
      return distinct(query, "sessionId");
    },
    async countDistinctUsers(query) {
      return distinct(query, "userId");
    },
    async countByEntryResolution(query) {
      return groupBy(query, "entryCampaignContextResolved").map(
        ([entryCampaignContextResolved, count]) => ({
          entryCampaignContextResolved,
          count,
        }),
      );
    },
    async groupBySurface(query) {
      return groupBy(query, "surface").map(([surface, count]) => ({
        surface,
        count,
      }));
    },
    async groupByProvider(query) {
      return groupBy(query, "provider").map(([provider, count]) => ({
        provider,
        count,
      }));
    },
    async groupByBrandCommerceProduct(query) {
      return groupBy(query, "brandCommerceProductId").map(([id, count]) => ({
        id,
        count,
      }));
    },
    async groupByLesson(query) {
      return groupBy(query, "lessonId").map(([id, count]) => ({ id, count }));
    },
    async groupByExperience(query) {
      return groupBy(query, "experienceId").map(([id, count]) => ({
        id,
        count,
      }));
    },
    async listClickTimestamps(query) {
      return {
        timestamps: rowsFor(query).map((row) => ({ createdAt: row.createdAt })),
        truncated: false,
      };
    },

    // Present to satisfy the contract; a creator route calling any of these is
    // itself the bug, so they fail loudly rather than returning empty data.
    async groupByEntryCampaign() {
      throw new Error(
        "Creator analytics must not build an entry-campaign breakdown.",
      );
    },
    async groupByProductCampaign() {
      throw new Error(
        "Creator analytics must not build a product-campaign breakdown.",
      );
    },
    async groupByConnectedProduct() {
      throw new Error("Unexpected groupByConnectedProduct call.");
    },
    async groupByCreatorProfile() {
      throw new Error("Unexpected groupByCreatorProfile call.");
    },
    async groupByQrCode() {
      throw new Error("Unexpected groupByQrCode call.");
    },
  };
}

const CREATOR_A: CreatorContext = {
  userId: "user-a",
  creatorProfile: { id: "creator-a", userId: "user-a", displayName: "A" },
};

/** Creator A owns exp-a1/exp-a2. Creator B's exp-b1 is never theirs to see. */
const CREATOR_A_EXPERIENCES = [
  { id: "exp-a1", title: "Alpha Experience" },
  { id: "exp-a2", title: "Beta Experience" },
];

const LESSON_TITLES: Record<string, string> = {
  "lesson-a1": "Alpha Lesson",
  "lesson-b1": "Bravo Lesson (Creator B)",
};

const PRODUCT_TITLES: Record<string, string> = {
  "bcp-1": "Reserve Cabernet",
  "bcp-b": "Creator B Product",
};

function buildDeps(input: {
  clicks?: readonly ClickFixture[];
  context?: CreatorContext | null;
  experiences?: Array<{ id: string; title: string }>;
}): { deps: Partial<CreatorCommerceAnalyticsDeps>; repository: RecordingRepository } {
  const repository = buildRepository(input.clicks ?? []);
  const experiences = input.experiences ?? CREATOR_A_EXPERIENCES;

  return {
    repository,
    deps: {
      getCreatorContext: async () =>
        input.context === undefined ? CREATOR_A : input.context,
      repository,
      listOwnedExperiences: async () => experiences,
      // Mirrors the production double-scoping: a lesson outside the supplied
      // experienceIds is simply not returned.
      listLessonTitles: async ({ lessonIds, experienceIds }) => {
        const allowed = new Set(experienceIds);
        return [...lessonIds]
          .filter((id) => (id.startsWith("lesson-b") ? allowed.has("exp-b1") : true))
          .map((id) => ({ id, title: LESSON_TITLES[id] ?? id }));
      },
      listProductTitles: async (ids) =>
        [...ids].map((id) => ({ id, title: PRODUCT_TITLES[id] ?? id })),
      now: () => NOW,
    },
  };
}

function get(url: string) {
  return new NextRequest(new URL(url, "https://sqratch.test"));
}

async function callRoute(
  url: string,
  deps: Partial<CreatorCommerceAnalyticsDeps>,
) {
  const response = await creatorCommerceAnalyticsGetImpl(get(url), deps);
  const json = (await response.json()) as
    | CreatorCommerceAnalyticsResponse
    | { error: string };
  return { response, json };
}

function expectData(
  json: CreatorCommerceAnalyticsResponse | { error: string },
): CreatorCommerceAnalyticsResponse["data"] {
  assert.ok("data" in json, `Expected a success body, got ${JSON.stringify(json)}`);
  return json.data;
}

describe("creator commerce analytics — authorization", () => {
  test("an unauthenticated request is rejected", async () => {
    const { deps } = buildDeps({ context: null });
    const { response, json } = await callRoute(
      "/api/creator/analytics/commerce",
      deps,
    );

    // Matches src/app/api/creator/analytics/route.ts exactly: getCreatorContext
    // returns null for both no-session and wrong-role, and the route answers
    // 403 for both, so the two are indistinguishable to a caller.
    assert.equal(response.status, 403);
    assert.deepEqual(json, { error: "Creator access required." });
  });

  test("an authenticated non-CREATOR (e.g. BRAND_ADMIN) is rejected", async () => {
    // getCreatorContext itself enforces `role !== "CREATOR" -> null`, including
    // for a global ADMIN. The double reproduces that null.
    const { deps } = buildDeps({ context: null });
    const { response } = await callRoute("/api/creator/analytics/commerce", deps);
    assert.equal(response.status, 403);
  });

  test("getCreatorContext denies global ADMIN and any non-CREATOR role", () => {
    // Source inspection of the shared helper the route reuses verbatim.
    const source = readFileSync(
      join(process.cwd(), "src/lib/creator-auth.ts"),
      "utf8",
    );
    assert.match(source, /role !== "CREATOR"/);
    assert.doesNotMatch(source, /role === "ADMIN"/);
  });
});

describe("creator commerce analytics — cross-creator isolation", () => {
  const CLICKS = [
    click({ experienceId: "exp-a1", lessonId: "lesson-a1", brandCommerceProductId: "bcp-1" }),
    click({ experienceId: "exp-a2", lessonId: "lesson-a1", brandCommerceProductId: "bcp-1" }),
    // Creator B's rows. Same fixture list, different Experience.
    click({ experienceId: "exp-b1", lessonId: "lesson-b1", brandCommerceProductId: "bcp-b" }),
    click({ experienceId: "exp-b1", lessonId: "lesson-b1", brandCommerceProductId: "bcp-b" }),
    click({ experienceId: "exp-b1", lessonId: "lesson-b1", brandCommerceProductId: "bcp-b" }),
  ];

  test("every issued scope contains only Experiences the creator owns", async () => {
    const { deps, repository } = buildDeps({ clicks: CLICKS });
    const { response, json } = await callRoute(
      "/api/creator/analytics/commerce",
      deps,
    );
    const data = expectData(json);

    assert.equal(response.status, 200);
    assert.ok(repository.scopes.length > 0, "expected the repository to be used");

    for (const scope of repository.scopes) {
      assert.equal(scope.kind, "EXPERIENCE");
      assert.ok(scope.kind === "EXPERIENCE");
      assert.deepEqual([...scope.experienceIds].sort(), ["exp-a1", "exp-a2"]);
    }

    // Creator B's three clicks are absent from every number and every list.
    assert.equal(data.totals.clicks, 2);
    assert.deepEqual(
      data.topExperiences?.map((row) => row.id).sort(),
      ["exp-a1", "exp-a2"],
    );
    assert.deepEqual(data.topLessons.map((row) => row.id), ["lesson-a1"]);
    assert.deepEqual(data.topProducts.map((row) => row.id), ["bcp-1"]);

    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes("exp-b1"), "leaked another creator's Experience");
    assert.ok(!serialized.includes("lesson-b1"), "leaked another creator's Lesson");
    assert.ok(!serialized.includes("bcp-b"), "leaked another creator's product");
  });

  test("supplying another creator's experienceId is rejected, never honored", async () => {
    const { deps, repository } = buildDeps({ clicks: CLICKS });
    const { response, json } = await callRoute(
      "/api/creator/analytics/commerce?experienceId=exp-b1",
      deps,
    );

    assert.equal(response.status, 404);
    assert.deepEqual(json, { error: "Experience not found." });
    // Rejected BEFORE any query: the foreign id never reached a scope, and the
    // request was not silently widened back to the creator's own Experiences.
    assert.equal(repository.scopes.length, 0);
  });

  test("an unknown experienceId is indistinguishable from another creator's", async () => {
    const { deps } = buildDeps({ clicks: CLICKS });
    const { response, json } = await callRoute(
      "/api/creator/analytics/commerce?experienceId=does-not-exist",
      deps,
    );

    assert.equal(response.status, 404);
    assert.deepEqual(json, { error: "Experience not found." });
  });

  test("an owned experienceId narrows the scope and drops topExperiences", async () => {
    const { deps, repository } = buildDeps({ clicks: CLICKS });
    const { json } = await callRoute(
      "/api/creator/analytics/commerce?experienceId=exp-a1",
      deps,
    );
    const data = expectData(json);

    for (const scope of repository.scopes) {
      assert.ok(scope.kind === "EXPERIENCE");
      assert.deepEqual([...scope.experienceIds], ["exp-a1"]);
    }

    assert.equal(data.totals.clicks, 1);
    assert.equal(data.filters.experienceId, "exp-a1");
    assert.equal(
      "topExperiences" in data,
      false,
      "a single-Experience view must omit the by-Experience breakdown",
    );
  });

  test("no brand or campaign identifier is reported to the creator", async () => {
    // The sponsoring brand's campaign ids ride on in-scope clicks (that is
    // legitimate), but this route never groups by or serializes them. The
    // repository double throws if either campaign breakdown is requested.
    const { deps } = buildDeps({
      clicks: [
        click({
          experienceId: "exp-a1",
          entryCampaignContextResolved: true,
          entryCampaignId: "campaign-sponsor-secret",
        }),
      ],
    });
    const { json } = await callRoute("/api/creator/analytics/commerce", deps);
    const data = expectData(json);

    const serialized = JSON.stringify(data);
    assert.ok(!serialized.includes("campaign-sponsor-secret"));
    assert.ok(!/"campaignId"/.test(serialized));
    assert.ok(!/"brandId"/.test(serialized));
    assert.ok(!/"attributedBrandId"/.test(serialized));
    // The aggregate split is still reported — it names no campaign.
    assert.equal(data.totals.campaignEntryClicks, 1);
  });
});

describe("creator commerce analytics — empty states", () => {
  test("a creator owning zero Experiences gets a clean zero response", async () => {
    const { deps, repository } = buildDeps({ clicks: [], experiences: [] });
    const { response, json } = await callRoute(
      "/api/creator/analytics/commerce",
      deps,
    );
    const data = expectData(json);

    assert.equal(response.status, 200);
    // The empty scope short-circuits: no query is issued at all.
    assert.equal(repository.scopes.length, 0);
    assert.equal(data.totals.clicks, 0);
    assert.deepEqual(data.totals.uniqueSessions, { value: 0, truncated: false });
    assert.deepEqual(data.totals.uniqueUsers, { value: 0, truncated: false });
    assert.equal(data.totals.campaignEntryClicks, 0);
    assert.equal(data.totals.directEntryClicks, 0);
    assert.deepEqual(data.topProducts, []);
    assert.deepEqual(data.topLessons, []);
    assert.deepEqual(data.topExperiences, []);
    assert.deepEqual(data.providerBreakdown, []);
    assert.deepEqual(data.surfaceBreakdown, {
      BRAND_STOREFRONT: 0,
      CAMPAIGN_PRODUCT: 0,
      LESSON: 0,
      UNKNOWN: 0,
    });
    // The series is still fully populated with zeroed days, never omitted.
    assert.equal(data.timeSeries.length, 30);
    assert.ok(data.timeSeries.every((point) => point.clicks === 0));
    assert.equal(data.timeSeriesTruncated, false);
  });

  test("owned Experiences with zero clicks also return a clean zero response", async () => {
    const { deps } = buildDeps({ clicks: [] });
    const { response, json } = await callRoute(
      "/api/creator/analytics/commerce",
      deps,
    );
    const data = expectData(json);

    assert.equal(response.status, 200);
    assert.equal(data.totals.clicks, 0);
    assert.deepEqual(data.topProducts, []);
    assert.deepEqual(data.topExperiences, []);
    assert.equal(data.timeSeries.length, 30);
  });
});

describe("creator commerce analytics — entry split", () => {
  test("the split follows entryCampaignContextResolved, not the campaign id", async () => {
    // BEHAVIOURAL check. The fixture deliberately makes a null-check disagree
    // with the flag in both directions:
    //   - one click has resolved=true but entryCampaignId=null (the campaign
    //     was deleted; ON DELETE SET NULL nulled the id, flag survives),
    //   - one click has resolved=false but a non-null entryCampaignId.
    // A null-check implementation would report 1/2; the correct one reports 2/1.
    const { deps } = buildDeps({
      clicks: [
        click({ entryCampaignContextResolved: true, entryCampaignId: null }),
        click({ entryCampaignContextResolved: true, entryCampaignId: "camp-1" }),
        click({ entryCampaignContextResolved: false, entryCampaignId: "camp-2" }),
      ],
    });
    const { json } = await callRoute("/api/creator/analytics/commerce", deps);
    const data = expectData(json);

    assert.equal(data.totals.campaignEntryClicks, 2);
    assert.equal(data.totals.directEntryClicks, 1);
    assert.equal(
      data.totals.campaignEntryClicks + data.totals.directEntryClicks,
      data.totals.clicks,
    );
  });

  test("the route never null-checks a campaign id to build the split", () => {
    // SOURCE INSPECTION, complementing the behavioural test above.
    assert.match(ROUTE_SOURCE, /buildEntrySplit\(entryResolutionRows\)/);
    assert.doesNotMatch(ROUTE_SOURCE, /entryCampaignId/);
    assert.doesNotMatch(ROUTE_SOURCE, /productCampaignId/);
  });
});

describe("creator commerce analytics — totals and shaping", () => {
  test("totals, breakdowns and the daily series match a constructed fixture", async () => {
    const { deps } = buildDeps({
      clicks: [
        click({
          experienceId: "exp-a1",
          lessonId: "lesson-a1",
          brandCommerceProductId: "bcp-1",
          provider: "SHOPIFY",
          surface: "LESSON",
          sessionId: "s1",
          userId: "u1",
          entryCampaignContextResolved: true,
          createdAt: new Date("2026-08-05T01:00:00.000Z"),
        }),
        click({
          experienceId: "exp-a1",
          lessonId: "lesson-a1",
          brandCommerceProductId: "bcp-1",
          provider: "SHOPIFY",
          surface: null, // pre-migration row -> the honest UNKNOWN bucket
          sessionId: "s1",
          userId: null,
          entryCampaignContextResolved: false,
          createdAt: new Date("2026-08-05T23:00:00.000Z"),
        }),
        click({
          experienceId: "exp-a2",
          lessonId: null,
          brandCommerceProductId: "bcp-2",
          provider: "COMMERCE7",
          surface: "BRAND_STOREFRONT",
          sessionId: "s2",
          userId: "u2",
          entryCampaignContextResolved: false,
          createdAt: new Date("2026-08-06T09:00:00.000Z"),
        }),
      ],
    });

    const { json } = await callRoute("/api/creator/analytics/commerce", deps);
    const data = expectData(json);

    assert.equal(data.totals.clicks, 3);
    assert.deepEqual(data.totals.uniqueSessions, { value: 2, truncated: false });
    assert.deepEqual(data.totals.uniqueUsers, { value: 2, truncated: false });
    assert.equal(data.totals.campaignEntryClicks, 1);
    assert.equal(data.totals.directEntryClicks, 2);

    assert.deepEqual(data.surfaceBreakdown, {
      BRAND_STOREFRONT: 1,
      CAMPAIGN_PRODUCT: 0,
      LESSON: 1,
      UNKNOWN: 1,
    });

    // Descending by clicks, id-tiebroken — the pure layer's deterministic order.
    assert.deepEqual(data.providerBreakdown, [
      { provider: "SHOPIFY", clicks: 2 },
      { provider: "COMMERCE7", clicks: 1 },
    ]);

    assert.deepEqual(data.topProducts, [
      { id: "bcp-1", name: "Reserve Cabernet", clicks: 2 },
      { id: "bcp-2", name: "bcp-2", clicks: 1 },
    ]);

    // The null lessonId group is dropped, not bucketed as a fake row.
    assert.deepEqual(data.topLessons, [
      { id: "lesson-a1", title: "Alpha Lesson", clicks: 2 },
    ]);

    assert.deepEqual(data.topExperiences, [
      { id: "exp-a1", title: "Alpha Experience", clicks: 2 },
      { id: "exp-a2", title: "Beta Experience", clicks: 1 },
    ]);

    const withClicks = data.timeSeries.filter((point) => point.clicks > 0);
    assert.deepEqual(withClicks, [
      { date: "2026-08-05", clicks: 2 },
      { date: "2026-08-06", clicks: 1 },
    ]);
    assert.equal(data.range.end, "2026-08-08T23:59:59.999Z");
  });

  test("a malformed date range is a 400, not a 500", async () => {
    const { deps } = buildDeps({});
    const { response, json } = await callRoute(
      "/api/creator/analytics/commerce?dateFrom=08-08-2026",
      deps,
    );

    assert.equal(response.status, 400);
    assert.ok("error" in json);
    assert.match(json.error, /dateFrom/);
  });

  test("an inverted date range is a 400", async () => {
    const { deps } = buildDeps({});
    const { response } = await callRoute(
      "/api/creator/analytics/commerce?dateFrom=2026-08-08&dateTo=2026-08-01",
      deps,
    );
    assert.equal(response.status, 400);
  });

  test("a malformed limit is a 400 and an oversized limit is clamped", async () => {
    const { deps } = buildDeps({});

    const bad = await callRoute("/api/creator/analytics/commerce?limit=abc", deps);
    assert.equal(bad.response.status, 400);

    const zero = await callRoute("/api/creator/analytics/commerce?limit=0", deps);
    assert.equal(zero.response.status, 400);

    const huge = await callRoute(
      "/api/creator/analytics/commerce?limit=9999",
      deps,
    );
    assert.equal(huge.response.status, 200);
    assert.equal(expectData(huge.json).filters.limit, 50);
  });
});

describe("creator commerce analytics — forbidden fields and vocabulary", () => {
  const FORBIDDEN_FIELDS = [
    "ipHash",
    "tokenHash",
    "tokenPrefix",
    "destinationUrl",
    "destinationHost",
    "userAgent",
    "referrer",
    "commerceOrder",
    "orderLineItem",
  ];

  test("no identifying or order-side column is referenced by the route", () => {
    // SOURCE INSPECTION over the whole route file.
    for (const field of FORBIDDEN_FIELDS) {
      assert.doesNotMatch(
        ROUTE_SOURCE,
        new RegExp(`\\b${field}\\b`),
        `${field} must never appear in the creator commerce analytics route`,
      );
    }
  });

  test("raw session and user ids are only ever counted, never selected", () => {
    // `sessionId`/`userId` appear nowhere in the route; identity reaches it
    // exclusively as the repository's pre-computed distinct counts.
    assert.doesNotMatch(ROUTE_SOURCE, /\bsessionId\b/);
    assert.doesNotMatch(ROUTE_SOURCE, /\buserId\b/);
    assert.match(ROUTE_SOURCE, /countDistinctSessions/);
    assert.match(ROUTE_SOURCE, /countDistinctUsers/);
  });

  test("no downstream-outcome vocabulary appears outside the mandated note", () => {
    // The one sanctioned exception is CREATOR_COMMERCE_ANALYTICS_NOTE, whose
    // wording is fixed by the phase spec and whose entire job is to state what
    // is NOT measured. It is removed before the scan so the rest of the file is
    // held to a hard zero.
    const scanned = ROUTE_SOURCE.replace(
      /"Commerce analytics currently measures[^"]*"/,
      '""',
    ).toLowerCase();

    assert.ok(
      !scanned.includes("order and revenue attribution"),
      "the disclaimer should have been excised before scanning",
    );

    for (const word of [
      "revenue",
      "sales",
      "conversion",
      "roas",
      "purchase",
      "commission",
      "ordervalue",
    ]) {
      assert.doesNotMatch(
        scanned,
        new RegExp(`\\b${word}\\b`),
        `"${word}" must not appear in a click-only analytics route`,
      );
    }
  });

  test("only the EXPERIENCE scope kind is reachable from this route", () => {
    assert.match(ROUTE_SOURCE, /kind: "EXPERIENCE"/);
    assert.doesNotMatch(ROUTE_SOURCE, /kind: "ATTRIBUTED_BRAND"/);
    assert.doesNotMatch(ROUTE_SOURCE, /kind: "ENTRY_CAMPAIGN"/);
    assert.doesNotMatch(ROUTE_SOURCE, /kind: "PRODUCT_CAMPAIGN"/);
  });

  test("the pre-existing creator analytics route is untouched by this phase", () => {
    // Phase 11 is purely additive on the creator side: the older endpoint must
    // still carry no commerce-click involvement whatsoever.
    const existing = readFileSync(EXISTING_ROUTE_PATH, "utf8");
    assert.doesNotMatch(existing, /commerce/i);
    assert.doesNotMatch(existing, /commerceClickAttribution/);
  });
});
