/**
 * tests/commerce7-order-reconciliation-routes.test.ts
 *
 * PHASE 22 — route-level auth/ownership/validation for the three new
 * reconciliation endpoints. Mirrors the established DI-route-test pattern
 * (`commerce7-storefront-configuration.test.ts`'s battery 13-15,
 * `commerce7-connection-lifecycle.test.ts`'s route describes).
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import { brandCommerceCatchUpPostImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/orders/catch-up/route";
import { brandCommerceReconcileRangePostImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/orders/reconcile-range/route";
import { brandCommerceReconciliationStateGetImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/orders/reconciliation-state/route";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "../src/lib/commerce/errors";
import type { BrandAdminContext } from "../src/lib/brand-auth";

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

describe("POST .../orders/catch-up", () => {
  test("unauthenticated caller never reaches catchUp()", async () => {
    let called = false;
    const res = await brandCommerceCatchUpPostImpl(
      {
        getContext: async () => null,
        catchUp: async () => {
          called = true;
          return { status: "UP_TO_DATE", reconciledThrough: null, target: new Date(), reachedTarget: true, chunk: null, ordersFetched: 0, ordersProcessed: 0, error: null };
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("CommerceConnectionNotFoundError maps to 404", async () => {
    const res = await brandCommerceCatchUpPostImpl(
      { getContext: async () => makeContext(), catchUp: async () => { throw new CommerceConnectionNotFoundError("conn-1"); } },
      "conn-1",
    );
    assert.equal(res.status, 404);
  });

  test("CommerceConnectionMismatchError maps to 400", async () => {
    const res = await brandCommerceCatchUpPostImpl(
      {
        getContext: async () => makeContext(),
        catchUp: async () => {
          throw new CommerceConnectionMismatchError("conn-1", CommerceProvider.COMMERCE7, CommerceProvider.SHOPIFY);
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 400);
  });

  test("CommerceConnectionNotReadyError maps to 409", async () => {
    const res = await brandCommerceCatchUpPostImpl(
      {
        getContext: async () => makeContext(),
        catchUp: async () => {
          throw new CommerceConnectionNotReadyError("conn-1", CommerceProvider.COMMERCE7, "DISCONNECTED");
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 409);
  });

  test("a successful PROGRESS result maps to 200 with the full progress payload", async () => {
    const res = await brandCommerceCatchUpPostImpl(
      {
        getContext: async () => makeContext(),
        catchUp: async () => ({
          status: "PROGRESS",
          reconciledThrough: new Date("2026-08-02T00:00:00.000Z"),
          target: new Date("2026-08-10T00:00:00.000Z"),
          reachedTarget: false,
          chunk: { from: new Date("2026-08-01T00:00:00.000Z"), to: new Date("2026-08-02T00:00:00.000Z") },
          ordersFetched: 3,
          ordersProcessed: 3,
          error: null,
        }),
      },
      "conn-1",
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, "PROGRESS");
    assert.equal(body.data.reachedTarget, false);
    assert.equal(body.data.ordersProcessed, 3);
  });

  test("a missing connectionId maps to 400 before catchUp() is called", async () => {
    let called = false;
    const res = await brandCommerceCatchUpPostImpl(
      { getContext: async () => makeContext(), catchUp: async () => { called = true; throw new Error("must not be called"); } },
      undefined,
    );
    assert.equal(res.status, 400);
    assert.equal(called, false);
  });
});

describe("POST .../orders/reconcile-range", () => {
  test("unauthenticated caller never reaches reconcileRange()", async () => {
    let called = false;
    const res = await brandCommerceReconcileRangePostImpl(
      { getContext: async () => null, reconcileRange: async () => { called = true; throw new Error("must not be called"); } },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("missing from/to maps to 400", async () => {
    const res = await brandCommerceReconcileRangePostImpl(
      { getContext: async () => makeContext() },
      "conn-1",
      null,
    );
    assert.equal(res.status, 400);
  });

  test("from >= to maps to 400", async () => {
    const res = await brandCommerceReconcileRangePostImpl(
      { getContext: async () => makeContext() },
      "conn-1",
      { from: "2026-01-02T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" },
    );
    assert.equal(res.status, 400);
  });

  test("a range extending into the future maps to 400", async () => {
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const evenFurther = new Date(Date.now() + 366 * 24 * 60 * 60 * 1000).toISOString();
    const res = await brandCommerceReconcileRangePostImpl(
      { getContext: async () => makeContext() },
      "conn-1",
      { from: farFuture, to: evenFurther },
    );
    assert.equal(res.status, 400);
  });

  test("a range wider than the maximum window maps to 400 with WINDOW_TOO_WIDE", async () => {
    const from = new Date("2020-01-01T00:00:00.000Z").toISOString();
    const to = new Date("2025-01-01T00:00:00.000Z").toISOString();
    const res = await brandCommerceReconcileRangePostImpl(
      { getContext: async () => makeContext() },
      "conn-1",
      { from, to },
    );
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.code, "WINDOW_TOO_WIDE");
  });

  test("CommerceConnectionNotFoundError maps to 404", async () => {
    const res = await brandCommerceReconcileRangePostImpl(
      { getContext: async () => makeContext(), reconcileRange: async () => { throw new CommerceConnectionNotFoundError("conn-1"); } },
      "conn-1",
      { from: "2026-01-01T00:00:00.000Z", to: "2026-01-02T00:00:00.000Z" },
    );
    assert.equal(res.status, 404);
  });

  test("a successful custom-range result maps to 200 and never touches the primary checkpoint fields", async () => {
    const res = await brandCommerceReconcileRangePostImpl(
      {
        getContext: async () => makeContext(),
        reconcileRange: async () => ({
          status: "PROGRESS",
          cursor: new Date("2026-08-21T00:00:00.000Z"),
          from: new Date("2026-08-20T00:00:00.000Z"),
          to: new Date("2026-08-21T00:00:00.000Z"),
          reachedTarget: true,
          chunk: { from: new Date("2026-08-20T00:00:00.000Z"), to: new Date("2026-08-21T00:00:00.000Z") },
          ordersFetched: 1,
          ordersProcessed: 1,
          error: null,
        }),
      },
      "conn-1",
      { from: "2026-08-20T00:00:00.000Z", to: "2026-08-21T00:00:00.000Z" },
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.status, "PROGRESS");
    assert.equal(body.data.reachedTarget, true);
    assert.ok(!("reconciledThrough" in body.data), "custom-range response must never expose the primary checkpoint field");
  });
});

describe("GET .../orders/reconciliation-state", () => {
  test("unauthenticated caller never reaches getState()", async () => {
    let called = false;
    const res = await brandCommerceReconciliationStateGetImpl(
      { getContext: async () => null, getState: async () => { called = true; throw new Error("must not be called"); } },
      "conn-1",
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("CommerceConnectionNotFoundError maps to 404", async () => {
    const res = await brandCommerceReconciliationStateGetImpl(
      { getContext: async () => makeContext(), getState: async () => { throw new CommerceConnectionNotFoundError("conn-1"); } },
      "conn-1",
    );
    assert.equal(res.status, 404);
  });

  test("a never-reconciled connection returns all-null state with 200, not an error", async () => {
    const res = await brandCommerceReconciliationStateGetImpl(
      {
        getContext: async () => makeContext(),
        getState: async () => ({
          reconciledThrough: null,
          targetThrough: null,
          lastAttemptedAt: null,
          lastRunOutcome: null,
          lastRunError: null,
          customRangeFrom: null,
          customRangeTo: null,
          customRangeCursor: null,
        }),
      },
      "conn-1",
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.reconciledThrough, null);
  });

  test("a reconciled connection returns the real checkpoint", async () => {
    const res = await brandCommerceReconciliationStateGetImpl(
      {
        getContext: async () => makeContext(),
        getState: async () => ({
          reconciledThrough: "2026-08-10T00:00:00.000Z",
          targetThrough: "2026-08-10T00:00:00.000Z",
          lastAttemptedAt: "2026-08-10T00:00:00.000Z",
          lastRunOutcome: "SUCCEEDED",
          lastRunError: null,
          customRangeFrom: null,
          customRangeTo: null,
          customRangeCursor: null,
        }),
      },
      "conn-1",
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.reconciledThrough, "2026-08-10T00:00:00.000Z");
  });
});
