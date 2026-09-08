/**
 * tests/public-shop-pagination.test.ts
 *
 * Pure, DB-free tests for the block-aware keyset orchestration in
 * `src/lib/commerce/public-shop-pagination.ts`. These exercise
 * `resolvePublicShopPage` directly against injected fake block fetchers —
 * no route, no Prisma, no HTTP — so the hardest part of PHASE 29 (walking
 * blocks, proving `hasNextPage`, computing the resume cursor) is verified in
 * isolation from the DB-query plumbing tested separately in
 * `public-experience-product-catalog.test.ts` and
 * `public-shop-pagination-live.test.ts`.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  clampPublicShopLimit,
  decodePublicShopCursor,
  encodePublicShopCursor,
  resolvePublicShopPage,
  type PublicShopBlockCursor,
  type PublicShopPageRow,
} from "../src/lib/commerce/public-shop-pagination";

/** One in-memory "block" of items, pre-sorted the way a real query would be. */
function block(items: Array<{ displayOrder: number; sortKey: string; catalogId: string }>) {
  return items
    .slice()
    .sort(
      (a, b) =>
        a.displayOrder - b.displayOrder ||
        a.sortKey.localeCompare(b.sortKey) ||
        a.catalogId.localeCompare(b.catalogId),
    );
}

function fetcherFor(blocks: ReturnType<typeof block>[]) {
  let calls = 0;
  const callLog: Array<{ blockIndex: number; cursor: PublicShopBlockCursor | null; limit: number }> = [];
  return {
    calls: () => calls,
    callLog,
    blockCount: blocks.length,
    async fetchBlockPage(blockIndex: number, cursor: PublicShopBlockCursor | null, limit: number) {
      calls++;
      callLog.push({ blockIndex, cursor, limit });
      const rows = blocks[blockIndex] ?? [];
      const after = cursor
        ? rows.filter(
            (r) =>
              r.displayOrder > cursor.displayOrder ||
              (r.displayOrder === cursor.displayOrder && r.sortKey > cursor.sortKey) ||
              (r.displayOrder === cursor.displayOrder &&
                r.sortKey === cursor.sortKey &&
                r.catalogId > cursor.catalogId),
          )
        : rows;
      return after.slice(0, limit).map(
        (r): PublicShopPageRow<string> => ({
          displayOrder: r.displayOrder,
          sortKey: r.sortKey,
          catalogId: r.catalogId,
          item: r.catalogId,
        }),
      );
    },
  };
}

function item(i: number, o = 0) {
  return { displayOrder: o, sortKey: `p${String(i).padStart(3, "0")}`, catalogId: `id-${i}` };
}

describe("resolvePublicShopPage — single block", () => {
  test("0 items: empty page, no next", async () => {
    const deps = fetcherFor([block([])]);
    const page = await resolvePublicShopPage({ cursor: null, limit: 10 }, deps);
    assert.deepEqual(page.items, []);
    assert.equal(page.hasNextPage, false);
    assert.equal(page.nextCursor, null);
  });

  test("1 item, limit 10: full page, no next", async () => {
    const deps = fetcherFor([block([item(1)])]);
    const page = await resolvePublicShopPage({ cursor: null, limit: 10 }, deps);
    assert.deepEqual(page.items, ["id-1"]);
    assert.equal(page.hasNextPage, false);
  });

  test("exactly `limit` items with nothing after: no next page (no false positive)", async () => {
    const items = Array.from({ length: 10 }, (_, i) => item(i));
    const deps = fetcherFor([block(items)]);
    const page = await resolvePublicShopPage({ cursor: null, limit: 10 }, deps);
    assert.equal(page.items.length, 10);
    assert.equal(page.hasNextPage, false);
    assert.equal(page.nextCursor, null);
  });

  test("limit - 1 items: fewer than a page, no next", async () => {
    const items = Array.from({ length: 9 }, (_, i) => item(i));
    const deps = fetcherFor([block(items)]);
    const page = await resolvePublicShopPage({ cursor: null, limit: 10 }, deps);
    assert.equal(page.items.length, 9);
    assert.equal(page.hasNextPage, false);
  });

  test("limit + 1 items: exactly one page filled, hasNextPage true, cursor resumes at the right row", async () => {
    const items = Array.from({ length: 11 }, (_, i) => item(i));
    const deps = fetcherFor([block(items)]);
    const page = await resolvePublicShopPage({ cursor: null, limit: 10 }, deps);
    assert.equal(page.items.length, 10);
    assert.equal(page.hasNextPage, true);
    assert.ok(page.nextCursor);
    assert.equal(page.nextCursor!.catalogId, "id-9");

    const page2 = await resolvePublicShopPage({ cursor: page.nextCursor, limit: 10 }, deps);
    assert.deepEqual(page2.items, ["id-10"]);
    assert.equal(page2.hasNextPage, false);
  });

  test("50 items over pages of 24 (the real default limit): no duplicates, no missing rows", async () => {
    const items = Array.from({ length: 50 }, (_, i) => item(i));
    const deps = fetcherFor([block(items)]);
    const seen: string[] = [];
    let cursor: PublicShopBlockCursor | null = null;
    let guard = 0;
    while (guard++ < 20) {
      const page: Awaited<ReturnType<typeof resolvePublicShopPage<string>>> = await resolvePublicShopPage({ cursor, limit: 24 }, deps);
      seen.push(...page.items);
      if (!page.hasNextPage) break;
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, 50);
    assert.deepEqual(seen, Array.from(new Set(seen)), "no duplicates across pages");
    assert.deepEqual(
      seen,
      items.map((i) => i.catalogId),
      "stable ordering preserved end to end",
    );
  });

  test("51 items: an odd remainder page terminates cleanly", async () => {
    const items = Array.from({ length: 51 }, (_, i) => item(i));
    const deps = fetcherFor([block(items)]);
    const seen: string[] = [];
    let cursor: PublicShopBlockCursor | null = null;
    let guard = 0;
    while (guard++ < 20) {
      const page: Awaited<ReturnType<typeof resolvePublicShopPage<string>>> = await resolvePublicShopPage({ cursor, limit: 24 }, deps);
      seen.push(...page.items);
      if (!page.hasNextPage) break;
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, 51);
  });

  test("101 items over the max limit (60): multiple pages, complete coverage", async () => {
    const items = Array.from({ length: 101 }, (_, i) => item(i));
    const deps = fetcherFor([block(items)]);
    const seen: string[] = [];
    let cursor: PublicShopBlockCursor | null = null;
    let pages = 0;
    let guard = 0;
    while (guard++ < 20) {
      const page: Awaited<ReturnType<typeof resolvePublicShopPage<string>>> = await resolvePublicShopPage({ cursor, limit: 60 }, deps);
      pages++;
      seen.push(...page.items);
      if (!page.hasNextPage) break;
      cursor = page.nextCursor;
    }
    assert.equal(seen.length, 101);
    assert.ok(pages >= 2, "101 items over a 60 cap must take at least 2 pages");
  });
});

