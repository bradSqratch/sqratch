import { test } from "node:test";
import assert from "node:assert/strict";

import { ShopifyRewardRedemptionStatus } from "@prisma/client";
import {
  REDEMPTION_STATUSES,
  ALLOWED_TRANSITIONS,
  TERMINAL_STATUSES,
  CLAIM_COUNTED_REDEMPTION_STATUSES,
  REFRESH_ELIGIBLE_STATUSES,
  RECONCILIATION_ELIGIBLE_STATUSES,
  isTerminal,
  canRefresh,
  countsTowardLimit,
  isValidTransition,
  assertTransition,
} from "../src/lib/reward-redemption-state";

const S = ShopifyRewardRedemptionStatus;

// ---------------------------------------------------------------------------
// REDEMPTION_STATUSES — all 8 values are present
// ---------------------------------------------------------------------------

test("REDEMPTION_STATUSES contains all 8 statuses", () => {
  const expected = [
    S.PENDING,
    S.POINTS_DEBITED,
    S.ISSUED,
    S.USED,
    S.EXPIRED,
    S.FAILED,
    S.REFUNDED,
    S.CANCELLED,
  ];
  assert.equal(REDEMPTION_STATUSES.length, 8);
  for (const s of expected) {
    assert.ok(REDEMPTION_STATUSES.includes(s), `Missing status: ${s}`);
  }
});

// ---------------------------------------------------------------------------
// ALLOWED_TRANSITIONS — valid transitions return true / do not throw
// ---------------------------------------------------------------------------

test("valid transitions: PENDING → POINTS_DEBITED, FAILED, CANCELLED", () => {
  for (const to of [S.POINTS_DEBITED, S.FAILED, S.CANCELLED]) {
    assert.ok(isValidTransition(S.PENDING, to), `Expected PENDING→${to} to be valid`);
    assert.doesNotThrow(() => assertTransition(S.PENDING, to));
  }
});

test("valid transitions: POINTS_DEBITED → ISSUED, REFUNDED, FAILED", () => {
  for (const to of [S.ISSUED, S.REFUNDED, S.FAILED]) {
    assert.ok(isValidTransition(S.POINTS_DEBITED, to), `Expected POINTS_DEBITED→${to} to be valid`);
    assert.doesNotThrow(() => assertTransition(S.POINTS_DEBITED, to));
  }
});

test("valid transitions: ISSUED → USED, EXPIRED", () => {
  for (const to of [S.USED, S.EXPIRED]) {
    assert.ok(isValidTransition(S.ISSUED, to), `Expected ISSUED→${to} to be valid`);
    assert.doesNotThrow(() => assertTransition(S.ISSUED, to));
  }
});

