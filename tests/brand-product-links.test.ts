process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";

/**
 * Brand Products links. A Customer-Tag-restricted Commerce7 wine has `productUrl: ""` (product sync deliberately refuses a
 * public URL for it). Rendering `<a href="">` reloaded SQRATCH itself. Only a validated absolute HTTPS public URL may be an
 * anchor. A restricted product may instead show a Brand-Admin-only "Open in Commerce7" store preview, built server-side
 * from the merchant-confirmed storefront config, where Commerce7 itself enforces login and Customer Tag access.
 */
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommerceProvider } from "@prisma/client";
import { NextRequest } from "next/server";

import type { BrandAdminContext } from "../src/lib/brand-auth";
import type { BrandProductRow, BrandProductsListDeps } from "../src/app/api/brand/products/route";
import { brandProductLinks, safeExternalProductUrl } from "../src/lib/commerce/product-link-display";
import { buildCommerce7AdminPreviewUrl, isCommerce7AccessRestricted } from "../src/lib/commerce/providers/commerce7-products";

let listProductsImpl: (request: NextRequest, overrides?: Partial<BrandProductsListDeps>) => Promise<Response>;
before(async () => {
  listProductsImpl = (await import("../src/app/api/brand/products/route")).listProductsImpl;
});

const STOREFRONT = { storefrontUrl: "https://sqratch-inc.v2-template.commerce7.com", productRoute: "/product" };
const THREE_TAGS = ["tag-uuid-aaaa", "tag-uuid-bbbb", "tag-uuid-cccc"];
const restrictedMetadata = { status: "ACTIVE", security: { availableTo: "Tag", displayOption: "Display Product / Show Login", availableToObjectIds: THREE_TAGS } };
const publicMetadata = { status: "ACTIVE", security: { availableTo: "Public", displayOption: null, availableToObjectIds: [] } };

describe("which links a product row may render", () => {
  test("public Commerce7 and Shopify product pages stay clickable, exactly as before", () => {
    for (const url of ["https://sqratch-inc.v2-template.commerce7.com/product/2015-chardonnay", "https://acme.myshopify.com/products/widget"]) {
      assert.deepEqual(brandProductLinks({ productUrl: url }), { publicUrl: url, previewUrl: null, note: null });
    }
  });

  test("the bug: an empty productUrl never becomes an anchor (it reloaded SQRATCH)", () => {
    assert.deepEqual(brandProductLinks({ productUrl: "" }), { publicUrl: null, previewUrl: null, note: "No public product link." });
  });

  test("missing, relative, malformed and untrusted URLs are never clickable", () => {
    for (const value of [null, undefined, "", "   ", "/product/x", "product/x", "not a url", "javascript:alert(1)", "data:text/html,x", "http://insecure.example/x", "https://user:pass@shop.example/x", "//shop.example/x"]) {
      assert.equal(safeExternalProductUrl(value), null, String(value));
      assert.equal(brandProductLinks({ productUrl: value }).publicUrl, null, String(value));
    }
  });

  test("a restricted Commerce7 wine: no public link, a short explanation, and only a valid HTTPS preview", () => {
    const preview = "https://sqratch-inc.v2-template.commerce7.com/product/sample-2015-chardonnay";
    assert.deepEqual(brandProductLinks({ productUrl: "", accessRestricted: true, adminPreviewUrl: preview }), { publicUrl: null, previewUrl: preview, note: "Restricted in Commerce7 — no public product link." });
    assert.equal(brandProductLinks({ productUrl: "", accessRestricted: true, adminPreviewUrl: "javascript:alert(1)" }).previewUrl, null);
    assert.equal(brandProductLinks({ productUrl: "", accessRestricted: true, adminPreviewUrl: null }).note, "Restricted in Commerce7 — no public product link.");
    assert.equal(brandProductLinks({ productUrl: "", accessRestricted: false, adminPreviewUrl: preview }).previewUrl, null, "a preview is only offered for a restricted product");
  });

  test("a public URL always wins; a restricted flag can never turn a public row into a preview", () => {
    const url = "https://sqratch-inc.v2-template.commerce7.com/product/2015-chardonnay";
    assert.deepEqual(brandProductLinks({ productUrl: url, accessRestricted: true, adminPreviewUrl: "https://other.example/x" }), { publicUrl: url, previewUrl: null, note: null });
  });
});

describe("Commerce7 admin preview (server)", () => {
  type PreviewInput = Parameters<typeof buildCommerce7AdminPreviewUrl>[0];
  const base: PreviewInput = { isAvailable: true, productUrl: "", slug: "sample-2015-chardonnay", productMetadata: restrictedMetadata, storefront: STOREFRONT };

  test("a restricted, available wine gets its store page on the merchant-confirmed origin and route", () => {
    assert.equal(buildCommerce7AdminPreviewUrl(base), "https://sqratch-inc.v2-template.commerce7.com/product/sample-2015-chardonnay");
    assert.equal(isCommerce7AccessRestricted(restrictedMetadata), true);
    for (const metadata of [publicMetadata, { status: "ACTIVE" }, null, [], { security: "Tag" }, { security: { availableTo: "" } }]) {
      assert.equal(isCommerce7AccessRestricted(metadata), false, JSON.stringify(metadata));
    }
  });

  test("never built for a public, priced, unavailable, slug-less or misconfigured product, or an unsafe slug", () => {
    const cases: Array<Partial<PreviewInput>> = [
      { productMetadata: publicMetadata },
      { productUrl: "https://sqratch-inc.v2-template.commerce7.com/product/x" },
      { isAvailable: false },
      { slug: null }, { slug: "" }, { slug: "../admin" }, { slug: ".." }, { slug: "a/b" },
      { storefront: null },
      { storefront: { storefrontUrl: "http://sqratch-inc.v2-template.commerce7.com", productRoute: "/product" } },
      { storefront: { storefrontUrl: null, productRoute: "/product" } },
      { storefront: { storefrontUrl: STOREFRONT.storefrontUrl, productRoute: null } },
      { storefront: { storefrontUrl: STOREFRONT.storefrontUrl, productRoute: "/../x" } },
    ];
    for (const override of cases) assert.equal(buildCommerce7AdminPreviewUrl({ ...base, ...override }), null, JSON.stringify(override));
  });
});

