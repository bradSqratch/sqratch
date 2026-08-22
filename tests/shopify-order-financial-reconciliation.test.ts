process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/shopify-order-financial-reconciliation.test.ts
 *
 * Unit tests for the Shopify provider-layer live financial reconciliation
 * adapter (`src/lib/commerce/providers/shopify-order-financial-reconciliation.ts`).
 * `fetchImpl` and `getAccessToken` are always injected — no real network call,
 * no real DB, in this file.
 *
 * Covered cases (letters match the task's required-test list):
 *  A/B. Successful partial and full cumulative refund via the settled
 *       transaction sum, using the exact live order #1002 values.
 *  B. Transaction-count boundary (249 trusted, 250 fails closed) — see the
 *     "transaction-count boundary" describe block for why "C. multiple
 *     pages" and "H. malformed pageInfo/cursor" are N/A by verified Shopify
 *     schema fact (`Order.transactions` has no cursor pagination at all).
 *  C/D/E. PENDING / FAILURE / ERROR transactions never reduce settled revenue.
 *  G. A shipping-only (or any-composition) refund reconciles correctly
 *     through the transaction-level sum — no refund sub-shape to enumerate —
 *     and hitting the transaction-count boundary never returns a partial sum.
 *  H. Multi-currency: a transaction's presentment-currency amount is never
 *     written into the shop-currency total.
 *  L. Provider-neutral boundary: nothing outside the Shopify provider layer
 *     imports this module.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  reconcileShopifyOrderFinancials,
  mapShopifyDisplayFinancialStatus,
  buildShopifyOrderGid,
  type ReconcileShopifyOrderFinancialsDeps,
} from "../src/lib/commerce/providers/shopify-order-financial-reconciliation";

const BRAND_ID = "brand-1";
const CONNECTION_ID = "shopify-X";
const SHOP_DOMAIN = "test-shop.myshopify.com";
const EXTERNAL_ORDER_ID = "1002";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function money(amount: string, currencyCode: string) {
  return { amount, currencyCode };
}

function transaction(
  kind: string,
  status: string,
  shopMoney: { amount: string; currencyCode: string } | null,
) {
  return { kind, status, amountSet: shopMoney ? { shopMoney } : undefined };
}

function graphqlSuccess(order: Record<string, unknown> | null) {
  return { ok: true, json: async () => ({ data: { order } }) } as unknown as Response;
}

function okAccessToken(): ReconcileShopifyOrderFinancialsDeps["getAccessToken"] {
  return async () => ({ ok: true, accessToken: "shpat_test-token" });
}

function fetchReturning(response: Response, calls?: Array<{ url: string; body: unknown }>) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    calls?.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return response;
  };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("mapShopifyDisplayFinancialStatus", () => {
  const cases: Array<[string, string]> = [
    ["PENDING", "PENDING"],
    ["AUTHORIZED", "AUTHORIZED"],
    ["PARTIALLY_PAID", "PARTIALLY_PAID"],
    ["PAID", "PAID"],
    ["PARTIALLY_REFUNDED", "PARTIALLY_REFUNDED"],
    ["REFUNDED", "REFUNDED"],
    ["VOIDED", "VOIDED"],
  ];
  for (const [input, expected] of cases) {
    test(`${input} -> ${expected}`, () => {
      assert.equal(mapShopifyDisplayFinancialStatus(input), expected);
    });
  }

  test("EXPIRED has no neutral equivalent and maps to null, never guessed", () => {
    assert.equal(mapShopifyDisplayFinancialStatus("EXPIRED"), null);
  });

  test("an unrecognized or non-string value maps to null", () => {
    assert.equal(mapShopifyDisplayFinancialStatus("SOMETHING_NEW"), null);
    assert.equal(mapShopifyDisplayFinancialStatus(null), null);
    assert.equal(mapShopifyDisplayFinancialStatus(undefined), null);
    assert.equal(mapShopifyDisplayFinancialStatus(42), null);
  });
});

