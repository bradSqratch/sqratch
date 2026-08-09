process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.COMMERCE_CLICK_TOKEN_PEPPER = "test-pepper-for-commerce-click-attribution-tests-only";

/**
 * tests/commerce-click-attribution.test.ts
 *
 * Coverage for src/lib/commerce/click-attribution.ts (`handleCommerceClick`)
 * using its injectable `CommerceClickDeps` overrides — no real DB, no network.
 * Also includes permanent migration-shape tests — one per migration that
 * touches `CommerceClickAttribution` — mirroring
 * tests/campaign-lesson-product-schema.test.ts's style:
 *
 *   * 20260807160000_add_commerce_click_attribution   (creates the table)
 *   * 20260808150000_add_commerce_click_analytics_durability
 *     (Phase 10: adds `surface` + `attributedBrandId` and eight indexes)
 *
 * House convention: EVERY migration touching this table gets a committed shape
 * test here, not an ad-hoc one-time check by whoever wrote it.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/**
 * A resolved canonical click target. Phase 8: EVERY surface resolves through
 * `BrandCommerceProduct -> ConnectedCommerceProduct -> CommerceConnection`, so
 * the connection id, connected-product id and provider are always present and
 * `connectionExternalAccountId` (not a legacy `sourceShopDomain` snapshot) pins
 * synthesized URLs; provider-supplied Shopify custom-domain URLs carry a
 * separate server-derived provenance fact.
 */
function resolvedLink(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "bcp-1",
    productUrl: "https://acme.test/products/widget",
    brandId: "brand-1",
    courseId: null,
    lessonId: null,
    campaignLessonProductId: null,
    // Null ONLY for the generic brand-storefront surface. A fixture that sets a
    // scope represents a current active one unless it says otherwise.
    scope: null,
    brandCommerceProductId: "bcp-1",
    connectedProductId: "connected-1",
    commerceConnectionId: "connection-1",
    provider: "SHOPIFY" as const,
    connectionExternalAccountId: "acme.test",
    hasProviderSuppliedStorefrontUrl: false,
    ...overrides,
  };
}

function lessonLink(overrides: Partial<Record<string, unknown>> = {}) {
  return resolvedLink({
    id: "clp-1",
    campaignLessonProductId: "clp-1",
    lessonId: "lesson-1",
    courseId: "course-1",
    scope: { campaignId: "campaign-A", isActive: true },
    ...overrides,
  });
}

