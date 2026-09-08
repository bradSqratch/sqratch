/**
 * tests/brand-commerce-order-activity.test.ts
 *
 * PHASE C — order-ingestion activity: authorization, tenant/connection
 * isolation, webhook-vs-reconciliation classification, the
 * history-vs-current-state distinction, bounded querying, and the
 * sanitization boundary (no payload digests, no credentials, no PII).
 *
 * The service and route are driven through their REAL implementations with
 * injected data access — no database, no network.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommerceProvider } from "@prisma/client";

import {
  getBrandCommerceOrderActivity,
  clampOrderActivityLimit,
  decodeOrderActivityCursor,
  encodeOrderActivityCursor,
  DEFAULT_ORDER_ACTIVITY_LIMIT,
  MAX_ORDER_ACTIVITY_LIMIT,
  type BrandCommerceOrderActivityDeps,
  type OrderActivityRow,
} from "../src/lib/commerce/order-activity";
import {
  classifyOrderEventTopic,
  isOrderReconciliationEventTopic,
  isOrderWebhookEventTopic,
} from "../src/lib/commerce/order-operations-summary";
import { brandCommerceOrderActivityGetImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/orders/activity/route";
import { parseOrderActivityPage } from "../src/app/(withSidebar)/dashboard/brand/commerce/commerce-response-validation";
import type { BrandAdminContext } from "../src/lib/brand-auth";

function makeContext(brandId = "brand-a"): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [{ id: brandId, name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
    membership: {
      id: "member-1",
      role: "ADMIN",
      brand: { id: brandId, name: "Acme", slug: "acme", bio: null, websiteUrl: null, logoUrl: null, coverImageUrl: null },
    },
  };
}

function eventRow(overrides: Partial<OrderActivityRow> = {}): OrderActivityRow {
  return {
    id: "evt-1",
    provider: CommerceProvider.COMMERCE7,
    topic: "commerce7:order:Update",
    status: "PROCESSED",
    receivedAt: new Date("2026-08-26T18:12:00.000Z"),
    processedAt: new Date("2026-08-26T18:12:01.000Z"),
    providerUpdatedAt: new Date("2026-08-26T18:11:55.847Z"),
    externalOrderRef: "c93ea68d-ee3e-43da-897b-3d28e8da1ec8",
    failureSummary: null,
    order: { id: "order-row-1", orderNumber: "1002" },
    ...overrides,
  };
}

function depsWith(rows: OrderActivityRow[], overrides: Partial<BrandCommerceOrderActivityDeps> = {}) {
  return {
    loadConnection: async () => ({ id: "conn-1", provider: CommerceProvider.COMMERCE7 }),
    findEvents: async () => rows,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Topic classification — reuses the SINGLE shared contract
// ---------------------------------------------------------------------------

describe("PHASE C — event classification reuses the one shared topic contract", () => {
  test("Commerce7 Create/Update are genuine webhooks", () => {
    assert.equal(classifyOrderEventTopic(CommerceProvider.COMMERCE7, "commerce7:order:Create"), "WEBHOOK");
    assert.equal(classifyOrderEventTopic(CommerceProvider.COMMERCE7, "commerce7:order:Update"), "WEBHOOK");
  });

  test("commerce7:order:backfill is RECONCILIATION, never a webhook", () => {
    assert.equal(
      classifyOrderEventTopic(CommerceProvider.COMMERCE7, "commerce7:order:backfill"),
      "RECONCILIATION",
    );
    assert.equal(isOrderWebhookEventTopic(CommerceProvider.COMMERCE7, "commerce7:order:backfill"), false);
    assert.equal(
      isOrderReconciliationEventTopic(CommerceProvider.COMMERCE7, "commerce7:order:backfill"),
      true,
    );
  });

  test("Shopify genuine order/refund webhook topics are unchanged and all classify as WEBHOOK", () => {
    for (const topic of ["orders/create", "orders/updated", "order_transactions/create", "refunds/create"]) {
      assert.equal(classifyOrderEventTopic(CommerceProvider.SHOPIFY, topic), "WEBHOOK", topic);
    }
  });

  test("an unknown/future topic FAILS CLOSED — never optimistically called a webhook", () => {
    assert.equal(classifyOrderEventTopic(CommerceProvider.COMMERCE7, "commerce7:order:futureThing"), "OTHER");
    assert.equal(classifyOrderEventTopic(CommerceProvider.SHOPIFY, "orders/some_new_topic"), "OTHER");
    assert.equal(isOrderWebhookEventTopic(CommerceProvider.SHOPIFY, "orders/some_new_topic"), false);
  });

  test("a Shopify reconciliation topic list exists but is empty rather than guessed", () => {
    assert.equal(isOrderReconciliationEventTopic(CommerceProvider.SHOPIFY, "commerce7:order:backfill"), false);
    assert.equal(isOrderReconciliationEventTopic(CommerceProvider.SHOPIFY, "orders/create"), false);
  });

  test("the allow-list is NOT duplicated — order-activity.ts imports the shared classifier", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/commerce/order-activity.ts"), "utf8");
    assert.match(source, /classifyOrderEventTopic/);
    assert.match(source, /from "\.\/order-operations-summary"/);
    // No second copy of any topic literal.
    assert.doesNotMatch(source, /commerce7:order:Create/);
    assert.doesNotMatch(source, /orders\/updated/);
  });
});

// ---------------------------------------------------------------------------
// Authorization and isolation
// ---------------------------------------------------------------------------

describe("PHASE C — authorization and connection ownership", () => {
  test("an unauthenticated caller never reaches the data layer", async () => {
    let called = false;
    const res = await brandCommerceOrderActivityGetImpl(
      {
        getContext: async () => null,
        getActivity: async () => {
          called = true;
          return null;
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("brandId always comes from the authenticated context, never the request", async () => {
    let capturedBrandId: string | null = null;
    await brandCommerceOrderActivityGetImpl(
      {
        getContext: async () => makeContext("brand-a"),
        getActivity: async (input) => {
          capturedBrandId = input.brandId;
          return { entries: [], hasNextPage: false, nextCursor: null, limit: 25 };
        },
      },
      "conn-1",
    );
    assert.equal(capturedBrandId, "brand-a");
  });

  test("a foreign connection is a 404 — indistinguishable from a nonexistent one", async () => {
    const res = await brandCommerceOrderActivityGetImpl(
      { getContext: async () => makeContext(), getActivity: async () => null },
      "conn-of-another-brand",
    );
    assert.equal(res.status, 404);
    const body = await res.json();
    // The message must not reveal that the connection exists but is foreign.
    assert.match(body.error, /not found/i);
    assert.doesNotMatch(body.error, /permission|forbidden|another/i);
  });

  test("the service returns null (-> 404) when loadConnection rejects the brand+connection pair", async () => {
    const page = await getBrandCommerceOrderActivity(
      { connectionId: "conn-1", brandId: "brand-a", cursor: null, limit: 25 },
      { loadConnection: async () => null, findEvents: async () => [eventRow()] },
    );
    assert.equal(page, null);
  });

  test("the events query is scoped by BOTH connectionId and brandId", async () => {
    const captured: { connectionId: string; brandId: string }[] = [];
    await getBrandCommerceOrderActivity(
      { connectionId: "conn-1", brandId: "brand-a", cursor: null, limit: 25 },
      depsWith([], {
        findEvents: async (input) => {
          captured.push({ connectionId: input.connectionId, brandId: input.brandId });
          return [];
        },
      }),
    );
    assert.equal(captured.length, 1);
    assert.equal(captured[0].connectionId, "conn-1");
    assert.equal(captured[0].brandId, "brand-a");
  });

  test("a missing connectionId is a 400 before any lookup", async () => {
    let called = false;
    const res = await brandCommerceOrderActivityGetImpl(
      {
        getContext: async () => makeContext(),
        getActivity: async () => {
          called = true;
          return null;
        },
      },
      "   ",
    );
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });
});

// ---------------------------------------------------------------------------
// The real production history/current-state case
// ---------------------------------------------------------------------------

describe("PHASE C — history vs current state (the #1003 / #1002 case)", () => {
  test("a historical FAILED refund-child event and a later PROCESSED reconciliation BOTH appear, correctly classified", async () => {
    const page = await getBrandCommerceOrderActivity(
      { connectionId: "conn-1", brandId: "brand-a", cursor: null, limit: 25 },
      depsWith([
        // Newest first: the successful repair.
        eventRow({
          id: "evt-repair",
          topic: "commerce7:order:backfill",
          status: "PROCESSED",
          receivedAt: new Date("2026-08-27T10:00:00.000Z"),
          order: { id: "order-row-1002", orderNumber: "1002" },
        }),
        // The older failure, for the refund CHILD, which has no canonical order.
        eventRow({
          id: "evt-1003-failed",
          topic: "commerce7:order:Update",
          status: "FAILED",
          receivedAt: new Date("2026-08-26T18:12:00.000Z"),
          failureSummary: "CONTRADICTORY_FINANCIAL_SNAPSHOT",
          externalOrderRef: "57391df9-8d44-4295-a55d-a731d1e38782",
          order: null,
        }),
      ]),
    );

    assert.ok(page);
    assert.equal(page?.entries.length, 2);

    const repair = page?.entries[0];
    assert.equal(repair?.category, "RECONCILIATION", "a backfill is reconciliation, not a webhook");
    assert.equal(repair?.status, "PROCESSED");
    assert.equal(repair?.order?.orderNumber, "1002");

    const failure = page?.entries[1];
    assert.equal(failure?.category, "WEBHOOK");
    assert.equal(failure?.status, "FAILED");
    assert.equal(failure?.failureSummary, "CONTRADICTORY_FINANCIAL_SNAPSHOT");
    // The refund child never became a canonical order — a meaningful null.
    assert.equal(failure?.order, null);
    // ...but the provider reference is present so the operator can tell WHICH
    // provider document the failure concerned.
    assert.equal(failure?.externalOrderRef, "57391df9-8d44-4295-a55d-a731d1e38782");
  });

  test("the service reports history ONLY — it derives no health/is-broken verdict from event status", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/commerce/order-activity.ts"), "utf8");
    const executable = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [/\bhealthy\b/i, /\bisBroken\b/i, /\bhasErrors\b/i, /\boverallStatus\b/i]) {
      assert.doesNotMatch(executable, forbidden);
    }
  });

  test("SKIPPED_STALE is surfaced as its own distinct outcome, not folded into failure", async () => {
    const page = await getBrandCommerceOrderActivity(
      { connectionId: "conn-1", brandId: "brand-a", cursor: null, limit: 25 },
      depsWith([eventRow({ status: "SKIPPED_STALE", topic: "commerce7:order:backfill" })]),
    );
    assert.equal(page?.entries[0].status, "SKIPPED_STALE");
    assert.equal(page?.entries[0].category, "RECONCILIATION");
  });

  test("null timestamps are preserved as null, never fabricated", async () => {
    const page = await getBrandCommerceOrderActivity(
      { connectionId: "conn-1", brandId: "brand-a", cursor: null, limit: 25 },
      depsWith([eventRow({ processedAt: null, providerUpdatedAt: null, externalOrderRef: null })]),
    );
    assert.equal(page?.entries[0].processedAt, null);
    assert.equal(page?.entries[0].providerUpdatedAt, null);
    assert.equal(page?.entries[0].externalOrderRef, null);
  });

  test("an event is classified by its OWN provider, not the connection's", async () => {
    const page = await getBrandCommerceOrderActivity(
      { connectionId: "conn-1", brandId: "brand-a", cursor: null, limit: 25 },
      depsWith([eventRow({ provider: CommerceProvider.SHOPIFY, topic: "orders/updated" })]),
    );
    assert.equal(page?.entries[0].category, "WEBHOOK");
    assert.equal(page?.entries[0].provider, "SHOPIFY");
  });
});

// ---------------------------------------------------------------------------
// Bounded querying / pagination
// ---------------------------------------------------------------------------

describe("PHASE C — bounded querying", () => {
  test("limit is clamped, defaulted, and never unbounded", () => {
    assert.equal(clampOrderActivityLimit(null), DEFAULT_ORDER_ACTIVITY_LIMIT);
    assert.equal(clampOrderActivityLimit("0"), DEFAULT_ORDER_ACTIVITY_LIMIT);
    assert.equal(clampOrderActivityLimit("-5"), DEFAULT_ORDER_ACTIVITY_LIMIT);
    assert.equal(clampOrderActivityLimit("abc"), DEFAULT_ORDER_ACTIVITY_LIMIT);
    assert.equal(clampOrderActivityLimit("10"), 10);
    assert.equal(clampOrderActivityLimit("99999"), MAX_ORDER_ACTIVITY_LIMIT);
  });

  test("a full page reports hasNextPage and a cursor; the look-ahead row is never returned", async () => {
    const rows = Array.from({ length: 26 }, (_, i) =>
      eventRow({ id: `evt-${i}`, receivedAt: new Date(2026, 7, 26, 0, 0, i) }),
    );
    const page = await getBrandCommerceOrderActivity(
      { connectionId: "conn-1", brandId: "brand-a", cursor: null, limit: 25 },
      depsWith(rows),
    );
    assert.equal(page?.entries.length, 25);
    assert.equal(page?.hasNextPage, true);
    assert.ok(page?.nextCursor);
  });

  test("a short page reports no next page and a null cursor", async () => {
    const page = await getBrandCommerceOrderActivity(
      { connectionId: "conn-1", brandId: "brand-a", cursor: null, limit: 25 },
      depsWith([eventRow()]),
    );
    assert.equal(page?.hasNextPage, false);
    assert.equal(page?.nextCursor, null);
  });

  test("the query requests limit + 1 so hasNextPage needs no COUNT", async () => {
    let capturedLimit = -1;
    await getBrandCommerceOrderActivity(
      { connectionId: "conn-1", brandId: "brand-a", cursor: null, limit: 25 },
      depsWith([], {
        findEvents: async (input) => {
          capturedLimit = input.limit;
          return [];
        },
      }),
    );
    assert.equal(capturedLimit, 25);
  });

  test("the cursor round-trips and a malformed one is ignored rather than throwing", () => {
    const cursor = { receivedAt: "2026-08-26T18:12:00.000Z", id: "evt-1" };
    assert.deepEqual(decodeOrderActivityCursor(encodeOrderActivityCursor(cursor)), cursor);
    assert.equal(decodeOrderActivityCursor("!!!not-base64!!!"), null);
    assert.equal(decodeOrderActivityCursor(null), null);
    assert.equal(
      decodeOrderActivityCursor(Buffer.from(JSON.stringify({ receivedAt: "nope", id: "x" })).toString("base64url")),
      null,
    );
  });

  test("the cursor keyset is composed under AND, never object-spread (no future OR collision)", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/commerce/order-activity.ts"), "utf8");
    assert.match(source, /\.\.\.\(cursorWhere \? \{ AND: \[cursorWhere\] \} : \{\}\)/);
    // The fragile shape must not come back.
    assert.doesNotMatch(source, /brandId: input\.brandId, \.\.\.cursorWhere/);
  });

  test("the canonical order is joined in the SAME query — no N+1 per event", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/commerce/order-activity.ts"), "utf8");
    assert.match(source, /order: \{ select: \{ id: true, orderNumber: true \} \}/);
    // Exactly one event query and one connection lookup — no per-row fetch.
    assert.equal((source.match(/commerceOrderEvent\.findMany/g) ?? []).length, 1);
    assert.doesNotMatch(source, /for \(const .* of .*\) \{[\s\S]*?await prisma/);
  });
});

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

describe("PHASE C — sanitization boundary", () => {
  test("the DTO exposes no payloadDigest, providerEventId, credential, or PII field", async () => {
    const page = await getBrandCommerceOrderActivity(
      { connectionId: "conn-1", brandId: "brand-a", cursor: null, limit: 25 },
      depsWith([eventRow()]),
    );
    const serialized = JSON.stringify(page).toLowerCase();
    for (const forbidden of [
      "payloaddigest",
      "providereventid",
      "authorization",
      "password",
      "secret",
      "accesstoken",
      "providermetadata",
      "email",
      "phone",
      "address",
      "customer",
      "cardnumber",
    ]) {
      assert.ok(!serialized.includes(forbidden), `activity DTO must not contain "${forbidden}"`);
    }
  });

  test("forbidden columns are never even SELECTED — absent by construction, not filtered later", () => {
    const source = readFileSync(join(process.cwd(), "src/lib/commerce/order-activity.ts"), "utf8");
    const selectStart = source.indexOf("const ACTIVITY_SELECT");
    const selectBlock = source.slice(selectStart, source.indexOf("} as const;", selectStart));
    assert.doesNotMatch(selectBlock, /payloadDigest/);
    assert.doesNotMatch(selectBlock, /providerEventId/);
    assert.doesNotMatch(selectBlock, /providerMetadata/);
  });

  test("the route never leaks an internal error or stack trace to the client", async () => {
    const res = await brandCommerceOrderActivityGetImpl(
      {
        getContext: async () => makeContext(),
        getActivity: async () => {
          throw new Error("SENSITIVE-INTERNAL-DETAIL-abc123");
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 500);
    const body = JSON.stringify(await res.json());
    assert.ok(!body.includes("SENSITIVE-INTERNAL-DETAIL"));
    assert.ok(!body.includes("stack"));
  });
});

// ---------------------------------------------------------------------------
// Runtime response validation
// ---------------------------------------------------------------------------

function validEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    category: "WEBHOOK",
    provider: "COMMERCE7",
    status: "PROCESSED",
    receivedAt: "2026-08-26T18:12:00.000Z",
    processedAt: "2026-08-26T18:12:01.000Z",
    providerUpdatedAt: "2026-08-26T18:11:55.847Z",
    externalOrderRef: "c93ea68d",
    failureSummary: null,
    order: { id: "order-1", orderNumber: "1002" },
    ...overrides,
  };
}

describe("PHASE C — runtime response validation", () => {
  test("a valid page parses", () => {
    const parsed = parseOrderActivityPage({
      entries: [validEntry()],
      hasNextPage: false,
      nextCursor: null,
      limit: 25,
    });
    assert.ok(parsed);
    assert.equal(parsed?.entries.length, 1);
  });

  test("an unknown category or status is rejected rather than rendered as a blank badge", () => {
    for (const bad of [{ category: "MYSTERY" }, { status: "WEIRD" }, { provider: "WOOCOMMERCE" }]) {
      assert.equal(
        parseOrderActivityPage({
          entries: [validEntry(bad)],
          hasNextPage: false,
          nextCursor: null,
          limit: 25,
        }),
        null,
        JSON.stringify(bad),
      );
    }
  });

  test("a malformed timestamp is rejected", () => {
    assert.equal(
      parseOrderActivityPage({
        entries: [validEntry({ receivedAt: "not-a-date" })],
        hasNextPage: false,
        nextCursor: null,
        limit: 25,
      }),
      null,
    );
  });

  test("legitimate nulls are accepted", () => {
    const parsed = parseOrderActivityPage({
      entries: [
        validEntry({ processedAt: null, providerUpdatedAt: null, externalOrderRef: null, order: null }),
      ],
      hasNextPage: false,
      nextCursor: null,
      limit: 25,
    });
    assert.ok(parsed);
    assert.equal(parsed?.entries[0].order, null);
  });

  test("a malformed envelope is rejected rather than crashing on undefined", () => {
    assert.equal(parseOrderActivityPage(null), null);
    assert.equal(parseOrderActivityPage({ entries: "nope", hasNextPage: false, limit: 25 }), null);
    assert.equal(parseOrderActivityPage({ entries: [], hasNextPage: "yes", limit: 25 }), null);
    assert.equal(parseOrderActivityPage({ entries: [], hasNextPage: false }), null);
  });

  test("ONE malformed entry rejects the whole page — a partial history would silently hide events", () => {
    assert.equal(
      parseOrderActivityPage({
        entries: [validEntry(), validEntry({ id: "evt-2", status: "NONSENSE" })],
        hasNextPage: false,
        nextCursor: null,
        limit: 25,
      }),
      null,
    );
  });
});

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------

describe("PHASE C — activity UI wiring", () => {
  const source = readFileSync(
    join(
      process.cwd(),
      "src/app/(withSidebar)/dashboard/brand/commerce/orders/BrandCommerceOrdersClient.tsx",
    ),
    "utf8",
  );

  test("the panel states plainly that it is history, not current order state", () => {
    assert.match(source, /history of ingestion events, not the current state/i);
  });

  test("rows link to the canonical order so current state can be checked directly", () => {
    assert.match(source, /\/dashboard\/brand\/commerce\/orders\/\$\{entry\.order\.id\}/);
  });

  test("a null canonical order is rendered meaningfully, not as an error", () => {
    assert.match(source, /No canonical order/);
  });

  test("Custom Range progress is labelled as SEPARATE from the Catch Up checkpoint", () => {
    assert.match(source, /separate from the checkpoint above/i);
    assert.match(source, /does not move the\s*\n?\s*contiguous Catch Up checkpoint/i);
  });

  test("the fuller reconciliation checkpoint is surfaced (target, last attempt, outcome)", () => {
    assert.match(source, /Catching up toward:/);
    assert.match(source, /Last attempted:/);
    assert.match(source, /Last outcome:/);
  });

  test("webhook readiness wording stays truthful about what SQRATCH cannot observe", () => {
    assert.match(source, /subscription state is not observable from here/i);
  });

  test("the activity request has a stale-response guard", () => {
    const panelStart = source.indexOf("function OrderActivityPanel(");
    const panelBody = source.slice(panelStart, panelStart + 3000);
    assert.match(panelBody, /requestSeq/);
    assert.match(panelBody, /seq !== requestSeq\.current/);
  });

  test("the panel validates the response at runtime rather than casting it", () => {
    assert.match(source, /parseOrderActivityPage\(data\)/);
  });
});