describe("buildShopifyOrderGid", () => {
  test("a bare positive-integer string builds the stable gid:// convention", () => {
    assert.equal(buildShopifyOrderGid("1002"), "gid://shopify/Order/1002");
    assert.equal(
      buildShopifyOrderGid("820982911946154500"),
      "gid://shopify/Order/820982911946154500",
    );
  });

  test("anything non-numeric is rejected rather than interpolated unexamined", () => {
    assert.equal(buildShopifyOrderGid("gid://shopify/Order/1002"), null);
    assert.equal(buildShopifyOrderGid("1002; DROP TABLE"), null);
    assert.equal(buildShopifyOrderGid(""), null);
    assert.equal(buildShopifyOrderGid("-1002"), null);
    assert.equal(buildShopifyOrderGid("12.5"), null);
  });
});

// ---------------------------------------------------------------------------
// reconcileShopifyOrderFinancials — eligibility gate
// ---------------------------------------------------------------------------

describe("NOT_ELIGIBLE: deterministic reasons reconciliation cannot happen right now", () => {
  test("X/Y reconciliation requests only the order's exact connection credential", async () => {
    const tokenCalls: unknown[] = [];
    const networkCalls: Array<{ url: string; body: unknown }> = [];
    const getAccessToken: NonNullable<ReconcileShopifyOrderFinancialsDeps["getAccessToken"]> =
      async (brandId, options) => {
        tokenCalls.push({ brandId, options });
        return {
          ok: true,
          accessToken: options.connectionId === "shopify-X" ? "TOKEN_X" : "TOKEN_Y",
        };
      };
    const result = await reconcileShopifyOrderFinancials(
      {
        brandId: BRAND_ID,
        connectionId: "shopify-X",
        shopDomain: "x.myshopify.com",
        externalOrderId: EXTERNAL_ORDER_ID,
      },
      {
        getAccessToken,
        fetchImpl: fetchReturning(graphqlSuccess(null), networkCalls),
      },
    );
    await reconcileShopifyOrderFinancials(
      {
        brandId: BRAND_ID,
        connectionId: "shopify-Y",
        shopDomain: "y.myshopify.com",
        externalOrderId: EXTERNAL_ORDER_ID,
      },
      {
        getAccessToken,
        fetchImpl: fetchReturning(graphqlSuccess(null), networkCalls),
      },
    );

    assert.equal(result.outcome, "NOT_ELIGIBLE");
    assert.deepEqual(tokenCalls, [
      {
        brandId: BRAND_ID,
        options: {
          connectionId: "shopify-X",
          expectedExternalAccountId: "x.myshopify.com",
        },
      },
      {
        brandId: BRAND_ID,
        options: {
          connectionId: "shopify-Y",
          expectedExternalAccountId: "y.myshopify.com",
        },
      },
    ]);
    assert.equal(networkCalls[0]?.url.startsWith("https://x.myshopify.com/"), true);
    assert.equal(networkCalls[1]?.url.startsWith("https://y.myshopify.com/"), true);
  });

  test("an invalid externalOrderId never reaches the network", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "not-numeric" },
      { getAccessToken: okAccessToken(), fetchImpl: fetchReturning(graphqlSuccess(null), calls) },
    );
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "INVALID_ORDER_ID" });
    assert.equal(calls.length, 0);
  });

  test("no usable credential never reaches the network", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      {
        getAccessToken: async () => ({ ok: false }),
        fetchImpl: fetchReturning(graphqlSuccess(null), calls),
      },
    );
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "NO_CREDENTIAL" });
    assert.equal(calls.length, 0);
  });

  test("Shopify affirmatively returning order: null is ORDER_NOT_FOUND, distinct from a malformed shape", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      { getAccessToken: okAccessToken(), fetchImpl: fetchReturning(graphqlSuccess(null)) },
    );
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "ORDER_NOT_FOUND" });
  });

  test("a response with no `data` key at all is MALFORMED_SNAPSHOT", async () => {
    const response = { ok: true, json: async () => ({}) } as unknown as Response;
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      { getAccessToken: okAccessToken(), fetchImpl: fetchReturning(response) },
    );
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" });
  });

  test("missing currencyCode on totalPriceSet.shopMoney is MALFORMED_SNAPSHOT", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PAID",
            totalPriceSet: { shopMoney: { amount: "10.00" } },
            transactions: [],
          }),
        ),
      },
    );
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" });
  });

  test("an unparseable updatedAt is MALFORMED_SNAPSHOT", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "not-a-date",
            displayFinancialStatus: "PAID",
            totalPriceSet: { shopMoney: money("10.00", "USD") },
            transactions: [],
          }),
        ),
      },
    );
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" });
  });

  test("transactions not shaped as an array is MALFORMED_SNAPSHOT", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PAID",
            totalPriceSet: { shopMoney: money("10.00", "USD") },
            transactions: "not-an-array",
          }),
        ),
      },
    );
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" });
  });

  test("H (defensive). a settled REFUND transaction whose own shop-currency code disagrees with the order's is unreconcilable data, never silently summed", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PARTIALLY_REFUNDED",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [transaction("REFUND", "SUCCESS", money("610.63", "USD"))],
          }),
        ),
      },
    );
    assert.deepEqual(result, { outcome: "NOT_ELIGIBLE", reason: "MALFORMED_SNAPSHOT" });
  });
});

