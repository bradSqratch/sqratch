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
    findProductLinks: async () => [],
    findBrands: async () => [],
    countBrandSelections: async () => 0,
    findCuratedProducts: async () => [],
    findCampaignProducts: async () => [],
    fetchLegacyCampaignProducts: async () => ({
      ok: true,
      items: [],
      hasNextPage: false,
      limit: 100,
      endCursor: null,
    }),
    ...overrides,
  };
}

function brand(id: "brand-a" | "brand-b") {
  const label = id === "brand-a" ? "Brand A" : "Brand B";
  return {
    id,
    name: label,
    slug: id,
    shopifyShopDomain: `${id}.myshopify.com`,
    shopifyConnectionStatus: "CONNECTED",
    shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
    shopifyUninstalledAt: null,
    shopifyLastProductSyncAt: null,
    shopifyGrantedScopes: "read_products",
    shopifyCurrencyCode: "USD",
  };
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
        countBrandSelections: async () => 1,
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
        findBrands: async () => [
          {
            id: "brand-b",
            name: "Brand B",
            slug: "brand-b",
            shopifyShopDomain: "brand-b.myshopify.com",
            shopifyConnectionStatus: "CONNECTED",
            shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
            shopifyUninstalledAt: null,
            shopifyLastProductSyncAt: null,
            shopifyGrantedScopes: "read_products",
            shopifyCurrencyCode: "USD",
          },
        ],
        countBrandSelections: async () => 1,
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

  test("direct ExperienceProductLink rows still render even when the campaign context is ambiguous (precedence over fallback is unaffected)", async () => {
    const response = await getProducts(
      request(),
      routeContext,
      baseDeps({
        getAccess: async () => twoCampaignAccess(null),
        findProductLinks: async () => [
          {
            id: "direct-1",
            productUrl: "https://acme.test/products/direct",
            title: "Direct product",
            imageUrl: null,
            priceText: null,
            currency: null,
            brandId: "brand-a",
            sourceShopDomain: "brand-a.myshopify.com",
          },
        ],
        findBrands: async () => [
          {
            id: "brand-a",
            name: "Brand A",
            slug: "brand-a",
            shopifyShopDomain: "brand-a.myshopify.com",
            shopifyConnectionStatus: "CONNECTED",
            shopifyInstalledAt: new Date("2026-01-01T00:00:00Z"),
            shopifyUninstalledAt: null,
            shopifyLastProductSyncAt: null,
            shopifyGrantedScopes: "read_products",
            shopifyCurrencyCode: "USD",
          },
        ],
      }),
    );

    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.products.length, 1);
    assert.equal(body.data.products[0].source, "LINKED");
    // The link carries its OWN brand (a property of the product), not the
    // ambiguous visitor context — this is unaffected by campaign ambiguity.
    assert.equal(body.data.products[0].brand.id, "brand-a");
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

describe("public lesson-products route wiring (source inspection)", () => {
  test("resolves the visitor's campaign through resolvePublicCampaignId, never campaigns[0] (item 20)", () => {
    assert.match(lessonProductsRouteSource, /resolvePublicCampaignId\(/);
    assert.equal(/\.campaigns\[0\]/.test(lessonProductsRouteSource), false);
  });

  test("an unscoped link (no active CampaignLessonProduct) always renders regardless of context (item 11)", () => {
    assert.match(
      lessonProductsRouteSource,
      /if \(!scope \|\| !scope\.isActive\) \{\s*return true;\s*\}/,
    );
  });

  test("a scoped link renders only when its campaignId equals the resolved visitor context (items 18, 19)", () => {
    assert.match(
      lessonProductsRouteSource,
      /return scope\.campaignId === visitorCampaign\?\.campaignId;/,
    );
  });

  test("the CampaignLessonProduct projection selects only campaignId and isActive — no internal ids or provider metadata (item 22)", () => {
    const selectMatch = lessonProductsRouteSource.match(
      /campaignProductLink:\s*\{\s*select:\s*\{([\s\S]*?)\},?\s*\},/,
    );
    assert.ok(selectMatch, "campaignProductLink select clause must exist");
    const fields = selectMatch![1];
    assert.match(fields, /campaignId:\s*true/);
    assert.match(fields, /isActive:\s*true/);
    // Nothing else: no id, no brandCommerceProductId, no displayOrder.
    const fieldNames = Array.from(fields.matchAll(/(\w+):\s*true/g)).map(
      (m) => m[1],
    );
    assert.deepEqual(new Set(fieldNames), new Set(["campaignId", "isActive"]));
  });

  test("no response body construction in the GET handler matches a credential/secret/internal-id leak pattern (item 22)", () => {
    // Isolate the exported GET function's body (up to the sibling exported
    // POST) and assert none of these forbidden substrings appear anywhere in
    // it — the strongest available guarantee without a live response to
    // introspect, matching the technique the prompt itself sanctions for
    // this exact check.
    const getStart = lessonProductsRouteSource.indexOf(
      "export async function GET(",
    );
    const postStart = lessonProductsRouteSource.indexOf(
      "export async function POST(",
    );
    assert.ok(
      getStart >= 0 && postStart > getStart,
      "GET must precede POST in this route file",
    );
    const getBody = lessonProductsRouteSource
      .slice(getStart, postStart)
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
