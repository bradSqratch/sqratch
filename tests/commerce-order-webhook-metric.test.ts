/**
 * tests/commerce-order-webhook-metric.test.ts
 *
 * PHASE 23 — PART 2: "Latest webhook processed" must mean the latest
 * successfully processed event that actually entered through a provider
 * WEBHOOK path — never reconciliation/backfill/catch-up/custom-range, and
 * never a future non-webhook `CommerceOrderEvent` topic by default.
 *
 * `isOrderWebhookEventTopic` is tested directly as a pure, exhaustive
 * allow-list. The end-to-end scenarios below reuse that SAME exported
 * function (not a reimplemented copy) inside a small in-memory fake of
 * `defaultFindLatestWebhookProcessedAt`'s query shape (status = PROCESSED,
 * topic in the provider's webhook allow-list, latest by receivedAt), wired
 * through the real `getBrandOrderOperationsSummary` via the existing
 * `OrderOperationsSummaryDeps` injection seam — the same DI pattern already
 * used throughout `brand-commerce-orders-summary.test.ts`. A regression in
 * the real allow-list is therefore caught here, not masked by a
 * independently-drifted test fake.
 */
import "./env-setup";

import { test, describe } from "node:test";
import { strict as assert } from "node:assert";
import { CommerceProvider } from "@prisma/client";

import {
  getBrandOrderOperationsSummary,
  isOrderWebhookEventTopic,
  type OrderOperationsSummaryDeps,
} from "../src/lib/commerce/order-operations-summary";
import type { CommerceConnectionSummary } from "../src/lib/commerce/types";

function connectionSummary(overrides: Partial<CommerceConnectionSummary> = {}): CommerceConnectionSummary {
  return {
    id: "conn-1",
    brandId: "brand-a",
    provider: CommerceProvider.COMMERCE7,
    status: "CONNECTED",
    displayName: "Acme Winery",
    externalAccountId: "tenant-1",
    storefrontUrl: null,
    isPrimary: true,
    grantedScopes: [],
    installedAt: null,
    uninstalledAt: null,
    lastProductSyncAt: null,
    currencyCode: "USD",
    productRoute: "/product",
    ...overrides,
  };
}

type FakeEvent = {
  connectionId: string;
  topic: string;
  status: "PROCESSED" | "FAILED" | "PENDING";
  receivedAt: Date;
  processedAt: Date | null;
};

function findLatestWebhookProcessedAtFromFake(events: FakeEvent[]) {
  return async (connectionId: string, provider: CommerceProvider): Promise<Date | null> => {
    const matches = events
      .filter((event) => event.connectionId === connectionId)
      .filter((event) => event.status === "PROCESSED")
      .filter((event) => isOrderWebhookEventTopic(provider, event.topic))
      .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
    const latest = matches[0];
    if (!latest) return null;
    return latest.processedAt ?? latest.receivedAt;
  };
}

function baseDeps(events: FakeEvent[]): Partial<OrderOperationsSummaryDeps> {
  return {
    countOrdersByFinancialStatus: async () => [],
    countAttributedOrders: async () => 0,
    countUnattributedOrders: async () => 0,
    findLatestOrderIngestedAt: async () => null,
    findLatestWebhookProcessedAt: findLatestWebhookProcessedAtFromFake(events),
  };
}

describe("isOrderWebhookEventTopic — closed, provider-aware allow-list", () => {
  test("Commerce7 genuine webhook topics: Create and Update", () => {
    assert.equal(isOrderWebhookEventTopic(CommerceProvider.COMMERCE7, "commerce7:order:Create"), true);
    assert.equal(isOrderWebhookEventTopic(CommerceProvider.COMMERCE7, "commerce7:order:Update"), true);
  });

  test("Commerce7 backfill/reconciliation topic is never a webhook", () => {
    assert.equal(isOrderWebhookEventTopic(CommerceProvider.COMMERCE7, "commerce7:order:backfill"), false);
  });

  test("an unknown/future Commerce7 topic does not automatically count as a webhook", () => {
    assert.equal(
      isOrderWebhookEventTopic(CommerceProvider.COMMERCE7, "commerce7:order:someFutureRepairMode"),
      false,
    );
  });

  test("Shopify genuine order webhook topics are recognized", () => {
    for (const topic of ["orders/create", "orders/updated", "order_transactions/create", "refunds/create"]) {
      assert.equal(isOrderWebhookEventTopic(CommerceProvider.SHOPIFY, topic), true);
    }
  });

  test("an unknown/future Shopify topic does not automatically count as a webhook", () => {
    assert.equal(isOrderWebhookEventTopic(CommerceProvider.SHOPIFY, "orders/someFutureTopic"), false);
  });

  test("the spoofable x-shopify-topic-style raw header value is not itself trusted here — only the closed list is", () => {
    assert.equal(isOrderWebhookEventTopic(CommerceProvider.SHOPIFY, "checkouts/create"), false);
  });
});