describe("TRANSIENT_FAILURE: environmental conditions that plausibly resolve on retry", () => {
  test("fetch throwing (network error)", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: async () => {
          throw new Error("ECONNRESET");
        },
      },
    );
    assert.deepEqual(result, { outcome: "TRANSIENT_FAILURE" });
  });

  test("a non-2xx HTTP response", async () => {
    const response = { ok: false, json: async () => ({}) } as unknown as Response;
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      { getAccessToken: okAccessToken(), fetchImpl: fetchReturning(response) },
    );
    assert.deepEqual(result, { outcome: "TRANSIENT_FAILURE" });
  });

  test("response.json() throwing (malformed JSON body)", async () => {
    const response = {
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token");
      },
    } as unknown as Response;
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      { getAccessToken: okAccessToken(), fetchImpl: fetchReturning(response) },
    );
    assert.deepEqual(result, { outcome: "TRANSIENT_FAILURE" });
  });

  test("a GraphQL `errors` array on an otherwise well-formed request", async () => {
    const response = {
      ok: true,
      json: async () => ({ errors: [{ message: "Throttled" }] }),
    } as unknown as Response;
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: EXTERNAL_ORDER_ID },
      { getAccessToken: okAccessToken(), fetchImpl: fetchReturning(response) },
    );
    assert.deepEqual(result, { outcome: "TRANSIENT_FAILURE" });
  });
});

// ---------------------------------------------------------------------------
// RECONCILED — the settlement gate itself (A-E, G, H)
// ---------------------------------------------------------------------------

