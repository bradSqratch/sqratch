/**
 * tests/public-campaign-context-isolation.test.ts
 *
 * Public-side coverage for Phase 5 multi-campaign product links, split into
 * two techniques:
 *
 *  1. Full behavioral tests against `publicExperienceProductsGetImpl`
 *     (src/app/api/public/experience/[experienceSlug]/products/route.ts),
 *     which IS dependency-injected — same technique as
 *     tests/public-experience-product-catalog.test.ts.
 *
 *  2. Source-inspection tests for the lesson-products route
 *     (src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/products/route.ts)
 *     and the progress route (src/app/api/progress/lesson/route.ts), which
 *     are NOT dependency-injected — they call `getExperienceAccessContext`,
 *     which calls next-auth's `getServerSession`, which calls
 *     `next/headers` `cookies()`. That throws "headers was called outside a
 *     request scope" outside a real Next.js request lifecycle, so no test
 *     anywhere in this repo drives such a route through directly (confirmed
 *     against tests/points-activity-source-checks.test.ts, the established
 *     precedent for this exact situation). The pure filtering/resolution
 *     logic these routes depend on (`resolveValidatedPublicCampaignContext`,
 *     `resolvePublicCampaignId`) is fully covered behaviorally in
 *     tests/campaign-context.test.ts; this file additionally proves the
 *     routes actually WIRE that logic in on the exact fields/order the audit
 *     requires.
 *
 * No real DB connection or network call is made anywhere in this file.
 */
process.env.DATABASE_URL =
  "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";
process.env.NEXTAUTH_SECRET = "test-nextauth-secret";

