process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/shopify-order-webhook.test.ts
 *
 * Tests the shared order-webhook pipeline
 * (`src/lib/commerce/providers/shopify-order-webhook.ts`'s
 * `handleShopifyOrderWebhook` / `resolveProviderEventId` /
 * `shopifyTopicRequiresFinancialReconciliation`) and the four real,
 * production-unreachable route handlers built on it
 * (`src/app/api/shopify/webhooks/{orders/create,orders/updated,refunds/create,order_transactions/create}/route.ts`).
 *
 * The four route files themselves take no deps parameter (they call
 * `handleShopifyOrderWebhook(request, TOPIC, normalizer)` with no override),
 * so — matching the exact precedent in
 * `tests/shopify-webhook-verification.test.ts` for the four EXISTING webhook
 * routes — their success path is exercised here only via requests that never
 * reach a real Prisma call: an HMAC failure (401) returns before any lookup,
 * and a request with no `x-shopify-shop-domain` header makes
 * `verification.shop === ""` (falsy), which short-circuits
 * `handleShopifyOrderWebhook`'s connection lookup entirely and falls straight
 * to the shared 200-empty-body response. Full pipeline behavior (idempotency,
 * ingestion wiring, PII-safe logging) is proven directly against
 * `handleShopifyOrderWebhook` with injected, DB-free deps — the exact
 * `ShopifyOrderWebhookDeps` seam the module exports for this purpose.
 *
 * Every "valid signature" case computes a GENUINE HMAC with node:crypto over
 * the raw body — never a stubbed verifier.
 *
 * Covered cases (numbered to match the task's review checklist):
 *  2.  Duplicate webhook idempotency — same X-Shopify-Webhook-Id delivered
 *      twice through handleShopifyOrderWebhook creates ONE order.
 *  20. HMAC verification enforced — every one of the four routes rejects an
 *      invalid/missing signature with 401, using a genuine computed HMAC for
 *      the valid case.
 *  21. Unverified webhook rejected before writes — ingest is never invoked
 *      when HMAC verification fails.
 *  P12.4. Financial reconciliation orchestration — refund evidence gates a
 *      live Shopify GraphQL reconciliation; RECONCILED overlays financial
 *      fields, NOT_ELIGIBLE defers them (never fabricates), TRANSIENT_FAILURE
 *      blocks ingest entirely and asks for redelivery.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { CommerceProvider } from "@prisma/client";
import type { CommerceOrderEventStatus } from "@prisma/client";

import {
  handleShopifyOrderWebhook,
  resolveProviderEventId,
  shopifyProductKeyCandidates,
  shopifyTopicRequiresFinancialReconciliation,
  type ShopifyOrderWebhookDeps,
} from "../src/lib/commerce/providers/shopify-order-webhook";
import {
  normalizeShopifyOrderPayload,
  normalizeShopifyRefundPayload,
  normalizeShopifyOrderTransactionPayload,
} from "../src/lib/commerce/providers/shopify-order-normalizer";
import type { ReconcileShopifyOrderFinancialsResult } from "../src/lib/commerce/providers/shopify-order-financial-reconciliation";
import {
  ingestNormalizedOrder,
  resolveOrderEventClaim,
  EVENT_CLAIM_LEASE_MS,
  type ExistingOrderEventRow,
  type OrderEventClaim,
  type OrderEventClaimStore,
  type OrderIngestionDeps,
  type OrderIngestionOutcome,
  type OrderIngestionEventInput,
  type NormalizedOrderInput,
} from "../src/lib/commerce/order-ingestion";

// Route modules transitively import src/lib/prisma.ts, which throws
// synchronously at module-evaluation time unless DATABASE_URL is already set
// — same reasoning and pattern as tests/shopify-webhook-verification.test.ts.
// The top-level assignment on line 1 has already run by the time `before()`
// executes this dynamic import.
let ordersCreateRoute: typeof import("../src/app/api/shopify/webhooks/orders/create/route");
let ordersUpdatedRoute: typeof import("../src/app/api/shopify/webhooks/orders/updated/route");
let refundsCreateRoute: typeof import("../src/app/api/shopify/webhooks/refunds/create/route");
let orderTransactionsCreateRoute: typeof import("../src/app/api/shopify/webhooks/order_transactions/create/route");

before(async () => {
  ordersCreateRoute = await import("../src/app/api/shopify/webhooks/orders/create/route");
  ordersUpdatedRoute = await import("../src/app/api/shopify/webhooks/orders/updated/route");
  refundsCreateRoute = await import("../src/app/api/shopify/webhooks/refunds/create/route");
  orderTransactionsCreateRoute = await import("../src/app/api/shopify/webhooks/order_transactions/create/route");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADER_HMAC = "x-shopify-hmac-sha256";
const HEADER_SHOP = "x-shopify-shop-domain";
const HEADER_WEBHOOK_ID = "x-shopify-webhook-id";

const SECRET = "test-order-webhook-shared-secret-7c2e";

function computeHmac(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

async function withShopifyApiSecret<T>(secret: string | undefined, fn: () => Promise<T>): Promise<T> {
  const original = process.env.SHOPIFY_API_SECRET;
  if (secret === undefined) {
    delete process.env.SHOPIFY_API_SECRET;
  } else {
    process.env.SHOPIFY_API_SECRET = secret;
  }
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.SHOPIFY_API_SECRET;
    } else {
      process.env.SHOPIFY_API_SECRET = original;
    }
  }
}

interface WebhookRequestOptions {
  rawBody: string;
  hmac?: string;
  shopDomain?: string;
  webhookId?: string;
}

function buildWebhookRequest(url: string, options: WebhookRequestOptions): NextRequest {
  const headers = new Headers();
  if (options.hmac !== undefined) headers.set(HEADER_HMAC, options.hmac);
  if (options.shopDomain !== undefined) headers.set(HEADER_SHOP, options.shopDomain);
  if (options.webhookId !== undefined) headers.set(HEADER_WEBHOOK_ID, options.webhookId);
  return new NextRequest(url, { method: "POST", headers, body: options.rawBody });
}

const REPO_ROOT = process.cwd();
function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// 20 & route-level: HMAC verification enforced on all four order webhook routes,
// exactly like the four existing webhook routes.
// ---------------------------------------------------------------------------

interface RouteUnderTest {
  name: string;
  url: string;
  post: () => (request: NextRequest) => Promise<Response>;
}

function routes(): RouteUnderTest[] {
  return [
    {
      name: "orders/create",
      url: "http://localhost/api/shopify/webhooks/orders/create",
      post: () => ordersCreateRoute.POST,
    },
    {
      name: "orders/updated",
      url: "http://localhost/api/shopify/webhooks/orders/updated",
      post: () => ordersUpdatedRoute.POST,
    },
    {
      name: "refunds/create",
      url: "http://localhost/api/shopify/webhooks/refunds/create",
      post: () => refundsCreateRoute.POST,
    },
    {
      name: "order_transactions/create",
      url: "http://localhost/api/shopify/webhooks/order_transactions/create",
      post: () => orderTransactionsCreateRoute.POST,
    },
  ];
}

describe("20. HMAC verification is enforced on every one of the four order webhook routes", () => {
  test("all four: an invalid signature -> 401 {error:\"Invalid Shopify webhook signature.\"}", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      for (const route of routes()) {
        const rawBody = JSON.stringify({ id: 1 });
        const request = buildWebhookRequest(route.url, {
          rawBody,
          hmac: "clearly-not-a-real-signature==",
          shopDomain: "test-shop.myshopify.com",
        });
        const response = await route.post()(request);
        assert.equal(response.status, 401, `${route.name} must reject an invalid HMAC with 401`);
        const body = await response.json();
        assert.deepEqual(body, { error: "Invalid Shopify webhook signature." });
      }
    });
  });

  test("all four: a MISSING signature header -> the same 401", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      for (const route of routes()) {
        const rawBody = JSON.stringify({ id: 1 });
        const request = buildWebhookRequest(route.url, { rawBody, shopDomain: "test-shop.myshopify.com" });
        const response = await route.post()(request);
        assert.equal(response.status, 401, `${route.name} must reject a missing HMAC with 401`);
      }
    });
  });

  test("all four: a GENUINE, correctly-computed signature over the exact raw bytes verifies (200), with no shop connection registered (DB-free success path)", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      for (const route of routes()) {
        const rawBody = JSON.stringify({ id: 1, updated_at: "2026-08-01T00:00:00-04:00" });
        const hmac = computeHmac(rawBody, SECRET);
        // No x-shopify-shop-domain header: verification.shop becomes "" —
        // falsy — so handleShopifyOrderWebhook's connection lookup is
        // short-circuited entirely and no Prisma call is ever reached, while
        // still proving the HMAC-valid path returns 200 with an empty body.
        const request = buildWebhookRequest(route.url, { rawBody, hmac });
        const response = await route.post()(request);
        assert.equal(response.status, 200, `${route.name} must accept a genuinely valid signature`);
        assert.equal(await response.text(), "", "success body must be empty");
      }
    });
  });

  test("all four: a missing SHOPIFY_API_SECRET -> 500, even with an otherwise well-formed request", async () => {
    await withShopifyApiSecret(undefined, async () => {
      for (const route of routes()) {
        const rawBody = JSON.stringify({ id: 1 });
        const request = buildWebhookRequest(route.url, {
          rawBody,
          hmac: computeHmac(rawBody, "irrelevant-because-secret-is-missing"),
          shopDomain: "test-shop.myshopify.com",
        });
        const response = await route.post()(request);
        assert.equal(response.status, 500);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Route wiring: each route binds its own dedicated topic and normalizer, and
// none of them re-implements verification.
// ---------------------------------------------------------------------------

describe("route wiring is bound to the route path, not the spoofable x-shopify-topic header", () => {
  const wiring: Array<{ file: string; topic: string; normalizer: string }> = [
    {
      file: "src/app/api/shopify/webhooks/orders/create/route.ts",
      topic: "orders/create",
      normalizer: "normalizeShopifyOrderPayload",
    },
    {
      file: "src/app/api/shopify/webhooks/orders/updated/route.ts",
      topic: "orders/updated",
      normalizer: "normalizeShopifyOrderPayload",
    },
    {
      file: "src/app/api/shopify/webhooks/refunds/create/route.ts",
      topic: "refunds/create",
      normalizer: "normalizeShopifyRefundPayload",
    },
    {
      file: "src/app/api/shopify/webhooks/order_transactions/create/route.ts",
      topic: "order_transactions/create",
      normalizer: "normalizeShopifyOrderTransactionPayload",
    },
  ];

  for (const { file, topic, normalizer } of wiring) {
    test(`${file} binds TOPIC="${topic}" and calls handleShopifyOrderWebhook with ${normalizer}`, () => {
      const source = readSource(file);
      assert.match(source, new RegExp(`const TOPIC = "${topic}"`));
      assert.match(source, /handleShopifyOrderWebhook\(request, TOPIC, \w+\)/);
      assert.match(source, new RegExp(`import \\{ ${normalizer} \\}`));
    });
  }

  test("none of the four routes reads x-shopify-topic in actual code (comments deliberately NAME the header to document its exclusion)", () => {
    for (const { file } of wiring) {
      const codeOnly = readSource(file)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");
      assert.doesNotMatch(codeOnly, /x-shopify-topic/i);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveProviderEventId
// ---------------------------------------------------------------------------

describe("resolveProviderEventId", () => {
  test("prefers the X-Shopify-Webhook-Id header when present", () => {
    assert.equal(resolveProviderEventId("real-webhook-id-123", "digest-abc"), "real-webhook-id-123");
  });

  test("falls back to a deterministic digest: prefix when the header is absent", () => {
    assert.equal(resolveProviderEventId(null, "digest-abc"), "digest:digest-abc");
  });

  test("falls back the same way for a blank header", () => {
    assert.equal(resolveProviderEventId("   ", "digest-abc"), "digest:digest-abc");
  });

  test("two byte-identical deliveries with no header collapse to the SAME synthesized id (this is the documented, deliberate trade-off)", () => {
    const a = resolveProviderEventId(null, "same-digest");
    const b = resolveProviderEventId(null, "same-digest");
    assert.equal(a, b);
  });
});

// ---------------------------------------------------------------------------
// 2 & 21. Full pipeline: idempotency and pre-write signature enforcement,
// against handleShopifyOrderWebhook directly with injected, DB-free deps.
// ---------------------------------------------------------------------------

/** Records every call made to `ingest`, without touching a real DB. */
function makeIngestSpy(outcome: OrderIngestionOutcome) {
  const calls: Array<{ event: OrderIngestionEventInput; order: NormalizedOrderInput }> = [];
  const fn = async (
    event: OrderIngestionEventInput,
    order: NormalizedOrderInput,
  ): Promise<OrderIngestionOutcome> => {
    calls.push({ event, order });
    return outcome;
  };
  return { fn: fn as unknown as typeof ingestNormalizedOrder, calls };
}

const PASS_OUTCOME: OrderIngestionOutcome = {
  status: "CREATED",
  reason: null,
  eventId: "event-1",
  orderId: "order-1",
  lineItemCount: 1,
  attributionLinked: false,
  brandIdOverriddenFromConnection: false,
};

const DETERMINISTIC_FAILURE: OrderIngestionOutcome = {
  ...PASS_OUTCOME,
  status: "FAILED",
  reason: "MISSING_EXTERNAL_ORDER_ID",
  orderId: null,
};

const TRANSIENT_FAILURE: OrderIngestionOutcome = {
  ...PASS_OUTCOME,
  status: "FAILED",
  reason: "WRITE_FAILED",
  orderId: null,
};

const IN_FLIGHT_OUTCOME: OrderIngestionOutcome = {
  ...PASS_OUTCOME,
  status: "IN_FLIGHT",
  reason: "DELIVERY_IN_FLIGHT",
  orderId: null,
};

const UNEXPECTED_FAILURE: OrderIngestionOutcome = {
  ...PASS_OUTCOME,
  status: "FAILED",
  reason: "UNEXPECTED_FAILURE",
  eventId: null,
  orderId: null,
};

/**
 * A DB-free ingestion stack whose `CommerceOrderEvent` ledger is REAL enough to
 * exercise the claim state machine: it tracks `status` and `receivedAt` per row
 * and delegates the decision-making to the production `resolveOrderEventClaim`
 * rather than reimplementing it. Kept self-contained here (same idiom as
 * tests/order-ingestion.test.ts) so this file can prove the HTTP contract
 * end-to-end against the real `ingestNormalizedOrder`.
 */
const LEDGER_NOW = new Date("2026-08-07T12:00:00.000Z");

class FakeEventLedger {
  nextId = 1;
  clock: Date = LEDGER_NOW;
  rows = new Map<string, { id: string; status: CommerceOrderEventStatus; receivedAt: Date }>();

  claim(input: { provider: CommerceProvider; providerEventId: string }): Promise<OrderEventClaim> {
    const key = `${input.provider}:${input.providerEventId}`;
    const store: OrderEventClaimStore = {
      insertClaim: async () => {
        if (this.rows.has(key)) return "DUPLICATE";
        const row = {
          id: `event-${this.nextId++}`,
          status: "RECEIVED" as CommerceOrderEventStatus,
          receivedAt: this.clock,
        };
        this.rows.set(key, row);
        return { id: row.id };
      },
      findExistingClaim: async () => this.rows.get(key) ?? null,
      reclaim: async (row: ExistingOrderEventRow, now: Date) => {
        const current = this.rows.get(key);
        if (
          !current ||
          current.status !== row.status ||
          current.receivedAt.getTime() !== row.receivedAt.getTime()
        ) {
          return false;
        }
        current.status = "RECEIVED";
        current.receivedAt = now;
        return true;
      },
    };
    return resolveOrderEventClaim(store, this.clock);
  }

  /** Stands in for `finalizeEvent`, which cannot reach the blocked test DB. */
  finalize(providerEventId: string, status: CommerceOrderEventStatus): void {
    const row = this.rows.get(`${CommerceProvider.SHOPIFY}:${providerEventId}`);
    if (!row) throw new Error(`no event row for ${providerEventId}`);
    row.status = status;
  }
}

function makeIngestionStack() {
  const ledger = new FakeEventLedger();
  const state = { orderCount: 0 };
  const deps: Partial<OrderIngestionDeps> = {
    claimEvent: (input) => ledger.claim(input),
    async loadConnection() {
      return {
        id: "conn-1",
        brandId: "brand-1",
        provider: CommerceProvider.SHOPIFY,
        status: "CONNECTED" as const,
      };
    },
    async runTransaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
      const fakeTx = {
        commerceOrder: {
          async findUnique() {
            return null;
          },
          async create() {
            state.orderCount += 1;
            return { id: `order-${state.orderCount}` };
          },
          async update() {
            return {};
          },
        },
        commerceOrderLineItem: {
          async deleteMany() {
            return { count: 0 };
          },
          async createMany({ data }: { data: unknown[] }) {
            return { count: data.length };
          },
        },
        connectedCommerceProduct: {
          async findMany() {
            return [];
          },
        },
        commerceClickAttribution: {
          async findUnique() {
            return null;
          },
          async updateMany() {
            return { count: 0 };
          },
        },
      };
      return fn(fakeTx as never);
    },
    hashAttributionToken: (token: string) => `hash:${token}`,
    now: () => LEDGER_NOW,
  };

  const webhookDeps: Partial<ShopifyOrderWebhookDeps> = {
    async findConnectionByShopDomain() {
      return { id: "conn-1", brandId: "brand-1" };
    },
    ingest: ingestNormalizedOrder,
    ingestionDeps: deps,
  };

  return { ledger, state, webhookDeps };
}

const ORDER_BODY = JSON.stringify({
  id: 5551,
  currency: "USD",
  total_price: "10.00",
  updated_at: "2026-08-01T00:00:00-04:00",
  line_items: [],
});

function orderDelivery(webhookId: string, rawBody = ORDER_BODY): NextRequest {
  return buildWebhookRequest("http://localhost/api/shopify/webhooks/orders/create", {
    rawBody,
    hmac: computeHmac(rawBody, SECRET),
    shopDomain: "idempotency-test.myshopify.com",
    webhookId,
  });
}

describe("2. duplicate webhook idempotency through the full handleShopifyOrderWebhook pipeline", () => {
  test("the same X-Shopify-Webhook-Id delivered twice results in exactly one CREATED ingest call and one ALREADY_PROCESSED — proven against the REAL ingestNormalizedOrder, not a stub", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const { ledger, state, webhookDeps } = makeIngestionStack();

      const first = await handleShopifyOrderWebhook(
        orderDelivery("same-delivery-id-999"),
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );
      assert.equal(first.status, 200);
      assert.equal(state.orderCount, 1, "first delivery must create exactly one order");

      // Production's finalizeEvent marks the row PROCESSED here; it cannot run
      // against the blocked test DATABASE_URL, so it is simulated explicitly.
      ledger.finalize("same-delivery-id-999", "PROCESSED");

      const second = await handleShopifyOrderWebhook(
        orderDelivery("same-delivery-id-999"),
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );
      assert.equal(second.status, 200);
      assert.equal(state.orderCount, 1, "the duplicate delivery must NOT create a second order");
    });
  });

  for (const terminal of ["SKIPPED_STALE", "SKIPPED_DISCONNECTED"] as const) {
    test(`a redelivery of an event already finalized as ${terminal} is also answered 200 with no reprocessing`, async () => {
      await withShopifyApiSecret(SECRET, async () => {
        const { ledger, state, webhookDeps } = makeIngestionStack();

        await handleShopifyOrderWebhook(
          orderDelivery("terminal-delivery"),
          "orders/create",
          normalizeShopifyOrderPayload,
          webhookDeps,
        );
        assert.equal(state.orderCount, 1);
        ledger.finalize("terminal-delivery", terminal);

        const redelivery = await handleShopifyOrderWebhook(
          orderDelivery("terminal-delivery"),
          "orders/create",
          normalizeShopifyOrderPayload,
          webhookDeps,
        );
        assert.equal(redelivery.status, 200);
        assert.equal(state.orderCount, 1);
      });
    });
  }
});

// ---------------------------------------------------------------------------
// THE P1: an in-flight delivery must never be acknowledged
// ---------------------------------------------------------------------------

describe("P1. a delivery still in flight is answered 500 so Shopify keeps retrying", () => {
  test("THE CRASH WINDOW: a worker dies after claiming and before writing — the retry inside the lease gets 500 and no order, and a later retry lands the order for real", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const { ledger, state, webhookDeps } = makeIngestionStack();

      // 1. A worker claims the delivery and then dies: RECEIVED row, no order.
      const claim = await ledger.claim({
        provider: CommerceProvider.SHOPIFY,
        providerEventId: "crashed-delivery",
      });
      assert.equal(claim.status, "CLAIMED");
      assert.equal(state.orderCount, 0);

      // 2. Shopify redelivers 5s later, inside the 60s lease.
      ledger.clock = new Date(LEDGER_NOW.getTime() + 5_000);
      const retry = await handleShopifyOrderWebhook(
        orderDelivery("crashed-delivery"),
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );

      assert.equal(
        retry.status,
        500,
        "answering 200 here is what stopped Shopify retrying and lost the order",
      );
      assert.equal(state.orderCount, 0, "and nothing was written twice either");

      // 3. After the lease expires the retry reclaims the abandoned event and
      //    finally lands the order — the data is recovered, not lost.
      ledger.clock = new Date(LEDGER_NOW.getTime() + EVENT_CLAIM_LEASE_MS + 1_000);
      const recovered = await handleShopifyOrderWebhook(
        orderDelivery("crashed-delivery"),
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );
      assert.equal(recovered.status, 200);
      assert.equal(state.orderCount, 1, "the order is landed by the later retry");
    });
  });

  test("a concurrent redelivery arriving while the first is still being processed is 500, not a silent 200", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const { ledger, state, webhookDeps } = makeIngestionStack();

      const first = await handleShopifyOrderWebhook(
        orderDelivery("live-lease"),
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );
      assert.equal(first.status, 200);
      assert.equal(state.orderCount, 1);

      // finalizeEvent never landed (it cannot here, and in production it is
      // best-effort), so the lease is still live. Nothing may be acknowledged
      // on the strength of a terminal write we cannot see.
      assert.equal(ledger.rows.get(`SHOPIFY:live-lease`)!.status, "RECEIVED");

      const concurrent = await handleShopifyOrderWebhook(
        orderDelivery("live-lease"),
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );
      assert.equal(concurrent.status, 500);
      assert.equal(state.orderCount, 1, "no second order write");
    });
  });
});

