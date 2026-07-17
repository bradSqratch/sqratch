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
