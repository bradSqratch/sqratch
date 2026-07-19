import assert from "node:assert/strict";
import { test } from "node:test";

import { isProductLinkCurrent } from "../src/lib/product-link-compatibility";

test("a link sourced from the brand's current store is current (visible)", () => {
  const result = isProductLinkCurrent(
    { brandId: "brand-1", sourceShopDomain: "Shop.MyShopify.com" },
    new Map([["brand-1", "shop.myshopify.com"]]),
  );
  assert.equal(result, true);
});

test("a link sourced from a previous store is not current (hidden)", () => {
  const result = isProductLinkCurrent(
    { brandId: "brand-1", sourceShopDomain: "old-shop.myshopify.com" },
    new Map([["brand-1", "new-shop.myshopify.com"]]),
  );
  assert.equal(result, false);
});

test("a link with an unknown (missing) source domain is not current (hidden)", () => {
  const result = isProductLinkCurrent(
    { brandId: "brand-1", sourceShopDomain: null },
    new Map([["brand-1", "shop.myshopify.com"]]),
  );
  assert.equal(result, false);
});

test("a link with no brand association is not current (hidden)", () => {
  const result = isProductLinkCurrent(
    { brandId: null, sourceShopDomain: "shop.myshopify.com" },
    new Map([["brand-1", "shop.myshopify.com"]]),
  );
  assert.equal(result, false);
});

test("a link whose brand has no current domain on file is not current (hidden)", () => {
  const result = isProductLinkCurrent(
    { brandId: "brand-1", sourceShopDomain: "shop.myshopify.com" },
    new Map([["brand-1", null]]),
  );
  assert.equal(result, false);
});

test("a link whose brand is missing from the lookup map is not current (hidden)", () => {
  const result = isProductLinkCurrent(
    { brandId: "brand-unknown", sourceShopDomain: "shop.myshopify.com" },
    new Map([["brand-1", "shop.myshopify.com"]]),
  );
  assert.equal(result, false);
});
