import assert from "node:assert/strict";
import test from "node:test";

import { idempotencyMatch } from "../src/lib/redemption-idempotency";

test("idempotencyMatch — MATCH when same user and same offer", () => {
  const result = idempotencyMatch(
    { userId: "user-1", offerId: "offer-a" },
    { userId: "user-1", offerId: "offer-a" },
  );
  assert.equal(result, "MATCH");
});

test("idempotencyMatch — USER_MISMATCH when different user", () => {
  const result = idempotencyMatch(
    { userId: "user-1", offerId: "offer-a" },
    { userId: "user-2", offerId: "offer-a" },
  );
  assert.equal(result, "USER_MISMATCH");
});

test("idempotencyMatch — OFFER_MISMATCH when same user but different offer", () => {
  const result = idempotencyMatch(
    { userId: "user-1", offerId: "offer-a" },
    { userId: "user-1", offerId: "offer-b" },
  );
  assert.equal(result, "OFFER_MISMATCH");
});

test("idempotencyMatch — USER_MISMATCH takes priority over offer diff (different user AND different offer)", () => {
  const result = idempotencyMatch(
    { userId: "user-1", offerId: "offer-a" },
    { userId: "user-2", offerId: "offer-b" },
  );
  assert.equal(result, "USER_MISMATCH");
});
