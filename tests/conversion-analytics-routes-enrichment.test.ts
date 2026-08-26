/**
 * tests/conversion-analytics-routes-enrichment.test.ts
 *
 * PHASE 24 — PART 29/30: static source-inspection tests for the name
 * enrichment and (creator-side) Experience-filter authorization added to
 * both conversion routes. Same idiom as the existing "(source inspection)"
 * tests at the bottom of `tests/order-analytics.test.ts` — those routes are
 * not dependency-injected, so their contract is verified against the exact
 * source text rather than executed against a real database.
 */
import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const BRAND_ROUTE = join(process.cwd(), "src/app/api/brand/analytics/conversions/route.ts");
const CREATOR_ROUTE = join(process.cwd(), "src/app/api/creator/analytics/conversions/route.ts");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("brand conversions route — name enrichment stays brand-scoped", () => {
  const source = readFileSync(BRAND_ROUTE, "utf8");
  const executable = stripComments(source);

  test("campaign name lookups (entry AND product campaign) are scoped by brandId, not a bare id lookup", () => {
    const campaignLoader = executable.match(/async function loadCampaignNames[\s\S]*?\n}/)?.[0] ?? "";
    assert.ok(campaignLoader, "loadCampaignNames not found");
    assert.match(campaignLoader, /where:\s*{\s*id:\s*{\s*in:\s*distinct\s*},\s*brandId\s*}/);
  });

  test("connected-product name lookup is scoped by brandId", () => {
    const productLoader = executable.match(/async function loadConnectedProductNames[\s\S]*?\n}/)?.[0] ?? "";
    assert.ok(productLoader, "loadConnectedProductNames not found");
    assert.match(productLoader, /where:\s*{\s*id:\s*{\s*in:\s*distinct\s*},\s*brandId\s*}/);
  });

  test("every breakdown is enriched with names before the response is built, and the raw (unnamed) aggregator output is never returned directly", () => {
    assert.match(executable, /const conversion = buildConversionAnalytics\(scoped\);/);
    assert.match(executable, /enrichBrandConversionBreakdownNames\(conversion, \{/);
    assert.doesNotMatch(executable, /\.\.\.buildConversionAnalytics\(scoped\)/);
  });

  test("name lookups run against ids taken from the aggregator's OWN breakdown output, never from client input", () => {
    assert.match(executable, /idsOf\(conversion\.attributedOrdersByEntryCampaign\)/);
    assert.match(executable, /idsOf\(conversion\.attributedOrdersByProductCampaign\)/);
    assert.match(executable, /idsOf\(conversion\.attributedOrdersByExperience\)/);
    assert.match(executable, /idsOf\(conversion\.attributedOrdersByCreator\)/);
    assert.match(executable, /idsOf\(conversion\.attributedOrdersByLesson\)/);
    assert.match(executable, /idsOf\(conversion\.attributedOrdersByProduct\)/);
  });
});

describe("creator conversions route — Experience filter fails closed and stays creator-scoped", () => {
  const source = readFileSync(CREATOR_ROUTE, "utf8");
  const executable = stripComments(source);

  test("an Experience filter is validated with the established ownership helper before any order query runs", () => {
    const ownershipCheckIndex = executable.indexOf("getOwnedExperienceForCreator(");
    const orderQueryIndex = executable.indexOf("prisma.commerceOrder.findMany(");
    assert.ok(ownershipCheckIndex > -1, "ownership check not found");
    assert.ok(orderQueryIndex > -1, "order query not found");
    assert.ok(
      ownershipCheckIndex < orderQueryIndex,
      "the ownership check must run BEFORE the order query, not after",
    );
  });

  test("an unowned/unknown Experience id is rejected with a generic 404, never a distinguishing error", () => {
    assert.match(executable, /if \(!owned\)\s*{\s*return NextResponse\.json\(\{\s*error:\s*"Experience not found\."\s*},\s*{\s*status:\s*404\s*}\s*\);/);
  });

  test("the creatorProfileId scope is present UNCONDITIONALLY in the order query — the Experience filter can only ever narrow it, never appear in its place", () => {
    // The exact literal must be a direct property of the `is` object, not
    // hidden inside the same spread/conditional that adds `experienceId`.
    assert.match(executable, /is:\s*{\s*creatorProfileId:\s*context\.creatorProfile\.id,/);
  });

  test("the Experience filter is applied via a conditional spread onto the SAME is: object as creatorProfileId — it cannot be sent as a top-level replacement scope", () => {
    assert.match(
      executable,
      /creatorProfileId:\s*context\.creatorProfile\.id,\s*\.\.\.\(requestedExperienceId \? \{ experienceId: requestedExperienceId } : \{\}\),/,
    );
  });

  test("Experience and Lesson name lookups are re-scoped to this creator's ownership, not a bare id lookup", () => {
    const experienceLoader = executable.match(/async function loadOwnedExperienceNames[\s\S]*?\n}/)?.[0] ?? "";
    assert.match(experienceLoader, /where:\s*{\s*id:\s*{\s*in:\s*distinct\s*},\s*creatorId:\s*creatorProfileId\s*}/);

    const lessonLoader = executable.match(/async function loadOwnedLessonNames[\s\S]*?\n}/)?.[0] ?? "";
    assert.match(lessonLoader, /course:\s*{\s*experience:\s*{\s*creatorId:\s*creatorProfileId\s*}\s*}/);
  });

  test("the response echoes the VALIDATED filter, never raw unvalidated request input", () => {
    assert.match(executable, /filters:\s*{\s*experienceId:\s*requestedExperienceId\s*}/);
    // The raw searchParams read is assigned to requestedExperienceId ONCE,
    // trimmed, and that variable — never a second raw read — is what
    // reaches both the ownership check and the response.
    const rawReads = executable.match(/searchParams\.get\("experienceId"\)/g) ?? [];
    assert.equal(rawReads.length, 1, "experienceId must be read from the request exactly once");
  });

  test("still selects no campaign id and no order line item (PHASE 24 did not weaken the existing privacy boundary)", () => {
    assert.doesNotMatch(executable, /entryCampaignId:\s*true/);
    assert.doesNotMatch(executable, /productCampaignId:\s*true/);
    assert.doesNotMatch(executable, /entryCampaign:\s*\{/);
    assert.doesNotMatch(executable, /productCampaign:\s*\{/);
    assert.doesNotMatch(executable, /lineItems:\s*\{/);
  });
});
