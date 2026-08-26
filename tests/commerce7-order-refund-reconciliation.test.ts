/**
 * tests/commerce7-order-refund-reconciliation.test.ts
 *
 * PHASE 25 — Commerce7 refund reconciliation. Fixtures below are sanitized
 * and structurally modeled on the real refund observed against sandbox
 * tenant `sqratch-inc` (order #1002 / #1003, 2026-08-26): no customer name,
 * email, phone, address, IP, or payment-card data appears anywhere in this
 * file — every fixture carries only ids, amounts, statuses, and dates.
 */
import "./env-setup";

process.env.COMMERCE7_APP_ID = "test-app-id";
process.env.COMMERCE7_APP_SECRET = "test-app-secret";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import {
  classifyCommerce7Order,
  reconcileCommerce7OrderRefunds,
  prepareCommerce7OrderForIngestion,
} from "../src/lib/commerce/providers/commerce7-order-refund-reconciliation";
import { CommerceProviderApiError } from "../src/lib/commerce/errors";
import type { Commerce7OrderNormalizationContext } from "../src/lib/commerce/providers/commerce7-order-normalizer";

const CONTEXT: Commerce7OrderNormalizationContext = {
  connectionId: "conn-1",
  brandId: "brand-a",
  provider: CommerceProvider.COMMERCE7,
  currencyCode: "CAD",
};

const TENANT = "sqratch-inc";

// ---------------------------------------------------------------------------
// Fixtures — sanitized, structurally modeled on the real #1002/#1003 refund.
// ---------------------------------------------------------------------------

function saleTender(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tender-sale-1",
    chargeType: "Sale",
    chargeStatus: "Success",
    amountTendered: 9831,
    ...overrides,
  };
}

function refundTender(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "tender-refund-1",
    chargeType: "Refund",
    chargeStatus: "Success",
    amountTendered: -3277,
    ...overrides,
  };
}

/** The ORIGINAL order — modeled on #1002, before any refund. */
function rootOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "order-1002",
    orderNumber: 1002,
    paymentStatus: "Paid",
    fulfillmentStatus: "Fulfilled",
    subTotal: 8700,
    taxTotal: 1131,
    total: 9831,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-26T04:39:24.783Z",
    tenders: [saleTender()],
    items: [
      { id: "line-1", productId: "product-chardonnay-2015", productTitle: "Sample - 2015 Chardonnay", sku: "2015C", quantity: 1, price: 2900, tax: 377 },
      { id: "line-2", productId: "product-rose-2016", productTitle: "Sample - 2016 Rose", sku: "2016R", quantity: 1, price: 1900, tax: 247 },
      { id: "line-3", productId: "product-reserve-chardonnay-2016", productTitle: "Sample - 2016 Reserve Chardonnay", sku: "2016RC", quantity: 1, price: 3900, tax: 507 },
    ],
    ...overrides,
  };
}

/** The ORIGINAL order AFTER Commerce7 links a refund — its own tenders/total never change. */
function rootOrderWithLink(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rootOrder({
    linkedOrders: [{ orderId: "order-1003", orderNumber: 1003, purchaseType: "Refund" }],
    ...overrides,
  });
}

/** The REFUND order — modeled on #1003. */
function refundOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "order-1003",
    orderNumber: 1003,
    purchaseType: "Refund",
    previousOrderId: "order-1002",
    previousOrderNumber: 1002,
    paymentStatus: "Paid",
    subTotal: -2900,
    taxTotal: -377,
    total: -3277,
    createdAt: "2026-08-26T04:43:12.901Z",
    updatedAt: "2026-08-26T04:43:12.901Z",
    tenders: [refundTender()],
    items: [
      { id: "refund-line-1", productId: "product-chardonnay-2015", productTitle: "Sample - 2015 Chardonnay", sku: "2015C", quantity: -1, price: 2900, tax: -377 },
    ],
    ...overrides,
  };
}

function fakeFetchOrder(
  byId: Record<string, Record<string, unknown> | (() => never)>,
): (input: { tenant: string; externalOrderId: string }) => Promise<Record<string, unknown>> {
  return async (input) => {
    const entry = byId[input.externalOrderId];
    if (entry === undefined) {
      throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "not found", undefined, 404);
    }
    if (typeof entry === "function") {
      return entry();
    }
    return entry;
  };
}

