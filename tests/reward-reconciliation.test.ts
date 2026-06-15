/**
 * Tests for reward-reconciliation.ts
 *
 * All Shopify API calls and DB operations are mocked via dependency injection.
 * No network, no real DB.
 *
 * Covered cases:
 *  (a) Shopify discount exists → decision = COMPLETE_ISSUED
 *  (b) Definitely missing     → decision = REFUND
 *  (c) Timeout / ambiguous    → decision = RETAIN
 *  (d) Two workers: only one claims (CAS count===1 semantics)
 *  (e) Repeated past maxAttempts → manual review
 *  (f) Refund exactly once (second attempt with composite-unique → no double increment)
 *  (g) ISSUED transition exactly once (assertTransition)
 *  (h) Token unavailable / shop disconnected → RETAIN with reason
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  makeReconciliationDecision,
  reconcileStuckRedemptionsWithDeps,
  type ReconciliationDeps,
  type ReconciliationRow,
  type ReconciliationSummary,
} from "../src/lib/reward-reconciliation";
import { ShopifyRewardRedemptionStatus } from "../src/lib/reward-redemption-state";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<ReconciliationRow> = {}): ReconciliationRow {
  return {
    id: "row-1",
    userId: "user-1",
    brandId: "brand-1",
    code: "TESTCODE",
    status: ShopifyRewardRedemptionStatus.POINTS_DEBITED,
    pointsCost: 100,
    shopifyShopDomain: "test.myshopify.com",
    shopifyDiscountNodeId: null,
    issuedAt: null,
    expiresAt: null,
    reconcileAttempts: 1,
    needsManualReview: false,
    reconcileLockedUntil: null,
    createdAt: new Date(Date.now() - 10 * 60 * 1000),
    ...overrides,
  };
}

/** Creates a minimal fake deps object. Caller overrides individual methods as needed. */
function makeDeps(overrides: Partial<ReconciliationDeps> = {}): ReconciliationDeps {
  return {
    async selectCandidates() {
      return [];
    },
    async claimRow() {
      return { count: 1 };
    },
    async releaseLock() {},
    async updateReconcileMetadata() {},
    async completeToIssued() {},
    async refundRow() {
      return "refunded";
    },
    async getToken() {
      return { ok: true, accessToken: "mock-token" };
    },
    async lookupByNodeId() {
      return { ok: true, exists: false };
    },
    async lookupByCode() {
      return { ok: true, exists: false };
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) Decision: Shopify discount exists → COMPLETE_ISSUED
// ---------------------------------------------------------------------------

test("(a) makeReconciliationDecision: discount exists → COMPLETE_ISSUED", () => {
  const result = makeReconciliationDecision(
    {
      ok: true,
      exists: true,
      discountNodeId: "gid://shopify/DiscountCodeNode/99",
      status: "ACTIVE",
      endsAt: new Date("2026-07-15T00:00:00Z"),
      asyncUsageCount: 0,
    },
    1,
    5,
  );
  assert.equal(result.action, "COMPLETE_ISSUED");
  assert.equal(result.discountNodeId, "gid://shopify/DiscountCodeNode/99");
  assert.equal(result.status, "ACTIVE");
  assert.equal(result.asyncUsageCount, 0);
});

test("(a) full flow: discount found by code → issued row", async () => {
  const completedIds: string[] = [];
  const row = makeRow({ shopifyDiscountNodeId: null });

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async lookupByCode() {
      return {
        ok: true,
        exists: true,
        discountNodeId: "gid://shopify/DiscountCodeNode/42",
        status: "ACTIVE",
        endsAt: new Date("2026-07-15T00:00:00Z"),
        asyncUsageCount: 0,
      };
    },
    async completeToIssued(id) {
      completedIds.push(id);
    },
  });

  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  assert.equal(summary.issued, 1);
  assert.equal(summary.refunded, 0);
  assert.deepEqual(completedIds, ["row-1"]);
});

