/**
 * tests/public-commerce-response-validation.test.ts
 *
 * Runtime response validation for the PUBLIC commerce surfaces.
 *
 * THE DEFECT UNDER TEST. `fetchJson` ends in `return (json?.data ?? json) as T`
 * — a compile-time claim only. The public shop then read
 * `shopData?.products.length`, where `?.` guards `shopData` but NOT `products`.
 * A body of `{}` therefore produced a truthy object whose `.products` was
 * `undefined` and the render threw, white-screening a public storefront. The
 * lesson surface had the same defect through `setProducts(result.items)`, and
 * the public campaign page assigned `json.data` with no checks at all.
 *
 * These tests pin the parsers AND the wiring, because a correct parser that
 * nothing calls fixes nothing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  MAX_PUBLIC_PRODUCTS,
  PUBLIC_PRODUCT_SOURCES,
  isPublicLessonProductCard,
  isPublicShopProductCard,
  isSafeClickPathSegment,
  parsePublicCampaignPayload,
  parsePublicLessonProducts,
  parsePublicShopEnvelope,
  parsePublicShopResponse,
} from "../src/lib/commerce/public-commerce-response";

/**
 * Strips comments so a "must not contain X" assertion can never be satisfied
 * or broken by prose. Explanatory comments in these files legitimately discuss
 * the very patterns some assertions forbid in CODE.
 */
function executableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/\s.*$/gm, "");
}

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

const SHOP_CLIENT = "src/components/experience/shop-client.tsx";
const LESSON_CLIENT = "src/components/experience/lesson-client.tsx";
const CAMPAIGN_PAGE = "src/app/c/[campaignSlug]/page.tsx";

function shopProduct(overrides: Record<string, unknown> = {}) {
  return {
    id: "campaign-abc123",
    productId: "gid-999",
    productLinkId: null,
    title: "Reserve Cabernet",
    imageUrl: "https://cdn.example.com/a.jpg",
    priceText: "$49.00",
    productUrl: "https://shop.example.com/products/reserve",
    brand: { id: "brand-1", name: "Example", slug: "example" },
    source: "CAMPAIGN_PRODUCT",
    campaignAssignmentId: "cma_abc123",
    ...overrides,
  };
}

function shopResponse(overrides: Record<string, unknown> = {}) {
  return {
    experience: { id: "exp-1", slug: "tasting", title: "Tasting" },
    campaign: { id: "camp-1", name: "Spring", brand: null },
    products: [shopProduct()],
    ...overrides,
  };
}