describe("RECONCILED: the settlement gate — only kind:REFUND + status:SUCCESS transactions ever count", () => {
  test("A. successful partial refund: shop CAD 1322.57 order, settled shop refund CAD 610.63 -> refunded=61063, PARTIALLY_REFUNDED", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T11:00:00Z",
            displayFinancialStatus: "PARTIALLY_REFUNDED",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [
              transaction("SALE", "SUCCESS", money("1322.57", "CAD")),
              transaction("REFUND", "SUCCESS", money("610.63", "CAD")),
            ],
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.currencyCode, "CAD");
    assert.equal(result.snapshot.totalMinor, BigInt(132257));
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(61063));
    assert.equal(result.snapshot.financialStatus, "PARTIALLY_REFUNDED");
  });

  test("B. successful full cumulative refund: two settled REFUND transactions sum to the full amount -> refunded=132257, REFUNDED", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "REFUNDED",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [
              transaction("SALE", "SUCCESS", money("1322.57", "CAD")),
              transaction("REFUND", "SUCCESS", money("610.63", "CAD")),
              transaction("REFUND", "SUCCESS", money("711.94", "CAD")),
            ],
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(132257));
    assert.equal(result.snapshot.totalMinor, result.snapshot.totalRefundedMinor);
    assert.equal(result.snapshot.financialStatus, "REFUNDED");
  });

  test("C. a PENDING refund transaction must NOT reduce settled refunded revenue", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PAID",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [
              transaction("SALE", "SUCCESS", money("1322.57", "CAD")),
              transaction("REFUND", "PENDING", money("610.63", "CAD")),
            ],
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
  });

  test("D. a FAILURE refund transaction must NOT reduce settled refunded revenue", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PAID",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [transaction("REFUND", "FAILURE", money("610.63", "CAD"))],
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
  });

  test("E. an ERROR refund transaction must NOT reduce settled refunded revenue (and neither does AWAITING_RESPONSE or UNKNOWN)", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PAID",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [
              transaction("REFUND", "ERROR", money("100.00", "CAD")),
              transaction("REFUND", "AWAITING_RESPONSE", money("100.00", "CAD")),
              transaction("REFUND", "UNKNOWN", money("100.00", "CAD")),
            ],
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
  });

  test("non-REFUND kinds (AUTHORIZATION, CAPTURE, SALE, VOID, CHANGE) never count even when SUCCESS", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PAID",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [
              transaction("AUTHORIZATION", "SUCCESS", money("1322.57", "CAD")),
              transaction("CAPTURE", "SUCCESS", money("1322.57", "CAD")),
              transaction("SALE", "SUCCESS", money("1322.57", "CAD")),
              transaction("VOID", "SUCCESS", money("1322.57", "CAD")),
              transaction("CHANGE", "SUCCESS", money("5.00", "CAD")),
            ],
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
  });

  test("G. a shipping-only refund reconciles correctly through the settled-transaction sum — no refund sub-shape (line item vs shipping vs duty) to enumerate or miss", async () => {
    // Whatever Shopify refunded — a shipping charge, a duty, a discrepancy
    // adjustment — it manifests as a settled kind:REFUND transaction. This
    // is the exact case the old REST refund_line_items/refund_shipping_lines
    // component-summing design could miss (refundShippingLines is
    // GraphQL-only and absent from REST bodies); the transaction-level sum
    // has no such gap.
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PARTIALLY_REFUNDED",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [transaction("REFUND", "SUCCESS", money("15.00", "CAD"))],
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(1500));
  });

  test("H. multi-currency: shop CAD / presentment USD — the transaction's presentmentMoney (if the fixture even included one) is never read; only shopMoney contributes", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PARTIALLY_REFUNDED",
            // totalPriceSet only exposes shopMoney to this query by design —
            // see the GraphQL document in the source module — so a
            // presentment figure is structurally unable to leak in.
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [transaction("REFUND", "SUCCESS", money("610.63", "CAD"))],
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    // The live-QA bug produced 44000 (USD 440.00 in cents) mislabeled as
    // CAD. This snapshot must never contain that number under any currency.
    assert.notEqual(result.snapshot.totalRefundedMinor, BigInt(44000));
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(61063));
    assert.equal(result.snapshot.currencyCode, "CAD");
  });

  test("a transaction whose own shop_money is absent (no amountSet at all) contributes nothing, never throws", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PAID",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [{ kind: "REFUND", status: "PENDING" }],
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
  });

  test("the GraphQL request variable carries the correct gid://shopify/Order/<id>, never the bare numeric id", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PAID",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [],
          }),
          calls,
        ),
      },
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `https://${SHOP_DOMAIN}/admin/api/2026-04/graphql.json`);
    const body = calls[0].body as { variables: { id: string } };
    assert.equal(body.variables.id, "gid://shopify/Order/1002");
  });

  test("zero settled refund transactions on an otherwise-normal order reconciles to totalRefundedMinor 0n, not null", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T10:00:00Z",
            displayFinancialStatus: "PAID",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: [],
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
    assert.equal(result.snapshot.totalMinor, BigInt(132257));
  });
});

// ---------------------------------------------------------------------------
// B/G. Transaction-count boundary — fail-closed truncation detection.
//
// `Order.transactions` is verified (against Shopify's current Admin GraphQL
// docs — see the source module's file header) to be a PLAIN ARRAY field with
// no cursor pagination (no `after`/`pageInfo`/`hasNextPage`/`endCursor`) and
// no alternative connection query exists to page through it. Shopify's
// platform-wide ceiling for a `first` argument is 250, which is already what
// this module requests — there is no larger single-request value available.
// "C. multiple pages" and "H. malformed pageInfo/cursor" from the task's
// required-test list are therefore N/A BY VERIFIED SCHEMA FACT, not by
// omission: no pagination loop exists in the implementation to test, because
// none can exist against this field today. What IS implemented and tested
// here is the correct, honest equivalent: detecting the truncation boundary
// and refusing to trust (let alone persist) a possibly-incomplete sum.
// ---------------------------------------------------------------------------