// ---------------------------------------------------------------------------
// classifyCommerce7Order (pure)
// ---------------------------------------------------------------------------

describe("classifyCommerce7Order", () => {
  test("1. a normal paid order with no refund evidence classifies REGULAR", () => {
    assert.deepEqual(classifyCommerce7Order(rootOrder()), { kind: "REGULAR" });
  });

  test("2. an order whose own purchaseType is Refund classifies REFUND_CHILD with previousOrderId", () => {
    assert.deepEqual(classifyCommerce7Order(refundOrder()), {
      kind: "REFUND_CHILD",
      previousOrderId: "order-1002",
    });
  });

  test("15. a Refund-typed order missing previousOrderId classifies REFUND_CHILD_UNRESOLVABLE — fail closed", () => {
    const malformed = refundOrder({ previousOrderId: undefined });
    assert.deepEqual(classifyCommerce7Order(malformed), { kind: "REFUND_CHILD_UNRESOLVABLE" });
  });

  test("an original order carrying a linked Refund order classifies ROOT_WITH_LINKED_REFUNDS", () => {
    assert.deepEqual(classifyCommerce7Order(rootOrderWithLink()), {
      kind: "ROOT_WITH_LINKED_REFUNDS",
      linkedRefundOrderIds: ["order-1003"],
    });
  });

  test("Section 6: an unrelated purchaseType (e.g. Exchange) on a linked order is never treated as refund evidence", () => {
    const withExchange = rootOrder({
      linkedOrders: [{ orderId: "order-9999", orderNumber: 9999, purchaseType: "Exchange" }],
    });
    assert.deepEqual(classifyCommerce7Order(withExchange), { kind: "REGULAR" });
  });

  test("a duplicate linked order id is deduplicated at classification time", () => {
    const withDup = rootOrder({
      linkedOrders: [
        { orderId: "order-1003", orderNumber: 1003, purchaseType: "Refund" },
        { orderId: "order-1003", orderNumber: 1003, purchaseType: "Refund" },
      ],
    });
    const result = classifyCommerce7Order(withDup);
    assert.equal(result.kind, "ROOT_WITH_LINKED_REFUNDS");
    if (result.kind === "ROOT_WITH_LINKED_REFUNDS") {
      assert.deepEqual(result.linkedRefundOrderIds, ["order-1003"]);
    }
  });

  test("10. multiple independent partial refund orders are all classified", () => {
    const withTwo = rootOrder({
      linkedOrders: [
        { orderId: "order-refund-a", orderNumber: 1010, purchaseType: "Refund" },
        { orderId: "order-refund-b", orderNumber: 1011, purchaseType: "Refund" },
      ],
    });
    const result = classifyCommerce7Order(withTwo);
    assert.equal(result.kind, "ROOT_WITH_LINKED_REFUNDS");
    if (result.kind === "ROOT_WITH_LINKED_REFUNDS") {
      assert.deepEqual(result.linkedRefundOrderIds, ["order-refund-a", "order-refund-b"]);
    }
  });

  test("a malformed (non-object) payload classifies REGULAR, deferring to normalizeCommerce7Order's own malformed-payload handling", () => {
    assert.deepEqual(classifyCommerce7Order("not an object"), { kind: "REGULAR" });
  });
});

// ---------------------------------------------------------------------------
// reconcileCommerce7OrderRefunds (I/O, injected fetchOrder)
// ---------------------------------------------------------------------------

