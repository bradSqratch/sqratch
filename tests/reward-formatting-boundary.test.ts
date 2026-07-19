import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  formatRewardMoney,
  formatRewardPercentage,
} from "../src/lib/reward-formatting";

function readSource(relativePath: string) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

// ---------------------------------------------------------------------------
// Regression coverage for: "Attempted to call formatRewardMoney() from the
// server but formatRewardMoney is on the client." This was caused by the
// Points Activity enhancement importing a pure formatter from a module
// marked "use client" (src/components/experience/client-utils.ts) into a
// Server Component (dashboard/points/page.tsx). Any export from a "use
// client" file becomes a client reference to Next.js's RSC bundler — even a
// plain, non-component function — so a Server Component can reference it in
// JSX but must never call it directly.
// ---------------------------------------------------------------------------

test("the shared reward-formatting module is server-safe", () => {
  const source = readSource("src/lib/reward-formatting.ts");

  assert.doesNotMatch(source, /^\s*["']use client["'];?/m);
  assert.doesNotMatch(source, /from\s+["']react["']/i);
  assert.doesNotMatch(source, /\buseState\(|\buseEffect\(|\buseMemo\(/);
  assert.doesNotMatch(source, /\bwindow\.|\bdocument\.|\bnavigator\./);
  assert.match(source, /export function formatRewardMoney/);
  assert.match(source, /export function formatRewardPercentage/);
});

test("client-utils.ts no longer exports the reward formatters (single source of truth)", () => {
  const source = readSource("src/components/experience/client-utils.ts");

  assert.doesNotMatch(source, /formatRewardMoney/);
  assert.doesNotMatch(source, /formatRewardPercentage/);
  // Still the client boundary for the browser-only helpers it legitimately owns.
  assert.match(source, /^\s*["']use client["'];?/m);
});

test("the Points Activity Server Component imports formatters from the server-safe module, never from client-utils", () => {
  const source = readSource(
    "src/app/(withSidebar)/dashboard/points/page.tsx",
  );

  assert.doesNotMatch(source, /^\s*["']use client["'];?/m);
  assert.match(
    source,
    /formatRewardMoney,?\s*\n?\s*formatRewardPercentage,?\s*\n?\s*}\s*from\s*"@\/lib\/reward-formatting"/,
  );
  assert.doesNotMatch(
    source,
    /formatRewardMoney[\s\S]*?from\s*"@\/components\/experience\/client-utils"/,
  );
});

test("client-component reward consumers also import the formatters from the shared module (no duplication)", () => {
  const consumers = [
    "src/app/(withSidebar)/dashboard/brand/rewards/page.tsx",
    "src/components/rewards/shopify-shop-reward-card.tsx",
    "src/components/rewards/shopify-rewards-client.tsx",
  ];

  for (const relativePath of consumers) {
    const source = readSource(relativePath);
    assert.match(
      source,
      /from\s*"@\/lib\/reward-formatting"/,
      `${relativePath} should import formatters from @/lib/reward-formatting`,
    );
    assert.doesNotMatch(
      source,
      /formatRewardMoney[\s\S]*?from\s*"@\/components\/experience\/client-utils"/,
      `${relativePath} should not re-import formatters from client-utils`,
    );
  }
});

test("formatRewardMoney produces expected currency output and handles missing values", () => {
  assert.equal(formatRewardMoney(1000, "USD").includes("10.00"), true);
  assert.ok(formatRewardMoney(1000, "USD").includes("$"));
  assert.equal(formatRewardMoney(null, "USD"), "");
});

test("formatRewardPercentage produces expected percentage output and handles missing values", () => {
  assert.equal(formatRewardPercentage(1500), "15%");
  assert.equal(formatRewardPercentage(1525), "15.25%");
  assert.equal(formatRewardPercentage(1550), "15.5%");
  assert.notEqual(formatRewardPercentage(1500), "15.00%");
  assert.equal(formatRewardPercentage(null), "");
});
