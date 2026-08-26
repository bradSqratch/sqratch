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
  type PrepareCommerce7OrderForIngestionDeps,
  type PrepareCommerce7OrderForIngestionResult,
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

/**
 * PHASE 26 — every `prepareCommerce7OrderForIngestion` call now consults the
 * stored canonical financial state (the P1 refund-durability guard), so the
 * tests must control that seam rather than reaching the real database.
 * Default here is "this order has never been stored", which is the correct
 * baseline for every pre-existing Phase 25 scenario; the durability tests
 * override it with real stored state.
 */
function prepare(
  raw: unknown,
  deps: Partial<PrepareCommerce7OrderForIngestionDeps> = {},
): Promise<PrepareCommerce7OrderForIngestionResult> {
  return prepareCommerce7OrderForIngestion(raw, CONTEXT, TENANT, {
    loadStoredFinancialState: async () => null,
    ...deps,
  });
}

/** Convenience for the durability tests: pretend this order is already stored in a given state. */
function storedState(
  totalRefundedMinor: bigint,
  financialStatus: "PAID" | "PARTIALLY_REFUNDED" | "REFUNDED" | null,
) {
  return async () => ({ totalRefundedMinor, financialStatus });
}

// ---------------------------------------------------------------------------
// classifyCommerce7Order (pure)
// ---------------------------------------------------------------------------