describe("reconcileCommerce7OrderRefunds", () => {
  test("the real observed case: one successful Refund tender -> cumulative 3277", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-1003"] },
      { fetchOrder: fakeFetchOrder({ "order-1003": refundOrder() }) },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") {
      assert.equal(result.snapshot.totalRefundedMinor, BigInt(3277));
    }
  });

  test("no linked refund orders -> RECONCILED with zero (complete evidence of nothing refunded)", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: [] },
      { fetchOrder: fakeFetchOrder({}) },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") {
      assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
    }
  });

  test("10. multiple independent partial refunds sum cumulatively: 3277 + 2147 = 5424", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      {
        tenant: TENANT,
        rootExternalOrderId: "order-1002",
        linkedRefundOrderIds: ["order-refund-a", "order-refund-b"],
      },
      {
        fetchOrder: fakeFetchOrder({
          "order-refund-a": refundOrder({ id: "order-refund-a", tenders: [refundTender({ id: "t-a", amountTendered: -3277 })] }),
          "order-refund-b": refundOrder({ id: "order-refund-b", tenders: [refundTender({ id: "t-b", amountTendered: -2147 })] }),
        }),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") {
      assert.equal(result.snapshot.totalRefundedMinor, BigInt(5424));
    }
  });

  test("8. a duplicate logical refund represented by a repeated linked order id is not double-counted", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      {
        tenant: TENANT,
        rootExternalOrderId: "order-1002",
        linkedRefundOrderIds: ["order-1003", "order-1003"],
      },
      { fetchOrder: fakeFetchOrder({ "order-1003": refundOrder() }) },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") {
      assert.equal(result.snapshot.totalRefundedMinor, BigInt(3277));
    }
  });

  test("9. a repeated tender.id within one linked order's own tenders is not double-counted", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-1003"] },
      {
        fetchOrder: fakeFetchOrder({
          "order-1003": refundOrder({ tenders: [refundTender(), refundTender()] }),
        }),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") {
      assert.equal(result.snapshot.totalRefundedMinor, BigInt(3277));
    }
  });

  test("12. a Failed refund tender contributes zero", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-1003"] },
      { fetchOrder: fakeFetchOrder({ "order-1003": refundOrder({ tenders: [refundTender({ chargeStatus: "Failed" })] }) }) },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
  });

  test("13. a Pending refund tender contributes zero", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-1003"] },
      { fetchOrder: fakeFetchOrder({ "order-1003": refundOrder({ tenders: [refundTender({ chargeStatus: "Pending" })] }) }) },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
  });

  test("14. a Cancelled refund tender contributes zero", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-1003"] },
      { fetchOrder: fakeFetchOrder({ "order-1003": refundOrder({ tenders: [refundTender({ chargeStatus: "Cancelled" })] }) }) },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
  });

  test("16. a linked order whose own previousOrderId does not match the root is ignored, never counted silently", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-1003"] },
      { fetchOrder: fakeFetchOrder({ "order-1003": refundOrder({ previousOrderId: "order-SOME-OTHER-ORDER" }) }) },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
  });

  test("a linked order whose own purchaseType is not Refund is ignored", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-1003"] },
      { fetchOrder: fakeFetchOrder({ "order-1003": refundOrder({ purchaseType: "Exchange" }) }) },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") assert.equal(result.snapshot.totalRefundedMinor, BigInt(0));
  });

  test("Section 8: exceeding the linked-refund-order ceiling fails closed NOT_ELIGIBLE, no fetch attempted", async () => {
    let fetchCalled = false;
    const manyIds = Array.from({ length: 26 }, (_, i) => `order-refund-${i}`);
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: manyIds },
      {
        fetchOrder: async () => {
          fetchCalled = true;
          throw new Error("must not be called");
        },
      },
    );
    assert.equal(result.outcome, "NOT_ELIGIBLE");
    if (result.outcome === "NOT_ELIGIBLE") assert.equal(result.reason, "LINKED_REFUND_ORDER_LIMIT_EXCEEDED");
    assert.equal(fetchCalled, false);
  });

  test("17. a network/transient failure fetching a linked order returns TRANSIENT_FAILURE — no financial corruption", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-1003"] },
      {
        fetchOrder: async () => {
          throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "unreachable");
        },
      },
    );
    assert.equal(result.outcome, "TRANSIENT_FAILURE");
  });

  test("a 404 fetching a linked order is a deterministic NOT_ELIGIBLE, not a silent zero", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-missing"] },
      { fetchOrder: fakeFetchOrder({}) },
    );
    assert.equal(result.outcome, "NOT_ELIGIBLE");
    if (result.outcome === "NOT_ELIGIBLE") assert.equal(result.reason, "LINKED_ORDER_NOT_FOUND");
  });

  test("a 401/403 fetching a linked order is a deterministic NOT_ELIGIBLE (NO_CREDENTIAL)", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-1003"] },
      {
        fetchOrder: async () => {
          throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "forbidden", undefined, 403);
        },
      },
    );
    assert.equal(result.outcome, "NOT_ELIGIBLE");
    if (result.outcome === "NOT_ELIGIBLE") assert.equal(result.reason, "NO_CREDENTIAL");
  });

  test("11. full refund: cumulative equals the root's own total", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: ["order-1003"] },
      { fetchOrder: fakeFetchOrder({ "order-1003": refundOrder({ tenders: [refundTender({ amountTendered: -9831 })] }) }) },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") assert.equal(result.snapshot.totalRefundedMinor, BigInt(9831));
  });
});