describe("resolvePublicShopPage — multiple blocks (campaign + storefront union)", () => {
  test("a page filled exactly at a block boundary correctly probes forward for hasNextPage", async () => {
    // Block 0 has exactly `limit` items; block 1 has one more. Without the
    // forward probe this would wrongly report hasNextPage=false.
    const deps = fetcherFor([block([item(1), item(2)]), block([item(3)])]);
    const page = await resolvePublicShopPage({ cursor: null, limit: 2 }, deps);
    assert.deepEqual(page.items, ["id-1", "id-2"]);
    assert.equal(page.hasNextPage, true);
    assert.equal(page.nextCursor?.blockIndex, 0, "cursor still points at the exhausted block index it ended on... ");
  });

  test("...and the NEXT page correctly starts block 1 from its own beginning", async () => {
    const deps = fetcherFor([block([item(1), item(2)]), block([item(3)])]);
    const page1 = await resolvePublicShopPage({ cursor: null, limit: 2 }, deps);
    const page2 = await resolvePublicShopPage({ cursor: page1.nextCursor, limit: 2 }, deps);
    assert.deepEqual(page2.items, ["id-3"]);
    assert.equal(page2.hasNextPage, false);
  });

  test("a page boundary that lands exactly at dataset end reports NO next page (peek finds nothing)", async () => {
    const deps = fetcherFor([block([item(1), item(2)])]);
    const page = await resolvePublicShopPage({ cursor: null, limit: 2 }, deps);
    assert.equal(page.hasNextPage, false);
    assert.equal(page.nextCursor, null);
  });

  test("an empty leading block is skipped transparently", async () => {
    const deps = fetcherFor([block([]), block([item(1)])]);
    const page = await resolvePublicShopPage({ cursor: null, limit: 10 }, deps);
    assert.deepEqual(page.items, ["id-1"]);
    assert.equal(page.hasNextPage, false);
  });

  test("a page spans two blocks in one request when the first is short", async () => {
    const deps = fetcherFor([block([item(1)]), block([item(2), item(3)])]);
    const page = await resolvePublicShopPage({ cursor: null, limit: 10 }, deps);
    assert.deepEqual(page.items, ["id-1", "id-2", "id-3"]);
    assert.equal(page.hasNextPage, false);
  });

  test("resuming mid-block-1 does not re-walk block 0", async () => {
    const deps = fetcherFor([block([item(1)]), block([item(2), item(3), item(4)])]);
    const page1 = await resolvePublicShopPage({ cursor: null, limit: 2 }, deps);
    assert.deepEqual(page1.items, ["id-1", "id-2"]);
    assert.equal(page1.nextCursor?.blockIndex, 1);

    const page2 = await resolvePublicShopPage({ cursor: page1.nextCursor, limit: 2 }, deps);
    assert.deepEqual(page2.items, ["id-3", "id-4"]);
    // Block 0 must not have been re-fetched on the resumed page.
    assert.equal(
      deps.callLog.some((call, idx) => idx >= 2 && call.blockIndex === 0),
      false,
    );
  });

  test("full multi-block traversal: no duplicates, no missing rows, stable order preserved", async () => {
    const blocks = [
      block(Array.from({ length: 7 }, (_, i) => item(i))),
      block(Array.from({ length: 5 }, (_, i) => item(100 + i))),
      block(Array.from({ length: 3 }, (_, i) => item(200 + i))),
    ];
    const deps = fetcherFor(blocks);
    const expected = blocks.flat().map((r) => r.catalogId);

    const seen: string[] = [];
    let cursor: PublicShopBlockCursor | null = null;
    let guard = 0;
    while (guard++ < 20) {
      const page: Awaited<ReturnType<typeof resolvePublicShopPage<string>>> = await resolvePublicShopPage({ cursor, limit: 3 }, deps);
      seen.push(...page.items);
      if (!page.hasNextPage) break;
      cursor = page.nextCursor;
    }
    assert.deepEqual(seen, expected);
    assert.deepEqual(seen, Array.from(new Set(seen)), "no duplicates across the full traversal");
  });
});

