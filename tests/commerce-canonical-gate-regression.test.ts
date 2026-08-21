/**
 * tests/commerce-canonical-gate-regression.test.ts
 *
 * PHASE 14B.4B — N. Static regression guard: the routes/services migrated in
 * this phase must keep resolving connectivity/identity through the CANONICAL
 * `CommerceConnection` path, never regress back to a direct three-part
 * `Brand.shopifyShopDomain && Brand.shopifyAdminAccessTokenEncrypted &&
 * Brand.shopifyConnectionStatus === "CONNECTED"` gate. This is a coarse,
 * intentionally simple tripwire — it does not replace the behavioral tests
 * elsewhere in this suite, it just makes a regression to the OLD pattern fail
 * loudly at the source-text level, in one place, for every migrated file at
 * once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

// The exact shape of the pre-14B.4B legacy gate this phase eliminated.
const OLD_THREE_PART_GATE = /shopifyConnectionStatus\s*!==?\s*["']CONNECTED["']/;

const CANONICAL_GATED_FILES = [
  "src/app/api/brand/shopify/status/route.ts",
  "src/app/api/brand/shopify/products/route.ts",
  "src/app/api/me/dashboard-summary/route.ts",
  "src/lib/shopify-embedded-connection.ts",
];

for (const file of CANONICAL_GATED_FILES) {
  test(`N. ${file} no longer contains the old direct three-part Brand.shopify* connectivity gate`, () => {
    const source = readSource(file);
    assert.doesNotMatch(
      source,
      OLD_THREE_PART_GATE,
      `${file} appears to have regressed to a direct Brand.shopifyConnectionStatus gate`,
    );
  });

  test(`N. ${file} references the canonical connection service`, () => {
    const source = readSource(file);
    assert.match(
      source,
      /getActiveCommerceConnection|commerceConnection\.findUnique|CommerceConnection/,
      `${file} should resolve connectivity through the canonical CommerceConnection path`,
    );
  });
}

test("N. connection-service.ts's canonical row never defers to a disagreeing legacy Brand value", () => {
  const source = readSource("src/lib/commerce/connection-service.ts").replace(
    /\/\*[\s\S]*?\*\//g,
    "",
  );
  // The function body that returns the canonical connection when a row
  // exists must return unconditionally — this is a structural check that the
  // "if (preferredRow) { ... return { connection, ... } }" shape from this
  // phase's fix is present, not a full parse (a coarse but effective
  // tripwire against silently reintroducing a legacy-wins branch there).
  assert.match(source, /if \(preferredRow\) \{/);
  assert.doesNotMatch(
    source,
    /if \(preferredRow\)[\s\S]{0,400}rowExternalAccountId === legacyDomain \? .*legacySummary/,
  );
});

// ---------------------------------------------------------------------------
// PHASE 14B.4C — reward-surface Category-D elimination
// ---------------------------------------------------------------------------

const REWARD_D_FIELDS = [
  "shopifyShopDomain",
  "shopifyAdminAccessTokenEncrypted",
  "shopifyCurrencyCode",
  "shopifyConnectionStatus",
  "shopifyInstalledAt",
  "shopifyUninstalledAt",
  "shopifyLastProductSyncAt",
  "shopifyGrantedScopes",
  "shopifyClientId",
  "shopifyDisconnectedAt",
];

const REWARD_CANONICAL_FILES = [
  "src/app/api/rewards/shopify/route.ts",
  "src/app/api/brand/rewards/offers/route.ts",
  "src/app/api/brand/rewards/offers/[offerId]/route.ts",
];

for (const file of REWARD_CANONICAL_FILES) {
  test(`O. ${file} reads none of the legacy Brand.shopify* fields as runtime authority`, () => {
    const source = readSource(file);
    for (const field of REWARD_D_FIELDS) {
      assert.doesNotMatch(
        source,
        new RegExp(field),
        `${file} still references Brand.${field} — Category D must be zero`,
      );
    }
  });

  test(`O. ${file} resolves connectivity through the canonical connection service`, () => {
    const source = readSource(file);
    assert.match(
      source,
      /getActiveCommerceConnection/,
      `${file} should resolve connectivity through getActiveCommerceConnection(sForBrands)`,
    );
  });

  test(`O. ${file} no longer defines the removed canActivateShopifyOffer legacy gate`, () => {
    const source = readSource(file);
    assert.doesNotMatch(source, /canActivateShopifyOffer/);
  });
}

test("O. the public rewards route never imports a token/credential resolver — it makes no Shopify API call", () => {
  const source = readSource("src/app/api/rewards/shopify/route.ts");
  assert.doesNotMatch(source, /getValidAccessToken/);
  assert.doesNotMatch(source, /getShopifyShopCurrency/);
});

test("O. brand offer routes resolve a real Shopify network call's token via getValidAccessToken, never a raw Brand-encrypted token", () => {
  for (const file of [
    "src/app/api/brand/rewards/offers/route.ts",
    "src/app/api/brand/rewards/offers/[offerId]/route.ts",
  ]) {
    const source = readSource(file);
    assert.match(source, /getValidAccessToken/, `${file} should resolve its token canonically`);
    assert.match(
      source,
      /getShopifyShopCurrencyWithAccessToken/,
      `${file} should use the plaintext-token currency entry point, not decrypt a Brand token directly`,
    );
    assert.doesNotMatch(
      source,
      /getShopifyShopCurrency\(\{/,
      `${file} must not call the encrypted-token getShopifyShopCurrency wrapper directly`,
    );
  }
});

test("N. applyGrantedScopesUpdate resolves identity via CommerceConnection.externalAccountId, and no Brand.shopifyShopDomain fallback exists at all (Phase 14C-B2)", () => {
  const source = readSource("src/lib/shopify-token-manager.ts");
  const fnStart = source.indexOf("export async function applyGrantedScopesUpdate");
  assert.ok(fnStart > -1, "applyGrantedScopesUpdate not found");
  const fnBody = source.slice(fnStart, fnStart + 4000);

  assert.ok(
    fnBody.indexOf("provider_externalAccountId") > -1,
    "canonical connection lookup not found",
  );

  // PHASE 14C-B2: the ordering check this test used to make (canonical lookup
  // BEFORE the legacy Brand fallback) is now an absence check — the column was
  // physically dropped, so any Brand.shopifyShopDomain lookup here would not
  // even compile. Asserted on the source text so the guard stays meaningful
  // rather than passing vacuously.
  assert.doesNotMatch(
    fnBody,
    /brand\.find(?:Unique|First)\s*\(\s*\{\s*\n?\s*where:\s*\{\s*shopifyShopDomain/,
    "no Brand.shopifyShopDomain fallback lookup may exist",
  );
});
