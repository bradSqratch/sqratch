import "./env-setup";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const source = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/me/dashboard-summary/route.ts"),
  "utf8",
);

test("member activity reads commerce clicks from canonical attribution", () => {
  assert.match(source, /prisma\.commerceClickAttribution\.findMany\(/);
  assert.match(source, /label: "Opened shop product"/);
  assert.doesNotMatch(source, /name: "shop_click"/);
});

test("member learning activity remains AnalyticsEvent-backed", () => {
  assert.match(source, /prisma\.analyticsEvent\.findMany\(/);
  assert.match(source, /"lesson_started"/);
  assert.match(source, /"lesson_completed"/);
});

// ---------------------------------------------------------------------------
// G. PHASE 14B.4B — dashboard's commerce connection/sync-health signal is
// canonical-first (CommerceConnection), never a direct Brand.shopify* gate.
// PHASE 16C2 — that resolution is now PROVIDER-NEUTRAL
// (getActiveCommerceConnectionAnyProvider), not hard-coded to Shopify, so a
// Commerce7-connected brand's dashboard card reflects its real status too.
// ---------------------------------------------------------------------------

test("G. brand admin cards derive their connection signal from the canonical, provider-neutral connection summary, not Brand.shopify* directly", () => {
  assert.match(source, /getActiveCommerceConnectionAnyProvider\(/);
  assert.match(source, /isConnectionUsable\(/);
  // Must not be hard-coded back to a single provider.
  assert.doesNotMatch(source, /getActiveCommerceConnection\(\s*brand\.id,\s*CommerceProvider\.SHOPIFY/);
  // The old three-part Brand.shopify* gate must be gone.
  assert.doesNotMatch(
    source,
    /brand\.shopifyShopDomain\s*&&\s*\n?\s*brand\.shopifyAdminAccessTokenEncrypted/,
  );
});