describe("GET /api/brand/products — link fields", () => {
  const brand = { id: "brand-1", name: "Acme", slug: "acme", bio: null, websiteUrl: null, logoUrl: null, coverImageUrl: null };
  const context: BrandAdminContext = { userId: "user-1", selectionRequired: false, brands: [{ id: brand.id, name: brand.name, slug: brand.slug, membershipRole: "MANAGER" }], membership: { id: "member-1", role: "MANAGER", brand } };
  const row = (overrides: Partial<BrandProductRow>): BrandProductRow => ({
    id: "prod", externalId: "ext", title: "Wine", handle: "wine", productUrl: "", imageUrl: null, images: [], sku: null, isAvailable: true,
    lastSeenAt: new Date("2026-10-08T00:00:00Z"), unavailableSince: null, currencyCode: "CAD", priceMinMinor: 2900, priceMaxMinor: 2900, priceMinorUnitExponent: 2,
    providerMetadata: { status: "ACTIVE" }, brandSelections: [], ...overrides,
  });
  const connection = { storefrontUrl: STOREFRONT.storefrontUrl, providerMetadata: { currencyCode: "CAD", productRoute: "/product" } };

  test("restricted, public Commerce7 and Shopify rows; no Customer Tag id, metadata or connection config is serialized", async () => {
    const rows = [
      row({ id: "rare", externalId: "1a74fd90-ef2a-4306-a33e-6c02b4b3202d", title: "Rare - 2015 Chardonnay", handle: "sample-2015-chardonnay", sku: "2015C-duplicate", provider: CommerceProvider.COMMERCE7, connection, providerMetadata: restrictedMetadata }),
      row({ id: "public", title: "Sample - 2015 Chardonnay", handle: "2015-chardonnay", productUrl: "https://sqratch-inc.v2-template.commerce7.com/product/2015-chardonnay", provider: CommerceProvider.COMMERCE7, connection, providerMetadata: publicMetadata }),
      row({ id: "shopify", title: "Widget", handle: "widget", productUrl: "https://acme.myshopify.com/products/widget", provider: CommerceProvider.SHOPIFY, connection: { storefrontUrl: null, providerMetadata: null } }),
      row({ id: "legacy-fixture", productUrl: "https://acme.myshopify.com/products/old" }),
    ];
    const res = await listProductsImpl(new NextRequest("https://x/api/brand/products"), { getContext: async () => context, findProducts: async () => rows, getLastSyncRun: async () => null });
    assert.equal(res.status, 200);
    const body = await res.json();
    const byId = Object.fromEntries(body.data.map((product: { id: string }) => [product.id, product]));
    assert.equal(byId.rare.productUrl, "", "the canonical public URL stays empty: restricted inventory never becomes public");
    assert.equal(byId.rare.accessRestricted, true);
    assert.equal(byId.rare.adminPreviewUrl, "https://sqratch-inc.v2-template.commerce7.com/product/sample-2015-chardonnay");
    assert.equal(byId.public.productUrl, "https://sqratch-inc.v2-template.commerce7.com/product/2015-chardonnay");
    assert.equal(byId.public.accessRestricted, false); assert.equal(byId.public.adminPreviewUrl, null);
    assert.equal(byId.shopify.productUrl, "https://acme.myshopify.com/products/widget");
    assert.equal(byId.shopify.accessRestricted, false); assert.equal(byId.shopify.adminPreviewUrl, null);
    assert.equal(byId["legacy-fixture"].adminPreviewUrl, null);
    const serialized = JSON.stringify(body);
    for (const forbidden of [...THREE_TAGS, "availableToObjectIds", "providerMetadata", "displayOption", "productRoute", "\"connection\"", "storefrontUrl", "security"]) {
      assert.ok(!serialized.includes(forbidden), `must not expose ${forbidden}`);
    }
  });
});

describe("Brand product link renderings use the safe helper", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  test("Brand Products never renders a raw productUrl href; image and title link only to the validated public URL", () => {
    const source = read("src/app/(withSidebar)/dashboard/brand/products/BrandProductsClient.tsx");
    assert.doesNotMatch(source, /href=\{product\.productUrl\}/);
    assert.match(source, /brandProductLinks\(product\)/);
    assert.equal((source.match(/href=\{links\.publicUrl\}/g) ?? []).length, 2, "thumbnail and title");
    assert.match(source, /href=\{links\.previewUrl\}[\s\S]{0,800}Open in Commerce7/);
  });

  test("the legacy Brand Shopify page guards its Open product link the same way", () => {
    const source = read("src/app/(withSidebar)/dashboard/brand/shopify/BrandShopifyClient.tsx");
    assert.doesNotMatch(source, /href=\{product\.productUrl\}/);
    assert.match(source, /safeExternalProductUrl\(product\.productUrl\)/);
  });
});