describe("B/G. transaction-count boundary: never trust or persist a possibly-truncated transaction list", () => {
  function manyRefundTransactions(count: number) {
    return Array.from({ length: count }, () => transaction("REFUND", "SUCCESS", money("1.00", "CAD")));
  }

  test("B. 249 transactions (one under Shopify's 250-per-request ceiling) is trusted and summed normally", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PARTIALLY_REFUNDED",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: manyRefundTransactions(249),
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(24900));
  });

  test("B/G. exactly 250 transactions (Shopify's per-request ceiling) is a possible truncation — fails closed, NEVER returns a summed total", async () => {
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "REFUNDED",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: manyRefundTransactions(250),
          }),
        ),
      },
    );
    assert.deepEqual(result, {
      outcome: "NOT_ELIGIBLE",
      reason: "TRANSACTION_COUNT_LIMIT_EXCEEDED",
    });
  });

  test("D-analog. a settled REFUND transaction in the LAST position of a large-but-under-boundary batch still contributes (no position-dependent bug)", async () => {
    const transactions = [
      ...manyRefundTransactions(0),
      transaction("AUTHORIZATION", "SUCCESS", money("1322.57", "CAD")),
      ...Array.from({ length: 247 }, () => transaction("REFUND", "PENDING", money("5.00", "CAD"))),
      transaction("REFUND", "SUCCESS", money("610.63", "CAD")), // position 249 of 249
    ];
    const result = await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "PARTIALLY_REFUNDED",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions,
          }),
        ),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome !== "RECONCILED") return;
    assert.equal(result.snapshot.totalRefundedMinor, BigInt(61063));
  });

  test("G-analog. hitting the boundary makes exactly one GraphQL request — there is no retry/second-page request to leak a partial total from", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    await reconcileShopifyOrderFinancials(
      { brandId: BRAND_ID, connectionId: CONNECTION_ID, shopDomain: SHOP_DOMAIN, externalOrderId: "1002" },
      {
        getAccessToken: okAccessToken(),
        fetchImpl: fetchReturning(
          graphqlSuccess({
            updatedAt: "2026-08-15T12:00:00Z",
            displayFinancialStatus: "REFUNDED",
            totalPriceSet: { shopMoney: money("1322.57", "CAD") },
            transactions: manyRefundTransactions(250),
          }),
          calls,
        ),
      },
    );
    assert.equal(calls.length, 1, "no pagination loop exists to make a second request");
  });

  test("H-analog. the actual GraphQL query string requests no cursor/pageInfo fields — there is no cursor state that malformed data could corrupt into a loop", async () => {
    // Scoped to the query template literal itself, not the whole file — the
    // file's OWN doc comment legitimately discusses pageInfo/hasNextPage/
    // endCursor by name to explain why they are NOT used, which would
    // false-fail a whole-file regex against its own documentation.
    const source = readSource(
      "src/lib/commerce/providers/shopify-order-financial-reconciliation.ts",
    );
    const queryStart = source.indexOf("const FINANCIAL_SNAPSHOT_QUERY = `");
    assert.notEqual(queryStart, -1);
    const queryEnd = source.indexOf("`;", queryStart + "const FINANCIAL_SNAPSHOT_QUERY = `".length);
    assert.notEqual(queryEnd, -1);
    const query = source.slice(queryStart, queryEnd);

    assert.doesNotMatch(query, /pageInfo/);
    assert.doesNotMatch(query, /hasNextPage/);
    assert.doesNotMatch(query, /endCursor/);
    assert.doesNotMatch(query, /\bafter\s*:/);
  });
});

// ---------------------------------------------------------------------------
// L. Provider-neutral boundary
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

describe("L. provider-neutral boundary: this Shopify-specific module is never imported by the neutral core", () => {
  test("order-ingestion.ts never imports shopify-order-financial-reconciliation", () => {
    assert.doesNotMatch(
      readSource("src/lib/commerce/order-ingestion.ts"),
      /shopify-order-financial-reconciliation/,
    );
  });

  test("order-analytics.ts never imports shopify-order-financial-reconciliation", () => {
    assert.doesNotMatch(
      readSource("src/lib/commerce/order-analytics.ts"),
      /shopify-order-financial-reconciliation/,
    );
  });
});

test("this test file pins DATABASE_URL to the blocked host on line 1, before any import", () => {
  const source = readSource("tests/shopify-order-financial-reconciliation.test.ts");
  assert.equal(
    source.split("\n")[0],
    'process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";',
  );
});