describe("webhook retry classification: 200 means settled, 500 means redeliver", () => {
  const rawBody = JSON.stringify({ id: 55, updated_at: "2026-08-01T00:00:00Z" });
  const requestFor = () =>
    buildWebhookRequest("http://localhost/api/shopify/webhooks/orders/create", {
      rawBody,
      hmac: computeHmac(rawBody, SECRET),
      shopDomain: "retry-test.myshopify.com",
      webhookId: "retry-delivery",
    });
  const baseDeps = {
    async findConnectionByShopDomain() {
      return { id: "conn-1", brandId: "brand-1" };
    },
    ingestionDeps: {},
  };

  const matrix: Array<{ name: string; outcome: OrderIngestionOutcome; status: number }> = [
    { name: "CREATED", outcome: PASS_OUTCOME, status: 200 },
    {
      name: "deterministic rejection (MISSING_EXTERNAL_ORDER_ID)",
      outcome: DETERMINISTIC_FAILURE,
      status: 200,
    },
    {
      name: "genuinely completed duplicate (ALREADY_PROCESSED)",
      outcome: { ...PASS_OUTCOME, status: "ALREADY_PROCESSED", reason: "DUPLICATE_DELIVERY" },
      status: 200,
    },
    {
      name: "stale event (SKIPPED_STALE)",
      outcome: { ...PASS_OUTCOME, status: "SKIPPED_STALE", reason: "OLDER_THAN_STORED_STATE" },
      status: 200,
    },
    {
      name: "disconnected shop (SKIPPED_DISCONNECTED)",
      outcome: {
        ...PASS_OUTCOME,
        status: "SKIPPED_DISCONNECTED",
        reason: "CONNECTION_NOT_INGESTIBLE",
      },
      status: 200,
    },
    { name: "transient write failure (WRITE_FAILED)", outcome: TRANSIENT_FAILURE, status: 500 },
    { name: "delivery in flight (IN_FLIGHT)", outcome: IN_FLIGHT_OUTCOME, status: 500 },
    {
      name: "unexpected pipeline error (UNEXPECTED_FAILURE)",
      outcome: UNEXPECTED_FAILURE,
      status: 500,
    },
  ];

  for (const { name, outcome, status } of matrix) {
    test(`${name} -> ${status}`, async () => {
      await withShopifyApiSecret(SECRET, async () => {
        const response = await handleShopifyOrderWebhook(
          requestFor(),
          "orders/create",
          normalizeShopifyOrderPayload,
          { ...baseDeps, ingest: makeIngestSpy(outcome).fn },
        );
        assert.equal(response.status, status);
      });
    });
  }
});

