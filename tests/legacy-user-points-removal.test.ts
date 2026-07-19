import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

// ---------------------------------------------------------------------------
// Regression coverage for the removal of the legacy `User.points` mirror
// column. UserPointAccount (spendablePoints / lifetimeEarnedPoints /
// lifetimeSpentPoints / lifetimeRefundedPoints) and PointTransaction (the
// immutable ledger) are the sole authoritative sources for balances. These
// tests prove active code never reads or writes `User.points`, so the schema
// column can be safely dropped in a later migration.
// ---------------------------------------------------------------------------

function readSource(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

const ACTIVE_SOURCE_FILES = [
  "src/lib/points.ts",
  "src/lib/reward-reconciliation.ts",
  "src/app/api/user/me/route.ts",
  "src/app/api/rewards/shopify/redeem/route.ts",
  "src/app/api/rewards/shopify/route.ts",
  "src/app/api/progress/lesson/route.ts",
  "src/app/api/progress/merge/route.ts",
  "src/app/api/public/scan/route.ts",
  "src/app/api/auth/verify-email/route.ts",
  "src/app/api/auth/[...nextauth]/options.ts",
  "src/app/api/auth/signup/route.ts",
  "src/app/(withSidebar)/dashboard/points/page.tsx",
];

test("no active source file references the legacy User.points field", () => {
  for (const relativePath of ACTIVE_SOURCE_FILES) {
    const source = readSource(relativePath);
    assert.doesNotMatch(
      source,
      /\bUser\.points\b|\buser\.points\b/,
      `${relativePath} should not reference User.points`,
    );
  }
});

test("no Prisma select on the User model includes a legacy `points` field", () => {
  const source = readSource("src/lib/points.ts");

  // Every prisma.user / tx.user findUnique select block in points.ts must
  // stay free of `points` — the only `points: true` selects allowed in this
  // file belong to PointTransaction (the ledger's own signed amount column).
  const userSelectBlocks = [
    ...source.matchAll(/(?:prisma|tx)\.user\.findUnique\(\{[\s\S]*?select:\s*\{([\s\S]*?)\}/g),
  ];
  assert.ok(userSelectBlocks.length > 0, "expected at least one User select block in points.ts");
  for (const match of userSelectBlocks) {
    assert.doesNotMatch(match[1], /\bpoints\s*:/, "a User select block still selects points");
  }
});

test("no Prisma update targets the User model's points field", () => {
  const source = readSource("src/lib/points.ts");

  assert.doesNotMatch(source, /(?:prisma|tx)\.user\.update\(/);
  assert.doesNotMatch(source, /(?:prisma|tx)\.user\.upsert\(/);
});

test("GET /api/user/me no longer selects the legacy column, and sources `points` from the point account", () => {
  const source = readSource("src/app/api/user/me/route.ts");

  assert.doesNotMatch(source, /select:\s*\{[\s\S]*?\bpoints\s*:\s*true[\s\S]*?\}/);
  assert.match(source, /getUserSpendablePointBalance/);
});

test("QR reward, lesson/course reward, redemption, and refund call sites never pass a User update", () => {
  for (const relativePath of [
    "src/app/api/progress/lesson/route.ts",
    "src/app/api/progress/merge/route.ts",
    "src/app/api/public/scan/route.ts",
    "src/app/api/auth/verify-email/route.ts",
    "src/app/api/rewards/shopify/redeem/route.ts",
  ]) {
    const source = readSource(relativePath);
    assert.doesNotMatch(
      source,
      /user\.update\([^)]*points/,
      `${relativePath} should not update User.points`,
    );
  }
});

test("anonymous-merge and login flows do not reference the legacy balance", () => {
  // Anonymous → user merge (QR/lesson/course award re-run) and NextAuth
  // credential login must both be fully independent of User.points.
  const merge = readSource("src/app/api/progress/merge/route.ts");
  const authOptions = readSource("src/app/api/auth/[...nextauth]/options.ts");

  assert.doesNotMatch(merge, /\.points\b/);
  assert.doesNotMatch(authOptions, /\.points\b/);
});

test("getUserPointsOverview sources spendable/lifetime totals from the point account, with a ledger-derived (not legacy-field) fallback", () => {
  const source = readSource("src/lib/points.ts");

  const overviewMatch = source.match(
    /export async function getUserPointsOverview\(userId: string, take = 25\) \{[\s\S]*/,
  );
  assert.ok(overviewMatch, "expected to find getUserPointsOverview");
  const body = overviewMatch![0];

  assert.match(body, /const spendablePoints = account\?\.spendablePoints \?\? ledgerSpendableTotal;/);
  assert.doesNotMatch(body, /\?\?\s*user\.points/);
});