test("terminal statuses have no outgoing transitions", () => {
  for (const terminal of TERMINAL_STATUSES) {
    assert.deepEqual(
      ALLOWED_TRANSITIONS[terminal],
      [],
      `Expected no transitions from terminal status ${terminal}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Same-status no-ops are valid (idempotent)
// ---------------------------------------------------------------------------

test("same-status transitions are valid no-ops for all 8 statuses", () => {
  for (const s of REDEMPTION_STATUSES) {
    assert.ok(isValidTransition(s, s), `Expected ${s}→${s} to be a valid no-op`);
    assert.doesNotThrow(() => assertTransition(s, s), `assertTransition(${s}, ${s}) should not throw`);
  }
});

// ---------------------------------------------------------------------------
// Invalid transitions return false / throw
// ---------------------------------------------------------------------------

test("invalid transition: REFUNDED → USED returns false and throws", () => {
  assert.equal(isValidTransition(S.REFUNDED, S.USED), false);
  assert.throws(() => assertTransition(S.REFUNDED, S.USED), /Invalid redemption state transition/);
});

test("invalid transition: FAILED → ISSUED returns false and throws", () => {
  assert.equal(isValidTransition(S.FAILED, S.ISSUED), false);
  assert.throws(() => assertTransition(S.FAILED, S.ISSUED), /Invalid redemption state transition/);
});

test("invalid transition: USED → EXPIRED returns false and throws", () => {
  assert.equal(isValidTransition(S.USED, S.EXPIRED), false);
  assert.throws(() => assertTransition(S.USED, S.EXPIRED), /Invalid redemption state transition/);
});

test("invalid transition: CANCELLED → POINTS_DEBITED returns false and throws", () => {
  assert.equal(isValidTransition(S.CANCELLED, S.POINTS_DEBITED), false);
  assert.throws(() => assertTransition(S.CANCELLED, S.POINTS_DEBITED), /Invalid redemption state transition/);
});

test("invalid transition: ISSUED → PENDING returns false and throws", () => {
  assert.equal(isValidTransition(S.ISSUED, S.PENDING), false);
  assert.throws(() => assertTransition(S.ISSUED, S.PENDING), /Invalid redemption state transition/);
});

test("invalid transition: EXPIRED → USED returns false and throws", () => {
  assert.equal(isValidTransition(S.EXPIRED, S.USED), false);
  assert.throws(() => assertTransition(S.EXPIRED, S.USED), /Invalid redemption state transition/);
});

test("invalid transition: PENDING → ISSUED returns false and throws", () => {
  assert.equal(isValidTransition(S.PENDING, S.ISSUED), false);
  assert.throws(() => assertTransition(S.PENDING, S.ISSUED), /Invalid redemption state transition/);
});

// ---------------------------------------------------------------------------
// isTerminal — all 8 statuses
// ---------------------------------------------------------------------------

test("isTerminal is true for USED, EXPIRED, REFUNDED, FAILED, CANCELLED", () => {
  for (const s of [S.USED, S.EXPIRED, S.REFUNDED, S.FAILED, S.CANCELLED]) {
    assert.ok(isTerminal(s), `Expected ${s} to be terminal`);
  }
});

test("isTerminal is false for PENDING, POINTS_DEBITED, ISSUED", () => {
  for (const s of [S.PENDING, S.POINTS_DEBITED, S.ISSUED]) {
    assert.equal(isTerminal(s), false, `Expected ${s} to NOT be terminal`);
  }
});

// ---------------------------------------------------------------------------
// canRefresh — true only for ISSUED
// ---------------------------------------------------------------------------

test("canRefresh is true only for ISSUED", () => {
  assert.ok(canRefresh(S.ISSUED));
  assert.equal(REFRESH_ELIGIBLE_STATUSES.length, 1);
  assert.equal(REFRESH_ELIGIBLE_STATUSES[0], S.ISSUED);
});

test("canRefresh is false for all non-ISSUED statuses", () => {
  const nonIssued = REDEMPTION_STATUSES.filter((s) => s !== S.ISSUED);
  for (const s of nonIssued) {
    assert.equal(canRefresh(s), false, `Expected canRefresh(${s}) to be false`);
  }
});

// ---------------------------------------------------------------------------
// countsTowardLimit — matches the expected counted set
// ---------------------------------------------------------------------------

test("countsTowardLimit is true for PENDING, POINTS_DEBITED, ISSUED, USED, EXPIRED", () => {
  for (const s of [S.PENDING, S.POINTS_DEBITED, S.ISSUED, S.USED, S.EXPIRED]) {
    assert.ok(countsTowardLimit(s), `Expected ${s} to count toward limit`);
  }
});

test("countsTowardLimit is false for FAILED, REFUNDED, CANCELLED", () => {
  for (const s of [S.FAILED, S.REFUNDED, S.CANCELLED]) {
    assert.equal(countsTowardLimit(s), false, `Expected ${s} to NOT count toward limit`);
  }
});

test("CLAIM_COUNTED_REDEMPTION_STATUSES contains exactly 5 entries", () => {
  assert.equal(CLAIM_COUNTED_REDEMPTION_STATUSES.length, 5);
});

// ---------------------------------------------------------------------------
// RECONCILIATION_ELIGIBLE_STATUSES
// ---------------------------------------------------------------------------

test("RECONCILIATION_ELIGIBLE_STATUSES contains only POINTS_DEBITED", () => {
  assert.equal(RECONCILIATION_ELIGIBLE_STATUSES.length, 1);
  assert.equal(RECONCILIATION_ELIGIBLE_STATUSES[0], S.POINTS_DEBITED);
});

// ---------------------------------------------------------------------------
// assertTransition error message clarity
// ---------------------------------------------------------------------------

test("assertTransition error message includes from, to, and allowed list", () => {
  try {
    assertTransition(S.REFUNDED, S.PENDING);
    assert.fail("Expected error to be thrown");
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.ok(err.message.includes("REFUNDED"), "Error should mention from status");
    assert.ok(err.message.includes("PENDING"), "Error should mention to status");
    assert.ok(err.message.includes("none"), "Error should mention no allowed transitions");
  }
});
