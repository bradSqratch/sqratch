import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { SHOPIFY_SCOPES } from "../src/lib/shopify";

const expected = "read_products,read_orders,read_themes,read_discounts,write_discounts";

test("Shopify scopes stay aligned across server and both CLI configs", () => {
  assert.equal(SHOPIFY_SCOPES, expected);
  for (const file of ["shopify.app.toml", "shopify.app.custom.toml"]) {
    const contents = readFileSync(file, "utf8");
    assert.match(contents, new RegExp(`scopes = "${expected}"`));
    assert.doesNotMatch(contents, /write_products/);
    assert.doesNotMatch(contents, /read_all_orders/);
  }
});

// The declared `scopes` string above is only half of scope correctness: under
// Shopify-managed installation, what an ALREADY-INSTALLED merchant actually
// holds can change server-side (Shopify grants a newly declared scope without
// a re-OAuth). `app/scopes_update` is the only signal that reports that change,
// so both configs must subscribe to it or SQRATCH's cached
// `Brand.shopifyGrantedScopes` silently drifts from the real grant. Both
// configs must also keep managed installation on — `use_legacy_install_flow`
// absent, or present and false — since the legacy flow is what would make the
// topic meaningless.
test("both CLI configs subscribe to app/scopes_update under managed installation", () => {
  for (const file of ["shopify.app.toml", "shopify.app.custom.toml"]) {
    const contents = readFileSync(file, "utf8");
    assert.match(contents, /topics = \[ "app\/scopes_update" \]/, `${file} must subscribe to app/scopes_update`);
    assert.match(
      contents,
      /uri = "[^"]+\/api\/shopify\/webhooks\/app\/scopes_update"/,
      `${file} must bind app/scopes_update to its dedicated route`,
    );
    assert.doesNotMatch(
      contents,
      /use_legacy_install_flow = true/,
      `${file} must keep Shopify-managed installation enabled`,
    );
  }
});