// ===========================================================================
describe("PUBLIC SHOP — malformed API response", () => {
  test("THE CRASH CASE: a body with no `products` key is rejected, not cast", () => {
    // This exact payload used to reach the render and throw on
    // `shopData?.products.length` — `?.` guards the object, not the array.
    const parsed = parsePublicShopResponse({
      experience: { id: "exp-1", slug: "tasting", title: "Tasting" },
      campaign: null,
    });
    assert.equal(parsed, null);
  });

  test("`products: null` and a non-array `products` are both rejected", () => {
    assert.equal(parsePublicShopResponse(shopResponse({ products: null })), null);
    assert.equal(parsePublicShopResponse(shopResponse({ products: {} })), null);
    assert.equal(parsePublicShopResponse(shopResponse({ products: "many" })), null);
  });

  test("non-object bodies are rejected without throwing", () => {
    for (const body of [null, undefined, 0, "", "text", [], true, NaN]) {
      assert.equal(parsePublicShopResponse(body), null);
    }
  });

  test("an EMPTY catalog is valid and is NOT confused with malformed", () => {
    // The distinction that matters: `[]` means "this shop has no products"
    // and must render the empty state; `null` means the response was broken.
    const parsed = parsePublicShopResponse(shopResponse({ products: [] }));
    assert.ok(parsed);
    assert.deepEqual(parsed.products, []);
  });

  test("one malformed card invalidates the whole page rather than silently vanishing", () => {
    // Mirrors `parseOrderListEnvelope`. A partial catalog would read as
    // complete to both the shopper and the brand.
    const parsed = parsePublicShopResponse(
      shopResponse({ products: [shopProduct(), { title: "broken" }] }),
    );
    assert.equal(parsed, null);
  });

  test("an absurdly large array is refused instead of being rendered", () => {
    const products = Array.from({ length: MAX_PUBLIC_PRODUCTS + 1 }, (_, i) =>
      shopProduct({ id: `campaign-${i}` }),
    );
    assert.equal(parsePublicShopResponse(shopResponse({ products })), null);
  });

  test("the ceiling is defensive only and must stay far above a real catalog", () => {
    // ADVERSARIAL REVIEW ROUND 1 caught this as a self-inflicted regression:
    // the cap started at 500, but the public shop route applies NO `take:` and
    // returns every eligible product. A brand with a larger catalog would have
    // seen "Failed to load shop products" instead of their shop — the
    // validator itself becoming the outage. Lowering this back toward a
    // plausible catalog size reintroduces that bug.
    assert.ok(
      MAX_PUBLIC_PRODUCTS >= 5000,
      "cap must stay well above any real catalog; the route is unbounded",
    );
  });

  test("a large but legitimate catalog still parses", () => {
    const products = Array.from({ length: 1200 }, (_, i) =>
      shopProduct({ id: `campaign-${i}` }),
    );
    const parsed = parsePublicShopResponse(shopResponse({ products }));
    assert.ok(parsed, "a 1200-product catalog must render, not error");
    assert.equal(parsed.products.length, 1200);
  });

  test("a valid response round-trips its fields unchanged", () => {
    const parsed = parsePublicShopResponse(shopResponse());
    assert.ok(parsed);
    assert.equal(parsed.experience.slug, "tasting");
    assert.equal(parsed.campaign?.name, "Spring");
    assert.equal(parsed.products[0].title, "Reserve Cabernet");
    assert.equal(parsed.products[0].priceText, "$49.00");
  });
});

// ===========================================================================
describe("PUBLIC SHOP — pagination envelope (PHASE 29)", () => {
  function envelope(overrides: { data?: unknown; meta?: unknown } = {}) {
    return {
      data: overrides.data !== undefined ? overrides.data : shopResponse(),
      meta:
        overrides.meta !== undefined
          ? overrides.meta
          : { hasNextPage: true, nextCursor: "Y3Vyc29y", limit: 24 },
    };
  }

  test("THE REGRESSION THIS PINS: meta is read from the FULL body, never from fetchJson's unwrapped data", () => {
    const parsed = parsePublicShopEnvelope(envelope());
    assert.ok(parsed);
    assert.equal(parsed.meta.hasNextPage, true);
    assert.equal(parsed.meta.nextCursor, "Y3Vyc29y");
    assert.equal(parsed.meta.limit, 24);

    // This is precisely what fetchJson would have returned instead.
    const whatFetchJsonReturns = (envelope() as { data?: unknown }).data;
    assert.equal(
      (whatFetchJsonReturns as Record<string, unknown>).meta,
      undefined,
      "the unwrapped value must not carry meta — this is the bug being pinned",
    );
  });

  test("a last page reports hasNextPage false with a null cursor", () => {
    const parsed = parsePublicShopEnvelope(
      envelope({ meta: { hasNextPage: false, nextCursor: null, limit: 24 } }),
    );
    assert.ok(parsed);
    assert.equal(parsed.meta.hasNextPage, false);
    assert.equal(parsed.meta.nextCursor, null);
  });

  test("an empty-string cursor normalizes to null", () => {
    const parsed = parsePublicShopEnvelope(
      envelope({ meta: { hasNextPage: true, nextCursor: "", limit: 24 } }),
    );
    assert.equal(parsed?.meta.nextCursor, null);
  });

  test("a missing meta block is rejected, never defaulted to 'no more pages'", () => {
    // Defaulting would silently reintroduce the campaign-products bug: an
    // unreachable next page the UI confidently claims does not exist.
    assert.equal(parsePublicShopEnvelope({ data: shopResponse() }), null);
    assert.equal(parsePublicShopEnvelope(envelope({ meta: null })), null);
    assert.equal(parsePublicShopEnvelope(envelope({ meta: {} })), null);
  });

  test("a non-boolean hasNextPage is rejected rather than coerced", () => {
    for (const bad of ["true", 1, null, undefined]) {
      assert.equal(
        parsePublicShopEnvelope(envelope({ meta: { hasNextPage: bad, nextCursor: null, limit: 24 } })),
        null,
      );
    }
  });

  test("an invalid limit is rejected", () => {
    for (const bad of [0, -1, 1.5, "24", null]) {
      assert.equal(
        parsePublicShopEnvelope(envelope({ meta: { hasNextPage: false, nextCursor: null, limit: bad } })),
        null,
      );
    }
  });

  test("a malformed data half invalidates the whole envelope, even with valid meta", () => {
    assert.equal(parsePublicShopEnvelope(envelope({ data: { experience: {} } })), null);
  });

  test("non-object bodies are rejected without throwing", () => {
    for (const body of [null, undefined, "x", 5, [], true]) {
      assert.equal(parsePublicShopEnvelope(body), null);
    }
  });
});