describe("getBrandOrderOperationsSummary — latest webhook processed semantics", () => {
  test("1. Commerce7 processed backfill only -> latest webhook timestamp is null", async () => {
    const events: FakeEvent[] = [
      {
        connectionId: "conn-1",
        topic: "commerce7:order:backfill",
        status: "PROCESSED",
        receivedAt: new Date("2026-08-26T04:43:12.901Z"),
        processedAt: new Date("2026-08-26T04:43:12.901Z"),
      },
    ];
    const result = await getBrandOrderOperationsSummary("brand-a", {
      ...baseDeps(events),
      getConnections: async () => ({ connections: [connectionSummary()], complete: true }),
    });
    assert.equal(result.connections[0].latestWebhookProcessedAt, null);
  });

  test("2. Commerce7 backfill plus a processed Update -> latest webhook is the real Update event", async () => {
    const events: FakeEvent[] = [
      {
        connectionId: "conn-1",
        topic: "commerce7:order:backfill",
        status: "PROCESSED",
        receivedAt: new Date("2026-08-20T00:00:00.000Z"),
        processedAt: new Date("2026-08-20T00:00:00.000Z"),
      },
      {
        connectionId: "conn-1",
        topic: "commerce7:order:Update",
        status: "PROCESSED",
        receivedAt: new Date("2026-08-25T00:00:00.000Z"),
        processedAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    ];
    const result = await getBrandOrderOperationsSummary("brand-a", {
      ...baseDeps(events),
      getConnections: async () => ({ connections: [connectionSummary()], complete: true }),
    });
    assert.equal(result.connections[0].latestWebhookProcessedAt, "2026-08-25T00:00:00.000Z");
  });

  test("3. a newer backfill after a genuine webhook does not move the webhook timestamp forward", async () => {
    const events: FakeEvent[] = [
      {
        connectionId: "conn-1",
        topic: "commerce7:order:Update",
        status: "PROCESSED",
        receivedAt: new Date("2026-08-25T00:00:00.000Z"),
        processedAt: new Date("2026-08-25T00:00:00.000Z"),
      },
      {
        connectionId: "conn-1",
        topic: "commerce7:order:backfill",
        status: "PROCESSED",
        receivedAt: new Date("2026-08-26T00:00:00.000Z"),
        processedAt: new Date("2026-08-26T00:00:00.000Z"),
      },
    ];
    const result = await getBrandOrderOperationsSummary("brand-a", {
      ...baseDeps(events),
      getConnections: async () => ({ connections: [connectionSummary()], complete: true }),
    });
    assert.equal(result.connections[0].latestWebhookProcessedAt, "2026-08-25T00:00:00.000Z");
  });

  test("4. Commerce7 Create is recognized as a genuine webhook", async () => {
    const events: FakeEvent[] = [
      {
        connectionId: "conn-1",
        topic: "commerce7:order:Create",
        status: "PROCESSED",
        receivedAt: new Date("2026-08-25T00:00:00.000Z"),
        processedAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    ];
    const result = await getBrandOrderOperationsSummary("brand-a", {
      ...baseDeps(events),
      getConnections: async () => ({ connections: [connectionSummary()], complete: true }),
    });
    assert.equal(result.connections[0].latestWebhookProcessedAt, "2026-08-25T00:00:00.000Z");
  });

  test("5. Shopify genuine order webhook topics continue to be recognized", async () => {
    const events: FakeEvent[] = [
      {
        connectionId: "conn-shop",
        topic: "orders/updated",
        status: "PROCESSED",
        receivedAt: new Date("2026-08-25T00:00:00.000Z"),
        processedAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    ];
    const result = await getBrandOrderOperationsSummary("brand-a", {
      ...baseDeps(events),
      getConnections: async () => ({
        connections: [
          connectionSummary({
            id: "conn-shop",
            provider: CommerceProvider.SHOPIFY,
            externalAccountId: "shop-1.myshopify.com",
          }),
        ],
        complete: true,
      }),
    });
    assert.equal(result.connections[0].latestWebhookProcessedAt, "2026-08-25T00:00:00.000Z");
  });

  test("6. an unknown/future non-webhook CommerceOrderEvent topic does not automatically count as a webhook", async () => {
    const events: FakeEvent[] = [
      {
        connectionId: "conn-1",
        topic: "commerce7:order:someFutureRepairMode",
        status: "PROCESSED",
        receivedAt: new Date("2026-08-25T00:00:00.000Z"),
        processedAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    ];
    const result = await getBrandOrderOperationsSummary("brand-a", {
      ...baseDeps(events),
      getConnections: async () => ({ connections: [connectionSummary()], complete: true }),
    });
    assert.equal(result.connections[0].latestWebhookProcessedAt, null);
  });

  test("7. failed/non-PROCESSED events never count, even on a genuine webhook topic", async () => {
    const events: FakeEvent[] = [
      {
        connectionId: "conn-1",
        topic: "commerce7:order:Update",
        status: "FAILED",
        receivedAt: new Date("2026-08-25T00:00:00.000Z"),
        processedAt: null,
      },
    ];
    const result = await getBrandOrderOperationsSummary("brand-a", {
      ...baseDeps(events),
      getConnections: async () => ({ connections: [connectionSummary()], complete: true }),
    });
    assert.equal(result.connections[0].latestWebhookProcessedAt, null);
  });

  test("events on a DIFFERENT connection never leak into this connection's latest-webhook timestamp", async () => {
    const events: FakeEvent[] = [
      {
        connectionId: "conn-other",
        topic: "commerce7:order:Update",
        status: "PROCESSED",
        receivedAt: new Date("2026-08-25T00:00:00.000Z"),
        processedAt: new Date("2026-08-25T00:00:00.000Z"),
      },
    ];
    const result = await getBrandOrderOperationsSummary("brand-a", {
      ...baseDeps(events),
      getConnections: async () => ({ connections: [connectionSummary({ id: "conn-1" })], complete: true }),
    });
    assert.equal(result.connections[0].latestWebhookProcessedAt, null);
  });
});