describe("no unexpected exception escapes the webhook: it becomes a deliberate, retryable 500", () => {
  const rawBody = JSON.stringify({ id: 77, updated_at: "2026-08-01T00:00:00Z" });
  const requestFor = () =>
    buildWebhookRequest("http://localhost/api/shopify/webhooks/orders/create", {
      rawBody,
      hmac: computeHmac(rawBody, SECRET),
      shopDomain: "throwing-test.myshopify.com",
      webhookId: "throwing-delivery",
    });

  test("a throwing connection lookup answers 500 instead of rejecting the promise", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const response = await handleShopifyOrderWebhook(
        requestFor(),
        "orders/create",
        normalizeShopifyOrderPayload,
        {
          async findConnectionByShopDomain() {
            throw new Error("P1001: can't reach database server at db:5432");
          },
          ingest: makeIngestSpy(PASS_OUTCOME).fn,
          ingestionDeps: {},
        },
      );
      assert.equal(response.status, 500);
    });
  });

  test("a throwing ingest also answers 500 rather than crashing the route", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const response = await handleShopifyOrderWebhook(
        requestFor(),
        "orders/create",
        normalizeShopifyOrderPayload,
        {
          async findConnectionByShopDomain() {
            return { id: "conn-1", brandId: "brand-1" };
          },
          ingest: (async () => {
            throw new Error("unexpected");
          }) as unknown as typeof ingestNormalizedOrder,
          ingestionDeps: {},
        },
      );
      assert.equal(response.status, 500);
    });
  });

  test("a throwing claimEvent inside the REAL ingestion path is classified, not propagated, and answers 500", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const response = await handleShopifyOrderWebhook(
        requestFor(),
        "orders/create",
        normalizeShopifyOrderPayload,
        {
          async findConnectionByShopDomain() {
            return { id: "conn-1", brandId: "brand-1" };
          },
          ingest: ingestNormalizedOrder,
          ingestionDeps: {
            async claimEvent() {
              throw new Error("P1017: server has closed the connection");
            },
          },
        },
      );
      assert.equal(response.status, 500);
    });
  });
});