// ===========================================================================
describe("PUBLIC SHOP — invalid product status / ids / URL", () => {
  test("an unknown `source` is rejected (it decides which click hop is used)", () => {
    assert.equal(isPublicShopProductCard(shopProduct({ source: "MYSTERY" })), false);
    assert.equal(isPublicShopProductCard(shopProduct({ source: null })), false);
    assert.equal(isPublicShopProductCard(shopProduct({ source: undefined })), false);
  });

  test("both canonical sources are accepted", () => {
    for (const source of PUBLIC_PRODUCT_SOURCES) {
      assert.equal(
        isPublicShopProductCard(shopProduct({ source, campaignProductId: "bcp_1" })),
        true,
        `${source} should be a valid card source`,
      );
    }
  });

  test("a card missing its render key `id` is rejected", () => {
    // `id` keys the React list, the failed-image set and the in-flight click
    // state; without it cards cross-talk.
    assert.equal(isPublicShopProductCard(shopProduct({ id: undefined })), false);
    assert.equal(isPublicShopProductCard(shopProduct({ id: "" })), false);
    assert.equal(isPublicShopProductCard(shopProduct({ id: 7 })), false);
  });

  test("a missing destination or title is rejected", () => {
    assert.equal(isPublicShopProductCard(shopProduct({ productUrl: "" })), false);
    assert.equal(isPublicShopProductCard(shopProduct({ productUrl: null })), false);
    assert.equal(isPublicShopProductCard(shopProduct({ title: "   " })), false);
    assert.equal(isPublicShopProductCard(shopProduct({ productId: undefined })), false);
  });

  test("a click id containing a path separator is rejected", () => {
    // These ids are interpolated into a URL PATH. Traversal must not be able
    // to re-point the click hop at a different endpoint.
    for (const hostile of [
      "../../../admin",
      "a/b",
      "abc?x=1",
      "abc#frag",
      "abc def",
      "abc%2f",
      "",
    ]) {
      assert.equal(
        isPublicShopProductCard(shopProduct({ campaignAssignmentId: hostile })),
        false,
        `${JSON.stringify(hostile)} must not be accepted as a click id`,
      );
    }
  });

  test("a card with NO click id is still valid — it simply is not clickable", () => {
    const card = shopProduct({ campaignAssignmentId: null, campaignProductId: null });
    assert.equal(isPublicShopProductCard(card), true);
  });

  test("a malformed brand ref is rejected but an absent one is fine", () => {
    assert.equal(isPublicShopProductCard(shopProduct({ brand: { name: "x" } })), false);
    assert.equal(isPublicShopProductCard(shopProduct({ brand: null })), true);
  });
});