describe("resolvePublicShopPage — dataset changed between page loads", () => {
  test("a cursor pointing at a block index that no longer exists ends the page gracefully, not with an error", async () => {
    const deps = fetcherFor([block([item(1)])]); // only 1 block now
    const staleCursor: PublicShopBlockCursor = {
      blockIndex: 5, // used to exist; the operator removed campaigns since
      displayOrder: 0,
      sortKey: "p000",
      catalogId: "id-0",
    };
    const page = await resolvePublicShopPage({ cursor: staleCursor, limit: 10 }, deps);
    assert.deepEqual(page.items, []);
    assert.equal(page.hasNextPage, false);
    assert.equal(page.nextCursor, null);
  });

  test("a negative blockIndex (should never occur, but must not crash) is clamped to the start", async () => {
    const deps = fetcherFor([block([item(1)])]);
    const weirdCursor = { blockIndex: -1, displayOrder: 0, sortKey: "", catalogId: "x" };
    const page = await resolvePublicShopPage({ cursor: weirdCursor, limit: 10 }, deps);
    assert.deepEqual(page.items, ["id-1"]);
  });
});

describe("cursor encode/decode", () => {
  test("round-trips exactly", () => {
    const cursor: PublicShopBlockCursor = {
      blockIndex: 2,
      displayOrder: 7,
      sortKey: "Reserve Cabernet",
      catalogId: "bcp_abc123",
    };
    const decoded = decodePublicShopCursor(encodePublicShopCursor(cursor));
    assert.deepEqual(decoded, cursor);
  });

  test("a null/empty raw cursor decodes to null (start from the top), never throws", () => {
    assert.equal(decodePublicShopCursor(null), null);
    assert.equal(decodePublicShopCursor(""), null);
  });

  test("garbage input decodes to null rather than throwing", () => {
    for (const garbage of [
      "not-base64url-json!!!",
      Buffer.from("null", "utf8").toString("base64url"),
      Buffer.from("42", "utf8").toString("base64url"),
      Buffer.from("[]", "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ blockIndex: -1 }), "utf8").toString("base64url"),
      Buffer.from(JSON.stringify({ blockIndex: 1.5, displayOrder: 0, sortKey: "a", catalogId: "b" }), "utf8").toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ blockIndex: 0, displayOrder: "nope", sortKey: "a", catalogId: "b" }), "utf8").toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ blockIndex: 0, displayOrder: 0, sortKey: 5, catalogId: "b" }), "utf8").toString(
        "base64url",
      ),
      Buffer.from(JSON.stringify({ blockIndex: 0, displayOrder: 0, sortKey: "a", catalogId: "" }), "utf8").toString(
        "base64url",
      ),
    ]) {
      assert.equal(decodePublicShopCursor(garbage), null, `expected null for ${garbage}`);
    }
  });

  test("a valid cursor with displayOrder 0 (falsy but valid) decodes correctly — not treated as missing", () => {
    const cursor: PublicShopBlockCursor = { blockIndex: 0, displayOrder: 0, sortKey: "a", catalogId: "b" };
    assert.deepEqual(decodePublicShopCursor(encodePublicShopCursor(cursor)), cursor);
  });
});

describe("clampPublicShopLimit", () => {
  test("null/absent defaults", () => {
    assert.equal(clampPublicShopLimit(null), 24);
  });

  test("clamps to the maximum", () => {
    assert.equal(clampPublicShopLimit("9999"), 60);
  });

  test("rejects non-positive or non-numeric input with the default", () => {
    for (const bad of ["0", "-5", "abc", ""]) {
      assert.equal(clampPublicShopLimit(bad), 24);
    }
  });

  test("accepts an in-range value exactly", () => {
    assert.equal(clampPublicShopLimit("40"), 40);
  });
});