// ---------------------------------------------------------------------------
// Shopify-specific product-key expansion lives in the Shopify provider module
// ---------------------------------------------------------------------------

describe("shopifyProductKeyCandidates: the provider's own id-form knowledge", () => {
  test("a bare numeric REST id also matches the catalog's GraphQL global id", () => {
    assert.deepEqual(shopifyProductKeyCandidates("123"), [
      "123",
      "gid://shopify/Product/123",
    ]);
  });

  test("a global id also matches its bare numeric form", () => {
    assert.deepEqual(shopifyProductKeyCandidates("gid://shopify/Product/456"), [
      "gid://shopify/Product/456",
      "456",
    ]);
  });

  test("anything else is passed through unchanged, and blank yields nothing", () => {
    assert.deepEqual(shopifyProductKeyCandidates("weird-handle"), ["weird-handle"]);
    assert.deepEqual(shopifyProductKeyCandidates(null), []);
    assert.deepEqual(shopifyProductKeyCandidates("  "), []);
  });

  test("the webhook handler injects it into the ingestion deps, so the generic layer never needs Shopify's id format", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      let injected: Partial<OrderIngestionDeps> | undefined;
      const capturingIngest = (async (
        _event: OrderIngestionEventInput,
        _order: NormalizedOrderInput,
        deps?: Partial<OrderIngestionDeps>,
      ): Promise<OrderIngestionOutcome> => {
        injected = deps;
        return PASS_OUTCOME;
      }) as unknown as typeof ingestNormalizedOrder;

      const rawBody = JSON.stringify({ id: 99, updated_at: "2026-08-01T00:00:00Z" });
      const request = buildWebhookRequest(
        "http://localhost/api/shopify/webhooks/orders/create",
        {
          rawBody,
          hmac: computeHmac(rawBody, SECRET),
          shopDomain: "wiring-test.myshopify.com",
          webhookId: "wiring-delivery",
        },
      );

      await handleShopifyOrderWebhook(request, "orders/create", normalizeShopifyOrderPayload, {
        async findConnectionByShopDomain() {
          return { id: "conn-1", brandId: "brand-1" };
        },
        ingest: capturingIngest,
      });

      assert.ok(injected?.expandProductKeyCandidates, "expansion must be wired by default");
      assert.deepEqual(injected!.expandProductKeyCandidates!("1001"), [
        "1001",
        "gid://shopify/Product/1001",
      ]);
    });
  });
});