function deps(overrides: Partial<CommerceClickDeps> = {}): Partial<CommerceClickDeps> {
  return {
    getAccess: async () => access(),
    ensureSession: async () => "minted-session",
    findBrandStorefrontProduct: async () => resolvedLink(),
    findCampaignProduct: async () => null,
    findCampaignLessonProduct: async () => null,
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

/**
 * The generic brand-storefront surface, which replaces the deleted
 * `EXPERIENCE_SHOP` surface as this file's default "unscoped click" case.
 */
const SHOP_SURFACE: CommerceClickSurface = {
  kind: "BRAND_STOREFRONT",
  brandCommerceProductId: "bcp-1",
};

const LESSON_SURFACE: CommerceClickSurface = {
  kind: "LESSON",
  lessonId: "lesson-1",
  campaignLessonProductId: "clp-1",
};

describe("cross-brand and cross-campaign integrity", () => {
  test("resolved brandId always comes from the looked-up link row, never a poisoned dependency's echo of client input", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(SHOP_SURFACE, {
      findBrandStorefrontProduct: async () => resolvedLink({ brandId: "brand-real" }),
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

  test("a lesson attachment scoped to a different campaign than the visitor's resolved context yields the generic 404, not the destination", async () => {
    const response = await click(LESSON_SURFACE, {
      getAccess: async () =>
        access({ entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" } }),
      findCampaignLessonProduct: async () =>
        lessonLink({ scope: { campaignId: "campaign-OTHER", isActive: true } }),
    });

    assert.equal(response.status, 404);
  });

  test("an inactive lesson scope is denied instead of becoming a global click target", async () => {
    const response = await click(LESSON_SURFACE, {
      getAccess: async () => access({
        entryContext: { kind: "DIRECT" },
        campaigns: twoEligibleCampaigns(),
      }),
      findCampaignLessonProduct: async () =>
        lessonLink({ scope: { campaignId: "campaign-A", isActive: false } }),
    });

    assert.equal(response.status, 404);
  });

  test("direct lesson union rejects a scope whose campaign is no longer linked to the Experience", async () => {
    const response = await click(LESSON_SURFACE, {
      getAccess: async () => access({
        entryContext: { kind: "DIRECT" },
        campaigns: twoEligibleCampaigns(),
      }),
      findCampaignLessonProduct: async () =>
        lessonLink({ scope: { campaignId: "campaign-removed", isActive: true } }),
    });

    assert.equal(response.status, 404);
  });

  test("the resolved campaign always comes from the session-derived resolver: the lesson click route URL has no campaign segment or query param", () => {
    const lessonRoute = readFileSync(
      join(
        process.cwd(),
        "src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/products/click/[campaignLessonProductId]/route.ts",
      ),
      "utf8",
    );

    assert.doesNotMatch(lessonRoute, /searchParams/i);
    // The only path params accepted are experienceSlug / lessonId /
    // campaignLessonProductId — all internal SQRATCH ids resolved server-side,
    // never a campaign identifier, brand, provider, or URL.
    assert.match(
      lessonRoute,
      /params: Promise<\{[\s\S]*?campaignLessonProductId: string;[\s\S]*?\}>/,
    );
    // No brand, provider, campaign id, or URL is read anywhere in the executable
    // body; the only mentions in this file are prose in the header comment.
    const codeOnly = lessonRoute
      .split("\n")
      .filter(
        (line) =>
          !line.trim().startsWith("*") &&
          !line.trim().startsWith("/*") &&
          !line.trim().startsWith("//"),
      )
      .join("\n");
    assert.doesNotMatch(codeOnly, /brandId|provider|productUrl/);
    assert.doesNotMatch(codeOnly, /campaignId(?!\w)/);
  });

  test("the deleted EXPERIENCE_SHOP click route and surface are gone", () => {
    assert.equal(
      existsSync(
        join(
          process.cwd(),
          "src/app/api/public/experience/[experienceSlug]/products/click/[productLinkId]/route.ts",
        ),
      ),
      false,
    );
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/click-attribution.ts"),
      "utf8",
    );
    const codeOnly = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    assert.doesNotMatch(codeOnly, /experienceProductLink/i);
    assert.doesNotMatch(codeOnly, /lessonProductLink/i);
    assert.doesNotMatch(codeOnly, /EXPERIENCE_SHOP/);
    assert.doesNotMatch(codeOnly, /sourceShopDomain/);
    assert.doesNotMatch(codeOnly, /providerHint/);
  });

  test("Campaign A entry records acquisition Campaign A without fabricating product authorization for an unscoped storefront click", async () => {
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
    const response = await click(LESSON_SURFACE, {
      getAccess: async () =>
        access({
          campaigns: twoEligibleCampaigns(),
          storedCampaignId: "campaign-A", // stale state must not control direct entry
          entryContext: { kind: "DIRECT" },
        }),
      findCampaignLessonProduct: async () => lessonLink(),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured[0].entryCampaignId, null);
    assert.equal(captured[0].productCampaignId, "campaign-A");
  });

  test("all four canonical identity columns are populated on a lesson click, and no legacy link id is ever written", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(LESSON_SURFACE, {
      getAccess: async () =>
        access({ entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" } }),
      findCampaignLessonProduct: async () => lessonLink(),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured[0].campaignLessonProductId, "clp-1");
    assert.equal(captured[0].brandCommerceProductId, "bcp-1");
    assert.equal(captured[0].connectedProductId, "connected-1");
    assert.equal(captured[0].commerceConnectionId, "connection-1");
    assert.equal(captured[0].provider, "SHOPIFY");
    // The doomed columns are not even expressible on the mint input.
    assert.equal("lessonProductLinkId" in captured[0], false);
    assert.equal("experienceProductLinkId" in captured[0], false);
  });

  test("the mint writes the canonical identity columns and never the two doomed ones", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/click-attribution.ts"),
      "utf8",
    );
    const createStart = source.indexOf("prisma.commerceClickAttribution.create");
    assert.ok(createStart > 0);
    const createBody = source.slice(createStart);
    assert.match(createBody, /campaignLessonProductId: input\.campaignLessonProductId/);
    assert.match(createBody, /brandCommerceProductId: input\.brandCommerceProductId/);
    assert.match(createBody, /connectedProductId: input\.connectedProductId/);
    assert.match(createBody, /commerceConnectionId: input\.commerceConnectionId/);
    assert.doesNotMatch(createBody, /lessonProductLinkId:/);
    assert.doesNotMatch(createBody, /experienceProductLinkId:/);
  });

  test("direct generic brand catalog click does not invent a product campaign", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(
      { kind: "BRAND_STOREFRONT", brandCommerceProductId: "bcp-1" },
      {
        getAccess: async () =>
          access({
            campaigns: twoEligibleCampaigns(),
            storedCampaignId: "campaign-A",
            entryContext: { kind: "DIRECT" },
          }),
        findBrandStorefrontProduct: async (options) => {
          assert.equal(options.entryCampaignId, null);
          return resolvedLink();
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
      { kind: "CAMPAIGN_PRODUCT", campaignAssignmentId: "assignment-a" },
      {
        getAccess: async () =>
          access({ campaigns: twoEligibleCampaigns(), entryContext: { kind: "DIRECT" } }),
        findCampaignProduct: async (options) => {
          assert.equal(options.campaignAssignmentId, "assignment-a");
          return resolvedLink({
            id: "assignment-a",
            scope: { campaignId: "campaign-A", isActive: true },
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

describe("Campaign A/B lesson product isolation at the click surface (items 1 & 2)", () => {
  test("a Campaign A visitor cannot click a Campaign B lesson product", async () => {
    const response = await click(LESSON_SURFACE, {
      getAccess: async () =>
        access({
          entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" },
          campaigns: twoEligibleCampaigns(),
        }),
      findCampaignLessonProduct: async () =>
        lessonLink({ scope: { campaignId: "campaign-B", isActive: true } }),
    });

    assert.equal(response.status, 404);
  });

  test("a Campaign B visitor cannot click a Campaign A lesson product (symmetric)", async () => {
    const response = await click(LESSON_SURFACE, {
      getAccess: async () =>
        access({
          entryContext: { kind: "CAMPAIGN", campaignId: "campaign-B" },
          campaigns: twoEligibleCampaigns(),
        }),
      findCampaignLessonProduct: async () =>
        lessonLink({ scope: { campaignId: "campaign-A", isActive: true } }),
    });

    assert.equal(response.status, 404);
  });

  test("control: a Campaign A visitor CAN click Campaign A's own lesson product (proves the denial above is scope-specific, not a blanket failure)", async () => {
    const response = await click(LESSON_SURFACE, {
      getAccess: async () =>
        access({
          entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" },
          campaigns: twoEligibleCampaigns(),
        }),
      findCampaignLessonProduct: async () =>
        lessonLink({ scope: { campaignId: "campaign-A", isActive: true } }),
    });

    assert.equal(response.status, 302);
  });
});

describe("public lesson click: foreign ids fail closed against the real containment predicate (items 5 & 6)", () => {
  // These finders mirror ONLY the id/lessonId/experienceId containment portion
  // of DEFAULT_DEPS.findCampaignLessonProduct's actual Prisma `where` clause
  // (`where: { id: campaignLessonProductId, lessonId, lesson: { course: {
  // experienceId } } }`): a lookup resolves only when all three match a single
  // known-good row, exactly like `findFirst` returns null on any non-matching
  // WHERE. This is not a stub of the property under test — the fixture doesn't
  // know the "right answer" in advance, it re-derives it from the same three
  // fields the real query filters on.
  const REAL_ROW = { id: "clp-real", lessonId: "lesson-1", experienceId: "experience-1" };

  function containmentMirroringFinder() {
    return async (options: {
      campaignLessonProductId: string;
      lessonId: string;
      experienceId: string;
    }) => {
      if (
        options.campaignLessonProductId !== REAL_ROW.id ||
        options.lessonId !== REAL_ROW.lessonId ||
        options.experienceId !== REAL_ROW.experienceId
      ) {
        return null;
      }
      return lessonLink({ id: REAL_ROW.id, campaignLessonProductId: REAL_ROW.id, scope: null });
    };
  }

  test("a foreign CampaignLessonProduct id fails closed with the generic 404 (item 5)", async () => {
    const response = await click(
      { kind: "LESSON", lessonId: REAL_ROW.lessonId, campaignLessonProductId: "forged-clp-id" },
      { findCampaignLessonProduct: containmentMirroringFinder() },
    );

    assert.equal(response.status, 404);
  });

  test("a foreign Lesson id fails closed the same way, even with the correct product id (item 6)", async () => {
    const response = await click(
      { kind: "LESSON", lessonId: "forged-lesson-id", campaignLessonProductId: REAL_ROW.id },
      { findCampaignLessonProduct: containmentMirroringFinder() },
    );

    assert.equal(response.status, 404);
  });

  test("control: the exact matching id+lesson combination succeeds (proves the finder above isn't just always-null)", async () => {
    const response = await click(
      { kind: "LESSON", lessonId: REAL_ROW.lessonId, campaignLessonProductId: REAL_ROW.id },
      { findCampaignLessonProduct: containmentMirroringFinder() },
    );

    assert.equal(response.status, 302);
  });
});

describe("public lesson click: storefront gate fails closed behaviorally (item 17)", () => {
  // Per the module's own PUBLICLY_CLICKABLE_CONNECTED_PRODUCT documentation,
  // the gate lives inside the default finder's Prisma `where` predicate, not in
  // injectable logic reachable independent of a real query. This fake finder
  // faithfully re-implements ONLY that predicate (isAvailable AND
  // hasPublicStorefrontUrl, both required) against a fixture's own facts, the
  // same way `findFirst` would return no row for a WHERE that excludes it — it
  // does not simply hardcode the expected response.
  function storefrontGateMirroringFinder(productFacts: {
    isAvailable: boolean;
    hasPublicStorefrontUrl: boolean;
  }) {
    return async () => {
      if (!productFacts.isAvailable || !productFacts.hasPublicStorefrontUrl) {
        return null;
      }
      return lessonLink();
    };
  }

  test("isAvailable: true but hasPublicStorefrontUrl: false is denied at click time, not redirected", async () => {
    const response = await click(LESSON_SURFACE, {
      findCampaignLessonProduct: storefrontGateMirroringFinder({
        isAvailable: true,
        hasPublicStorefrontUrl: false,
      }),
    });

    assert.equal(response.status, 404);
  });

  test("hasPublicStorefrontUrl: true but isAvailable: false is denied too (neither condition substitutes for the other)", async () => {
    const response = await click(LESSON_SURFACE, {
      findCampaignLessonProduct: storefrontGateMirroringFinder({
        isAvailable: false,
        hasPublicStorefrontUrl: true,
      }),
    });

    assert.equal(response.status, 404);
  });

  test("control: both conditions true redirects (proves the fake finder isn't just always-null)", async () => {
    const response = await click(LESSON_SURFACE, {
      findCampaignLessonProduct: storefrontGateMirroringFinder({
        isAvailable: true,
        hasPublicStorefrontUrl: true,
      }),
    });

    assert.equal(response.status, 302);
  });
});

describe("forged input handling", () => {
  test("an unknown catalog id returns the generic 404, not a 500 and not a redirect", async () => {
    const response = await click(SHOP_SURFACE, {
      findBrandStorefrontProduct: async () => null,
    });

    assert.equal(response.status, 404);
    const body = await response.json();
    assert.equal(body.error, "Not found.");
  });

  test("a non-http(s) destination scheme is rejected, not redirected to", async () => {
    let mintCalled = false;
    const response = await click(SHOP_SURFACE, {
      findBrandStorefrontProduct: async () =>
        resolvedLink({ productUrl: "javascript:alert(1)" }),
      recordAttribution: async () => {
        mintCalled = true;
      },
    });

    assert.equal(response.status, 404);
    assert.equal(mintCalled, false);
  });

  test("a data: destination scheme is also rejected", async () => {
    const response = await click(SHOP_SURFACE, {
      findBrandStorefrontProduct: async () =>
        resolvedLink({ productUrl: "data:text/html,<script>alert(1)</script>" }),
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
    assert.match(
      source,
      /validateDestination\(\s*link\.productUrl,\s*link\.connectionExternalAccountId,\s*link\.provider,\s*link\.hasProviderSuppliedStorefrontUrl,?\s*\)/,
    );
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
  test("a Shopify custom-domain URL redirects only when provider-supplied provenance was persisted", async () => {
    const response = await click(SHOP_SURFACE, {
      findBrandStorefrontProduct: async () =>
        resolvedLink({
          productUrl: "https://shop.acme.example/products/widget",
          connectionExternalAccountId: "acme.myshopify.com",
          hasProviderSuppliedStorefrontUrl: true,
        }),
    });

    assert.equal(response.status, 302);
    assert.match(
      response.headers.get("location") || "",
      /^https:\/\/shop\.acme\.example\/products\/widget\?ref=/,
    );
  });

  test("a synthesized custom-domain URL is rejected rather than becoming an open redirect", async () => {
    let mintCalled = false;
    const response = await click(SHOP_SURFACE, {
      findBrandStorefrontProduct: async () =>
        resolvedLink({
          productUrl: "https://attacker.example/products/widget",
          connectionExternalAccountId: "acme.myshopify.com",
          hasProviderSuppliedStorefrontUrl: false,
        }),
      recordAttribution: async () => {
        mintCalled = true;
      },
    });

    assert.equal(response.status, 404);
    assert.equal(mintCalled, false);
  });

  test("the redirect Location carries only the opaque token as ?ref=, never an email or raw internal id", async () => {
    const response = await click(SHOP_SURFACE, {}, req());
    assert.equal(response.status, 302);
    const location = response.headers.get("location") || "";

    assert.match(location, /^https:\/\/acme\.test\/products\/widget\?ref=[A-Za-z0-9_-]{43}$/);
    assert.doesNotMatch(location, /@/); // no email pattern
    assert.doesNotMatch(location, /bcp-1|brand-1|campaign-A|creator-1|experience-1/);
  });

  test("Cache-Control and Referrer-Policy are set on the redirect (never cached, never leaked to the merchant's referer logs)", async () => {
    const response = await click(SHOP_SURFACE);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  });

  test("an existing ?ref= on the merchant's own URL is left untouched, not clobbered", async () => {
    const response = await click(SHOP_SURFACE, {
      findBrandStorefrontProduct: async () =>
        resolvedLink({ productUrl: "https://acme.test/products/widget?ref=merchant-own-value" }),
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
      "src/app/api/public/experience/[experienceSlug]/products/click/campaign/[campaignAssignmentId]/route.ts",
      "src/app/api/public/experience/[experienceSlug]/products/click/catalog/[brandCommerceProductId]/route.ts",
      "src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/products/click/[campaignLessonProductId]/route.ts",
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

describe("Phase 8.3 commerce click attribution matrix", () => {
  test("Matrix 6: Campaign A visitor clicks generic Brand storefront product -> entryCampaignId=Campaign A, productCampaignId=null", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(
      { kind: "BRAND_STOREFRONT", brandCommerceProductId: "bcp-1" },
      {
        getAccess: async () =>
          access({
            campaigns: twoEligibleCampaigns(),
            entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" },
          }),
        findBrandStorefrontProduct: async (options) => {
          assert.equal(options.entryCampaignId, "campaign-A");
          return resolvedLink({ scope: null });
        },
        recordAttribution: async (input) => {
          captured.push(input);
        },
      },
    );

    assert.equal(response.status, 302);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].entryCampaignId, "campaign-A");
    assert.equal(captured[0].productCampaignId, null);
    assert.equal(captured[0].campaignLessonProductId, null);
  });

  test("Matrix 7: Campaign A visitor clicks Campaign A-scoped product -> entryCampaignId=Campaign A, productCampaignId=Campaign A", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(
      { kind: "CAMPAIGN_PRODUCT", campaignAssignmentId: "assignment-a" },
      {
        getAccess: async () =>
          access({
            campaigns: twoEligibleCampaigns(),
            entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" },
          }),
        findCampaignProduct: async (options) => {
          assert.equal(options.campaignAssignmentId, "assignment-a");
          return resolvedLink({
            id: "assignment-a",
            scope: { campaignId: "campaign-A", isActive: true },
          });
        },
        recordAttribution: async (input) => {
          captured.push(input);
        },
      },
    );

    assert.equal(response.status, 302);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].entryCampaignId, "campaign-A");
    assert.equal(captured[0].productCampaignId, "campaign-A");
    assert.equal(captured[0].campaignLessonProductId, null);
  });

  test("Matrix 8: Direct Experience visitor clicks Campaign A-scoped product -> entryCampaignId=null, productCampaignId=Campaign A", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(
      { kind: "CAMPAIGN_PRODUCT", campaignAssignmentId: "assignment-a" },
      {
        getAccess: async () =>
          access({
            campaigns: twoEligibleCampaigns(),
            entryContext: { kind: "DIRECT" },
          }),
        findCampaignProduct: async (options) => {
          assert.equal(options.campaignAssignmentId, "assignment-a");
          return resolvedLink({
            id: "assignment-a",
            scope: { campaignId: "campaign-A", isActive: true },
          });
        },
        recordAttribution: async (input) => {
          captured.push(input);
        },
      },
    );

    assert.equal(response.status, 302);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].entryCampaignId, null);
    assert.equal(captured[0].productCampaignId, "campaign-A");
    assert.equal(captured[0].campaignLessonProductId, null);
  });

  test("Matrix 9: Direct Experience visitor clicks Lesson product -> entryCampaignId=null, productCampaignId=Campaign A, campaignLessonProductId populated", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(
      { kind: "LESSON", lessonId: "lesson-1", campaignLessonProductId: "clp-1" },
      {
        getAccess: async () =>
          access({
            campaigns: twoEligibleCampaigns(),
            entryContext: { kind: "DIRECT" },
          }),
        findCampaignLessonProduct: async (options) => {
          assert.equal(options.campaignLessonProductId, "clp-1");
          assert.equal(options.lessonId, "lesson-1");
          return resolvedLink({
            id: "clp-1",
            lessonId: "lesson-1",
            campaignLessonProductId: "clp-1",
            scope: { campaignId: "campaign-A", isActive: true },
          });
        },
        recordAttribution: async (input) => {
          captured.push(input);
        },
      },
    );

    assert.equal(response.status, 302);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].entryCampaignId, null);
    assert.equal(captured[0].productCampaignId, "campaign-A");
    assert.equal(captured[0].campaignLessonProductId, "clp-1");
  });
});

/**
 * A multi-brand Experience: two eligible campaigns owned by DIFFERENT brands.
 *
 * `twoEligibleCampaigns()` above deliberately puts both campaigns under
 * `brand-1`, which is the right fixture for campaign-isolation tests but cannot
 * distinguish "the entry campaign's brand" from "the clicked product's brand".
 * The Phase 10 durability tests need exactly that distinction, so they use this.
 */
function twoBrandCampaigns(): ExperienceAccessContext["experience"]["campaigns"] {
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
        brand: { id: "brand-2", name: "Globex", slug: "globex", logoUrl: null },
      },
    },
  ];
}

/**
 * PHASE 10 — the two durable analytics columns are actually WRITTEN, per surface.
 *
 * Before this block nothing asserted that a real `handleCommerceClick()` call
 * persists `surface` or `attributedBrandId` at all. Every combination below is
 * consistent with the "Phase 8.3 commerce click attribution matrix" block above,
 * which remains the de facto spec for `entryCampaignId` / `productCampaignId` /
 * `campaignLessonProductId`; these tests add the two new columns to that same
 * matrix rather than restating a second, divergent rule.
 *
 * No database: the same injected `CommerceClickDeps` doubles the other 48 tests
 * in this file use. `recordAttribution` captures the exact `AttributionInput`
 * the module built, which is the boundary at which the two values are decided.
 */
describe("Phase 10 durable capture: surface and attributedBrandId per surface kind", () => {
  test("a BRAND_STOREFRONT click records surface=BRAND_STOREFRONT and the resolved brand id", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(SHOP_SURFACE, {
      getAccess: async () => access({ entryContext: { kind: "DIRECT" } }),
      findBrandStorefrontProduct: async () =>
        resolvedLink({ brandId: "brand-1", scope: null }),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].surface, "BRAND_STOREFRONT");
    assert.equal(captured[0].attributedBrandId, "brand-1");
    // The durable copy is the SAME value the module resolved as `brandId`; it is
    // a snapshot of that decision, never an independent second derivation.
    assert.equal(captured[0].attributedBrandId, captured[0].brandId);
    // Matrix agreement (unscoped storefront surface).
    assert.equal(captured[0].productCampaignId, null);
    assert.equal(captured[0].campaignLessonProductId, null);
  });

  test("a CAMPAIGN_PRODUCT click records surface=CAMPAIGN_PRODUCT and the resolved brand id", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(
      { kind: "CAMPAIGN_PRODUCT", campaignAssignmentId: "assignment-a" },
      {
        getAccess: async () =>
          access({
            campaigns: twoEligibleCampaigns(),
            entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" },
          }),
        findCampaignProduct: async () =>
          resolvedLink({
            id: "assignment-a",
            brandId: "brand-1",
            scope: { campaignId: "campaign-A", isActive: true },
          }),
        recordAttribution: async (input) => {
          captured.push(input);
        },
      },
    );

    assert.equal(response.status, 302);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].surface, "CAMPAIGN_PRODUCT");
    assert.equal(captured[0].attributedBrandId, "brand-1");
    assert.equal(captured[0].attributedBrandId, captured[0].brandId);
    // Matrix 7 agreement.
    assert.equal(captured[0].entryCampaignId, "campaign-A");
    assert.equal(captured[0].productCampaignId, "campaign-A");
    assert.equal(captured[0].campaignLessonProductId, null);
  });

  test("a LESSON click records surface=LESSON and the resolved brand id", async () => {
    const captured: AttributionInput[] = [];
    const response = await click(LESSON_SURFACE, {
      getAccess: async () =>
        access({
          campaigns: twoEligibleCampaigns(),
          entryContext: { kind: "DIRECT" },
        }),
      findCampaignLessonProduct: async () => lessonLink({ brandId: "brand-1" }),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].surface, "LESSON");
    assert.equal(captured[0].attributedBrandId, "brand-1");
    assert.equal(captured[0].attributedBrandId, captured[0].brandId);
    // Matrix 9 agreement. This combination is precisely the one that becomes
    // unrecoverable without the durable column: deleting the
    // `CampaignLessonProduct` nulls `campaignLessonProductId` while leaving
    // `lessonId` and `productCampaignId`, so an inferring reader would then
    // reclassify this exact row as CAMPAIGN_PRODUCT.
    assert.equal(captured[0].entryCampaignId, null);
    assert.equal(captured[0].productCampaignId, "campaign-A");
    assert.equal(captured[0].campaignLessonProductId, "clp-1");
  });

  test("attributedBrandId tracks the PRODUCT's resolved brand, not the entry campaign's brand, when they differ", async () => {
    // Case-3-shaped cross-campaign fixture: the visitor was acquired by
    // campaign-A (owned by brand-1) but clicks a storefront product that
    // resolves to brand-2. Entry campaign and attributed brand genuinely differ,
    // which is the only fixture in which "which source wins" is observable — the
    // same technique the "resolved brandId always comes from the looked-up link
    // row" test at the top of this file uses.
    const captured: AttributionInput[] = [];
    const response = await click(SHOP_SURFACE, {
      getAccess: async () =>
        access({
          campaigns: twoBrandCampaigns(),
          entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" },
        }),
      findBrandStorefrontProduct: async () =>
        resolvedLink({ brandId: "brand-2", scope: null }),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured.length, 1);
    assert.equal(captured[0].entryCampaignId, "campaign-A");
    assert.equal(captured[0].productCampaignId, null);
    assert.equal(captured[0].surface, "BRAND_STOREFRONT");
    // The product's brand, NOT campaign-A's brand-1.
    assert.equal(captured[0].attributedBrandId, "brand-2");
    assert.notEqual(captured[0].attributedBrandId, "brand-1");
    assert.equal(captured[0].attributedBrandId, captured[0].brandId);
  });

  test("when the link carries no brand, attributedBrandId snapshots the same context-brand fallback brandId uses (never null-by-omission)", async () => {
    // `brandId = link.brandId ?? resolvedCampaignBrandId`. The durable column
    // must follow the module's RESULT, including this fallback branch —
    // otherwise brand analytics would silently lose every fallback-resolved
    // click while `brandId` still had one.
    const captured: AttributionInput[] = [];
    const response = await click(SHOP_SURFACE, {
      getAccess: async () =>
        access({
          campaigns: twoBrandCampaigns(),
          entryContext: { kind: "CAMPAIGN", campaignId: "campaign-B" },
        }),
      findBrandStorefrontProduct: async () =>
        resolvedLink({ brandId: null, scope: null }),
      recordAttribution: async (input) => {
        captured.push(input);
      },
    });

    assert.equal(response.status, 302);
    assert.equal(captured[0].brandId, "brand-2");
    assert.equal(captured[0].attributedBrandId, "brand-2");
    assert.equal(captured[0].attributedBrandId, captured[0].brandId);
  });

  test("the three surface kinds the union can dispatch are exactly the three values the persisted enum accepts", async () => {
    // Exhaustiveness tripwire. Adding a fourth variant to the
    // `CommerceClickSurface` discriminated union without adding it to the Prisma
    // enum (or vice versa) breaks the one-to-one relationship the schema's own
    // doc comment requires, and would make `surface` unwritable for that
    // variant. This asserts the set actually OBSERVED being recorded, not a
    // hand-maintained list.
    const recorded = new Set<string>();
    const surfaces: CommerceClickSurface[] = [
      SHOP_SURFACE,
      { kind: "CAMPAIGN_PRODUCT", campaignAssignmentId: "assignment-a" },
      LESSON_SURFACE,
    ];

    for (const surface of surfaces) {
      const response = await click(surface, {
        getAccess: async () =>
          access({ entryContext: { kind: "CAMPAIGN", campaignId: "campaign-A" } }),
        findBrandStorefrontProduct: async () => resolvedLink({ scope: null }),
        findCampaignProduct: async () =>
          resolvedLink({
            id: "assignment-a",
            scope: { campaignId: "campaign-A", isActive: true },
          }),
        findCampaignLessonProduct: async () => lessonLink(),
        recordAttribution: async (input) => {
          assert.ok(input.surface, "surface must never be recorded as undefined");
          recorded.add(input.surface);
        },
      });
      assert.equal(response.status, 302);
    }

    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const enumBody = /enum CommerceClickSurface \{([\s\S]*?)\n\}/.exec(schema);
    assert.ok(enumBody, "prisma/schema.prisma must declare enum CommerceClickSurface");
    const enumValues = new Set(
      enumBody[1]
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("///"))
    );

    assert.deepEqual(
      [...recorded].sort(),
      ["BRAND_STOREFRONT", "CAMPAIGN_PRODUCT", "LESSON"],
    );
    assert.deepEqual([...recorded].sort(), [...enumValues].sort());
  });

  test("AttributionInput leaves both durability columns OPTIONAL, so the fail-open mint path cannot NOT-NULL-violate on a caller that omits them", async () => {
    // THE LOAD-BEARING HALF OF THIS TEST IS CHECKED BY `tsc`, NOT AT RUNTIME.
    // This literal deliberately omits `surface` and `attributedBrandId`. If
    // either were promoted to a required property of `AttributionInput`, this
    // annotation stops compiling and `npm run typecheck` fails — which is the
    // assertion. Every pre-Phase-10 injected double in this repository omits
    // both, and the migration header's stated reason for both columns being
    // nullable is exactly this: a NOT NULL surprise would land INSIDE the mint
    // path's catch and silently stop recording clicks while redirects kept
    // working.
    const withoutDurabilityColumns: AttributionInput = {
      tokenHash: "hash",
      tokenPrefix: "prefix",
      brandId: "brand-1",
      entryCampaignId: null,
      productCampaignId: null,
      entryCampaignContextResolved: false,
      experienceId: "experience-1",
      courseId: null,
      lessonId: null,
      creatorProfileId: "creator-1",
      campaignLessonProductId: null,
      brandCommerceProductId: "bcp-1",
      connectedProductId: "connected-1",
      commerceConnectionId: "connection-1",
      provider: "SHOPIFY",
      destinationUrl: "https://acme.test/products/widget",
      destinationHost: "acme.test",
      userId: null,
      sessionId: "session-1",
      ipHash: null,
      userAgent: null,
      referrer: null,
      expiresAt: new Date("2026-09-07T00:00:00.000Z"),
      redirectedAt: new Date("2026-08-08T00:00:00.000Z"),
    };

    assert.equal("surface" in withoutDurabilityColumns, false);
    assert.equal("attributedBrandId" in withoutDurabilityColumns, false);

    // And a `recordAttribution`-shaped consumer accepts it without throwing.
    const consume: CommerceClickDeps["recordAttribution"] = async () => {};
    await assert.doesNotReject(() => consume(withoutDurabilityColumns));

    // The persisted projection turns an omitted value into an EXPLICIT SQL NULL
    // rather than leaving the key absent. Asserted against the real source so it
    // cannot drift into `surface: input.surface` (which would send `undefined`).
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/click-attribution.ts"),
      "utf8",
    );
    assert.match(source, /surface\?: PersistedClickSurface;/);
    assert.match(source, /attributedBrandId\?: string \| null;/);
    const createStart = source.indexOf("prisma.commerceClickAttribution.create");
    assert.ok(createStart > 0);
    const createBody = source.slice(createStart);
    assert.match(createBody, /surface: input\.surface \?\? null,/);
    assert.match(createBody, /attributedBrandId: input\.attributedBrandId \?\? null,/);
  });

  test("a NOT NULL-style mint failure on the durability columns still redirects the visitor (fail-open, per the migration's stated rationale)", async () => {
    // The generic fail-open case is already covered above; this asserts it for
    // the specific hazard these two nullable columns exist to avoid, because a
    // future NOT NULL on either would surface here and nowhere else.
    const response = await click(LESSON_SURFACE, {
      findCampaignLessonProduct: async () => lessonLink(),
      recordAttribution: async () => {
        const error = new Error(
          'null value in column "surface" violates not-null constraint',
        );
        error.name = "PrismaClientKnownRequestError";
        throw error;
      },
    });

    assert.equal(response.status, 302);
    // No token appended, because nothing was recorded — a reporting gap, not an
    // outage on the commerce path.
    assert.equal(
      response.headers.get("location"),
      "https://acme.test/products/widget",
    );
  });
});

/**
 * PHASE 10 — the actual durability property: WRITE-ONCE-AT-INSERT.
 *
 * The behavioral tests above prove the two columns are written correctly. This
 * block proves the stronger, structural claim the phase rests on: nothing
 * anywhere in `src/` can later rewrite them, and nothing re-derives them from
 * live relation state. That is what operationalizes the spec's "analytics must
 * not silently rewrite history merely because a related object was later
 * deleted" — a per-call-site behavioral test could never establish it, because
 * the risk is a call site that does not exist yet.
 */
describe("Phase 10 write-once durability: no code path rewrites surface or attributedBrandId", () => {
  const SRC_ROOT = join(process.cwd(), "src");

  function collectSourceFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        collectSourceFiles(full, out);
      } else if (/\.tsx?$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  /** Drops line comments and JSDoc continuation lines, keeping executable text. */
  function stripComments(source: string): string {
    return source
      .split("\n")
      .filter((line) => {
        const trimmed = line.trim();
        return (
          !trimmed.startsWith("//") &&
          !trimmed.startsWith("*") &&
          !trimmed.startsWith("/*")
        );
      })
      .join("\n");
  }

  /** The call's own argument text, up to and including its closing `});`. */
  function callPayload(source: string, startIndex: number): string {
    const end = source.indexOf("});", startIndex);
    return end === -1 ? source.slice(startIndex) : source.slice(startIndex, end + 3);
  }

  const sources = collectSourceFiles(SRC_ROOT).map((file) => ({
    file,
    relative: file.slice(process.cwd().length + 1),
    code: stripComments(readFileSync(file, "utf8")),
  }));

  test("the walk sees the whole src tree, including the modules under test (guards against a vacuously-passing sweep)", () => {
    assert.ok(sources.length > 100, `expected a real tree, saw ${sources.length} files`);
    const relatives = sources.map((entry) => entry.relative);
    assert.ok(relatives.includes("src/lib/commerce/click-attribution.ts"));
    assert.ok(relatives.includes("src/lib/commerce/commerce-click-analytics.ts"));
    assert.ok(
      relatives.includes("src/lib/commerce/commerce-click-analytics-repository.ts"),
    );
    assert.ok(relatives.includes("src/lib/commerce/order-ingestion.ts"));
  });

  test("the only MUTATING Prisma methods used against CommerceClickAttribution anywhere in src/ are create and updateMany", () => {
    const mutating = new Set<string>();
    for (const { code } of sources) {
      const pattern =
        /commerceClickAttribution\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g;
      for (const match of code.matchAll(pattern)) {
        mutating.add(match[1]);
      }
    }

    // A tripwire, deliberately exact: a new mutation method appearing on this
    // table must be reviewed against the write-once property below, not slip in.
    assert.deepEqual([...mutating].sort(), ["create", "updateMany"]);
  });

  test("no update/updateMany/upsert against CommerceClickAttribution touches surface or attributedBrandId", () => {
    let inspected = 0;

    for (const { relative, code } of sources) {
      const pattern =
        /commerceClickAttribution\s*\.\s*(update|updateMany|upsert)\s*\(/g;
      for (const match of code.matchAll(pattern)) {
        inspected += 1;
        const payload = callPayload(code, match.index);
        assert.doesNotMatch(
          payload,
          /\bsurface\b/,
          `${relative}: ${match[1]}() must never write surface`,
        );
        assert.doesNotMatch(
          payload,
          /\battributedBrandId\b/,
          `${relative}: ${match[1]}() must never write attributedBrandId`,
        );
        // Positive control: the one existing conditional update in this
        // repository is the order-ingestion click CLAIM, which writes only the
        // pre-existing idempotency seam. If that ever stops being true the
        // assertion above is no longer the whole story.
        assert.match(payload, /consumedAt/);
      }
    }

    // The sweep must not pass because it found nothing to look at.
    assert.equal(
      inspected,
      1,
      `expected exactly one conditional update on this table, saw ${inspected}`,
    );
  });

  test("exactly one INSERT into this table exists in src/, it is the mint path, and it is the only place the two columns are written", () => {
    // Scoped to actual Prisma write payloads on purpose. A bare `surface:` key
    // is NOT evidence of a write: the click routes construct the per-request
    // `CommerceClickSurface` union with `surface: { kind: ... }`, and the
    // analytics layer uses `surface:` as a type/breakdown/filter key. The claim
    // under test is narrower and stronger — the persisted columns are written by
    // exactly one INSERT and by nothing else.
    const inserts: Array<{ relative: string; payload: string }> = [];

    for (const { relative, code } of sources) {
      for (const match of code.matchAll(
        /commerceClickAttribution\s*\.\s*create(?:Many)?\s*\(/g,
      )) {
        inserts.push({ relative, payload: callPayload(code, match.index) });
      }
    }

    assert.equal(inserts.length, 1, `expected exactly one INSERT, saw ${inserts.length}`);
    assert.equal(inserts[0].relative, "src/lib/commerce/click-attribution.ts");
    assert.match(inserts[0].payload, /surface: input\.surface \?\? null,/);
    assert.match(
      inserts[0].payload,
      /attributedBrandId: input\.attributedBrandId \?\? null,/,
    );

    // And nothing anywhere in src/ ever ASSIGNS to either persisted column on a
    // fetched row, which is the only remaining shape a post-insert rewrite could
    // take now that the update/insert sweeps are pinned.
    for (const { relative, code } of sources) {
      assert.doesNotMatch(
        code,
        /\.\s*attributedBrandId\s*=[^=]/,
        `${relative} assigns to a row's attributedBrandId`,
      );
      assert.doesNotMatch(
        code,
        /\.\s*surface\s*=[^=]/,
        `${relative} assigns to a row's surface`,
      );
    }
  });

  test("no raw SQL exists anywhere in src/, so no UPDATE can bypass the Prisma-level sweep above", () => {
    for (const { relative, code } of sources) {
      assert.doesNotMatch(code, /\$executeRaw/, `${relative} uses $executeRaw`);
      assert.doesNotMatch(code, /\$queryRaw/, `${relative} uses $queryRaw`);
      assert.doesNotMatch(code, /Prisma\.sql/, `${relative} builds raw SQL`);
    }
  });

  test("the analytics layer reads the durable surface column and never re-derives it from surviving foreign keys", () => {
    const analytics = sources.filter((entry) =>
      [
        "src/lib/commerce/commerce-click-analytics.ts",
        "src/lib/commerce/commerce-click-analytics-repository.ts",
      ].includes(entry.relative),
    );
    assert.equal(analytics.length, 2);

    for (const { relative, code } of analytics) {
      // The lossy inference inputs named by the migration header. None of them
      // may appear in executable analytics code at all: the moment one does,
      // "surface" stops being a persisted fact and becomes a guess.
      assert.doesNotMatch(
        code,
        /campaignLessonProductId/,
        `${relative} must not infer a surface from campaignLessonProductId`,
      );
      // No assignment to either durable column, in any form.
      assert.doesNotMatch(code, /surface\s*=[^=]/, `${relative} assigns to surface`);
      assert.doesNotMatch(
        code,
        /attributedBrandId\s*=[^=]/,
        `${relative} assigns to attributedBrandId`,
      );
    }

    const repository = analytics.find((entry) =>
      entry.relative.endsWith("commerce-click-analytics-repository.ts"),
    );
    assert.ok(repository);
    // The surface split is a groupBy on the persisted column, and brand scoping
    // filters `attributedBrandId`, never the cascade-exposed `brandId`.
    assert.match(repository.code, /by: \["surface"\]/);
    assert.match(repository.code, /attributedBrandId: \{ in: ids \}/);
    assert.doesNotMatch(repository.code, /\bbrandId: \{ in: ids \}/);
  });
});

/**
 * Cross-check additions for the Phase 11 "provider-neutral" claim and the
 * click-only boundary, at the LIBRARY layer.
 *
 * tests/brand-commerce-analytics.test.ts and
 * tests/creator-commerce-analytics.test.ts already run vocabulary tripwires, but
 * both read only their own route file and dashboard page. The pure core and the
 * repository — the two files every route delegates to — were unguarded.
 */
describe("Phase 11 provider neutrality and click-only boundary in the analytics library", () => {
  const ANALYTICS_FILES = [
    "src/lib/commerce/commerce-click-analytics.ts",
    "src/lib/commerce/commerce-click-analytics-repository.ts",
  ];

  test("provider is a groupBy DIMENSION only: neither file branches on a provider value", () => {
    for (const file of ANALYTICS_FILES) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      // A `provider === "SHOPIFY"` test, a switch case on one, or any
      // provider-specific helper would make the analytics Shopify-shaped rather
      // than provider-neutral. `provider` may only ever be grouped by.
      assert.doesNotMatch(source, /provider\s*[=!]==?\s*["']SHOPIFY["']/i, file);
      assert.doesNotMatch(source, /["']SHOPIFY["']\s*[=!]==?\s*/i, file);
      assert.doesNotMatch(source, /case\s+["']SHOPIFY["']/i, file);
      assert.doesNotMatch(source, /isShopify|shopifyOnly|SHOPIFY_/i, file);
    }

    // Positive control: `provider` IS present, purely as a group-by dimension.
    const repository = readFileSync(
      join(process.cwd(), ANALYTICS_FILES[1]),
      "utf8",
    );
    assert.match(repository, /by: \["provider"\]/);
  });

  test("neither file references any CommerceOrder model or the .order relation", () => {
    for (const file of ANALYTICS_FILES) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      // Covers CommerceOrder, CommerceOrderLineItem, CommerceOrderEvent and the
      // `commerceOrder*` Prisma delegates in one case-insensitive token.
      assert.doesNotMatch(source, /commerceOrder/i, file);
      // `\b` keeps this from matching `orderBy`, which the repository uses
      // legitimately for deterministic bounded reads.
      assert.doesNotMatch(source, /\.order\b/, file);
      assert.doesNotMatch(source, /attributionId/i, file);
      assert.doesNotMatch(source, /consumedAt|consumedByOrderRef/, file);
    }
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

/**
 * The permanent shape test for the Phase 10 migration, kept beside the
 * 20260807160000 block above per this file's convention: every migration that
 * touches `CommerceClickAttribution` gets a committed shape test.
 */
describe("migration shape: 20260808150000_add_commerce_click_analytics_durability", () => {
  const migration = readFileSync(
    join(
      process.cwd(),
      "prisma/migrations/20260808150000_add_commerce_click_analytics_durability/migration.sql",
    ),
    "utf8",
  );
  const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");

  /**
   * Executable SQL only, stripped the same way the 20260807160000 block above
   * strips it. This distinction MATTERS more here than there: this migration's
   * header deliberately NAMES the vocabulary it refuses to introduce ("IT ADDS
   * NO MONEY, ORDER, CONVERSION, REVENUE, OR QUANTITY COLUMN"), so a
   * whole-file substring check for those words would fail on the very sentence
   * that promises their absence. Every "must not appear" assertion below is
   * therefore run against `codeOnly`, except where the whole file is genuinely
   * expected to be clean and is asserted as such explicitly.
   */
  const codeOnly = migration
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n");

  function countMatches(source: string, pattern: RegExp): number {
    return source.match(pattern)?.length ?? 0;
  }

  test("is additive-only: no UPDATE/DELETE/TRUNCATE/DROP, no ALTER ... DROP, no ALTER COLUMN, outside comments", () => {
    assert.equal(/^\s*(?:UPDATE|DELETE|TRUNCATE|DROP)\b/im.test(codeOnly), false);
    assert.equal(/^\s*ALTER TABLE .*\s+DROP\b/im.test(codeOnly), false);
    assert.equal(/\bALTER COLUMN\b/i.test(codeOnly), false);
    assert.equal(/\bDROP\b/i.test(codeOnly), false);
    // No pre-existing constraint, index or foreign key is redefined either.
    assert.equal(/\bADD CONSTRAINT\b/i.test(codeOnly), false);
    assert.equal(/\bALTER INDEX\b/i.test(codeOnly), false);
    // Positive control: the file really does contain executable SQL, so the
    // negatives above are not passing over an empty string.
    assert.match(codeOnly, /CREATE TYPE "CommerceClickSurface"/);
  });

  test("carries the PREFLIGHT, CASCADE REASONING and ROLLBACK LIMITATION header sections", () => {
    assert.match(migration, /^--\s*PREFLIGHT\b/m);
    assert.match(migration, /^--\s*CASCADE REASONING\s*$/m);
    assert.match(migration, /^--\s*ROLLBACK LIMITATION\b/m);
    // The two facts those sections exist to record, so a future edit cannot keep
    // the headings while dropping the reasoning that makes them load-bearing.
    assert.match(migration, /"attributedBrandId" IS DELIBERATELY NOT A FOREIGN KEY/);
    assert.match(migration, /NO BACKFILL, ON PURPOSE/);
  });

  test("introduces no money, order, conversion, revenue or quantity vocabulary", () => {
    // Substring, case-insensitive, over executable SQL (see `codeOnly` above).
    for (const word of [
      "amount",
      "price",
      "orderid",
      "quantity",
      "revenue",
      "conversion",
    ]) {
      assert.equal(
        codeOnly.toLowerCase().includes(word),
        false,
        `executable SQL unexpectedly mentions "${word}"`,
      );
    }
    // And the quoted-identifier form is absent from the WHOLE file, mirroring
    // the 20260807160000 block's own money-vocabulary assertion.
    assert.doesNotMatch(
      migration,
      /"amount"|"price"|"orderId"|"quantity"|"revenue"|"conversion"/i,
    );
  });

  test("does not touch or mention the order-side idempotency seam anywhere in the file", () => {
    // Whole file, not just executable SQL: this migration has no business even
    // discussing order consumption, and none of these appear today.
    assert.doesNotMatch(migration, /consumedAt/);
    assert.doesNotMatch(migration, /consumedByOrderRef/);
    assert.doesNotMatch(migration, /CommerceOrder/);
  });

  test("is exactly one CREATE TYPE, one ALTER TABLE ADD COLUMN adding two columns, and eight CREATE INDEX", () => {
    assert.equal(countMatches(codeOnly, /^CREATE TYPE\b/gim), 1);
    assert.equal(countMatches(codeOnly, /^ALTER TABLE\b/gim), 1);
    assert.equal(countMatches(codeOnly, /\bADD COLUMN\b/gi), 2);
    assert.equal(countMatches(codeOnly, /^CREATE INDEX\b/gim), 8);
    assert.equal(countMatches(codeOnly, /CREATE UNIQUE INDEX/gi), 0);

    // Ten statements total and nothing else: 1 + 1 + 8, counted independently of
    // the per-form regexes above so an unnoticed eleventh statement cannot hide.
    assert.equal(
      codeOnly.split(";").filter((statement) => statement.trim().length > 0).length,
      10,
    );

    assert.match(
      codeOnly,
      /CREATE TYPE "CommerceClickSurface" AS ENUM \('BRAND_STOREFRONT', 'CAMPAIGN_PRODUCT', 'LESSON'\);/,
    );
    // The single ALTER TABLE adds precisely the two Phase 10 columns and only
    // ever touches CommerceClickAttribution.
    assert.match(codeOnly, /ALTER TABLE "CommerceClickAttribution" ADD COLUMN\s+"attributedBrandId" TEXT,/);
    assert.match(codeOnly, /ADD COLUMN\s+"surface" "CommerceClickSurface";/);
    assert.equal(
      /ALTER TABLE (?!"CommerceClickAttribution")/.test(codeOnly),
      false,
      "no other table may be altered",
    );

    for (const index of [
      "CommerceClickAttribution_attributedBrandId_createdAt_idx",
      "CommerceClickAttribution_attributedBrand_surface_createdAt_idx",
      "CommerceClickAttribution_surface_createdAt_idx",
      "CommerceClickAttribution_creatorProfileId_createdAt_idx",
      "CommerceClickAttribution_lessonId_createdAt_idx",
      "CommerceClickAttribution_brandCommerceProductId_createdAt_idx",
      "CommerceClickAttribution_connectedProductId_createdAt_idx",
      "CommerceClickAttribution_qrCodeId_createdAt_idx",
    ]) {
      assert.ok(
        codeOnly.includes(`CREATE INDEX "${index}"`),
        `missing CREATE INDEX "${index}"`,
      );
      // Every index name is inside PostgreSQL's 63-byte identifier limit, so
      // none is silently truncated (the reason the middle one is named
      // explicitly in the schema rather than left to Prisma's default).
      assert.ok(index.length <= 63, `${index} is ${index.length} bytes`);
    }
  });

  test("attributedBrandId is created with NO foreign key — the property that makes it immune to the cascade hazard", () => {
    // Zero REFERENCES clauses in executable SQL at all, so a fortiori none on
    // `attributedBrandId`. (The word appears once in the header prose, as
    // "references a live Brand row", explaining the deliberate cost.)
    assert.equal(/\bREFERENCES\b/i.test(codeOnly), false);
    assert.equal(/\bFOREIGN KEY\b/i.test(codeOnly), false);
    assert.equal(/\bON DELETE\b/i.test(codeOnly), false);
    assert.equal(/\bON UPDATE\b/i.test(codeOnly), false);

    // Declared as a plain nullable TEXT column: no NOT NULL, no DEFAULT, no
    // backfill. Both columns must stay nullable because the mint path is
    // fail-open (see the durability describe block above).
    assert.match(codeOnly, /"attributedBrandId" TEXT,/);
    assert.equal(/"attributedBrandId" TEXT NOT NULL/i.test(codeOnly), false);
    assert.equal(/"surface" "CommerceClickSurface" NOT NULL/i.test(codeOnly), false);
    assert.equal(/\bDEFAULT\b/i.test(codeOnly), false);

    // The schema agrees: a plain optional scalar, not a relation field.
    assert.match(schema, /attributedBrandId String\?/);
    assert.equal(/attributedBrandId String\?[^\n]*@relation/.test(schema), false);
    assert.match(schema, /surface CommerceClickSurface\?/);
  });
});
