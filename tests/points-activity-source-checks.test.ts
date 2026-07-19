import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readSource(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("getUserPointsOverview batch-loads lesson/course/redemption/campaign context (no per-row queries)", () => {
  const source = readSource("src/lib/points.ts");

  // Every extra context lookup added for Points Activity must be a single
  // batched `findMany` keyed by a distinct id list collected up front —
  // never a query issued inside a per-transaction loop.
  assert.match(source, /prisma\.lesson\.findMany\(\{\s*where:\s*\{\s*id:\s*\{\s*in:\s*lessonIds/);
  assert.match(source, /prisma\.course\.findMany\(\{\s*where:\s*\{\s*id:\s*\{\s*in:\s*courseIdsFromCompletion/);
  assert.match(
    source,
    /prisma\.shopifyRewardRedemption\.findMany\(\{\s*where:\s*\{\s*id:\s*\{\s*in:\s*redemptionIds/,
  );
  assert.match(
    source,
    /prisma\.campaignExperience\.findMany\(\{\s*where:\s*\{\s*experienceId:\s*\{\s*in:\s*experienceIds/,
  );
  assert.match(
    source,
    /prisma\.campaign\.findMany\(\{\s*where:\s*\{\s*id:\s*\{\s*in:\s*metadataCampaignIds/,
  );

  // No per-transaction await inside a `.map`/`for` loop over `transactions`
  // (that would be the N+1 pattern this design specifically avoids).
  assert.doesNotMatch(
    source,
    /transactions\.map\(async/,
  );
});

test("getUserPointsOverview never selects Shopify credentials, discount codes, or Shopify node ids", () => {
  const source = readSource("src/lib/points.ts");

  // The redemption select clause that feeds Points Activity must stay
  // limited to safe, non-sensitive display fields.
  const redemptionSelectMatch = source.match(
    /prisma\.shopifyRewardRedemption\.findMany\(\{[\s\S]*?select:\s*\{([\s\S]*?)\},\s*\}\)/,
  );
  assert.ok(redemptionSelectMatch, "expected a shopifyRewardRedemption.findMany select clause");
  const selectBody = redemptionSelectMatch![1];

  assert.doesNotMatch(selectBody, /\bcode\s*:\s*true/);
  assert.doesNotMatch(selectBody, /shopifyDiscountNodeId/);
  assert.doesNotMatch(selectBody, /shopifyUserErrors/);
  assert.doesNotMatch(selectBody, /shopifyShopDomain/);
  assert.doesNotMatch(selectBody, /idempotencyKey/);

  // Brand selects anywhere in the file must never pull encrypted/OAuth
  // credential fields into this read model.
  assert.doesNotMatch(source, /shopifyAdminAccessTokenEncrypted/);
  assert.doesNotMatch(source, /shopifyRefreshTokenEncrypted/);
  assert.doesNotMatch(source, /shopifyGrantedScopes/);
});

test("the Points Activity page scopes data to the authenticated session user only", () => {
  const source = readSource(
    "src/app/(withSidebar)/dashboard/points/page.tsx",
  );

  // Must load the session and pass session.user.id — never a client-
  // supplied/query-string userId — into the overview lookup.
  assert.match(source, /getServerSession\(authOptions\)/);
  assert.match(source, /getUserPointsOverview\(session\.user\.id\)/);
  assert.doesNotMatch(source, /searchParams/);
});

test("getUserPointsOverview filters every query by the requested userId", () => {
  const source = readSource("src/lib/points.ts");

  // Sanity check that the base ledger queries remain userId-scoped (the
  // pre-existing authorization boundary this task must not weaken).
  assert.match(source, /prisma\.pointTransaction\.findMany\(\{\s*where:\s*\{\s*userId\s*\}/);
  assert.match(source, /prisma\.pointTransaction\.count\(\{\s*where:\s*\{\s*userId\s*\}\s*\}\)/);
});

test("the redeem route only records a campaign on the ledger when exactly one unlocked campaign was resolved", () => {
  const source = readSource("src/app/api/rewards/shopify/redeem/route.ts");

  assert.match(
    source,
    /rewardContext\.campaignIds\.length === 1\s*\?\s*rewardContext\.campaignIds\[0\]\s*:\s*null/,
  );
  // Passed through to every ledger-affecting call site — debit and both
  // refund paths — so campaign context is consistent across the whole
  // redemption lifecycle.
  const campaignIdPassCount = (
    source.match(/campaignId:\s*deterministicCampaignId/g) ?? []
  ).length;
  assert.equal(campaignIdPassCount, 3, "expected debit + 2 refund call sites");
});