describe("21. an unverified (invalid-HMAC) delivery never reaches ingest — no write is even attempted", () => {
  test("ingest is never invoked when the signature is invalid", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const spy = makeIngestSpy(PASS_OUTCOME);
      const webhookDeps: Partial<ShopifyOrderWebhookDeps> = {
        async findConnectionByShopDomain() {
          throw new Error("must never be called before verification");
        },
        ingest: spy.fn,
        ingestionDeps: {},
      };

      const rawBody = JSON.stringify({ id: 1 });
      const request = buildWebhookRequest("http://localhost/api/shopify/webhooks/orders/create", {
        rawBody,
        hmac: "totally-invalid-signature",
        shopDomain: "test-shop.myshopify.com",
      });

      const response = await handleShopifyOrderWebhook(
        request,
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );

      assert.equal(response.status, 401);
      assert.equal(spy.calls.length, 0, "ingest must never be called on a failed-verification delivery");
    });
  });

  test("a missing signature header also never reaches ingest", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const spy = makeIngestSpy(PASS_OUTCOME);
      const webhookDeps: Partial<ShopifyOrderWebhookDeps> = {
        ingest: spy.fn,
        ingestionDeps: {},
      };
      const rawBody = JSON.stringify({ id: 1 });
      const request = buildWebhookRequest("http://localhost/api/shopify/webhooks/orders/create", {
        rawBody,
        shopDomain: "test-shop.myshopify.com",
      });

      const response = await handleShopifyOrderWebhook(
        request,
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );

      assert.equal(response.status, 401);
      assert.equal(spy.calls.length, 0);
    });
  });

  test("an unknown shop (no matching CommerceConnection) also never reaches ingest, and still answers 200", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const spy = makeIngestSpy(PASS_OUTCOME);
      const webhookDeps: Partial<ShopifyOrderWebhookDeps> = {
        async findConnectionByShopDomain() {
          return null;
        },
        ingest: spy.fn,
        ingestionDeps: {},
      };
      const rawBody = JSON.stringify({ id: 1 });
      const hmac = computeHmac(rawBody, SECRET);
      const request = buildWebhookRequest("http://localhost/api/shopify/webhooks/orders/create", {
        rawBody,
        hmac,
        shopDomain: "unknown-shop.myshopify.com",
      });

      const response = await handleShopifyOrderWebhook(
        request,
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );

      assert.equal(response.status, 200);
      assert.equal(spy.calls.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// P12.4: financial reconciliation orchestration
// ---------------------------------------------------------------------------

describe("shopifyTopicRequiresFinancialReconciliation is the single gate for live reconciliation", () => {
  test("refunds/create and order_transactions/create ALWAYS require it, regardless of payload shape", () => {
    assert.equal(shopifyTopicRequiresFinancialReconciliation("refunds/create", {}), true);
    assert.equal(shopifyTopicRequiresFinancialReconciliation("refunds/create", null), true);
    assert.equal(
      shopifyTopicRequiresFinancialReconciliation("order_transactions/create", {}),
      true,
    );
  });

  test("orders/create and orders/updated require it ONLY when the payload's own refunds[] is non-empty", () => {
    assert.equal(
      shopifyTopicRequiresFinancialReconciliation("orders/updated", { refunds: [{ id: 1 }] }),
      true,
    );
    assert.equal(
      shopifyTopicRequiresFinancialReconciliation("orders/updated", { refunds: [] }),
      false,
    );
    assert.equal(shopifyTopicRequiresFinancialReconciliation("orders/updated", {}), false);
    assert.equal(
      shopifyTopicRequiresFinancialReconciliation("orders/create", { refunds: [{ id: 1 }] }),
      true,
    );
  });

  test("any other topic never requires it", () => {
    assert.equal(
      shopifyTopicRequiresFinancialReconciliation("app/uninstalled", { refunds: [{ id: 1 }] }),
      false,
    );
  });
});

describe("financial reconciliation orchestration through handleShopifyOrderWebhook", () => {
  const RECONCILED_SNAPSHOT_UPDATED_AT = new Date("2026-08-15T12:00:00.000Z");

  function reconciledResult(
    overrides: Partial<Extract<ReconcileShopifyOrderFinancialsResult, { outcome: "RECONCILED" }>["snapshot"]> = {},
  ): ReconcileShopifyOrderFinancialsResult {
    return {
      outcome: "RECONCILED",
      snapshot: {
        externalOrderId: "5551",
        currencyCode: "CAD",
        minorUnitExponent: 2,
        totalMinor: BigInt(132257),
        totalRefundedMinor: BigInt(61063),
        financialStatus: "PARTIALLY_REFUNDED",
        providerUpdatedAt: RECONCILED_SNAPSHOT_UPDATED_AT,
        ...overrides,
      },
    };
  }

  function makeReconcileSpy(result: ReconcileShopifyOrderFinancialsResult) {
    const calls: Array<{ brandId: string; shopDomain: string; externalOrderId: string }> = [];
    const fn = async (params: { brandId: string; shopDomain: string; externalOrderId: string }) => {
      calls.push(params);
      return result;
    };
    return { fn, calls };
  }

  const ORDER_WITH_REFUND_EVIDENCE_BODY = JSON.stringify({
    id: 5551,
    currency: "USD",
    total_price: "10.00",
    financial_status: "paid",
    updated_at: "2026-08-01T00:00:00-04:00",
    line_items: [],
    // Presence alone is the evidence signal — its own contents are never
    // trusted as a financial source (see shopifyOrderHasRefundEvidence).
    refunds: [{ id: 1 }],
  });

  function deliveryFor(url: string, rawBody: string, webhookId: string): NextRequest {
    return buildWebhookRequest(url, {
      rawBody,
      hmac: computeHmac(rawBody, SECRET),
      shopDomain: "reconciliation-test.myshopify.com",
      webhookId,
    });
  }

  test("A/B. orders/updated WITH refund evidence + RECONCILED: the merged financial fields reach ingest, non-financial fields are untouched", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const spy = makeIngestSpy(PASS_OUTCOME);
      const reconcile = makeReconcileSpy(reconciledResult());

      const response = await handleShopifyOrderWebhook(
        deliveryFor(
          "http://localhost/api/shopify/webhooks/orders/updated",
          ORDER_WITH_REFUND_EVIDENCE_BODY,
          "reconcile-merge-1",
        ),
        "orders/updated",
        normalizeShopifyOrderPayload,
        {
          async findConnectionByShopDomain() {
            return { id: "conn-1", brandId: "brand-1" };
          },
          ingest: spy.fn,
          ingestionDeps: {},
          reconcileFinancials: reconcile.fn,
        },
      );

      assert.equal(response.status, 200);
      assert.equal(reconcile.calls.length, 1);
      assert.deepEqual(reconcile.calls[0], {
        brandId: "brand-1",
        shopDomain: "reconciliation-test.myshopify.com",
        externalOrderId: "5551",
      });

      assert.equal(spy.calls.length, 1);
      const ingestedOrder = spy.calls[0].order;
      assert.equal(ingestedOrder.currencyCode, "CAD");
      assert.equal(ingestedOrder.minorUnitExponent, 2);
      assert.equal(ingestedOrder.totalMinor, BigInt(132257));
      assert.equal(ingestedOrder.totalRefundedMinor, BigInt(61063));
      assert.equal(ingestedOrder.financialStatus, "PARTIALLY_REFUNDED");
      assert.equal(ingestedOrder.providerUpdatedAt?.getTime(), RECONCILED_SNAPSHOT_UPDATED_AT.getTime());
      // Non-financial fields still come from the pure REST normalizer.
      assert.equal(ingestedOrder.externalOrderId, "5551");
      assert.equal(ingestedOrder.completeness, "FULL");
      assert.deepEqual(ingestedOrder.lineItems, []);
    });
  });

  test("B. orders/updated with NO refund evidence never calls reconcileFinancials (the common-case fast path pays no extra API cost)", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const spy = makeIngestSpy(PASS_OUTCOME);
      const reconcile = makeReconcileSpy(reconciledResult());

      await handleShopifyOrderWebhook(
        deliveryFor(
          "http://localhost/api/shopify/webhooks/orders/updated",
          ORDER_BODY,
          "no-refund-evidence-1",
        ),
        "orders/updated",
        normalizeShopifyOrderPayload,
        {
          async findConnectionByShopDomain() {
            return { id: "conn-1", brandId: "brand-1" };
          },
          ingest: spy.fn,
          ingestionDeps: {},
          reconcileFinancials: reconcile.fn,
        },
      );

      assert.equal(reconcile.calls.length, 0);
      assert.equal(spy.calls.length, 1);
    });
  });

  test("refunds/create ALWAYS calls reconcileFinancials, even though its own payload never carries a refunds[] array", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const spy = makeIngestSpy(PASS_OUTCOME);
      const reconcile = makeReconcileSpy(reconciledResult());
      const refundBody = JSON.stringify({
        id: 9001,
        order_id: 5551,
        processed_at: "2026-08-15T12:00:05-04:00",
      });

      await handleShopifyOrderWebhook(
        deliveryFor(
          "http://localhost/api/shopify/webhooks/refunds/create",
          refundBody,
          "refund-always-reconciles-1",
        ),
        "refunds/create",
        normalizeShopifyRefundPayload,
        {
          async findConnectionByShopDomain() {
            return { id: "conn-1", brandId: "brand-1" };
          },
          ingest: spy.fn,
          ingestionDeps: {},
          reconcileFinancials: reconcile.fn,
        },
      );

      assert.equal(reconcile.calls.length, 1);
      assert.equal(reconcile.calls[0].externalOrderId, "5551");
    });
  });

  test("TRANSIENT_FAILURE: 500, ingest is NEVER called (no CommerceOrderEvent claim is taken for this delivery)", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const spy = makeIngestSpy(PASS_OUTCOME);
      const reconcile = makeReconcileSpy({ outcome: "TRANSIENT_FAILURE" });

      const response = await handleShopifyOrderWebhook(
        deliveryFor(
          "http://localhost/api/shopify/webhooks/orders/updated",
          ORDER_WITH_REFUND_EVIDENCE_BODY,
          "reconcile-transient-1",
        ),
        "orders/updated",
        normalizeShopifyOrderPayload,
        {
          async findConnectionByShopDomain() {
            return { id: "conn-1", brandId: "brand-1" };
          },
          ingest: spy.fn,
          ingestionDeps: {},
          reconcileFinancials: reconcile.fn,
        },
      );

      assert.equal(response.status, 500, "Shopify must be asked to redeliver");
      assert.equal(spy.calls.length, 0, "no unproven data may reach ingest");
    });
  });

  test("F. NOT_ELIGIBLE: ingest IS called, but totalRefundedMinor and financialStatus are deferred (null) — never a guessed value; other fields still land", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const spy = makeIngestSpy(PASS_OUTCOME);
      const reconcile = makeReconcileSpy({ outcome: "NOT_ELIGIBLE", reason: "NO_CREDENTIAL" });

      const response = await handleShopifyOrderWebhook(
        deliveryFor(
          "http://localhost/api/shopify/webhooks/orders/updated",
          ORDER_WITH_REFUND_EVIDENCE_BODY,
          "reconcile-not-eligible-1",
        ),
        "orders/updated",
        normalizeShopifyOrderPayload,
        {
          async findConnectionByShopDomain() {
            return { id: "conn-1", brandId: "brand-1" };
          },
          ingest: spy.fn,
          ingestionDeps: {},
          reconcileFinancials: reconcile.fn,
        },
      );

      assert.equal(response.status, 200);
      assert.equal(spy.calls.length, 1);
      const ingestedOrder = spy.calls[0].order;
      assert.equal(ingestedOrder.totalRefundedMinor, null);
      assert.equal(ingestedOrder.financialStatus, null);
      // The immutable, pre-refund REST fields are untouched — only the two
      // settlement fields that needed reconciliation are deferred.
      assert.equal(ingestedOrder.currencyCode, "USD");
      assert.equal(ingestedOrder.totalMinor, BigInt(1000));
      assert.equal(ingestedOrder.externalOrderId, "5551");
    });
  });

  test("order_transactions/create ALWAYS triggers reconciliation from its own bare, order-id-only payload", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const spy = makeIngestSpy(PASS_OUTCOME);
      const reconcile = makeReconcileSpy(reconciledResult());
      const transactionBody = JSON.stringify({
        id: 42,
        order_id: 5551,
        kind: "refund",
        status: "success",
        processed_at: "2026-08-15T12:00:10-04:00",
      });

      await handleShopifyOrderWebhook(
        deliveryFor(
          "http://localhost/api/shopify/webhooks/order_transactions/create",
          transactionBody,
          "order-transaction-always-reconciles-1",
        ),
        "order_transactions/create",
        normalizeShopifyOrderTransactionPayload,
        {
          async findConnectionByShopDomain() {
            return { id: "conn-1", brandId: "brand-1" };
          },
          ingest: spy.fn,
          ingestionDeps: {},
          reconcileFinancials: reconcile.fn,
        },
      );

      assert.equal(reconcile.calls.length, 1);
      assert.equal(reconcile.calls[0].externalOrderId, "5551");
    });
  });
});