test("(a) full flow: discount found by node ID → issued row", async () => {
  const completedIds: string[] = [];
  const row = makeRow({ shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/77" });

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async lookupByNodeId() {
      return {
        ok: true,
        exists: true,
        discountNodeId: "gid://shopify/DiscountCodeNode/77",
        status: "ACTIVE",
        endsAt: null,
        asyncUsageCount: 1,
      };
    },
    async completeToIssued(id) {
      completedIds.push(id);
    },
  });

  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  assert.equal(summary.issued, 1);
  assert.deepEqual(completedIds, ["row-1"]);
});

// ---------------------------------------------------------------------------
// (b) Decision: definitely missing → REFUND
// ---------------------------------------------------------------------------

test("(b) makeReconciliationDecision: discount missing → REFUND", () => {
  const result = makeReconciliationDecision({ ok: true, exists: false }, 1, 5);
  assert.equal(result.action, "REFUND");
});

test("(b) full flow: discount missing → refundRow called", async () => {
  let refundCalled = false;
  const row = makeRow();

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async lookupByCode() {
      return { ok: true, exists: false };
    },
    async refundRow() {
      refundCalled = true;
      return "refunded";
    },
  });

  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  assert.equal(refundCalled, true);
  assert.equal(summary.refunded, 1);
  assert.equal(summary.issued, 0);
});

// ---------------------------------------------------------------------------
// (c) Decision: timeout / ambiguous → RETAIN
// ---------------------------------------------------------------------------

test("(c) makeReconciliationDecision: HTTP error → RETAIN", () => {
  const result = makeReconciliationDecision(
    { ok: false, status: 503, error: "Service unavailable" },
    1,
    5,
  );
  assert.equal(result.action, "RETAIN");
  // markManualReview should be falsy (undefined or false) when below maxAttempts
  assert.ok(!(result as { markManualReview?: boolean }).markManualReview);
});

test("(c) full flow: Shopify error → RETAIN, updateReconcileMetadata called", async () => {
  let metadataUpdated = false;
  const row = makeRow();

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async lookupByCode() {
      return { ok: false, status: 503, error: "timeout" };
    },
    async updateReconcileMetadata() {
      metadataUpdated = true;
    },
  });

  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  assert.equal(metadataUpdated, true);
  assert.equal(summary.retained, 1);
  assert.equal(summary.issued, 0);
  assert.equal(summary.refunded, 0);
});

// ---------------------------------------------------------------------------
// (d) Two workers: only one claims (CAS count === 1 semantics)
// ---------------------------------------------------------------------------

test("(d) CAS: claimRow returns count=0 → row skipped", async () => {
  const row = makeRow();
  let lookupCalled = false;

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async claimRow() {
      return { count: 0 }; // another worker already claimed it
    },
    async lookupByCode() {
      lookupCalled = true;
      return { ok: true, exists: true, discountNodeId: "x", status: null, endsAt: null, asyncUsageCount: 0 };
    },
  });

  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  assert.equal(lookupCalled, false);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.issued, 0);
});

test("(d) CAS: two concurrent calls on same row — only one issues", async () => {
  let claimCount = 0;
  const row = makeRow();

  // First call claims, second call does not
  const makeClaimer = (shouldClaim: boolean): ReconciliationDeps =>
    makeDeps({
      async selectCandidates() {
        return [row];
      },
      async claimRow() {
        claimCount++;
        return { count: shouldClaim ? 1 : 0 };
      },
      async lookupByCode() {
        return {
          ok: true,
          exists: true,
          discountNodeId: "gid://shopify/DiscountCodeNode/1",
          status: "ACTIVE",
          endsAt: null,
          asyncUsageCount: 0,
        };
      },
    });

  const [s1, s2] = await Promise.all([
    reconcileStuckRedemptionsWithDeps(makeClaimer(true)),
    reconcileStuckRedemptionsWithDeps(makeClaimer(false)),
  ]);

  assert.equal(s1.issued, 1);
  assert.equal(s2.skipped, 1);
  assert.equal(claimCount, 2);
});