import { before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

import type { PublicExperienceProductsDeps } from "../src/app/api/public/experience/[experienceSlug]/products/route";

let getProducts: (
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
  overrides?: Partial<PublicExperienceProductsDeps>,
) => Promise<Response>;

before(async () => {
  const route =
    await import("../src/app/api/public/experience/[experienceSlug]/products/route");
  getProducts = route.publicExperienceProductsGetImpl;
});

const routeContext = {
  params: Promise.resolve({ experienceSlug: "my-experience" }),
};

function request() {
  return new NextRequest(
    "https://sqratch.test/api/public/experience/my-experience/products",
  );
}

function twoCampaignAccess(storedCampaignId: string | null) {
  return {
    viewer: { sessionId: "viewer-session", userId: "viewer-1" },
    storedCampaignId,
    experience: {
      id: "experience-1",
      slug: "my-experience",
      title: "My experience",
      campaigns: [
        {
          campaignId: "campaign-a",
          campaign: {
            id: "campaign-a",
            name: "Campaign A",
            brand: {
              id: "brand-a",
              name: "Brand A",
              slug: "brand-a",
              logoUrl: null,
            },
          },
        },
        {
          campaignId: "campaign-b",
          campaign: {
            id: "campaign-b",
            name: "Campaign B",
            brand: {
              id: "brand-b",
              name: "Brand B",
              slug: "brand-b",
              logoUrl: null,
            },
          },
        },
      ],
    },
  };
}

function baseDeps(
  overrides: Partial<PublicExperienceProductsDeps> = {},
): PublicExperienceProductsDeps {
  return {
    getAccess: async () => twoCampaignAccess(null),
    ensureSession: async () => "session-1",
    findBrands: async () => [],
    findCuratedProducts: async () => [],
    findCampaignProducts: async () => [],
    ...overrides,
  };
}

function brand(id: "brand-a" | "brand-b") {
  const label = id === "brand-a" ? "Brand A" : "Brand B";
  return { id, name: label, slug: id };
}

function catalogProduct(options: {
  selectionId: string;
  assignmentId?: string;
  connectedId: string;
  brandId: "brand-a" | "brand-b";
  title: string;
}) {
  return {
    id: options.selectionId,
    ...(options.assignmentId
      ? { campaignAssignmentId: options.assignmentId }
      : {}),
    displayOrder: 0,
    titleOverride: null,
    shortDescriptionOverride: null,
    connectedProduct: {
      id: options.connectedId,
      brandId: options.brandId,
      externalId: `external-${options.connectedId}`,
      title: options.title,
      productUrl: `https://${options.brandId}.test/products/${options.connectedId}`,
      imageUrl: null,
      descriptionText: null,
      isAvailable: true,
      hasPublicStorefrontUrl: true,
      currencyCode: "USD",
      priceMinMinor: null,
      priceMaxMinor: null,
      priceMinorUnitExponent: null,
    },
  };
}

describe("public products route: explicit campaign scope and direct union", () => {
  test("direct entry unions both campaign-scoped and distinct-brand storefront products without choosing a campaign", async () => {
    const campaignCalls: string[] = [];
    const response = await getProducts(
      request(),
      routeContext,
      baseDeps({
        // A stale Campaign A session is deliberately overridden by the trusted
        // direct-entry marker established by /x/<experience-slug>.
        getAccess: async () => ({
          ...twoCampaignAccess("campaign-a"),
          entryContext: { kind: "DIRECT" as const },
        }),
        findBrands: async () => [brand("brand-a"), brand("brand-b")],
        findCampaignProducts: async ({ campaignId }) => {
          campaignCalls.push(campaignId);
          return campaignId === "campaign-a"
            ? [
                catalogProduct({
                  selectionId: "bcp-a",
                  assignmentId: "assignment-a",
                  connectedId: "connected-a",
                  brandId: "brand-a",
                  title: "A scoped",
                }),
              ]
            : [
                catalogProduct({
                  selectionId: "bcp-b",
                  assignmentId: "assignment-b",
                  connectedId: "connected-b",
                  brandId: "brand-b",
                  title: "B scoped",
                }),
              ];
        },
        findCuratedProducts: async (brandId) => {
          if (brandId === "brand-a") {
            // The same BCP is already campaign-scoped, so the generic card
            // must not erase its campaign-specific click/attribution context.
            return [
              catalogProduct({
                selectionId: "bcp-a",
                connectedId: "connected-a",
                brandId: "brand-a",
                title: "A generic duplicate",
              }),
            ];
          }
          return [
            catalogProduct({
              selectionId: "bcp-b-generic",
              connectedId: "connected-b-generic",
              brandId: "brand-b",
              title: "B storefront",
            }),
          ];
        },
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.campaign, null);
    assert.deepEqual(campaignCalls, ["campaign-a", "campaign-b"]);
    assert.deepEqual(
      body.data.products.map((product: { title: string }) => product.title),
      ["A scoped", "B scoped", "B storefront"],
    );
    assert.deepEqual(
      body.data.products
        .slice(0, 2)
        .map(
          (product: { productCampaign?: { id: string } }) =>
            product.productCampaign?.id,
        ),
      ["campaign-a", "campaign-b"],
    );
    assert.equal(body.data.products[0].campaignAssignmentId, "assignment-a");
    assert.equal(body.data.products[0].source, "CAMPAIGN_PRODUCT");
    assert.equal(body.data.products[1].source, "CAMPAIGN_PRODUCT");
    assert.equal(body.data.products[2].source, "BRAND_STOREFRONT");
  });

  test("2+ eligible campaigns WITH a trusted stored session campaign resolves to that exact campaign, never the other one", async () => {
    let requestedBrandId: string | null = null;
    const scopedCampaignIds: string[] = [];
    const response = await getProducts(
      request(),
      routeContext,
      baseDeps({
        getAccess: async () => ({
          ...twoCampaignAccess("campaign-b"),
          entryContext: { kind: "CAMPAIGN" as const, campaignId: "campaign-b" },
        }),
        findBrands: async () => [brand("brand-b")],
        findCampaignProducts: async ({ campaignId }) => {
          scopedCampaignIds.push(campaignId);
          return [];
        },
        findCuratedProducts: async (brandId) => {
          requestedBrandId = brandId;
          return [];
        },
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.campaign.id, "campaign-b");
    assert.equal(requestedBrandId, "brand-b");
    assert.deepEqual(scopedCampaignIds, ["campaign-b"]);
  });

  test("Matrix 10: Multi-campaign Experience: Campaign A entry never sees Campaign B campaign-scoped products", async () => {
    const response = await getProducts(
      request(),
      routeContext,
      baseDeps({
        getAccess: async () => ({
          ...twoCampaignAccess("campaign-a"),
          entryContext: { kind: "CAMPAIGN" as const, campaignId: "campaign-a" },
        }),
        findBrands: async () => [brand("brand-a")],
        findCampaignProducts: async ({ campaignId }) => {
          if (campaignId === "campaign-a") {
            return [
              catalogProduct({
                selectionId: "bcp-a",
                assignmentId: "assignment-a",
                connectedId: "connected-a",
                brandId: "brand-a",
                title: "Campaign A Exclusive",
              }),
            ];
          }
          return [
            catalogProduct({
              selectionId: "bcp-b",
              assignmentId: "assignment-b",
              connectedId: "connected-b",
              brandId: "brand-b",
              title: "Campaign B Exclusive",
            }),
          ];
        },
        findCuratedProducts: async () => [],
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.campaign.id, "campaign-a");
    assert.equal(body.data.products.length, 1);
    assert.equal(body.data.products[0].title, "Campaign A Exclusive");
    assert.equal(body.data.products[0].source, "CAMPAIGN_PRODUCT");
    assert.equal(body.data.products[0].campaignAssignmentId, "assignment-a");
    assert.equal(
      body.data.products.some((p: { title: string }) => p.title.includes("Campaign B")),
      false,
    );
  });

  test("a stored session campaign for an unrelated Experience is not trusted, and 2+ contexts still resolve to null", async () => {
    const response = await getProducts(
      request(),
      routeContext,
      baseDeps({
        getAccess: async () => twoCampaignAccess("campaign-from-elsewhere"),
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.campaign, null);
  });

  test("an ambiguous campaign context yields no product at all: there is no global/legacy card to fall back to", async () => {
    // Replaces the deleted ExperienceProductLink precedence test. Those rows
    // were the only globally-visible public shop cards; with them gone, an
    // ambiguous context renders each eligible campaign's OWN scoped catalog and
    // nothing global. Here neither brand has any persisted selection, so the
    // response is empty rather than falling back to anything.
    const response = await getProducts(
      request(),
      routeContext,
      baseDeps({
        getAccess: async () => twoCampaignAccess(null),
        findBrands: async () => [brand("brand-a"), brand("brand-b")],
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.campaign, null);
    assert.deepEqual(body.data.products, []);
  });
});

// ---------------------------------------------------------------------------
// Source-inspection coverage for the routes that cannot be driven end-to-end
// without a real Next.js request scope (see file header).
// ---------------------------------------------------------------------------

const root = process.cwd();
const lessonProductsRouteSource = readFileSync(
  join(
    root,
    "src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/products/route.ts",
  ),
  "utf8",
);
const progressRouteSource = readFileSync(
  join(root, "src/app/api/progress/lesson/route.ts"),
  "utf8",
);

/**
 * Executable lines only. These route/library headers deliberately NAME the
 * legacy machinery they replaced so a future reader knows what went and why, so
 * "this identifier is gone" assertions must be made against code, not prose.
 */
function codeLinesOf(source: string): string {
  return source
    .split("\n")
    .filter(
      (line) =>
        !line.trim().startsWith("//") &&
        !line.trim().startsWith("*") &&
        !line.trim().startsWith("/*"),
    )
    .join("\n");
}

const lessonProductsRouteCode = codeLinesOf(lessonProductsRouteSource);

describe("public lesson-products route wiring (source inspection)", () => {
  test("resolves the visitor's campaign from trusted entryContext, never campaigns[0] or stale stored state (item 20)", () => {
    assert.match(
      lessonProductsRouteSource,
      /access\.entryContext\.kind === "CAMPAIGN"[\s\S]*?access\.entryContext\.campaignId[\s\S]*?: null/,
    );
    assert.equal(/\.campaigns\[0\]/.test(lessonProductsRouteSource), false);
  });

  test("the query root is CampaignLessonProduct, so nothing can render unscoped, and an inactive scope remains a denial", () => {
    // Phase 8: the list is derived from `Lesson.campaignProducts`
    // (CampaignLessonProduct), whose campaignId is NOT NULL. There is no
    // LessonProductLink read and therefore no unscoped item to leak.
    assert.match(lessonProductsRouteCode, /campaignProducts:\s*\{/);
    assert.doesNotMatch(lessonProductsRouteCode, /productLinks/i);
    assert.doesNotMatch(lessonProductsRouteCode, /lessonProductLink/i);
    assert.match(
      lessonProductsRouteSource,
      /isPublicCampaignScopedContentVisible\(\{[\s\S]*?scope: \{[\s\S]*?campaignId: attachment\.campaignId,[\s\S]*?isActive: attachment\.isActive,[\s\S]*?entryContext: access\.entryContext,[\s\S]*?eligibleCampaignIds,/,
    );
  });

  test("the shared visibility predicate has NO unscoped branch and a non-nullable scope parameter", () => {
    const predicateSource = readFileSync(
      join(root, "src/lib/campaign-context.ts"),
      "utf8",
    );
    // The `!scope -> return true` branch was the last global-visibility path in
    // the public commerce surface. It must not come back, and the parameter must
    // stay non-nullable so the type system prevents a caller from needing it.
    assert.match(
      predicateSource,
      /export function isPublicCampaignScopedContentVisible\(options: \{\s*scope: PublicCampaignScopedContent;/,
    );
    const codeOnly = codeLinesOf(predicateSource);
    assert.doesNotMatch(codeOnly, /if \(!scope\)/);
    assert.doesNotMatch(
      codeOnly,
      /scope: PublicCampaignScopedContent \| null/,
    );
  });

  test("public lesson rendering requires isAvailable, hasPublicStorefrontUrl, AND a CONNECTED connection", () => {
    // PHASE 18 REPAIR (P1-3): the connection-status clause was added
    // alongside the original pair — see the constant's doc comment in the
    // route source.
    assert.match(
      lessonProductsRouteSource,
      /const PUBLICLY_LISTABLE_CONNECTED_PRODUCT = \{\s*isAvailable: true,\s*hasPublicStorefrontUrl: true,\s*connection: \{ is: \{ status: "CONNECTED" as const \} \},\s*\} as const;/,
    );
    assert.match(
      lessonProductsRouteSource,
      /connectedProduct: PUBLICLY_LISTABLE_CONNECTED_PRODUCT/,
    );
  });

  test("the click path applies the same triple, so a hidden or disconnected card is never redirectable", () => {
    const clickSource = readFileSync(
      join(root, "src/lib/commerce/click-attribution.ts"),
      "utf8",
    );
    assert.match(
      clickSource,
      /isAvailable: true,\s*hasPublicStorefrontUrl: true,\s*connection: \{ is: \{ status: "CONNECTED" as const \} \},\s*\} as const;/,
    );
    // Every finder query in the module applies it.
    const usages = clickSource.match(
      /connectedProduct: PUBLICLY_CLICKABLE_CONNECTED_PRODUCT/g,
    );
    assert.equal(usages?.length, 3);
  });

  test("direct lesson rendering and click authorization share the exact campaign-scope predicate", () => {
    const clickSource = readFileSync(
      join(root, "src/lib/commerce/click-attribution.ts"),
      "utf8",
    );
    assert.match(
      lessonProductsRouteSource,
      /isPublicCampaignScopedContentVisible/,
    );
    assert.match(clickSource, /isPublicCampaignScopedContentVisible/);
    assert.match(clickSource, /scope: link\.scope/);
  });

  test("lesson commerce analytics beacon was removed; canonical click route remains", () => {
    const clickSource = readFileSync(
      join(root, "src/lib/commerce/click-attribution.ts"),
      "utf8",
    );
    assert.doesNotMatch(lessonProductsRouteSource, /export async function POST/);
    assert.doesNotMatch(lessonProductsRouteSource, /lesson_product_click/);
    assert.match(clickSource, /kind: "LESSON"/);
  });

  test("the serialized lesson item exposes only public display fields — no catalog or scoping keys (item 22)", () => {
    const itemsMatch = lessonProductsRouteSource.match(
      /return \{\s*id: attachment\.id,([\s\S]*?)\};/,
    );
    assert.ok(itemsMatch, "the item projection must exist");
    const projected = Array.from(
      itemsMatch![1].matchAll(/^\s{16}(\w+):/gm),
    ).map((m) => m[1]);
    assert.deepEqual(new Set(projected), new Set([
      "productUrl",
      "title",
      "imageUrl",
      "priceText",
      "currency",
      "brandId",
    ]));
    // `sourceShopDomain` was legacy-compat only and has no client consumer.
    assert.doesNotMatch(lessonProductsRouteCode, /sourceShopDomain/);
  });

  test("no response body construction in the GET handler matches a credential/secret/internal-id leak pattern (item 22)", () => {
    // Isolate the exported GET function's body and assert none of these
    // forbidden substrings appear anywhere in it.
    const getStart = lessonProductsRouteSource.indexOf(
      "export async function GET(",
    );
    assert.ok(
      getStart >= 0,
      "GET handler must exist",
    );
    const getBody = lessonProductsRouteSource
      .slice(getStart)
      .split("\n")
      .filter(
        (line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    assert.equal(
      /token|secret|encrypted|password|brandCommerceProductId/i.test(getBody),
      false,
    );
  });
});

describe("progress route wiring (source inspection): session campaignId is never clobbered by a guess", () => {
  test("resolveValidatedPublicCampaignContext is used, never campaigns[0], to decide what (if anything) to stamp", () => {
    assert.match(
      progressRouteSource,
      /resolveValidatedPublicCampaignContext\(/,
    );
    assert.equal(/\.campaigns\[0\]/.test(progressRouteSource), false);
    // `campaignIds[0]` appears only inside a comment documenting the removed
    // bug (see the file's own explanation above the fix); no executable line
    // may index it.
    const codeOnly = progressRouteSource
      .split("\n")
      .filter(
        (line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"),
      )
      .join("\n");
    assert.equal(/campaignIds\[0\]/.test(codeOnly), false);
  });

  test("an existing stored session campaignId is passed through as null (never overwritten) rather than re-derived", () => {
    assert.match(
      progressRouteSource,
      /campaignId: storedSession\?\.campaignId\s*\n\s*\? null\s*\n\s*: resolveValidatedPublicCampaignContext\(/,
    );
  });
});
