import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SHOPIFY_SCOPES } from "../src/lib/shopify";

const expected = "read_products,read_discounts,write_discounts";

test("Shopify scopes stay aligned across server and both CLI configs", () => {
  assert.equal(SHOPIFY_SCOPES, expected);
  for (const file of ["shopify.app.toml", "shopify.app.custom.toml"]) {
    const contents = readFileSync(file, "utf8");
    assert.match(contents, new RegExp(`scopes = "${expected}"`));
    assert.doesNotMatch(contents, /write_products/);
  }
});
