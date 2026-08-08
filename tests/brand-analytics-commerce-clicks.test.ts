import "./env-setup";

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

const routeSource = fs.readFileSync(
  path.join(process.cwd(), "src/app/api/brand/analytics/route.ts"),
  "utf8",
);

test("Brand Analytics shopClicks counts canonical click evidence by trusted entry campaign", () => {
  assert.match(routeSource, /prisma\.commerceClickAttribution\.groupBy\(/);
  assert.match(routeSource, /by: \["entryCampaignId"\]/);
  assert.match(routeSource, /entryCampaignId: \{ in: campaignIds \}/);
  assert.match(routeSource, /row\.entryCampaignId/);
  assert.doesNotMatch(routeSource, /name: "shop_click"/);
  assert.doesNotMatch(routeSource, /prisma\.analyticsEvent\.groupBy\([\s\S]*?name: "shop_click"/);
});

test("non-commerce analytics remain in AnalyticsEvent", () => {
  assert.match(routeSource, /name: "qr_scan"/);
  assert.match(routeSource, /name: "lesson_started"/);
  assert.match(routeSource, /name: "lesson_completed"/);
});