// ---------------------------------------------------------------------------
// No PII / secrets in the audit log
// ---------------------------------------------------------------------------

describe("the webhook audit log never carries a payload excerpt, customer field, order total, or click token", () => {
  test("logWebhook's JSON.stringify call only ever serializes classified tags, counts, and the shop domain (source inspection, scoped to the actual object literal — not the sanitized-by-design doc comment above it, which deliberately NAMES 'payload excerpt' and 'token' to document their exclusion)", () => {
    const source = readSource("src/lib/commerce/providers/shopify-order-webhook.ts");
    const stringifyStart = source.indexOf("JSON.stringify({", source.indexOf("function logWebhook"));
    assert.notEqual(stringifyStart, -1);
    const closeIdx = source.indexOf("}),", stringifyStart);
    assert.notEqual(closeIdx, -1);
    const objectLiteral = source.slice(stringifyStart, closeIdx);

    assert.doesNotMatch(objectLiteral, /payload/i);
    assert.doesNotMatch(objectLiteral, /token/i);
    assert.doesNotMatch(objectLiteral, /rawBody/);

    // And exactly the expected, closed set of keys — nothing more.
    const keys = [...objectLiteral.matchAll(/^\s*(\w+)[:,]/gm)].map((m) => m[1]);
    assert.deepEqual(keys.sort(), [
      "attributionLinked",
      "event",
      "lineItemCount",
      "outcome",
      "reason",
      "reconciliationOutcome",
      "shopDomain",
      "topic",
      "warnings",
    ].sort());
  });
});

// ---------------------------------------------------------------------------
// DATABASE_URL pin
// ---------------------------------------------------------------------------

test("this test file pins DATABASE_URL to the blocked host on line 1, before any import", () => {
  const source = readSource("tests/shopify-order-webhook.test.ts");
  assert.equal(
    source.split("\n")[0],
    'process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";',
  );
});
