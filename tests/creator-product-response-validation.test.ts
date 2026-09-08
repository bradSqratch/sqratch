/**
 * tests/creator-product-response-validation.test.ts
 *
 * PHASE 29 — runtime validation for the Creator's product-attachment picker
 * response (`GET /api/creator/lessons/[lessonId]/available-products`).
 *
 * THE DEFECT UNDER TEST: `lesson-product-links-section.tsx` read this
 * endpoint as `fetchJson<AvailableLessonProductsResponse>(...)` — a bare
 * compile-time cast — then did `available.items.filter(...)` and
 * `available.items.length`. A body missing `items` would have thrown,
 * exactly like the public shop's pre-hardening crash. These tests pin the
 * parser AND the wiring, because a correct parser that nothing calls fixes
 * nothing.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  parseCreatorAvailableProducts,
} from "../src/lib/commerce/creator-product-response";

function executableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/\s.*$/gm, "");
}

const CLIENT = "src/components/creator/lesson-product-links-section.tsx";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: "catalog-1",
    catalogProductId: "bcp_abc123",
    title: "Reserve Cabernet",
    handle: "reserve-cabernet",
    productUrl: "https://acme.test/products/reserve",
    images: ["https://cdn.test/a.jpg"],
    imageUrl: "https://cdn.test/a.jpg",
    priceRange: { min: null, max: null },
    priceText: "$49.00",
    currency: "USD",
    variantIds: [],
    ...overrides,
  };
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    brand: { id: "brand-1", name: "Acme", slug: "acme" },
    candidateBrandCount: 1,
    connected: true,
    items: [product()],
    hasMore: false,
    ...overrides,
  };
}

// ===========================================================================
describe("PARSE — malformed API response", () => {
  test("THE CRASH CASE: a body with no `items` key is rejected, not cast", () => {
    const parsed = parseCreatorAvailableProducts({
      brand: null,
      candidateBrandCount: 0,
      connected: false,
    });
    assert.equal(parsed, null);
  });

  test("`items: null` and a non-array `items` are both rejected", () => {
    assert.equal(parseCreatorAvailableProducts(payload({ items: null })), null);
    assert.equal(parseCreatorAvailableProducts(payload({ items: {} })), null);
    assert.equal(parseCreatorAvailableProducts(payload({ items: "many" })), null);
  });

  test("non-object bodies are rejected without throwing", () => {
    for (const body of [null, undefined, 0, "", "text", [], true, NaN]) {
      assert.equal(parseCreatorAvailableProducts(body), null);
    }
  });

  test("an EMPTY picker is valid and is NOT confused with malformed", () => {
    const parsed = parseCreatorAvailableProducts(payload({ items: [] }));
    assert.ok(parsed);
    assert.deepEqual(parsed.items, []);
  });

  test("one malformed row invalidates the whole page rather than silently vanishing", () => {
    assert.equal(
      parseCreatorAvailableProducts(payload({ items: [product(), { title: "broken" }] })),
      null,
    );
  });

  test("a valid response round-trips its fields unchanged", () => {
    const parsed = parseCreatorAvailableProducts(payload());
    assert.ok(parsed);
    assert.equal(parsed.brand?.name, "Acme");
    assert.equal(parsed.items[0].title, "Reserve Cabernet");
    assert.equal(parsed.items[0].priceText, "$49.00");
  });
});

// ===========================================================================
describe("PARSE — hasMore is honest, never coerced or defaulted to hide truncation", () => {
  test("hasMore: true survives parsing", () => {
    const parsed = parseCreatorAvailableProducts(payload({ hasMore: true }));
    assert.equal(parsed?.hasMore, true);
  });

  test("an absent hasMore (older server response) reads as false, not malformed", () => {
    const body = payload();
    delete (body as Record<string, unknown>).hasMore;
    const parsed = parseCreatorAvailableProducts(body);
    assert.ok(parsed);
    assert.equal(parsed.hasMore, false);
  });

  test("a non-boolean hasMore is rejected rather than coerced", () => {
    assert.equal(parseCreatorAvailableProducts(payload({ hasMore: "true" })), null);
    assert.equal(parseCreatorAvailableProducts(payload({ hasMore: 1 })), null);
  });
});

// ===========================================================================
describe("PARSE — product rows", () => {
  test("a missing catalogProductId is rejected — it is the only value ever sent when attaching", () => {
    assert.equal(
      parseCreatorAvailableProducts(payload({ items: [product({ catalogProductId: "" })] })),
      null,
    );
    assert.equal(
      parseCreatorAvailableProducts(payload({ items: [product({ catalogProductId: undefined })] })),
      null,
    );
  });

  test("nullable presentation fields accept null but reject wrong types", () => {
    assert.ok(parseCreatorAvailableProducts(payload({ items: [product({ imageUrl: null, priceText: null })] })));
    assert.equal(
      parseCreatorAvailableProducts(payload({ items: [product({ imageUrl: 42 })] })),
      null,
    );
  });

  test("a numeric priceRange.min/max is accepted; a non-numeric one is rejected", () => {
    assert.ok(
      parseCreatorAvailableProducts(
        payload({ items: [product({ priceRange: { min: 1000, max: 2000 } })] }),
      ),
    );
    assert.equal(
      parseCreatorAvailableProducts(
        payload({ items: [product({ priceRange: { min: "1000", max: null } })] }),
      ),
      null,
    );
  });

  test("images/variantIds must be string arrays", () => {
    assert.equal(
      parseCreatorAvailableProducts(payload({ items: [product({ images: [1, 2] })] })),
      null,
    );
    assert.equal(
      parseCreatorAvailableProducts(payload({ items: [product({ variantIds: "not-an-array" })] })),
      null,
    );
  });
});

// ===========================================================================
describe("PARSE — curation/campaign selector", () => {
  test("curation is optional; when present it is fully validated", () => {
    const parsed = parseCreatorAvailableProducts(
      payload({
        curation: {
          enabled: true,
          requiresCampaignSelection: true,
          campaigns: [{ id: "camp-1", name: "Spring", brandId: "brand-1", brandName: "Acme" }],
        },
      }),
    );
    assert.ok(parsed?.curation);
    assert.equal(parsed.curation.campaigns[0].name, "Spring");
  });

  test("a malformed campaign option invalidates the whole payload", () => {
    assert.equal(
      parseCreatorAvailableProducts(
        payload({
          curation: {
            enabled: true,
            requiresCampaignSelection: true,
            campaigns: [{ name: "Spring" }],
          },
        }),
      ),
      null,
    );
  });

  test("a non-string campaignId when present is rejected", () => {
    assert.equal(
      parseCreatorAvailableProducts(
        payload({
          curation: { enabled: true, requiresCampaignSelection: false, campaigns: [], campaignId: 5 },
        }),
      ),
      null,
    );
  });
});

// ===========================================================================
describe("WIRING — the client actually validates instead of casting", () => {
  test("the client validates instead of casting", () => {
    const source = read(CLIENT);
    assert.match(source, /parseCreatorAvailableProducts\(/);
    assert.doesNotMatch(
      executableSource(source),
      /fetchJson<AvailableLessonProductsResponse>/,
    );
  });

  test("the client distinguishes malformed from empty", () => {
    const source = read(CLIENT);
    assert.match(source, /if \(!result\)/);
    assert.match(source, /setPickerError\(/);
  });

  test("the client does not re-declare the response shape it renders", () => {
    const source = read(CLIENT);
    assert.match(source, /type AvailableLessonProductsResponse = CreatorAvailableProductsPayload;/);
  });

  test("a truncated catalog is surfaced honestly to the operator", () => {
    const executable = executableSource(read(CLIENT));
    assert.match(executable, /available\?\.hasMore/);
  });

  test("product images use object-contain, never object-cover (the bottle-crop bug)", () => {
    const executable = executableSource(read(CLIENT));
    assert.match(executable, /object-contain/, "should use object-contain");
    assert.doesNotMatch(executable, /object-cover/, "must not crop provider product images");
  });
});