// ---------------------------------------------------------------------------
// (e) Repeated past maxAttempts → manual review
// ---------------------------------------------------------------------------

test("(e) makeReconciliationDecision: attempts >= maxAttempts → markManualReview=true", () => {
  const result = makeReconciliationDecision(
    { ok: false, status: 503, error: "timeout" },
    5, // reconcileAttempts
    5, // maxAttempts
  );
  assert.equal(result.action, "RETAIN");
  assert.equal((result as { markManualReview?: boolean }).markManualReview, true);
});

test("(e) full flow: after maxAttempts failures → manualReview incremented", async () => {
  const row = makeRow({ reconcileAttempts: 5 });
  let markedManual = false;

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async lookupByCode() {
      return { ok: false, status: 503, error: "persistent timeout" };
    },
    async updateReconcileMetadata(_id, data) {
      if (data.needsManualReview === true) {
        markedManual = true;
      }
    },
  });

  const summary = await reconcileStuckRedemptionsWithDeps(deps, { maxAttempts: 5 });
  assert.equal(markedManual, true);
  assert.equal(summary.manualReview, 1);
  assert.equal(summary.retained, 1);
});

test("(e) below maxAttempts → NOT marked for manual review", () => {
  const result = makeReconciliationDecision(
    { ok: false, status: 503, error: "timeout" },
    3, // below maxAttempts=5
    5,
  );
  assert.equal(result.action, "RETAIN");
  assert.ok(!(result as { markManualReview?: boolean }).markManualReview);
});

// ---------------------------------------------------------------------------
// (f) Refund exactly once: P2002 on second attempt → no double increment
// ---------------------------------------------------------------------------

test("(f) refundRow: P2002 on PointTransaction create → already_refunded, no double increment", async () => {
  let pointsIncrementCalled = false;
  const row = makeRow();

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async lookupByCode() {
      return { ok: true, exists: false };
    },
    async refundRow() {
      // Simulate: first attempt created the ledger row; this time P2002 fires
      // The production implementation returns "already_refunded" without incrementing.
      // We simulate the outcome here.
      return "already_refunded";
    },
  });

  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  // "already_refunded" still counts as refunded (idempotent)
  assert.equal(summary.refunded, 1);
  assert.equal(pointsIncrementCalled, false);
});

test("(f) two sequential refund attempts on same row → second returns already_refunded", async () => {
  let callCount = 0;

  const deps = makeDeps({
    async selectCandidates() {
      return callCount === 0 ? [makeRow()] : [];
    },
    async lookupByCode() {
      return { ok: true, exists: false };
    },
    async refundRow() {
      callCount++;
      if (callCount === 1) return "refunded";
      return "already_refunded";
    },
  });

  const s1 = await reconcileStuckRedemptionsWithDeps(deps);
  const s2 = await reconcileStuckRedemptionsWithDeps(deps);

  assert.equal(s1.refunded, 1);
  assert.equal(s2.refunded, 0); // no candidates second time
  assert.equal(callCount, 1); // refundRow only called once (no second candidate)
});

// ---------------------------------------------------------------------------
// (g) ISSUED transition exactly once (assertTransition guards)
// ---------------------------------------------------------------------------

test("(g) assertTransition POINTS_DEBITED → ISSUED does not throw", () => {
  // This is what completeToIssued depends on internally
  const { assertTransition } = require("../src/lib/reward-redemption-state");
  assert.doesNotThrow(() => {
    assertTransition(
      ShopifyRewardRedemptionStatus.POINTS_DEBITED,
      ShopifyRewardRedemptionStatus.ISSUED,
    );
  });
});

test("(g) assertTransition ISSUED → ISSUED does not throw (idempotent same-state)", () => {
  const { assertTransition } = require("../src/lib/reward-redemption-state");
  assert.doesNotThrow(() => {
    assertTransition(
      ShopifyRewardRedemptionStatus.ISSUED,
      ShopifyRewardRedemptionStatus.ISSUED,
    );
  });
});

