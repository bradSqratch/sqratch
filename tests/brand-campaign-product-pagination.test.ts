/**
 * tests/brand-campaign-product-pagination.test.ts
 *
 * THE BUG THIS PINS.
 *
 * `GET /api/brand/campaigns/[id]/commerce-products` answers
 *
 *     { data: { campaign, products }, meta: { hasNextPage, nextCursor, limit } }
 *
 * with `meta` OUTSIDE `data`. The campaign products page read it with
 * `fetchJson`, whose final statement is `return (json?.data ?? json) as T` —
 * so the value it received was only the inner `{ campaign, products }` and
 * `result.meta` was ALWAYS `undefined`.
 *
 * The page renders its pager as `{meta?.hasNextPage && meta.nextCursor && ...}`,
 * so "Load more products" NEVER rendered. With a page size of 50, a brand
 * whose eligible catalog exceeded 50 products could not reach — and therefore
 * could not assign to a campaign — any product past the first page. The data,
 * the cursor and the route were all correct; the envelope was being discarded
 * in the browser.
 *
 * The fix reads the FULL body with a plain `fetch` and validates both halves
 * through `parseCampaignProductEnvelope`, which is the same shape of fix
 * `parseOrderListEnvelope` already applies to the order list.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  isCampaignProductRow,
  parseCampaignProductEnvelope,
} from "../src/app/(withSidebar)/dashboard/brand/commerce/commerce-response-validation";

function executableSource(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\s\/\/\s.*$/gm, "");
}

const PAGE = "src/app/(withSidebar)/dashboard/brand/campaigns/[id]/products/page.tsx";
const ROUTE = "src/app/api/brand/campaigns/[id]/commerce-products/route.ts";

function read(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    brandCommerceProductId: "bcp_1",
    title: "Reserve Cabernet",
    description: null,
    imageUrl: null,
    isVisibleInShop: true,
    isCampaignEligible: true,
    isAvailable: true,
    hasPublicStorefrontUrl: true,
    assignment: null,
    ...overrides,
  };
}

function envelope(overrides: { data?: unknown; meta?: unknown } = {}) {
  return {
    data:
      overrides.data !== undefined
        ? overrides.data
        : { campaign: { id: "camp_1", name: "Spring" }, products: [row()] },
    meta:
      overrides.meta !== undefined
        ? overrides.meta
        : { hasNextPage: true, nextCursor: "Y3Vyc29y", limit: 50 },
  };
}

// ===========================================================================
describe("THE REGRESSION: meta survives the envelope", () => {
  test("meta is read from the FULL body, not from the fetchJson-unwrapped data", () => {
    const parsed = parseCampaignProductEnvelope(envelope());
    assert.ok(parsed);
    assert.equal(parsed.meta.hasNextPage, true);
    assert.equal(parsed.meta.nextCursor, "Y3Vyc29y");
    assert.equal(parsed.meta.limit, 50);
  });

  test("REPRODUCTION: the old fetchJson unwrapping loses meta entirely", () => {
    // This is precisely what `fetchJson` returned, and why the pager vanished.
    const body = envelope();
    const whatFetchJsonReturned = (body as { data?: unknown }).data ?? body;
    assert.equal(
      (whatFetchJsonReturned as Record<string, unknown>).meta,
      undefined,
      "the unwrapped value must not carry meta — this is the bug being pinned",
    );
    // ...whereas the envelope parser, given the same body, keeps it.
    assert.equal(parseCampaignProductEnvelope(body)?.meta.hasNextPage, true);
  });

  test("a last page reports hasNextPage false with a null cursor", () => {
    const parsed = parseCampaignProductEnvelope(
      envelope({ meta: { hasNextPage: false, nextCursor: null, limit: 50 } }),
    );
    assert.ok(parsed);
    assert.equal(parsed.meta.hasNextPage, false);
    assert.equal(parsed.meta.nextCursor, null);
  });

  test("an empty-string cursor normalizes to null rather than a falsy cursor value", () => {
    const parsed = parseCampaignProductEnvelope(
      envelope({ meta: { hasNextPage: true, nextCursor: "", limit: 50 } }),
    );
    assert.equal(parsed?.meta.nextCursor, null);
  });
});

// ===========================================================================
describe("campaign product envelope — malformed responses", () => {
  test("a missing meta block is rejected, never defaulted to 'no more pages'", () => {
    // Defaulting would silently reintroduce the original bug: an unreachable
    // second page that the UI confidently claims does not exist.
    assert.equal(parseCampaignProductEnvelope({ data: envelope().data }), null);
    assert.equal(parseCampaignProductEnvelope(envelope({ meta: null })), null);
    assert.equal(parseCampaignProductEnvelope(envelope({ meta: {} })), null);
  });

  test("a non-boolean hasNextPage is rejected rather than coerced", () => {
    for (const bad of ["true", 1, null, undefined]) {
      assert.equal(
        parseCampaignProductEnvelope(
          envelope({ meta: { hasNextPage: bad, nextCursor: null, limit: 50 } }),
        ),
        null,
      );
    }
  });

  test("an invalid limit is rejected", () => {
    for (const bad of [0, -1, 1.5, "50", null]) {
      assert.equal(
        parseCampaignProductEnvelope(
          envelope({ meta: { hasNextPage: false, nextCursor: null, limit: bad } }),
        ),
        null,
      );
    }
  });

  test("a missing products array is rejected", () => {
    assert.equal(
      parseCampaignProductEnvelope(
        envelope({ data: { campaign: { id: "c", name: "n" } } }),
      ),
      null,
    );
  });

  test("an EMPTY product list is valid and distinct from malformed", () => {
    const parsed = parseCampaignProductEnvelope(
      envelope({ data: { campaign: { id: "c", name: "n" }, products: [] } }),
    );
    assert.ok(parsed);
    assert.deepEqual(parsed.products, []);
  });

  test("one malformed row invalidates the page", () => {
    assert.equal(
      parseCampaignProductEnvelope(
        envelope({
          data: { campaign: { id: "c", name: "n" }, products: [row(), { title: "x" }] },
        }),
      ),
      null,
    );
  });

  test("more rows than the route's own MAX_PAGE_SIZE is rejected", () => {
    const products = Array.from({ length: 101 }, (_, i) =>
      row({ brandCommerceProductId: `bcp_${i}` }),
    );
    assert.equal(
      parseCampaignProductEnvelope(
        envelope({ data: { campaign: { id: "c", name: "n" }, products } }),
      ),
      null,
    );
  });

  test("non-object bodies are rejected without throwing", () => {
    for (const body of [null, undefined, "x", 5, [], true]) {
      assert.equal(parseCampaignProductEnvelope(body), null);
    }
  });
});

// ===========================================================================
describe("campaign product rows — eligibility booleans are never coerced", () => {
  test("all four eligibility booleans are required", () => {
    // Each drives a DIFFERENT explanation of why a product is or is not
    // publicly purchasable; a coerced default would state the wrong reason.
    for (const key of [
      "isVisibleInShop",
      "isCampaignEligible",
      "isAvailable",
      "hasPublicStorefrontUrl",
    ]) {
      assert.equal(
        isCampaignProductRow(row({ [key]: undefined })),
        false,
        `${key} must be required`,
      );
      assert.equal(
        isCampaignProductRow(row({ [key]: "true" })),
        false,
        `${key} must not accept a string`,
      );
    }
  });

  test("a valid row with no assignment is accepted", () => {
    assert.equal(isCampaignProductRow(row({ assignment: null })), true);
  });

  test("a valid assignment is accepted; a malformed one is not", () => {
    assert.equal(
      isCampaignProductRow(
        row({ assignment: { id: "cma_1", isActive: true, displayOrder: 0 } }),
      ),
      true,
    );
    assert.equal(
      isCampaignProductRow(row({ assignment: { id: "cma_1", isActive: "yes", displayOrder: 0 } })),
      false,
    );
    assert.equal(
      isCampaignProductRow(row({ assignment: { isActive: true, displayOrder: 0 } })),
      false,
    );
  });

  test("a row without its product id is rejected", () => {
    assert.equal(isCampaignProductRow(row({ brandCommerceProductId: "" })), false);
    assert.equal(isCampaignProductRow(row({ brandCommerceProductId: undefined })), false);
  });
});

// ===========================================================================
describe("WIRING — the page actually consumes the envelope", () => {
  const page = read(PAGE);
  const executable = executableSource(page);

  test("the page no longer reads this endpoint through fetchJson", () => {
    // `fetchJson` is what discarded `meta`. It may still be used for the
    // POST/PATCH/DELETE mutations, which return no meta — this asserts only
    // that the LIST read no longer goes through it.
    assert.doesNotMatch(executable, /fetchJson<[^>]*meta[^>]*>/);
    assert.doesNotMatch(executable, /fetchJson[^\n]*commerce-products\?/);
  });

  test("the page parses the full envelope", () => {
    assert.match(page, /parseCampaignProductEnvelope\(/);
    assert.match(executable, /await fetch\(/);
    assert.match(executable, /setMeta\(parsed\.meta\)/);
  });

  test("the pager is still rendered from meta (the control that was dead)", () => {
    assert.match(page, /meta\?\.hasNextPage/);
    assert.match(page, /Load more products/);
  });

  test("a superseded search response cannot repopulate the list", () => {
    // Typing fires overlapping requests; a slow earlier one must not land
    // after a fast later one.
    assert.match(executable, /requestSeq/);
    assert.match(executable, /seq !== requestSeq\.current/);
  });

  test("the page does not re-declare the shape it renders", () => {
    assert.match(page, /type ProductRow = CampaignProductRow;/);
  });

  test("the campaign id is encoded into the request path", () => {
    assert.match(executable, /encodeURIComponent\(campaignId\)/);
  });

  test("catalog search is debounced — not one query per keystroke", () => {
    // ADVERSARIAL REVIEW ROUND 2. `load`'s identity changes with `query`, and
    // the search box is live-typed, so every character previously issued its
    // own `contains` scan over the brand's catalog.
    assert.match(executable, /SEARCH_DEBOUNCE_MS/);
    assert.match(executable, /setTimeout\(/);
    assert.match(executable, /clearTimeout\(/);
  });

  test("an empty query loads immediately — the debounce never delays first paint", () => {
    assert.match(executable, /if \(!query\.trim\(\)\) \{\s*void load\(\);/);
  });

  test("the debounce interval stays in a sane range", () => {
    const match = read(PAGE).match(/const SEARCH_DEBOUNCE_MS = (\d+);/);
    assert.ok(match, "SEARCH_DEBOUNCE_MS must be declared as a literal");
    const ms = Number(match[1]);
    assert.ok(ms >= 150 && ms <= 600, `debounce of ${ms}ms is outside a usable range`);
  });
});

// ===========================================================================
describe("NON-REGRESSION — the route's own contract is unchanged", () => {
  const route = read(ROUTE);

  test("the route still answers meta OUTSIDE data (the client adapted, not the API)", () => {
    // Deliberately NOT 'fixed' by moving meta inside data: that would change a
    // server contract other callers may rely on, to paper over a client bug.
    assert.match(route, /meta: \{/);
    assert.match(route, /hasNextPage,/);
  });

  test("cursor pagination is preserved — no offset/skip crept in", () => {
    const executable = executableSource(route);
    assert.match(executable, /encodeCursor\(/);
    assert.doesNotMatch(executable, /\bskip[:=]/);
  });

  test("brand identity still comes from the authenticated context", () => {
    assert.doesNotMatch(
      executableSource(route),
      /searchParams\.get\("brandId"\)|body\.brandId/,
    );
  });
});
