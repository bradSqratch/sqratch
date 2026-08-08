process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/shopify-order-webhook.test.ts
 *
 * Tests the shared order-webhook pipeline
 * (`src/lib/commerce/providers/shopify-order-webhook.ts`'s
 * `handleShopifyOrderWebhook` / `resolveProviderEventId`) and the three real,
 * production-unreachable route handlers built on it
 * (`src/app/api/shopify/webhooks/{orders/create,orders/updated,refunds/create}/route.ts`).
 *
 * The three route files themselves take no deps parameter (they call
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
 *  20. HMAC verification enforced — one of the three new routes rejects an
 *      invalid/missing signature with 401, using a genuine computed HMAC for
 *      the valid case.
 *  21. Unverified webhook rejected before writes — ingest is never invoked
 *      when HMAC verification fails.
 */

import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";
import { CommerceProvider } from "@prisma/client";

import {
  handleShopifyOrderWebhook,
  resolveProviderEventId,
  type ShopifyOrderWebhookDeps,
} from "../src/lib/commerce/providers/shopify-order-webhook";
import { normalizeShopifyOrderPayload } from "../src/lib/commerce/providers/shopify-order-normalizer";
import {
  ingestNormalizedOrder,
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

before(async () => {
  ordersCreateRoute = await import("../src/app/api/shopify/webhooks/orders/create/route");
  ordersUpdatedRoute = await import("../src/app/api/shopify/webhooks/orders/updated/route");
  refundsCreateRoute = await import("../src/app/api/shopify/webhooks/refunds/create/route");
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
// 20 & route-level: HMAC verification enforced on all three new routes,
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
  ];
}

describe("20. HMAC verification is enforced on every one of the three new order webhook routes", () => {
  test("all three: an invalid signature -> 401 {error:\"Invalid Shopify webhook signature.\"}", async () => {
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

  test("all three: a MISSING signature header -> the same 401", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      for (const route of routes()) {
        const rawBody = JSON.stringify({ id: 1 });
        const request = buildWebhookRequest(route.url, { rawBody, shopDomain: "test-shop.myshopify.com" });
        const response = await route.post()(request);
        assert.equal(response.status, 401, `${route.name} must reject a missing HMAC with 401`);
      }
    });
  });

  test("all three: a GENUINE, correctly-computed signature over the exact raw bytes verifies (200), with no shop connection registered (DB-free success path)", async () => {
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

  test("all three: a missing SHOPIFY_API_SECRET -> 500, even with an otherwise well-formed request", async () => {
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
  ];

  for (const { file, topic, normalizer } of wiring) {
    test(`${file} binds TOPIC="${topic}" and calls handleShopifyOrderWebhook with ${normalizer}`, () => {
      const source = readSource(file);
      assert.match(source, new RegExp(`const TOPIC = "${topic}"`));
      assert.match(source, /handleShopifyOrderWebhook\(request, TOPIC, \w+\)/);
      assert.match(source, new RegExp(`import \\{ ${normalizer} \\}`));
    });
  }

  test("none of the three routes reads x-shopify-topic in actual code (comments deliberately NAME the header to document its exclusion)", () => {
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

describe("2. duplicate webhook idempotency through the full handleShopifyOrderWebhook pipeline", () => {
  test("the same X-Shopify-Webhook-Id delivered twice results in exactly one CREATED ingest call and one ALREADY_PROCESSED — proven against the REAL ingestNormalizedOrder, not a stub", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      // A minimal in-memory backing for ingestNormalizedOrder's own deps —
      // same idiom as tests/order-ingestion.test.ts, kept self-contained here
      // so this file proves the pipeline wiring end-to-end.
      const claimed = new Set<string>();
      let nextEventId = 1;
      let orderCounter = 0;
      const deps = {
        async claimEvent(input: { provider: CommerceProvider; providerEventId: string }) {
          const key = `${input.provider}:${input.providerEventId}`;
          if (claimed.has(key)) return { claimed: false as const };
          claimed.add(key);
          return { claimed: true as const, eventId: `event-${nextEventId++}` };
        },
        async loadConnection() {
          return { id: "conn-1", brandId: "brand-1", provider: CommerceProvider.SHOPIFY, status: "CONNECTED" as const };
        },
        async runTransaction<T>(fn: (tx: never) => Promise<T>): Promise<T> {
          const fakeTx = {
            commerceOrder: {
              async findUnique() {
                return null;
              },
              async create() {
                orderCounter += 1;
                return { id: `order-${orderCounter}` };
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
        now: () => new Date("2026-08-07T12:00:00.000Z"),
      };

      const webhookDeps: Partial<ShopifyOrderWebhookDeps> = {
        async findConnectionByShopDomain() {
          return { id: "conn-1", brandId: "brand-1" };
        },
        ingest: ingestNormalizedOrder,
        ingestionDeps: deps,
      };

      const rawBody = JSON.stringify({
        id: 5551,
        currency: "USD",
        total_price: "10.00",
        updated_at: "2026-08-01T00:00:00-04:00",
        line_items: [],
      });
      const hmac = computeHmac(rawBody, SECRET);

      const makeRequest = () =>
        buildWebhookRequest("http://localhost/api/shopify/webhooks/orders/create", {
          rawBody,
          hmac,
          shopDomain: "idempotency-test.myshopify.com",
          webhookId: "same-delivery-id-999",
        });

      const first = await handleShopifyOrderWebhook(
        makeRequest(),
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );
      assert.equal(first.status, 200);
      assert.equal(orderCounter, 1, "first delivery must create exactly one order");

      const second = await handleShopifyOrderWebhook(
        makeRequest(),
        "orders/create",
        normalizeShopifyOrderPayload,
        webhookDeps,
      );
      assert.equal(second.status, 200);
      assert.equal(orderCounter, 1, "the duplicate delivery must NOT create a second order");
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
