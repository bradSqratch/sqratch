import { test } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";
import { GET } from "@/app/shopify/route";

async function cspFor(shop?: string) {
  const url = new URL("https://sqratch.example/shopify");
  if (shop !== undefined) url.searchParams.set("shop", shop);
  const response = await GET(new NextRequest(url));
  return response.headers.get("content-security-policy");
}

async function htmlFor(shop = "example-store.myshopify.com") {
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
  assert.match(html, /aria-label="SQRATCH"/);
  assert.match(html, /SHOPIFY INTEGRATION/i);
  assert.match(html, /Connect Shopify to SQRATCH/);
  assert.match(html, /Shopify app setup/);
  assert.match(html, /id="error-message" role="alert" aria-live="polite"/);
  assert.match(html, /SQRATCH requests product access to display Shopify products/);
  assert.match(html, /Continue to SQRATCH linking/);
});

test("embedded setup page retains the session-token setup flow without a SQRATCH session", async () => {
  const html = await htmlFor();

  assert.match(html, /window\.shopify\.idToken\(\)/);
  assert.match(html, /fetch\("\/api\/shopify\/embedded\/session"/);
  assert.match(html, /Authorization: `Bearer \$\{sessionToken\}`/);
  assert.match(html, /window\.top\.location\.href = redirectTo/);
  assert.doesNotMatch(html, /getServerSession|useSession|localStorage/);
});