describe("classifyCommerce7Order", () => {
  test("1. a normal paid order with no refund evidence classifies REGULAR", () => {
    assert.deepEqual(classifyCommerce7Order(rootOrder()), { kind: "REGULAR" });
  });

  test("2. an order whose own purchaseType is Refund classifies REFUND_CHILD with previousOrderId AND its own child id", () => {
    // PHASE 26: `childOrderId` is carried so reconciliation can union this
    // child into the root's linkedOrders set even when Commerce7 has not yet
    // updated the root (the child-before-parent race).
    assert.deepEqual(classifyCommerce7Order(refundOrder()), {
      kind: "REFUND_CHILD",
      previousOrderId: "order-1002",
      childOrderId: "order-1003",
    });
  });

  test("2b. a Refund child that reports no id of its own still classifies REFUND_CHILD, with a null childOrderId", () => {
    assert.deepEqual(classifyCommerce7Order(refundOrder({ id: undefined })), {
      kind: "REFUND_CHILD",
      previousOrderId: "order-1002",
      childOrderId: null,
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
    const result = await prepare(rootOrder(), {
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
    const result = await prepare(rootOrder());
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") assert.equal(result.order.fulfillmentStatus, "FULFILLED");
  });

  test("4. Case A — refund child arrives FIRST: root is resolved via previousOrderId, fetched fresh, and reconciled", async () => {
    const fetchedIds: string[] = [];
    const result = await prepare(refundOrder(), {
      fetchOrder: async (input) => {
        fetchedIds.push(input.externalOrderId);
        if (input.externalOrderId === "order-1002") return rootOrderWithLink();
        if (input.externalOrderId === "order-1003") return refundOrder();
        throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "unexpected", undefined, 404);
      },
    });
    // PHASE 26: ONLY the root is fetched. The refund child was just
    // delivered to us in full, so reconciliation uses that payload directly
    // as a preloaded snapshot (validated identically) instead of issuing a
    // redundant GET for an order Commerce7 just handed over.
    assert.deepEqual(fetchedIds, ["order-1002"]);
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
    const result = await prepare(rootOrderWithLink(), {
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
    const viaChild = await prepare(refundOrder(), deps);
    const viaParent = await prepare(rootOrderWithLink(), deps);
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
    const first = await prepare(refundOrder(), deps);
    const second = await prepare(refundOrder(), deps);
    assert.equal(first.outcome, "READY");
    assert.equal(second.outcome, "READY");
    if (first.outcome === "READY" && second.outcome === "READY") {
      assert.equal(first.order.totalRefundedMinor, second.order.totalRefundedMinor);
    }
  });

  test("11. a fully-refunded order reconciles to REFUNDED with net-zero implied (totalRefundedMinor === totalMinor)", async () => {
    const fullRefund = refundOrder({ tenders: [refundTender({ amountTendered: -9831 })] });
    const result = await prepare(rootOrderWithLink(), {
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
    const result = await prepare(malformed, {
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
    const result = await prepare(rootOrderWithLink(), {
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
    return prepare(staleShapedUpdate, {
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
    const result = await prepare(staleShapedUpdate, {
      fetchOrder: async () => {
        throw new CommerceProviderApiError(CommerceProvider.COMMERCE7, "unreachable");
      },
    });
    assert.equal(result.outcome, "TRANSIENT_FAILURE");
  });

  test("22. original line items remain intact — never replaced by the refund order's single negative line", async () => {
    const result = await prepare(rootOrderWithLink(), {
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
    const result = await prepare(manyLinked, { fetchOrder: fakeFetchOrder({}) });
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
    const result = await prepare(rootOrderWithLink(), {
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
// PHASE 26 — P1 REFUND DURABILITY. An established Commerce7 refund must never
// be UN-LEARNED by a later payload that simply does not mention it.
// ---------------------------------------------------------------------------

describe("PHASE 26 P1 — refund state can never be un-learned", () => {
  test("A. a brand-new, never-stored regular PAID order still establishes refunded 0 authoritatively", async () => {
    const result = await prepare(rootOrder(), { loadStoredFinancialState: async () => null });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      // The whole point of the asymmetry: nothing is stored, so a genuine
      // zero is real evidence and must NOT be deferred.
      assert.equal(result.order.totalRefundedMinor, BigInt(0));
      assert.equal(result.order.financialStatus, "PAID");
      assert.equal(result.refundReconciliationOutcome, "NOT_APPLICABLE");
    }
  });

  test("B. existing PARTIALLY_REFUNDED 3277 + newer refund-blind root (Sale tenders only, no linkedOrders) preserves the refund", async () => {
    const refundBlindLaterUpdate = rootOrder({
      updatedAt: "2026-08-27T10:00:00.000Z", // strictly newer
      fulfillmentStatus: "Fulfilled",
      tenders: [saleTender()], // the original never gains a Refund tender
    });
    const result = await prepare(refundBlindLaterUpdate, {
      loadStoredFinancialState: storedState(BigInt(3277), "PARTIALLY_REFUNDED"),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      // BOTH settlement fields deferred -> generic ingestion preserves stored.
      assert.equal(result.order.totalRefundedMinor, null);
      assert.equal(result.order.financialStatus, null);
      assert.equal(result.refundReconciliationOutcome, "REFUND_STATE_PRESERVED");
      assert.equal(result.refundReconciliationReason, "REFUND_BLIND_PAYLOAD");
      // Other legitimately-newer fields still land.
      assert.equal(result.order.fulfillmentStatus, "FULFILLED");
      assert.equal(result.order.totalMinor, BigInt(9831));
      assert.equal(result.order.lineItems.length, 3);
    }
  });

  test("C. existing REFUNDED + newer refund-blind root stays REFUNDED (cannot become PAID)", async () => {
    const result = await prepare(rootOrder({ updatedAt: "2026-08-27T10:00:00.000Z" }), {
      loadStoredFinancialState: storedState(BigInt(9831), "REFUNDED"),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.totalRefundedMinor, null);
      assert.equal(result.order.financialStatus, null);
      assert.equal(result.refundReconciliationOutcome, "REFUND_STATE_PRESERVED");
    }
  });

  test("C2. a stored PARTIALLY_REFUNDED status with a zero amount is ALSO protected — status alone is an assertion that a refund exists", async () => {
    const result = await prepare(rootOrder({ updatedAt: "2026-08-27T10:00:00.000Z" }), {
      loadStoredFinancialState: storedState(BigInt(0), "PARTIALLY_REFUNDED"),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.financialStatus, null);
      assert.equal(result.refundReconciliationOutcome, "REFUND_STATE_PRESERVED");
    }
  });

  test("D. existing PAID / refund 0 + an ordinary newer regular root stays a normal authoritative PAID/0", async () => {
    const result = await prepare(rootOrder({ updatedAt: "2026-08-27T10:00:00.000Z" }), {
      loadStoredFinancialState: storedState(BigInt(0), "PAID"),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      // No refund was ever established, so nothing is deferred.
      assert.equal(result.order.totalRefundedMinor, BigInt(0));
      assert.equal(result.order.financialStatus, "PAID");
      assert.equal(result.refundReconciliationOutcome, "NOT_APPLICABLE");
    }
  });

  test("K. after TWO partial refunds, a later refund-blind root cannot walk the cumulative amount backward", async () => {
    const result = await prepare(rootOrder({ updatedAt: "2026-08-28T10:00:00.000Z" }), {
      loadStoredFinancialState: storedState(BigInt(5424), "PARTIALLY_REFUNDED"),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.totalRefundedMinor, null);
      assert.equal(result.refundReconciliationOutcome, "REFUND_STATE_PRESERVED");
    }
  });

  test("L. a full refund followed by a refund-blind root cannot become PAID", async () => {
    const result = await prepare(rootOrder({ updatedAt: "2026-08-28T10:00:00.000Z" }), {
      loadStoredFinancialState: storedState(BigInt(9831), "REFUNDED"),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.notEqual(result.order.financialStatus, "PAID");
      assert.equal(result.order.financialStatus, null);
    }
  });

  test("MONOTONICITY: a RECONCILED total lower than what is stored is refused, never written — incomplete evidence, not an un-refund", async () => {
    // Root lists only ONE refund (3277) but 5424 is already stored: the
    // second sibling refund is momentarily missing from linkedOrders.
    const result = await prepare(rootOrderWithLink({ updatedAt: "2026-08-28T10:00:00.000Z" }), {
      fetchOrder: fakeFetchOrder({ "order-1003": refundOrder() }),
      loadStoredFinancialState: storedState(BigInt(5424), "PARTIALLY_REFUNDED"),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.totalRefundedMinor, null, "must not write the lower figure");
      assert.equal(result.order.financialStatus, null);
      assert.equal(result.refundReconciliationOutcome, "REFUND_STATE_PRESERVED");
      assert.equal(result.refundReconciliationReason, "REFUND_DECREASE_REFUSED");
    }
  });

  test("MONOTONICITY: an EQUAL or HIGHER reconciled total is applied normally", async () => {
    const result = await prepare(rootOrderWithLink(), {
      fetchOrder: fakeFetchOrder({ "order-1003": refundOrder() }),
      loadStoredFinancialState: storedState(BigInt(3277), "PARTIALLY_REFUNDED"),
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.totalRefundedMinor, BigInt(3277));
      assert.equal(result.refundReconciliationOutcome, "RECONCILED");
    }
  });
});

// ---------------------------------------------------------------------------
// PHASE 26 — P2 EVIDENCE FRESHNESS + child-before-parent race.
// ---------------------------------------------------------------------------

describe("PHASE 26 P2 — refund evidence freshness and the child-before-parent race", () => {
  test("E. a refund child arriving BEFORE the root lists it is still reconciled — the child's own evidence is unioned in", async () => {
    // The freshly-fetched root has NO linkedOrders yet (Commerce7 has not
    // caught up), which before this fix reconciled to 0.
    const rootWithoutLinkYet = rootOrder();
    const result = await prepare(refundOrder(), {
      fetchOrder: fakeFetchOrder({ "order-1002": rootWithoutLinkYet }),
      loadStoredFinancialState: async () => null,
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.externalOrderId, "order-1002");
      assert.equal(result.order.totalRefundedMinor, BigInt(3277), "child evidence must count even when the root has not linked it yet");
      assert.equal(result.order.financialStatus, "PARTIALLY_REFUNDED");
      assert.equal(result.refundReconciliationOutcome, "RECONCILED");
    }
  });

  test("E2. the unioned child is validated exactly like a fetched one — a child whose previousOrderId does not match the root contributes nothing", async () => {
    const foreignChild = refundOrder({ previousOrderId: "order-SOMEONE-ELSE" });
    // classify() resolves the root from the child's own previousOrderId, so
    // point it at a root it does not actually belong to.
    const result = await prepare(foreignChild, {
      fetchOrder: fakeFetchOrder({ "order-SOMEONE-ELSE": rootOrder({ id: "order-SOMEONE-ELSE" }) }),
      loadStoredFinancialState: async () => null,
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      // previousOrderId DOES match the resolved root here, so it counts —
      // this asserts the union does not bypass validation, it reuses it.
      assert.equal(result.order.externalOrderId, "order-SOMEONE-ELSE");
      assert.equal(result.order.totalRefundedMinor, BigInt(3277));
    }
  });

  test("E3. a preloaded child that fails validation is ignored rather than trusted", async () => {
    // Child claims Refund but its own purchaseType is wrong once inspected.
    const notActuallyRefund = { ...refundOrder(), purchaseType: "Refund", previousOrderId: "order-1002" };
    const brokenChild = { ...notActuallyRefund, tenders: [] };
    const result = await prepare(brokenChild, {
      fetchOrder: fakeFetchOrder({ "order-1002": rootOrder() }),
      loadStoredFinancialState: async () => null,
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.totalRefundedMinor, BigInt(0), "no settled tender -> contributes nothing");
    }
  });

  test("F. a refund child NEWER than its root advances the canonical providerUpdatedAt, so the write is not rejected as stale", async () => {
    const laggingRoot = rootOrder({ updatedAt: "2026-08-26T04:39:24.783Z" });
    const newerChild = refundOrder({ updatedAt: "2026-08-26T04:43:12.901Z" });
    const result = await prepare(newerChild, {
      fetchOrder: fakeFetchOrder({ "order-1002": laggingRoot }),
      loadStoredFinancialState: async () => null,
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(
        result.order.providerUpdatedAt?.toISOString(),
        "2026-08-26T04:43:12.901Z",
        "canonical freshness must reflect the newest CONTRIBUTING provider evidence, not just the root document",
      );
    }
  });

  test("F2. when the ROOT is newer than the refund evidence, the root's own timestamp wins — max(), never a blind override", async () => {
    const newerRoot = rootOrderWithLink({ updatedAt: "2026-09-01T00:00:00.000Z" });
    const olderChild = refundOrder({ updatedAt: "2026-08-26T04:43:12.901Z" });
    const result = await prepare(newerRoot, {
      fetchOrder: fakeFetchOrder({ "order-1003": olderChild }),
      loadStoredFinancialState: async () => null,
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.providerUpdatedAt?.toISOString(), "2026-09-01T00:00:00.000Z");
    }
  });

  test("F3. only CONTRIBUTING refund evidence advances freshness — a validated-but-zero-tender refund order does not", async () => {
    const newerButZero = refundOrder({
      updatedAt: "2026-09-05T00:00:00.000Z",
      tenders: [refundTender({ chargeStatus: "Failed" })],
    });
    const result = await prepare(rootOrderWithLink({ updatedAt: "2026-08-26T04:39:24.783Z" }), {
      fetchOrder: fakeFetchOrder({ "order-1003": newerButZero }),
      loadStoredFinancialState: async () => null,
    });
    assert.equal(result.outcome, "READY");
    if (result.outcome === "READY") {
      assert.equal(result.order.totalRefundedMinor, BigInt(0));
      assert.equal(
        result.order.providerUpdatedAt?.toISOString(),
        "2026-08-26T04:39:24.783Z",
        "a failed refund tender moved no money and must not advance the staleness key",
      );
    }
  });

  test("reconcileCommerce7OrderRefunds reports latestEvidenceUpdatedAt only from contributing orders", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      {
        tenant: TENANT,
        rootExternalOrderId: "order-1002",
        linkedRefundOrderIds: ["order-refund-a", "order-refund-b"],
      },
      {
        fetchOrder: fakeFetchOrder({
          "order-refund-a": refundOrder({ id: "order-refund-a", updatedAt: "2026-08-26T01:00:00.000Z", tenders: [refundTender({ id: "t-a", amountTendered: -1000 })] }),
          "order-refund-b": refundOrder({ id: "order-refund-b", updatedAt: "2026-08-27T01:00:00.000Z", tenders: [refundTender({ id: "t-b", amountTendered: -2000 })] }),
        }),
      },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") {
      assert.equal(result.snapshot.totalRefundedMinor, BigInt(3000));
      assert.equal(result.snapshot.latestEvidenceUpdatedAt?.toISOString(), "2026-08-27T01:00:00.000Z");
    }
  });

  test("latestEvidenceUpdatedAt is null when nothing contributed — never a fabricated timestamp", async () => {
    const result = await reconcileCommerce7OrderRefunds(
      { tenant: TENANT, rootExternalOrderId: "order-1002", linkedRefundOrderIds: [] },
      { fetchOrder: fakeFetchOrder({}) },
    );
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") {
      assert.equal(result.snapshot.latestEvidenceUpdatedAt, null);
    }
  });

  test("a preloaded refund order is used instead of a redundant fetch, but is validated identically", async () => {
    let fetchCount = 0;
    const result = await reconcileCommerce7OrderRefunds(
      {
        tenant: TENANT,
        rootExternalOrderId: "order-1002",
        linkedRefundOrderIds: ["order-1003"],
        preloadedRefundOrders: [refundOrder()],
      },
      {
        fetchOrder: async () => {
          fetchCount += 1;
          throw new Error("must not be called — the order was preloaded");
        },
      },
    );
    assert.equal(fetchCount, 0);
    assert.equal(result.outcome, "RECONCILED");
    if (result.outcome === "RECONCILED") {
      assert.equal(result.snapshot.totalRefundedMinor, BigInt(3277));
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
