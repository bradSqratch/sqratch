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

test("the install UI keeps create-new mode available as a deliberate choice", () => {
  assert.equal(
    getDefaultShopifyInstallBrandId(brands, null),
    "brand-envinate",
  );

  const pageSource = readFileSync(
    join(
      process.cwd(),
      "src/app/(withSidebar)/dashboard/brand/shopify/install/page.tsx",
    ),
    "utf8",
  );
  assert.match(pageSource, /setSelectedBrandId\(nextBrandId\)/);
  assert.match(pageSource, /<option value="">Create new brand<\/option>/);
  assert.match(pageSource, /const creatingBrand = !selectedBrandId/);
  assert.match(pageSource, /creatingBrand && canCreate/);
});
