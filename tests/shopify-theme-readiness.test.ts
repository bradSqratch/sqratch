import assert from "node:assert/strict";
import { test } from "node:test";
import { getShopifyThemeTrackingReadiness } from "../src/lib/commerce/providers/shopify-theme-readiness";

const input = {
  brandId: "brand-1",
  shopDomain: "store.myshopify.com",
  apiKey: "0123456789abcdef0123456789abcdef",
  grantedScopes: ["read_products", "read_themes"],
};

function fetchFor(settings: unknown, status = 200): typeof fetch {
  return async (url) => new Response(
    String(url).includes("themes.json")
      ? JSON.stringify({ themes: [{ id: 42, role: "main" }] })
      : JSON.stringify({ asset: { value: JSON.stringify(settings) } }),
    { status, headers: { "content-type": "application/json" } },
  );
}

const token = async () => ({ ok: true as const, accessToken: "opaque-test-token" });

test("theme readiness distinguishes permission, missing, disabled, and enabled states", async () => {
  assert.equal((await getShopifyThemeTrackingReadiness({ ...input, grantedScopes: ["read_products"] }, { getAccessToken: token })).state, "PERMISSION_REQUIRED");
  assert.equal((await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl: fetchFor({ current: { blocks: {} } }) })).state, "NOT_CONFIGURED");
  const type = `shopify://apps/${input.apiKey}/blocks/sqratch-attribution-embed/abc`;
  assert.equal((await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl: fetchFor({ current: { blocks: { abc: { type, disabled: true } } } }) })).state, "DISABLED");
  assert.equal((await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl: fetchFor({ current: { blocks: { abc: { type, disabled: false } } } }) })).state, "ENABLED");
});

test("API, parse, and missing-main failures are UNKNOWN and never DISABLED", async () => {
  const apiFailure = await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl: fetchFor({}, 500) });
  assert.equal(apiFailure.state, "UNKNOWN");
  const malformed: typeof fetch = async (url) => new Response(String(url).includes("themes.json") ? JSON.stringify({ themes: [{ id: 1, role: "main" }] }) : JSON.stringify({ asset: { value: "{" } }), { status: 200 });
  assert.equal((await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl: malformed })).state, "UNKNOWN");
  const noMain: typeof fetch = async () => new Response(JSON.stringify({ themes: [] }), { status: 200 });
  assert.equal((await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl: noMain })).state, "UNKNOWN");
});

test("theme settings content is not persisted or returned", async () => {
  let requested = "";
  const fetchImpl: typeof fetch = async (url) => {
    requested = String(url);
    return fetchFor({ current: { blocks: {} } })(url);
  };
  const readiness = await getShopifyThemeTrackingReadiness(input, { getAccessToken: token, fetchImpl });
  assert.equal(readiness.provider, "SHOPIFY");
  assert.match(requested, /settings_data\.json/);
  assert.deepEqual(Object.keys(readiness), ["provider", "state"]);
});
