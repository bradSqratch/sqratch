/**
 * PHASE 18 — PART 13 (folds PART 11/12): Commerce7 connection diagnostics.
 * Battery items 39-42.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CommerceProvider } from "@prisma/client";

import {
  getCommerce7ConnectionDiagnostics,
  type Commerce7ConnectionDiagnosticsRow,
} from "../src/lib/commerce/providers/commerce7-diagnostics";
import { commerce7DiagnosticsGetImpl } from "../src/app/api/brand/commerce/connections/[connectionId]/diagnostics/route";
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

function connectionRow(
  overrides: Partial<Commerce7ConnectionDiagnosticsRow> = {},
): Commerce7ConnectionDiagnosticsRow {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    storefrontUrl: "https://shop.example.com",
    providerMetadata: { currencyCode: "USD", productRoute: "/product" },
    lastProductSyncAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("39-42. getCommerce7ConnectionDiagnostics", () => {
  test("39. the diagnostics object never contains a secret/credential-shaped field", async () => {
    const original = { id: process.env.COMMERCE7_APP_ID, secret: process.env.COMMERCE7_APP_SECRET };
    process.env.COMMERCE7_APP_ID = "test-id";
    process.env.COMMERCE7_APP_SECRET = "test-secret-value-must-never-leak";
    try {
      const result = await getCommerce7ConnectionDiagnostics("conn-1", "brand-a", {
        findConnection: async () => connectionRow(),
        hasAnyProduct: async () => true,
        findLatestOrderIngestedAt: async () => null,
        findLatestProcessedWebhookAt: async () => null,
        findLatestFailedWebhookEvent: async () => null,
      });
      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes("test-secret-value-must-never-leak"));
      for (const forbidden of ["secret", "password", "token", "encryptedPayload", "authorization"]) {
        assert.ok(!serialized.toLowerCase().includes(forbidden), `must not contain "${forbidden}"`);
      }
    } finally {
      if (original.id === undefined) delete process.env.COMMERCE7_APP_ID;
      else process.env.COMMERCE7_APP_ID = original.id;
      if (original.secret === undefined) delete process.env.COMMERCE7_APP_SECRET;
      else process.env.COMMERCE7_APP_SECRET = original.secret;
    }
  });

  test("40. orderReceiverConfigured reflects whether the webhook credential env vars are set — never the App Secret", async () => {
    const originalU = process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME;
    const originalP = process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD;
    delete process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME;
    delete process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD;
    try {
      const unconfigured = await getCommerce7ConnectionDiagnostics("conn-1", "brand-a", {
        findConnection: async () => connectionRow(),
        hasAnyProduct: async () => false,
        findLatestOrderIngestedAt: async () => null,
        findLatestProcessedWebhookAt: async () => null,
        findLatestFailedWebhookEvent: async () => null,
      });
      assert.equal(unconfigured?.orderReceiverConfigured, false);

      process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME = "hookuser";
      process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD = "hookpass";
      const configured = await getCommerce7ConnectionDiagnostics("conn-1", "brand-a", {
        findConnection: async () => connectionRow(),
        hasAnyProduct: async () => false,
        findLatestOrderIngestedAt: async () => null,
        findLatestProcessedWebhookAt: async () => null,
        findLatestFailedWebhookEvent: async () => null,
      });
      assert.equal(configured?.orderReceiverConfigured, true);
    } finally {
      if (originalU === undefined) delete process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME;
      else process.env.COMMERCE7_ORDER_WEBHOOK_USERNAME = originalU;
      if (originalP === undefined) delete process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD;
      else process.env.COMMERCE7_ORDER_WEBHOOK_PASSWORD = originalP;
    }
  });

  test("41. connection state reflects live status — CONNECTED true, non-CONNECTED false", async () => {
    const originalId = process.env.COMMERCE7_APP_ID;
    const originalSecret = process.env.COMMERCE7_APP_SECRET;
    process.env.COMMERCE7_APP_ID = "test-id";
    process.env.COMMERCE7_APP_SECRET = "test-secret";
    try {
      const connected = await getCommerce7ConnectionDiagnostics("conn-1", "brand-a", {
        findConnection: async () => connectionRow({ status: "CONNECTED" }),
        hasAnyProduct: async () => true,
        findLatestOrderIngestedAt: async () => null,
        findLatestProcessedWebhookAt: async () => null,
        findLatestFailedWebhookEvent: async () => null,
      });
      assert.equal(connected?.connected, true);
      assert.equal(connected?.orderReadOperational, true, "CONNECTED plus a configured app must be order-read-operational");

      const disconnected = await getCommerce7ConnectionDiagnostics("conn-1", "brand-a", {
        findConnection: async () => connectionRow({ status: "DISCONNECTED" }),
        hasAnyProduct: async () => true,
        findLatestOrderIngestedAt: async () => null,
        findLatestProcessedWebhookAt: async () => null,
        findLatestFailedWebhookEvent: async () => null,
      });
      assert.equal(disconnected?.connected, false);
      assert.equal(disconnected?.orderReadOperational, false, "a non-CONNECTED connection can never be order-read-operational");
    } finally {
      if (originalId === undefined) delete process.env.COMMERCE7_APP_ID;
      else process.env.COMMERCE7_APP_ID = originalId;
      if (originalSecret === undefined) delete process.env.COMMERCE7_APP_SECRET;
      else process.env.COMMERCE7_APP_SECRET = originalSecret;
    }
  });

  test("41b. storefrontUrl/productRoute/currency configured flags reflect the actual stored config", async () => {
    const configured = await getCommerce7ConnectionDiagnostics("conn-1", "brand-a", {
      findConnection: async () => connectionRow(),
      hasAnyProduct: async () => true,
      findLatestOrderIngestedAt: async () => null,
      findLatestProcessedWebhookAt: async () => null,
      findLatestFailedWebhookEvent: async () => null,
    });
    assert.equal(configured?.storefrontUrlConfigured, true);
    assert.equal(configured?.productRouteConfigured, true);
    assert.equal(configured?.currencyConfigured, true);
    assert.equal(configured?.productsSynced, true);

    const unconfigured = await getCommerce7ConnectionDiagnostics("conn-1", "brand-a", {
      findConnection: async () => connectionRow({ storefrontUrl: null, providerMetadata: null }),
      hasAnyProduct: async () => false,
      findLatestOrderIngestedAt: async () => null,
      findLatestProcessedWebhookAt: async () => null,
      findLatestFailedWebhookEvent: async () => null,
    });
    assert.equal(unconfigured?.storefrontUrlConfigured, false);
    assert.equal(unconfigured?.productRouteConfigured, false);
    assert.equal(unconfigured?.currencyConfigured, false);
    assert.equal(unconfigured?.productsSynced, false);
  });

  test("42. latest order/webhook event state is surfaced from canonical data, null when none exists", async () => {
    const withData = await getCommerce7ConnectionDiagnostics("conn-1", "brand-a", {
      findConnection: async () => connectionRow(),
      hasAnyProduct: async () => true,
      findLatestOrderIngestedAt: async () => new Date("2026-01-10T00:00:00.000Z"),
      findLatestProcessedWebhookAt: async () => new Date("2026-01-11T00:00:00.000Z"),
      findLatestFailedWebhookEvent: async () => ({
        receivedAt: new Date("2026-01-09T00:00:00.000Z"),
        failureSummary: "WRITE_FAILED: transient",
      }),
    });
    assert.equal(withData?.latestOrderIngestedAt, "2026-01-10T00:00:00.000Z");
    assert.equal(withData?.latestWebhookProcessedAt, "2026-01-11T00:00:00.000Z");
    assert.equal(withData?.latestFailedWebhookEvent?.receivedAt, "2026-01-09T00:00:00.000Z");

    const withoutData = await getCommerce7ConnectionDiagnostics("conn-1", "brand-a", {
      findConnection: async () => connectionRow(),
      hasAnyProduct: async () => false,
      findLatestOrderIngestedAt: async () => null,
      findLatestProcessedWebhookAt: async () => null,
      findLatestFailedWebhookEvent: async () => null,
    });
    assert.equal(withoutData?.latestOrderIngestedAt, null);
    assert.equal(withoutData?.latestWebhookProcessedAt, null);
    assert.equal(withoutData?.latestFailedWebhookEvent, null);
  });

  // ---------------------------------------------------------------------
  // PHASE 25 — PART 16: `latestWebhookProcessedAt` / `latestFailedWebhookEvent`
  // must be scoped to genuine webhook topics, never a `commerce7:order:backfill`
  // event. The DEFAULT query implementations are not DI-injectable data
  // sources (they ARE the thing under test), so this is proven by source
  // inspection against the real Prisma query text — same idiom already used
  // for the equivalent Order Operations fix in
  // tests/order-analytics.test.ts / tests/commerce-order-webhook-metric.test.ts.
  // ---------------------------------------------------------------------
  test("43. the default latest-processed-webhook query is scoped to the genuine webhook topic allow-list, not status alone", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/providers/commerce7-diagnostics.ts"),
      "utf8",
    );
    const fnBody = source.slice(
      source.indexOf("async function defaultFindLatestProcessedWebhookAt"),
      source.indexOf("async function defaultFindLatestFailedWebhookEvent"),
    );
    assert.match(fnBody, /status:\s*"PROCESSED"/);
    assert.match(fnBody, /topic:\s*{\s*in:\s*orderWebhookTopicsForProvider\(CommerceProvider\.COMMERCE7\)\s*}/);
  });

  test("44. the default latest-failed-webhook-event query is ALSO scoped to the genuine webhook topic allow-list — a failed backfill must never read as a failed webhook", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/providers/commerce7-diagnostics.ts"),
      "utf8",
    );
    const fnBody = source.slice(
      source.indexOf("async function defaultFindLatestFailedWebhookEvent"),
      source.indexOf("const DEFAULT_DEPS"),
    );
    assert.match(fnBody, /status:\s*"FAILED"/);
    assert.match(fnBody, /topic:\s*{\s*in:\s*orderWebhookTopicsForProvider\(CommerceProvider\.COMMERCE7\)\s*}/);
  });

  test("45. the topic allow-list is IMPORTED from order-operations-summary.ts, never re-declared — no duplicate topic list to drift", () => {
    const source = readFileSync(
      join(process.cwd(), "src/lib/commerce/providers/commerce7-diagnostics.ts"),
      "utf8",
    );
    assert.match(source, /import\s*{\s*orderWebhookTopicsForProvider\s*}\s*from\s*"\.\.\/order-operations-summary"/);
    assert.doesNotMatch(source, /"commerce7:order:Create"/);
    assert.doesNotMatch(source, /"commerce7:order:Update"/);
  });

  test("a foreign-brand connectionId resolves to null — indistinguishable from missing", async () => {
    const result = await getCommerce7ConnectionDiagnostics("conn-1", "brand-a", {
      findConnection: async () => connectionRow({ brandId: "brand-OTHER" }),
      hasAnyProduct: async () => true,
      findLatestOrderIngestedAt: async () => null,
      findLatestProcessedWebhookAt: async () => null,
      findLatestFailedWebhookEvent: async () => null,
    });
    assert.equal(result, null);
  });
});

describe("route: commerce7DiagnosticsGetImpl", () => {
  test("unauthenticated caller never reaches getDiagnostics()", async () => {
    let called = false;
    const res = await commerce7DiagnosticsGetImpl(
      {
        getContext: async () => null,
        getDiagnostics: async () => {
          called = true;
          return null;
        },
      },
      "conn-1",
    );
    assert.equal(res.status, 403);
    assert.equal(called, false);
  });

  test("a missing/foreign connection maps to 404", async () => {
    const res = await commerce7DiagnosticsGetImpl(
      {
        getContext: async () => makeContext(),
        getDiagnostics: async () => null,
      },
      "conn-1",
    );
    assert.equal(res.status, 404);
  });

  test("a resolved connection returns its diagnostics under data", async () => {
    const res = await commerce7DiagnosticsGetImpl(
      {
        getContext: async () => makeContext(),
        getDiagnostics: async () => ({
          connectionId: "conn-1",
          connected: true,
          storefrontUrlConfigured: true,
          productRouteConfigured: true,
          currencyConfigured: true,
          productsSynced: true,
          lastProductSyncAt: null,
          orderReceiverConfigured: true,
          latestOrderIngestedAt: null,
          latestWebhookProcessedAt: null,
          latestFailedWebhookEvent: null,
          orderReadOperational: true,
        }),
      },
      "conn-1",
    );
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.connectionId, "conn-1");
    assert.equal(body.data.connected, true);
  });
});
