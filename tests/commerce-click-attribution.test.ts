process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.COMMERCE_CLICK_TOKEN_PEPPER = "test-pepper-for-commerce-click-attribution-tests-only";

/**
 * tests/commerce-click-attribution.test.ts
 *
 * Coverage for src/lib/commerce/click-attribution.ts (`handleCommerceClick`)
 * using its injectable `CommerceClickDeps` overrides — no real DB, no network.
 * Also includes a migration-shape test for
 * prisma/migrations/20260807160000_add_commerce_click_attribution, mirroring
 * tests/campaign-lesson-product-schema.test.ts's style.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import type {
  AttributionInput,
  CommerceClickDeps,
  CommerceClickSurface,
} from "../src/lib/commerce/click-attribution";
import type { ExperienceAccessContext } from "../src/lib/experience-access";
import { store as rateLimitStore } from "../src/lib/rate-limit";

let handleCommerceClick: (
  request: NextRequest,
  options: { experienceSlug: string; surface: CommerceClickSurface },
  overrides?: Partial<CommerceClickDeps>,
) => Promise<Response>;

before(async () => {
  const mod = await import("../src/lib/commerce/click-attribution");
  handleCommerceClick = mod.handleCommerceClick;
});

beforeEach(() => {
  // Each test gets a distinct IP (see `req` below) but clearing between tests
  // keeps the in-memory limiter from ever becoming a source of flakiness.
  rateLimitStore.clear();
});

let ipCounter = 0;

function req(options: { headers?: Record<string, string> } = {}) {
  ipCounter += 1;
  return new NextRequest("https://sqratch.test/api/public/experience/exp/products/click/link-1", {
    headers: {
      "x-forwarded-for": `10.0.0.${ipCounter}`,
      ...options.headers,
    },
  });
}

function access(
  overrides: Partial<{
    viewerUserId: string | null;
    viewerSessionId: string | null;
    storedCampaignId: string | null;
    entryContext: { kind: "DIRECT" } | { kind: "CAMPAIGN"; campaignId: string };
    campaigns: ExperienceAccessContext["experience"]["campaigns"];
  }> = {},
): ExperienceAccessContext {
  return {
    viewer: {
      session: null,
      sessionId: overrides.viewerSessionId ?? "viewer-session-1",
      userId: overrides.viewerUserId ?? null,
    },
    experience: {
      id: "experience-1",
      slug: "exp",
      title: "Experience",
      description: null,
      coverImageUrl: null,
      whyVideoSource: null,
      whyYoutubeUrl: null,
      whyVideoUploadUrl: null,
      qaDailyQuestionLimit: 5,
      creator: {
        id: "creator-1",
        userId: "creator-user-1",
        displayName: "Creator",
        bio: null,
        avatarUrl: null,
        user: { name: "Creator" },
      },
      campaigns:
        overrides.campaigns ??
        [
          {
            campaignId: "campaign-A",
            campaign: {
              id: "campaign-A",
              name: "Campaign A",
              brand: { id: "brand-1", name: "Acme", slug: "acme", logoUrl: null },
            },
          },
        ],
    },
    campaignIds: (overrides.campaigns ?? []).map((item) => item.campaignId),
    storedCampaignId: overrides.storedCampaignId ?? null,
    entryContext: overrides.entryContext ?? { kind: "DIRECT" },
    isLoggedIn: Boolean(overrides.viewerUserId),
    isCreatorOwner: false,
    hasUnlockedCampaign: false,
    hasRedeemedQrWarning: false,
    canAccessPrivate: false,
    canInteract: false,
  };
}

function twoEligibleCampaigns(): ExperienceAccessContext["experience"]["campaigns"] {
  return [
    {
      campaignId: "campaign-A",
      campaign: {
        id: "campaign-A",
        name: "A",
        brand: { id: "brand-1", name: "Acme", slug: "acme", logoUrl: null },
      },
    },
    {
      campaignId: "campaign-B",
      campaign: {
        id: "campaign-B",
        name: "B",
        brand: { id: "brand-1", name: "Acme", slug: "acme", logoUrl: null },
      },
    },
  ];
}

function experienceLink(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "link-1",
    productUrl: "https://acme.test/products/widget",
    brandId: "brand-1",
    sourceShopDomain: "acme.test",
    courseId: null,
    lessonId: null,
    experienceProductLinkId: "link-1",
    lessonProductLinkId: null,
    campaignLessonProductId: null,
    scopedCampaignId: null,
    brandCommerceProductId: null,
    ...overrides,
  };
}

function deps(overrides: Partial<CommerceClickDeps> = {}): Partial<CommerceClickDeps> {
  return {
    getAccess: async () => access(),
    ensureSession: async () => "minted-session",
    findExperienceProductLink: async () => experienceLink(),
    findLessonProductLink: async () => null,
    recordAttribution: async () => {},
    ...overrides,
  };
}

async function click(
  surface: CommerceClickSurface,
  overrides: Partial<CommerceClickDeps> = {},
  request = req(),
) {
  return handleCommerceClick(request, { experienceSlug: "exp", surface }, deps(overrides));
}

const SHOP_SURFACE: CommerceClickSurface = { kind: "EXPERIENCE_SHOP", productLinkId: "link-1" };

describe("cross-brand and cross-campaign integrity", () => {
  test("resolved brandId always comes from the looked-up link row, never a poisoned dependency's echo of client input", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(SHOP_SURFACE, {
      findExperienceProductLink: async () => experienceLink({ brandId: "brand-real" }),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].brandId, "brand-real");
    // A link belonging to Brand A can never surface as Brand B: there is no
    // input to this function shaped like "attribute this to a different
    // brand" — the value comes from exactly one place, the resolved link.
  });

  test("a link scoped to a different campaign than the visitor's resolved context yields the generic 404, not the destination", async () => {
    const response = await click(
      { kind: "LESSON", lessonId: "lesson-1", productLinkId: "link-1" },
      {
        getAccess: async () =>
          access({ entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" } }),
        findExperienceProductLink: async () => null,
        findLessonProductLink: async () =>
          experienceLink({
            lessonProductLinkId: "link-1",
            experienceProductLinkId: null,
            scopedCampaignId: "campaign-OTHER",
          }),
      },
    );

    assert.equal(response.status, 404);
  });

  test("the resolved campaign always comes from the session-derived resolver: the click route URL has no campaign segment or query param", () => {
    const shopRoute = readFileSync(
      join(
        process.cwd(),
        "src/app/api/public/experience/[experienceSlug]/products/click/[productLinkId]/route.ts",
      ),
      "utf8",
    );
    const lessonRoute = readFileSync(
      join(
        process.cwd(),
        "src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/products/click/[productLinkId]/route.ts",
      ),
      "utf8",
    );

    for (const source of [shopRoute, lessonRoute]) {
      assert.doesNotMatch(source, /campaignId/i);
      assert.doesNotMatch(source, /searchParams/i);
      // The only path params accepted are experienceSlug / lessonId /
      // productLinkId — all internal SQRATCH ids resolved server-side, never a
      // campaign identifier.
      assert.match(source, /params: Promise<\{[^}]*productLinkId: string[^}]*\}>/);
    }
  });

  test("Campaign A entry records acquisition Campaign A without fabricating product authorization for a global link", async () => {
    const captured: AttributionInput[] = [];
    const twoCampaigns = twoEligibleCampaigns();

    const response = await click(SHOP_SURFACE, {
      getAccess: async () => access({
        campaigns: twoCampaigns,
        storedCampaignId: "campaign-A",
        entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" },
      }),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured[0].entryCampaignId, "campaign-A");
    assert.equal(captured[0].productCampaignId, null);
  });

  test("Campaign B entry records acquisition Campaign B (symmetric case)", async () => {
    const captured: AttributionInput[] = [];
    const twoCampaigns = twoEligibleCampaigns();

    const response = await click(SHOP_SURFACE, {
      getAccess: async () => access({
        campaigns: twoCampaigns,
        storedCampaignId: "campaign-B",
        entryContext: { kind: "CAMPAIGN", campaignId: "campaign-B" },
      }),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured[0].entryCampaignId, "campaign-B");
    assert.equal(captured[0].productCampaignId, null);
  });

  test("direct entry keeps a campaign-scoped product authorization without fabricating acquisition credit", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(
      { kind: "LESSON", lessonId: "lesson-1", productLinkId: "link-1" },
      {
        getAccess: async () =>
          access({
            campaigns: twoEligibleCampaigns(),
            storedCampaignId: "campaign-A", // stale state must not control direct entry
            entryContext: { kind: "DIRECT" },
          }),
        findExperienceProductLink: async () => null,
        findLessonProductLink: async () =>
          experienceLink({
            lessonProductLinkId: "link-1",
            experienceProductLinkId: null,
            scopedCampaignId: "campaign-A",
          }),
        recordAttribution: async (input) => {
          captured.push(input);
        },
      },
    );

    assert.equal(response.status, 302);
    assert.equal(captured[0].entryCampaignId, null);
    assert.equal(captured[0].productCampaignId, "campaign-A");
  });

  test("direct generic brand catalog click does not invent a product campaign", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(
      { kind: "CAMPAIGN_CATALOG", brandCommerceProductId: "bcp-1" },
      {
        getAccess: async () =>
          access({
            campaigns: twoEligibleCampaigns(),
            storedCampaignId: "campaign-A",
            entryContext: { kind: "DIRECT" },
          }),
        findCampaignCatalogProduct: async (options) => {
          assert.equal(options.entryCampaignId, null);
          return experienceLink({
            id: "bcp-1",
            experienceProductLinkId: null,
            brandCommerceProductId: "bcp-1",
          });
        },
        recordAttribution: async (input) => {
          captured.push(input);
        },
      },
    );

    assert.equal(response.status, 302);
    assert.equal(captured[0].entryCampaignId, null);
    assert.equal(captured[0].productCampaignId, null);
  });

  test("direct campaign-assignment catalog click preserves its product campaign only", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(
      { kind: "CAMPAIGN_ASSIGNMENT_CATALOG", campaignAssignmentId: "assignment-a" },
      {
        getAccess: async () =>
          access({ campaigns: twoEligibleCampaigns(), entryContext: { kind: "DIRECT" } }),
        findCampaignAssignmentCatalogProduct: async (options) => {
          assert.equal(options.campaignAssignmentId, "assignment-a");
          return experienceLink({
            id: "assignment-a",
            experienceProductLinkId: null,
            brandCommerceProductId: "bcp-1",
            scopedCampaignId: "campaign-A",
          });
        },
        recordAttribution: async (input) => {
          captured.push(input);
        },
      },
    );

    assert.equal(response.status, 302);
    assert.equal(captured[0].entryCampaignId, null);
    assert.equal(captured[0].productCampaignId, "campaign-A");
  });
});

describe("forged input handling", () => {
  test("an unknown productLinkId returns the generic 404, not a 500 and not a redirect", async () => {
    const response = await click(SHOP_SURFACE, {
      findExperienceProductLink: async () => null,
    });

    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "Not found.");
  });

  test("a non-http(s) destination scheme is rejected, not redirected to", async () => {
    let mintCalled = false;
    const response = await click(SHOP_SURFACE, {
      findExperienceProductLink: async () =>
        experienceLink({ productUrl: "javascript:alert(1)" }),
      recordAttribution: async () => {
        mintCalled = true;
      },
    });

    assert.equal(response.status, 404);
    assert.equal(mintCalled, false);
  });

  test("a data: destination scheme is also rejected", async () => {
    const response = await click(SHOP_SURFACE, {
      findExperienceProductLink: async () =>
        experienceLink({ productUrl: "data:text/html,<script>alert(1)</script>" }),
    });

    assert.equal(response.status, 404);
  });

  test("there is no code path reading a URL from request input (query, header, body) as the redirect target", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/click-attribution.ts"),
      "utf8",
    );
    // The only destination assembled anywhere is derived from `link.productUrl`
    // (the server-resolved row), never from `request.nextUrl`, `searchParams`,
    // or a request body.
    assert.doesNotMatch(source, /request\.nextUrl\.searchParams/);
    assert.doesNotMatch(source, /await request\.json\(\)/);
    assert.match(source, /validateDestination\(link\.productUrl, link\.sourceShopDomain\)/);
  });
});

describe("anonymous vs. logged-in clicks", () => {
  test("an anonymous click (no userId) still succeeds and redirects", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(SHOP_SURFACE, {
      getAccess: async () => access({ viewerUserId: null }),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured[0].userId, null);
  });

  test("a logged-in click carries the resolved internal userId", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(SHOP_SURFACE, {
      getAccess: async () => access({ viewerUserId: "user-42" }),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured[0].userId, "user-42");
  });
});

describe("redirect target and PII", () => {
  test("the redirect Location carries only the opaque token as ?ref=, never an email or raw internal id", async () => {
    const response = await click(SHOP_SURFACE, {}, req());
    assert.equal(response.status, 302);
    const location = response.headers.get("location") || "";

    assert.match(location, /^https:\/\/acme\.test\/products\/widget\?ref=[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(location, /@/); // no email pattern
    assert.doesNotMatch(location, /link-1|brand-1|campaign-A|creator-1|experience-1/);
  });

  test("Cache-Control and Referrer-Policy are set on the redirect (never cached, never leaked to the merchant's referer logs)", async () => {
    const response = await click(SHOP_SURFACE);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  });

  test("an existing ?ref= on the merchant's own URL is left untouched, not clobbered", async () => {
    const response = await click(SHOP_SURFACE, {
      findExperienceProductLink: async () =>
        experienceLink({ productUrl: "https://acme.test/products/widget?ref=merchant-own-value" }),
    });

    const location = response.headers.get("location") || "";
    assert.match(location, /ref=merchant-own-value/);
  });
});

describe("rate limiting rejects before any redirect", () => {
  test("a request over the per-IP budget returns 429, not a redirect", async () => {
    const fixedIp = "203.0.113.9";
    const fixedReq = () =>
      new NextRequest(
        "https://sqratch.test/api/public/experience/exp/products/click/link-1",
        { headers: { "x-forwarded-for": fixedIp } },
      );

    let lastResponse: Response | null = null;
    for (let i = 0; i < 121; i += 1) {
      lastResponse = await handleCommerceClick(
        fixedReq(),
        { experienceSlug: "exp", surface: SHOP_SURFACE },
        deps(),
      );
    }

    assert.equal(lastResponse?.status, 429);
  });
});

describe("fail-open attribution", () => {
  test("a mint failure (recordAttribution throws) never blocks the redirect", async () => {
    const response = await click(SHOP_SURFACE, {
      recordAttribution: async () => {
        throw new Error("simulated DB outage");
      },
    });

    assert.equal(response.status, 302);
    const location = response.headers.get("location") || "";
    // No token appended: the mint failed, so nothing is appended to the URL.
    assert.equal(location, "https://acme.test/products/widget");
  });

  test("an unknown Experience returns the generic 404 rather than throwing", async () => {
    const response = await click(SHOP_SURFACE, {
      getAccess: async () => null,
    });

    assert.equal(response.status, 404);
  });
});

describe("Phase 6 does not touch points or commissions", () => {
  test("no file in the Phase 6 click path references points-ledger or commission concepts", () => {
    const files = [
      "src/lib/commerce/click-attribution.ts",
      "src/lib/commerce/click-token.ts",
      "src/app/api/public/experience/[experienceSlug]/products/click/[productLinkId]/route.ts",
      "src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/products/click/[productLinkId]/route.ts",
    ];

    const forbidden = [
      /points/i,
      /PointTransaction/,
      /debitPoints/,
      /creditPoints/,
      /commission/i,
      /payout/i,
    ];

    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const pattern of forbidden) {
        assert.equal(
          pattern.test(source),
          false,
          `${file} unexpectedly matched ${pattern}`,
        );
      }
    }
  });
});

describe("no token-lookup/redemption path exists yet in Phase 6", () => {
  test("handleCommerceClick mints attribution rows; it never looks one up by token (that is Phase 7 territory)", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/click-attribution.ts"),
      "utf8",
    );
    // The only prisma access to this table in this module is a `.create`.
    // There is no `.findUnique`/`.findFirst` against CommerceClickAttribution,
    // so there is no token-expiry-lookup or unknown-token-lookup code path to
    // test here yet; both are explicitly out of scope for Phase 6.
    assert.doesNotMatch(source, /commerceClickAttribution\.find/);
    assert.match(source, /commerceClickAttribution\.create/);
  });
});

describe("schema-level idempotency seam (unused by Phase 6 code)", () => {
  test("CommerceClickAttribution has consumedAt/consumedByOrderRef columns, unreferenced by any Phase 6 runtime code path", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    assert.match(schema, /model CommerceClickAttribution \{/);
    assert.match(schema, /consumedAt\s+DateTime\?/);
    assert.match(schema, /consumedByOrderRef\s+String\?/);

    const attributionSource = readFileSync(
      join(process.cwd(), "src/lib/commerce/click-attribution.ts"),
      "utf8",
    );
    assert.doesNotMatch(attributionSource, /consumedAt/);
    assert.doesNotMatch(attributionSource, /consumedByOrderRef/);
  });
});

describe("production DB inaccessible in these tests", () => {
  test("DATABASE_URL is pinned to the blocked loopback sentinel", () => {
    assert.equal(
      process.env.DATABASE_URL,
      "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked",
    );
  });
});

describe("migration shape: 20260807160000_add_commerce_click_attribution", () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      "prisma/migrations/20260807160000_add_commerce_click_attribution/migration.sql",
    ),
    "utf8",
  );
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

  test("is additive-only: no UPDATE/DELETE/TRUNCATE/DROP, no ALTER ... DROP, outside comments", () => {
    assert.match(migration, /PREFLIGHT/);
    assert.match(migration, /ROLLBACK LIMITATION/);

    const codeOnly = migration
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");

    assert.equal(/^\s*(?:UPDATE|DELETE|TRUNCATE|DROP)\b/im.test(codeOnly), false);
    assert.equal(/^\s*ALTER TABLE .*\s+DROP\b/im.test(codeOnly), false);
    assert.match(codeOnly, /CREATE TABLE "CommerceClickAttribution"/);
  });

  test("keeps entry acquisition distinct from same-brand product authorization", () => {
    assert.match(
      migration,
      /FOREIGN KEY \("entryCampaignId"\) REFERENCES "Campaign"\("id"\)/,
    );
    assert.match(
      migration,
      /FOREIGN KEY \("productCampaignId", "brandId"\) REFERENCES "Campaign"\("id", "brandId"\)/,
    );
    assert.equal(/CREATE UNIQUE INDEX "Campaign_id_brandId_key"/.test(migration), false);
    assert.equal(
      /CREATE UNIQUE INDEX .* ON "BrandCommerceProduct"/.test(migration),
      false,
    );
    assert.equal(/ALTER TABLE "Campaign" ADD/.test(migration), false);
    assert.equal(/ALTER TABLE "BrandCommerceProduct" ADD/.test(migration), false);
  });

  test("tokenHash is the only unique index on the new table, and no money/order fields exist", () => {
    assert.match(
      migration,
      /CREATE UNIQUE INDEX "CommerceClickAttribution_tokenHash_key" ON "CommerceClickAttribution"\("tokenHash"\)/,
    );
    assert.doesNotMatch(migration, /"amount"|"price"|"orderId"|"quantity"/i);
  });

  test("schema documents direct entry separately from product authorization", () => {
    assert.match(schema, /entryCampaignId\s+String\?/);
    assert.match(schema, /productCampaignId\s+String\?/);
    assert.match(schema, /entryCampaignContextResolved\s+Boolean\s+@default\(false\)/);
  });
});
