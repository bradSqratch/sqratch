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
import { existsSync, readFileSync } from "node:fs";
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