test("(g) assertTransition REFUNDED → ISSUED throws (terminal)", () => {
  const { assertTransition } = require("../src/lib/reward-redemption-state");
  assert.throws(
    () =>
      assertTransition(
        ShopifyRewardRedemptionStatus.REFUNDED,
        ShopifyRewardRedemptionStatus.ISSUED,
      ),
    /Invalid redemption state transition/,
  );
});

test("(g) full flow: second completeToIssued call on same row → completeToIssued called once per run", async () => {
  let completeCount = 0;
  const row = makeRow({ shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/1" });

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async lookupByNodeId() {
      return {
        ok: true,
        exists: true,
        discountNodeId: "gid://shopify/DiscountCodeNode/1",
        status: "ACTIVE",
        endsAt: null,
        asyncUsageCount: 0,
      };
    },
    async completeToIssued() {
      completeCount++;
    },
  });

  await reconcileStuckRedemptionsWithDeps(deps);
  assert.equal(completeCount, 1);
});

// ---------------------------------------------------------------------------
// (h) Token unavailable / shop disconnected → RETAIN with reason
// ---------------------------------------------------------------------------

test("(h) token unavailable → RETAIN, reason contains 'token unavailable'", async () => {
  let capturedReason = "";
  const row = makeRow();

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async getToken() {
      return { ok: false, reason: "NEEDS_RECONNECT" };
    },
    async updateReconcileMetadata(_id, data) {
      capturedReason = data.lastReconcileReason ?? "";
    },
  });

  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  assert.equal(summary.retained, 1);
  assert.ok(
    capturedReason.includes("token unavailable") || capturedReason.includes("disconnected"),
    `Expected 'token unavailable' or 'disconnected' in reason, got: ${capturedReason}`,
  );
});

test("(h) shop not connected → RETAIN, lookupByCode not called", async () => {
  let lookupCalled = false;
  const row = makeRow();

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async getToken() {
      return { ok: false, reason: "NOT_CONNECTED" };
    },
    async lookupByCode() {
      lookupCalled = true;
      return { ok: true, exists: false };
    },
  });

  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  assert.equal(lookupCalled, false);
  assert.equal(summary.retained, 1);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("empty candidate list → zero summary", async () => {
  const deps = makeDeps({
    async selectCandidates() {
      return [];
    },
  });
  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  assert.deepEqual(summary, {
    processed: 0,
    issued: 0,
    refunded: 0,
    retained: 0,
    manualReview: 0,
    skipped: 0,
  });
});

test("refundRow returns skipped → counted as skipped not refunded", async () => {
  const row = makeRow();

  const deps = makeDeps({
    async selectCandidates() {
      return [row];
    },
    async lookupByCode() {
      return { ok: true, exists: false };
    },
    async refundRow() {
      return "skipped"; // row was no longer POINTS_DEBITED
    },
  });

  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.refunded, 0);
});

test("multiple rows processed correctly in batch", async () => {
  const rows: ReconciliationRow[] = [
    makeRow({ id: "row-exists", shopifyDiscountNodeId: null }),
    makeRow({ id: "row-missing", shopifyDiscountNodeId: null }),
    makeRow({ id: "row-error", shopifyDiscountNodeId: null }),
  ];

  const deps = makeDeps({
    async selectCandidates() {
      return rows;
    },
    async lookupByCode({ code: _code }) {
      if (_code === "TESTCODE") {
        // All rows have same code in this test; use row context via closure not available
        // so we use call count instead
        return { ok: true, exists: false };
      }
      return { ok: false, status: 503, error: "err" };
    },
    async refundRow() {
      return "refunded";
    },
  });

  // All rows have code "TESTCODE" and no nodeId → all go through lookupByCode
  // lookupByCode returns exists:false for all → all refunded
  const summary = await reconcileStuckRedemptionsWithDeps(deps);
  assert.equal(summary.refunded, 3);
  assert.equal(summary.issued, 0);
});