// ===========================================================================
describe("PUBLIC SHOP — money is never invented", () => {
  test("a null price stays null so the UI can omit it rather than print $0", () => {
    const parsed = parsePublicShopResponse(
      shopResponse({ products: [shopProduct({ priceText: null })] }),
    );
    assert.ok(parsed);
    assert.equal(parsed.products[0].priceText, null);
  });

  test("a NUMERIC price is rejected — the contract is a server-formatted string", () => {
    // Accepting a number would invite a client-side `/ 100` somewhere later.
    assert.equal(isPublicShopProductCard(shopProduct({ priceText: 4900 })), false);
    assert.equal(isPublicShopProductCard(shopProduct({ priceText: 49.0 })), false);
  });

  test("the validator performs no money arithmetic at all", () => {
    const source = executableSource(read("src/lib/commerce/public-commerce-response.ts"));
    assert.doesNotMatch(source, /\/\s*100\b/);
    assert.doesNotMatch(source, /\bparseFloat\b|\bNumber\(/);
    assert.doesNotMatch(source, /toFixed\(/);
  });
});

// ===========================================================================
describe("PUBLIC LESSON PRODUCTS — malformed API response", () => {
  const item = {
    id: "clp_abc123",
    productUrl: "https://shop.example.com/p/x",
    title: "Barrel Tour",
    imageUrl: null,
    priceText: null,
    currency: null,
  };

  test("THE CRASH CASE: a body with no `items` key is rejected", () => {
    assert.equal(parsePublicLessonProducts({}), null);
    assert.equal(parsePublicLessonProducts({ items: null }), null);
    assert.equal(parsePublicLessonProducts({ items: "none" }), null);
  });

  test("an inaccessible lesson's empty list is VALID, not an error", () => {
    // The route returns `items: []` when the viewer cannot access the lesson.
    const parsed = parsePublicLessonProducts({ items: [] });
    assert.ok(parsed);
    assert.deepEqual(parsed.items, []);
  });

  test("a valid list round-trips", () => {
    const parsed = parsePublicLessonProducts({ items: [item] });
    assert.ok(parsed);
    assert.equal(parsed.items[0].id, "clp_abc123");
  });

  test("the click id is held to the path-safe alphabet", () => {
    for (const hostile of ["../x", "a/b", "a b", "a?b", ""]) {
      assert.equal(
        isPublicLessonProductCard({ ...item, id: hostile }),
        false,
        `${JSON.stringify(hostile)} must not be accepted`,
      );
    }
  });

  test("one malformed item invalidates the list", () => {
    assert.equal(parsePublicLessonProducts({ items: [item, { id: "ok" }] }), null);
  });

  test("nullable presentation fields accept null but reject wrong types", () => {
    assert.equal(isPublicLessonProductCard({ ...item, title: null }), true);
    assert.equal(isPublicLessonProductCard({ ...item, currency: 42 }), false);
    assert.equal(isPublicLessonProductCard({ ...item, imageUrl: {} }), false);
  });
});

// ===========================================================================
describe("PUBLIC CAMPAIGN PAYLOAD — malformed API response", () => {
  const payload = {
    id: "camp-1",
    name: "Spring Release",
    description: null,
    brand: { id: "brand-1", name: "Example", slug: "example", logoUrl: null },
    experiences: [{ slug: "tasting", title: "Tasting", coverImageUrl: null }],
    isUnlocked: true,
    hasRedeemedQrWarning: false,
  };

  test("a valid payload round-trips", () => {
    const parsed = parsePublicCampaignPayload(payload);
    assert.ok(parsed);
    assert.equal(parsed.experiences[0].slug, "tasting");
    assert.equal(parsed.isUnlocked, true);
  });

  test("THE CRASH CASE: a missing `experiences` array is rejected", () => {
    assert.equal(parsePublicCampaignPayload({ ...payload, experiences: undefined }), null);
    assert.equal(parsePublicCampaignPayload({ ...payload, experiences: null }), null);
  });

  test("unlock state is NEVER coerced", () => {
    // `Boolean(undefined)` would silently present a locked campaign as
    // unlocked (or the reverse) — the one field a shopper's access hinges on.
    for (const bad of [undefined, null, "true", 1, 0]) {
      assert.equal(
        parsePublicCampaignPayload({ ...payload, isUnlocked: bad }),
        null,
        `isUnlocked=${JSON.stringify(bad)} must not be coerced`,
      );
    }
    assert.equal(parsePublicCampaignPayload({ ...payload, isUnlocked: false })?.isUnlocked, false);
  });

  test("an experience card without a slug is rejected (it builds the /x link)", () => {
    assert.equal(
      parsePublicCampaignPayload({
        ...payload,
        experiences: [{ slug: "", title: "T", coverImageUrl: null }],
      }),
      null,
    );
  });

  test("an absent brand is valid; a malformed brand is not", () => {
    assert.ok(parsePublicCampaignPayload({ ...payload, brand: null }));
    assert.equal(parsePublicCampaignPayload({ ...payload, brand: { name: "x" } }), null);
  });

  test("non-object bodies are rejected without throwing", () => {
    for (const body of [null, undefined, "x", 5, [], true]) {
      assert.equal(parsePublicCampaignPayload(body), null);
    }
  });
});

// ===========================================================================
describe("isSafeClickPathSegment", () => {
  test("accepts the id shapes Prisma actually mints", () => {
    assert.equal(isSafeClickPathSegment("clp_abc123"), true);
    assert.equal(isSafeClickPathSegment("ckqv8x1y70000abcd1234efgh"), true);
    assert.equal(isSafeClickPathSegment("a-b_c-123"), true);
  });

  test("rejects anything that could re-point a URL path", () => {
    for (const hostile of [
      "..",
      "../admin",
      "a/b",
      "a\\b",
      "a?b",
      "a#b",
      "a b",
      "a\tb",
      "a\nb",
      "%2e%2e",
      "",
      "a".repeat(129),
    ]) {
      assert.equal(
        isSafeClickPathSegment(hostile),
        false,
        `${JSON.stringify(hostile)} must be rejected`,
      );
    }
  });

  test("rejects non-strings", () => {
    for (const value of [null, undefined, 7, {}, [], true]) {
      assert.equal(isSafeClickPathSegment(value), false);
    }
  });
});

// ===========================================================================
describe("WIRING — the parsers are actually used by the public surfaces", () => {
  test("the shop client validates instead of casting", () => {
    const source = read(SHOP_CLIENT);
    // PHASE 29: the client now reads the full `{data, meta}` pagination
    // envelope via `parsePublicShopEnvelope` (which validates `data`
    // through `parsePublicShopResponse` internally), not the unwrapped
    // `data` shape directly — see the "meta survives the envelope" tests
    // below for why a bare `fetchJson`/`parsePublicShopResponse` pairing
    // would silently lose pagination.
    assert.match(source, /parsePublicShopEnvelope\(/);
    // The bare generic cast this replaced must not come back.
    assert.doesNotMatch(executableSource(source), /fetchJson<ShopResponse>/);
    assert.doesNotMatch(executableSource(source), /fetchJson<PublicShopResponse>/);
  });

  test("the shop client distinguishes malformed from empty", () => {
    const source = read(SHOP_CLIENT);
    // A malformed payload must set an ERROR, never an empty catalog that
    // would read as "this brand has no products".
    assert.match(source, /if \(!parsed\)/);
    assert.match(source, /setShopError\(/);
  });

  test("PHASE 29: the shop client reads meta via a plain fetch, never fetchJson, and drives Load More from it", () => {
    // The exact bug class this pins: `fetchJson` unwraps to `json.data`
    // only, so `result.meta` would always be `undefined` if the client used
    // it here — precisely what killed the Brand campaign-products page's
    // pager. See `parseCampaignProductEnvelope`'s header for the original
    // incident this mirrors.
    const source = read(SHOP_CLIENT);
    const executable = executableSource(source);
    assert.match(executable, /await fetch\(/);
    assert.doesNotMatch(executable, /fetchJson\(/);
    assert.match(source, /setHasNextPage\(parsed\.meta\.hasNextPage\)/);
    assert.match(source, /setNextCursor\(parsed\.meta\.nextCursor\)/);
    assert.match(source, /Load more products/);
  });

  test("PHASE 29: a Load More page APPENDS to the accumulated list, never replaces it", () => {
    const executable = executableSource(read(SHOP_CLIENT));
    assert.match(
      executable,
      /isFirstPage \? parsed\.data\.products : \[\.\.\.current, \.\.\.parsed\.data\.products\]/,
    );
  });

  test("PHASE 29: a superseded shop response cannot corrupt the accumulated list", () => {
    const executable = executableSource(read(SHOP_CLIENT));
    assert.match(executable, /requestSeq/);
    assert.match(executable, /seq !== requestSeq\.current/);
  });

  test("the lesson client validates instead of casting", () => {
    const source = read(LESSON_CLIENT);
    assert.match(source, /parsePublicLessonProducts\(/);
    assert.doesNotMatch(executableSource(source), /fetchJson<LessonProductsResponse>/);
  });

  test("the campaign page validates instead of assigning json.data raw", () => {
    const source = read(CAMPAIGN_PAGE);
    assert.match(source, /parsePublicCampaignPayload\(/);
    assert.doesNotMatch(executableSource(source), /setData\(json\.data\)/);
  });

  test("every public click hop re-checks its path segment at the point of use", () => {
    for (const file of [SHOP_CLIENT, LESSON_CLIENT]) {
      assert.match(
        read(file),
        /isSafeClickPathSegment\(/,
        `${file} should guard its click path segment`,
      );
    }
  });

  test("no public surface re-declares the response shape it renders", () => {
    // A re-declared copy would still compile after the validator tightened,
    // which is exactly how a validated shape and a rendered shape drift apart.
    assert.match(read(SHOP_CLIENT), /type ShopResponse = PublicShopResponse;/);
    assert.match(read(CAMPAIGN_PAGE), /type CampaignPayload = PublicCampaignPayload;/);
  });

  test("product images use object-contain, never object-cover (the bottle-crop bug)", () => {
    // ADVERSARIAL REVIEW ROUND 2. Phase 23 fixed this for the Brand catalog
    // thumbnail but the three PRODUCT surfaces still cropped: provider images
    // (Commerce7 wine bottle shots especially) are not square, and
    // `object-cover` cut the top and base off a tall bottle. Each canvas keeps
    // its fixed footprint; only the fit changed.
    for (const file of [
      SHOP_CLIENT,
      LESSON_CLIENT,
      "src/app/(withSidebar)/dashboard/brand/campaigns/[id]/products/page.tsx",
    ]) {
      const executable = executableSource(read(file));
      assert.match(executable, /object-contain/, `${file} should use object-contain`);
      assert.doesNotMatch(
        executable,
        /object-cover/,
        `${file} must not crop provider product images`,
      );
    }
  });

  test("the raw merchant productUrl is still never opened directly", () => {
    // Non-regression: bypassing the click hop would skip the storefront gate,
    // the campaign-scope check AND attribution.
    for (const file of [SHOP_CLIENT, LESSON_CLIENT]) {
      const executable = executableSource(read(file));
      assert.doesNotMatch(
        executable,
        /window\.open\(\s*(?:product|item)\.productUrl/,
        `${file} must not open the merchant URL directly`,
      );
    }
  });
});
