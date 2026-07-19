import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const root = new URL("..", import.meta.url);

function source(relativePath: string) {
  return readFileSync(new URL(relativePath, root), "utf8");
}

test("one React logo component references the canonical SVG", () => {
  const logo = source("src/components/brand/sqratch-logo.tsx");

  assert.match(logo, /from "next\/image"/);
  assert.match(logo, /src="\/sqratchLogo\.svg"/);
  assert.match(logo, /alt="SQRATCH"/);
  assert.match(logo, /width=\{333\}/);
  assert.match(logo, /height=\{58\}/);
  assert.doesNotMatch(logo, />\s*SQRATCH\s*</);
});

test("PublicHeader and the legacy PNG logo have no active consumer", () => {
  assert.equal(existsSync(new URL("src/components/publicHeader.tsx", root)), false);
  assert.equal(existsSync(new URL("public/sqratchLogo.png", root)), false);

  const files = [
    "src/components/commonNavbar.tsx",
    "src/app/(withSidebar)/layout.tsx",
    "src/app/shopify/route.ts",
  ];
  for (const file of files) {
    const value = source(file);
    assert.doesNotMatch(value, /publicHeader|sqratchLogo\.png/);
  }
});

test("CommonNavbar is the shared public and customer navigation", () => {
  const navbar = source("src/components/commonNavbar.tsx");
  assert.match(navbar, /SqratchLogo/);
  assert.match(navbar, /logoHref/);
  assert.match(navbar, /variant\?: "dark" \| "light"/);
  assert.doesNotMatch(navbar, />\s*SQRATCH\s*</);
  assert.doesNotMatch(navbar, /\bTM\b|™/);

  for (const file of [
    "src/app/(home)/page.tsx",
    "src/components/home/user-home-client.tsx",
    "src/components/experience/experience-shell.tsx",
  ]) {
    assert.match(source(file), /import CommonNavbar from "@\/components\/commonNavbar"/);
  }
});

test("dashboard and embedded Shopify use the canonical logo asset", () => {
  const dashboard = source("src/app/(withSidebar)/layout.tsx");
  assert.match(dashboard, /import \{ SqratchLogo \}/);
  assert.match(dashboard, /<SqratchLogo priority className="h-8 w-auto" \/>/);
  assert.match(dashboard, /<SqratchLogo priority className="h-6 w-auto" \/>/);
  assert.doesNotMatch(dashboard, /\bTM\b|™/);

  const shopify = source("src/app/shopify/route.ts");
  assert.match(shopify, /<img src="\/sqratchLogo\.svg" alt="SQRATCH" class="wordmark-logo" width="333" height="58">/);
  assert.doesNotMatch(shopify, /<svg[\s>]/);
  assert.match(shopify, /window\.shopify\.idToken\(\)/);
  assert.match(shopify, /fetch\("\/api\/shopify\/embedded\/status"/);
  assert.match(shopify, /fetch\("\/api\/shopify\/embedded\/disconnect"/);
});