// ---------------------------------------------------------------------------
// prepareCommerce7OrderForIngestion (end to end)
// ---------------------------------------------------------------------------

describe("prepareCommerce7OrderForIngestion", () => {
  test("1. a normal paid order with no refund evidence passes through unchanged (NOT_APPLICABLE, no network call)", async () => {
    let fetchCalled = false;
    const result = await prepareCommerce7OrderForIngestion(rootOrder(), CONTEXT, TENANT, {
      fetchOrder: async () => {
        fetchCalled = true;
        throw new Error("must not be called");
      },
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.externalOrderId, "order-1002");
      // rootOrder()'s own fixture carries a real (non-refund) tenders array,
      // so the ordinary tenders-based path correctly computes a real zero —
      // complete evidence of "nothing refunded", not "unknown" (see
      // commerce7-order-normalizer.ts's own REFUND EVIDENCE header).
      assert.equal(result.order.totalRefundedMinor, BigInt(0));
      assert.equal(result.refundReconciliationOutcome, "NOT_APPLICABLE");
    }
    assert.equal(fetchCalled, false);
  });

  test("2. original order becomes fulfilled (fulfillmentStatus passes through from the root snapshot)", async () => {
    const result = await prepareCommerce7OrderForIngestion(rootOrder(), CONTEXT, TENANT);
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") assert.equal(result.order.fulfillmentStatus, "FULFILLED");
  });

  test("4. Case A — refund child arrives FIRST: root is resolved via previousOrderId, fetched fresh, and reconciled", async () => {
    const fetchedIds: string[] = [];
    const result = await prepareCommerce7OrderForIngestion(refundOrder(), CONTEXT, TENANT, {
      fetchOrder: async (input) => {
        fetchedIds.push(input.externalOrderId);
        if (input.externalOrderId === "order-1002") return rootOrderWithLink();
        if (input.externalOrderId === "order-1003") return refundOrder();
        throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "unexpected", undefined, 404);
      },
    });
    // The ROOT is fetched first (to resolve identity), THEN the linked
    // refund order is fetched (during reconciliation) — both calls happen,
    // in this order.
    assert.deepEqual(fetchedIds, ["order-1002", "order-1003"]);
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      // The CHILD's own id must NEVER become the canonical order identity.
      assert.equal(result.order.externalOrderId, "order-1002");
      assert.notEqual(result.order.externalOrderId, "order-1003");
      assert.equal(result.order.totalMinor, BigInt(9831));
      assert.equal(result.order.totalRefundedMinor, BigInt(3277));
      assert.equal(result.order.financialStatus, "PARTIALLY_REFUNDED");
      assert.equal(result.refundReconciliationOutcome, "RECONCILED");
      // Original line items — NOT #1003's single negative refund line.
      assert.equal(result.order.lineItems.length, 3);
      assert.ok(result.order.lineItems.every((item) => (item.quantity ?? 0) >= 0));
    }
  });

  test("5. Case B — original linkedOrders update arrives FIRST: no root re-fetch needed, only the linked refund order is fetched", async () => {
    let rootFetchAttempted = false;
    const result = await prepareCommerce7OrderForIngestion(rootOrderWithLink(), CONTEXT, TENANT, {
      fetchOrder: async (input) => {
        if (input.externalOrderId === "order-1002") rootFetchAttempted = true;
        if (input.externalOrderId === "order-1003") return refundOrder();
        throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "unexpected", undefined, 404);
      },
    });
    assert.equal(rootFetchAttempted, false, "the root is already the payload itself — no redundant fetch");
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.externalOrderId, "order-1002");
      assert.equal(result.order.totalRefundedMinor, BigInt(3277));
      assert.equal(result.order.financialStatus, "PARTIALLY_REFUNDED");
    }
  });

  test("6. Case C — child-first and parent-first converge on the identical final state", async () => {
    const deps = {
      fetchOrder: async (input: { externalOrderId: string }) => {
        if (input.externalOrderId === "order-1002") return rootOrderWithLink();
        if (input.externalOrderId === "order-1003") return refundOrder();
        throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "unexpected", undefined, 404);
      },
    };
    const viaChild = await prepareCommerce7OrderForIngestion(refundOrder(), CONTEXT, TENANT, deps);
    const viaParent = await prepareCommerce7OrderForIngestion(rootOrderWithLink(), CONTEXT, TENANT, deps);
    assert.equal(viaChild.outcome, "READY");
    assert.equal(viaParent.outcome, "READY");
    if (viaChild.outcome === "READY" && viaParent.outcome === "READY") {
      assert.equal(viaChild.order.totalRefundedMinor, viaParent.order.totalRefundedMinor);
      assert.equal(viaChild.order.financialStatus, viaParent.order.financialStatus);
      assert.equal(viaChild.order.externalOrderId, viaParent.order.externalOrderId);
    }
  });

  test("7. a duplicate identical refund child delivery reconciles to the identical result — idempotent", async () => {
    const deps = { fetchOrder: fakeFetchOrder({ "order-1002": rootOrderWithLink(), "order-1003": refundOrder() }) };
    const first = await prepareCommerce7OrderForIngestion(refundOrder(), CONTEXT, TENANT, deps);
    const second = await prepareCommerce7OrderForIngestion(refundOrder(), CONTEXT, TENANT, deps);
    assert.equal(first.outcome, "READY");
    assert.equal(second.outcome, "READY");
    if (first.outcome === "READY" && second.outcome === "READY") {
      assert.equal(first.order.totalRefundedMinor, second.order.totalRefundedMinor);
    }
  });

  test("11. a fully-refunded order reconciles to REFUNDED with net-zero implied (totalRefundedMinor === totalMinor)", async () => {
    const fullRefund = refundOrder({ tenders: [refundTender({ amountTendered: -9831 })] });
    const result = await prepareCommerce7OrderForIngestion(rootOrderWithLink(), CONTEXT, TENANT, {
      fetchOrder: fakeFetchOrder({ "order-1003": fullRefund }),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.financialStatus, "REFUNDED");
      assert.equal(result.order.totalRefundedMinor, BigInt(9831));
    }
  });

  test("15. a Refund child with a malformed/missing previousOrderId fails closed — no bogus negative CommerceOrder", async () => {
    const malformed = refundOrder({ previousOrderId: undefined });
    const result = await prepareCommerce7OrderForIngestion(malformed, CONTEXT, TENANT, {
      fetchOrder: async () => {
        throw new Error("must not be called — no id to resolve");
      },
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.externalOrderId, null);
      assert.equal(result.refundReconciliationOutcome, "UNRESOLVABLE_REFUND_CHILD");
      // Never the child's own (negative) total leaking through as a real order.
      assert.equal(result.order.totalMinor, null);
    }
  });

  test("17. a transient reconciliation failure returns TRANSIENT_FAILURE with no order to persist", async () => {
    const result = await prepareCommerce7OrderForIngestion(rootOrderWithLink(), CONTEXT, TENANT, {
      fetchOrder: async () => {
        throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "unreachable");
      },
    });
    assert.equal(result.outcome, "TRANSIENT_FAILURE");
  });

  test("18. STALE-UPDATE CASE (Section 10): a later plain Update for the original — whose OWN tenders carry only the Sale tender — must NOT reset an already-established refund to zero", () => {
    // The critical property under test: prepareCommerce7OrderForIngestion
    // NEVER derives totalRefundedMinor from the root's own tenders once
    // linkedOrders indicates refund evidence — it always overrides with the
    // reconciled cumulative figure. This is proven structurally: the root
    // fixture below has ONLY its original Sale tender (matching real
    // Commerce7 behavior — the original order never gains a Refund tender),
    // yet linkedOrders is present, so reconciliation — not tenders — must
    // decide totalRefundedMinor.
    const staleShapedUpdate = rootOrderWithLink({ tenders: [saleTender()] });
    return prepareCommerce7OrderForIngestion(staleShapedUpdate, CONTEXT, TENANT, {
      fetchOrder: fakeFetchOrder({ "order-1003": refundOrder() }),
    }).then((result) => {
      assert.equal(result.outcome, "READY");
      if (result.outcome === "READY") {
        assert.equal(result.order.totalRefundedMinor, BigInt(3277), "must come from reconciliation, never from the tenders-only view");
        assert.equal(result.order.financialStatus, "PARTIALLY_REFUNDED");
      }
    });
  });

  test("18b. the SAME stale-shaped case under a TRANSIENT reconciliation failure defers rather than reports zero", async () => {
    const staleShapedUpdate = rootOrderWithLink({ tenders: [saleTender()] });
    const result = await prepareCommerce7OrderForIngestion(staleShapedUpdate, CONTEXT, TENANT, {
      fetchOrder: async () => {
        throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "unreachable");
      },
    });
    assert.equal(result.outcome, "TRANSIENT_FAILURE");
  });

  test("22. original line items remain intact — never replaced by the refund order's single negative line", async () => {
    const result = await prepareCommerce7OrderForIngestion(rootOrderWithLink(), CONTEXT, TENANT, {
      fetchOrder: fakeFetchOrder({ "order-1003": refundOrder() }),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      const skus = result.order.lineItems.map((item) => item.sku).sort();
      assert.deepEqual(skus, ["2015C", "2016R", "2016RC"]);
    }
  });

  test("a NOT_ELIGIBLE reconciliation defers totalRefundedMinor/financialStatus (both null) rather than guessing", async () => {
    const manyLinked = rootOrderWithLink({
      linkedOrders: Array.from({ length: 26 }, (_, i) => ({ orderId: `order-refund-${i}`, orderNumber: 2000 + i, purchaseType: "Refund" })),
    });
    const result = await prepareCommerce7OrderForIngestion(manyLinked, CONTEXT, TENANT, { fetchOrder: fakeFetchOrder({}) });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.totalRefundedMinor, null);
      assert.equal(result.order.financialStatus, null);
      assert.equal(result.refundReconciliationOutcome, "DEFERRED");
      assert.equal(result.refundReconciliationReason, "LINKED_REFUND_ORDER_LIMIT_EXCEEDED");
      // Everything else still lands from the authoritative snapshot.
      assert.equal(result.order.fulfillmentStatus, "FULFILLED");
      assert.equal(result.order.lineItems.length, 3);
    }
  });

  test("Section 7.10: an over-refund is passed through honestly, never clamped — left for the generic invariant guard to reject", async () => {
    const overRefund = refundOrder({ tenders: [refundTender({ amountTendered: -99999 })] });
    const result = await prepareCommerce7OrderForIngestion(rootOrderWithLink(), CONTEXT, TENANT, {
      fetchOrder: fakeFetchOrder({ "order-1003": overRefund }),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      // Not clamped to totalMinor, not silently corrected.
      assert.equal(result.order.totalRefundedMinor, BigInt(99999));
      assert.equal(result.order.financialStatus, "REFUNDED");
      assert.notEqual(result.order.totalRefundedMinor, result.order.totalMinor);
    }
  });
});

// ---------------------------------------------------------------------------
// No PII anywhere in this module's exported surface
// ---------------------------------------------------------------------------

test("no customer PII vocabulary appears in this test file's fixtures", () => {
  const source = [rootOrder(), refundOrder(), rootOrderWithLink()].map((o) => JSON.stringify(o)).join(" ");
  for (const forbidden of ["email", "phone", "address", "customer", "cardNumber", "ipAddress"]) {
    assert.ok(!source.toLowerCase().includes(forbidden.toLowerCase()), `fixture must not contain ${forbidden}`);
  }
});
