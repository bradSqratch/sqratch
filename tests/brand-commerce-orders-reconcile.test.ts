/**
 * PHASE 18 — PART 9: manual bounded Commerce7 order reconciliation route.
 * Battery items 34-38.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";

import { brandCommerceReconcilePostImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/orders/reconcile/route";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../src/lib/commerce/errors";
import type { BrandAdminContext } from "../src/lib/brand-auth";
import type { Commerce7OrderBackfillOutcome } from "../src/lib/commerce/providers/commerce7-order-backfill";

function makeContext(): BrandAdminContext {
  return {
    userId: "user-1",
    selectionRequired: false,
    brands: [{ id: "brand-a", name: "Acme", slug: "acme", membershipRole: "ADMIN" }],
    membership: {
      id: "member-1",
      role: "ADMIN",
      brand: { id: "brand-a", name: "Acme", slug: "acme", bio: null, websiteUrl: null, logoUrl: null, coverImageUrl: null },
    },
  };
}

function successOutcome(
  overrides: Partial<Commerce7OrderBackfillOutcome> = {},
): Commerce7OrderBackfillOutcome {
  return {
    status: "COMPLETED",
    ordersFetched: 2,
    ordersProcessed: 2,
    outcomes: [
      { status: "CREATED", reason: null, eventId: "e1", orderId: "o1", lineItemCount: 1, attributionLinked: false, brandIdOverriddenFromConnection: false },
      { status: "UPDATED", reason: null, eventId: "e2", orderId: "o2", lineItemCount: 1, attributionLinked: false, brandIdOverriddenFromConnection: false },
    ],
    ...overrides,
  };
}

describe("34-38. brandCommerceReconcilePostImpl", () => {
  test("34. authenticated + exact connection: the resolved brandId/connectionId flow through unchanged", async () => {
    let captured: unknown = null;
    const res = await brandCommerceReconcilePostImpl(
      {
        getContext: async () => makeContext(),
        reconcile: async (input) => {
          captured = input;
          return successOutcome();
        },
      },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-05T00:00:00.000Z" },
    );
    assert.equal(res.status, 200);
    assert.equal((captured as { brandId: string }).brandId, "brand-a");
    assert.equal((captured as { connectionId: string }).connectionId, "conn-1");
    const body = await res.json();
    assert.equal(body.data.status, "SUCCEEDED");
    assert.equal(body.data.createdCount, 1);
    assert.equal(body.data.updatedCount, 1);
    assert.equal(body.data.truncated, false);
  });

  test("an unauthenticated caller never reaches reconcile()", async () => {
    let called = false;
    const res = await brandCommerceReconcilePostImpl(
      {
        getContext: async () => null,
        reconcile: async () => {
          called = true;
          return successOutcome();
        },
      },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-05T00:00:00.000Z" },
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("35. exact-connection typed errors map to the correct HTTP status", async () => {
    const notFound = await brandCommerceReconcilePostImpl(
      {
        getContext: async () => makeContext(),
        reconcile: async () => {
          throw new CommerceConnectionNotFoundError("conn-1");
        },
      },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-05T00:00:00.000Z" },
    );
    assert.equal(notFound.status, 404);

    const mismatch = await brandCommerceReconcilePostImpl(
      {
        getContext: async () => makeContext(),
        reconcile: async () => {
          throw new CommerceConnectionMismatchError("conn-1", "COMMERCE7" as never, "SHOPIFY" as never);
        },
      },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-05T00:00:00.000Z" },
    );
    assert.equal(mismatch.status, 400);

    const notReady = await brandCommerceReconcilePostImpl(
      {
        getContext: async () => makeContext(),
        reconcile: async () => {
          throw new CommerceConnectionNotReadyError("conn-1", "COMMERCE7" as never, "DISCONNECTED" as never);
        },
      },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-05T00:00:00.000Z" },
    );
    assert.equal(notReady.status, 409);
  });

  test("36. an excessive date window is rejected with 400 before reconcile() is ever called", async () => {
    let called = false;
    const res = await brandCommerceReconcilePostImpl(
      {
        getContext: async () => makeContext(),
        reconcile: async () => {
          called = true;
          return successOutcome();
        },
      },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-06-01T00:00:00.000Z" },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "WINDOW_TOO_WIDE");
    assert.equal(called, false);
  });

  test("36b. from >= to is rejected", async () => {
    const res = await brandCommerceReconcilePostImpl(
      { getContext: async () => makeContext() },
      "conn-1",
      { from: "2026-01-05T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
    );
    assert.equal(res.status, 400);
  });

  test("36c. missing or malformed from/to is rejected", async () => {
    const missing = await brandCommerceReconcilePostImpl(
      { getContext: async () => makeContext() },
      "conn-1",
      {},
    );
    assert.equal(missing.status, 400);

    const malformed = await brandCommerceReconcilePostImpl(
      { getContext: async () => makeContext() },
      "conn-1",
      { from: "not-a-date", to: "2026-01-05T00:00:00.000Z" },
    );
    assert.equal(malformed.status, 400);
  });

  test("37. a TRUNCATED backfill outcome is reported honestly — never claimed complete", async () => {
    const res = await brandCommerceReconcilePostImpl(
      {
        getContext: async () => makeContext(),
        reconcile: async () => successOutcome({ status: "TRUNCATED" }),
      },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-05T00:00:00.000Z" },
    );
    const body = await res.json();
    assert.equal(body.data.truncated, true);
    assert.equal(body.data.status, "PARTIAL");
  });

  test("38. repeated reconciliation over the SAME window with unchanged upstream data reports unchangedCount, not duplicate creates", async () => {
    const res = await brandCommerceReconcilePostImpl(
      {
        getContext: async () => makeContext(),
        reconcile: async () =>
          successOutcome({
            outcomes: [
              { status: "ALREADY_PROCESSED", reason: "DUPLICATE_DELIVERY", eventId: "e1", orderId: "o1", lineItemCount: 1, attributionLinked: false, brandIdOverriddenFromConnection: false },
            ],
          }),
      },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-05T00:00:00.000Z" },
    );
    const body = await res.json();
    assert.equal(body.data.createdCount, 0);
    assert.equal(body.data.unchangedCount, 1);
  });

  test("a failed/in-flight outcome is counted and reported as PARTIAL, never silently dropped", async () => {
    const res = await brandCommerceReconcilePostImpl(
      {
        getContext: async () => makeContext(),
        reconcile: async () =>
          successOutcome({
            outcomes: [
              { status: "FAILED", reason: "WRITE_FAILED", eventId: "e1", orderId: null, lineItemCount: 0, attributionLinked: false, brandIdOverriddenFromConnection: false },
            ],
          }),
      },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-05T00:00:00.000Z" },
    );
    const body = await res.json();
    assert.equal(body.data.failedCount, 1);
    assert.equal(body.data.status, "PARTIAL");
  });
});
