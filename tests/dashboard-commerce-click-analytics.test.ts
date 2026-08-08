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
