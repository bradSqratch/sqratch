import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { getDefaultShopifyInstallBrandId } from "../src/lib/shopify-install-selection";

const brands = [{ id: "brand-envinate" }, { id: "brand-other" }];

test("active eligible brand is selected first", () => {
  assert.equal(
    getDefaultShopifyInstallBrandId(brands, "brand-other"),
    "brand-other",
  );
});

test("first eligible existing brand is selected when active brand is absent", () => {
  assert.equal(
    getDefaultShopifyInstallBrandId(brands, "brand-not-eligible"),
    "brand-envinate",
  );
});

test("create-new mode is selected only when no eligible brands exist", () => {
  assert.equal(getDefaultShopifyInstallBrandId([], "brand-envinate"), "");
});

test("first eligible brand is selected by default when no active brand is set", () => {
  assert.equal(
    getDefaultShopifyInstallBrandId(brands, null),
    "brand-envinate",
  );
});

test("the install UI only links to an existing eligible brand — brand creation was removed", () => {
  const pageSource = readFileSync(
    join(
      process.cwd(),
      "src/app/(withSidebar)/dashboard/brand/shopify/install/page.tsx",
    ),
    "utf8",
  );
  assert.match(pageSource, /setSelectedBrandId\(event\.target\.value\)/);
  assert.doesNotMatch(pageSource, /Create new brand/);
  assert.doesNotMatch(pageSource, /createBrand/);
  assert.doesNotMatch(pageSource, /canCreateBrand/);
});
