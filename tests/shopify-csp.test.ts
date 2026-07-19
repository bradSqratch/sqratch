import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

async function getRoute() {
  process.env.SHOPIFY_API_KEY = "shopify-csp-test-api-key";
  process.env.SHOPIFY_APP_DISTRIBUTION = "public";
  return import("@/app/shopify/route");
}

async function cspFor(shop?: string) {
  const url = new URL("https://sqratch.example/shopify");
  if (shop !== undefined) url.searchParams.set("shop", shop);
  const { GET } = await getRoute();
  const response = await GET(new NextRequest(url));
  return response.headers.get("content-security-policy");
}

async function htmlFor(shop = "example-store.myshopify.com") {
  const { GET } = await getRoute();
  const response = await GET(
    new NextRequest(`https://sqratch.example/shopify?shop=${shop}`),
  );
  return response.text();
}

test("embedded Shopify response includes validated shop and admin frame ancestors", async () => {
  assert.equal(
    await cspFor("example-store.myshopify.com"),
    "frame-ancestors https://example-store.myshopify.com https://admin.shopify.com;",
  );
});

test("embedded Shopify response uses safe admin fallback for invalid shop context", async () => {
  const expected = "frame-ancestors https://admin.shopify.com;";
  assert.equal(await cspFor(), expected);
  assert.equal(await cspFor("not-shopify.example.com"), expected);
  assert.equal(await cspFor("evil.myshopify.com\nframe-src https://evil.example"), expected);
  assert.equal(await cspFor("https://evil.example"), expected);
});

test("embedded setup page keeps the SQRATCH shell and setup states visible", async () => {
  const html = await htmlFor();

  assert.match(html, /class="topbar"/);
  assert.match(html, /<img src="\/sqratchLogo\.svg" alt="SQRATCH" class="wordmark-logo" width="333" height="58">/);
  assert.doesNotMatch(html, /<svg[\s>]/);
  assert.match(html, /SHOPIFY INTEGRATION|Connect Shopify to SQRATCH/i);
  assert.match(html, /Connect Shopify to SQRATCH/);
  assert.match(html, /Shopify app setup|Link your Shopify store with SQRATCH/);
  assert.match(html, /id="error-message" role="alert" aria-live="polite"/);
  assert.match(html, /SQRATCH requests product access to display Shopify products/);
  assert.match(html, /Continue to SQRATCH linking|Link to SQRATCH/);
  assert.match(html, /Checking Shopify connection/);
  assert.match(html, /Connected to Shopify/);
  assert.match(html, /Linked to /);
  assert.match(html, /Disconnect from SQRATCH/);
});

test("embedded setup page retains the session-token setup flow without a SQRATCH session", async () => {
  const html = await htmlFor();

  assert.match(html, /window\.shopify\.idToken\(\)/);
  assert.match(html, /fetch\("\/api\/shopify\/embedded\/session"/);
  assert.match(html, /fetch\("\/api\/shopify\/embedded\/status"/);
  assert.match(html, /fetch\("\/api\/shopify\/embedded\/disconnect"/);
  assert.match(html, /Authorization: `Bearer \$\{sessionToken\}`/);
  assert.match(html, /window\.top\.location\.href = redirectTo/);
  assert.doesNotMatch(html, /getServerSession|useSession|localStorage/);
});
