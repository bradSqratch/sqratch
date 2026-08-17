process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/shopify-webhook-verification.test.ts
 *
 * Hardens and proves the behavior of Shopify webhook verification
 * (src/lib/shopify-webhooks.ts's `verifyShopifyWebhookRequest`, used
 * unmodified by all four LIVE webhook routes:
 *   - src/app/api/shopify/webhooks/app/uninstalled/route.ts
 *   - src/app/api/shopify/webhooks/shop/redact/route.ts
 *   - src/app/api/shopify/webhooks/customers/redact/route.ts
 *   - src/app/api/shopify/webhooks/customers/data_request/route.ts
 *
 * and formally locks in the decision that webhooks intentionally do NOT
 * route through `ShopifyCommerceAdapter.verifyAndParseWebhook` (see the
 * "architecture lock" describe block near the bottom).
 *
 * Every "valid signature" case in this file computes a GENUINE HMAC with
 * node:crypto (`computeHmac` below) over a synthetic test secret — never a
 * stubbed verifier. `verifyShopifyWebhookHmac` itself
 * (src/lib/shopify.ts:75-95) is exercised exactly as production calls it,
 * unmodified and unmocked.
 *
 * DB-touching business logic (app/uninstalled and shop/redact's `if
 * (verification.shop)` blocks, which write to Brand/CommerceConnection/etc.
 * via prisma — owned by other agents and forbidden territory for this
 * task) is deliberately never exercised here: every route-level test either
 * (a) fails verification before any prisma call is reached, or (b) sends a
 * request with no `x-shopify-shop-domain` header, which makes
 * `verification.shop === ""` (falsy) and causes ALL FOUR routes to skip
 * their business-logic block entirely and fall straight through to the
 * shared 200-empty-body success return — so the success contract is proven
 * for every route without a reachable database. Full "valid signature ->
 * correct shop + payload" behavior is proven two ways: directly against the
 * shared `verifyShopifyWebhookRequest` helper (topic-agnostic — it is the
 * exact same function call in all four routes), and end-to-end through the
 * two routes that have no DB-touching success path at all
 * (customers/redact, customers/data_request).
 *
 * Covered cases (numbered to match the task checklist):
 *  1.  Valid signature -> ok, normalized (trim+lowercase) shop domain,
 *      correctly parsed payload (helper-level + end-to-end on the two
 *      DB-free topics).
 *  2.  Invalid signature -> exact current 401 body, all four routes.
 *  3.  Missing signature header -> the same 401, all four routes.
 *  4.  Missing SHOPIFY_API_SECRET -> exact current 500 body, all four
 *      routes.
 *  5.  Tampered body (valid-looking signature computed over DIFFERENT
 *      bytes) is rejected -> proves the HMAC covers raw bytes, not
 *      re-serialized JSON.
 *  6.  Timing-safe comparison (crypto.timingSafeEqual) is actually used,
 *      via source inspection (matches the tests/timing-safe-equal.test.ts /
 *      tests/shopify-scope-drift.test.ts precedent of asserting against
 *      file contents rather than re-testing crypto internals).
 *  7.  Malformed / empty JSON body does not throw; payload is `null`
 *      (helper-level + end-to-end on the two DB-free topics).
 *  8.  An unknown/forged `x-shopify-topic` header cannot make one route
 *      silently behave like another: shopify-webhooks.ts performs no
 *      topic-based branching at all, each live topic has its own dedicated
 *      URI in shopify.app.toml / shopify.app.custom.toml, and forging the
 *      header on a real request is shown not to change which route's
 *      logic actually ran.
 *  9.  Success responses remain an EMPTY body with status 200, all four
 *      routes.
 *  10. No secret, HMAC value, or raw signature appears in any captured log
 *      line or response body, across valid / invalid / missing-header /
 *      missing-secret cases.
 *  Architecture lock: the webhook routes verify BEFORE and WITHOUT any
 *      CommerceConnection lookup, and ShopifyCommerceAdapter.verifyAndParseWebhook
 *      accepts but never uses `connectionId` and wraps the exact same
 *      `verifyShopifyWebhookHmac` function — locking in the decision to
 *      keep webhooks on the existing helper.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, describe, before } from "node:test";

import { NextRequest } from "next/server";

import { verifyShopifyWebhookRequest } from "../src/lib/shopify-webhooks";

// The four route modules below transitively import src/lib/prisma.ts, which
// throws synchronously at module-evaluation time if DATABASE_URL is not yet
// set. Under real ESM (which is how `tsx --test` loads this file), a STATIC
// import's target module is evaluated before this file's own top-level
// `process.env.DATABASE_URL = ...` assignment runs (module graph evaluation
// order, not textual order) — so importing them statically here would throw
// before line 1 ever executes. Instead they are `await import()`-ed inside
// `before()`, AFTER the assignment has already run, matching the same
// pattern used by tests/qr-routes-hardening.test.ts for the same reason.
let appUninstalledRoute: typeof import("../src/app/api/shopify/webhooks/app/uninstalled/route");
let shopRedactRoute: typeof import("../src/app/api/shopify/webhooks/shop/redact/route");
let customersRedactRoute: typeof import("../src/app/api/shopify/webhooks/customers/redact/route");
let customersDataRequestRoute: typeof import("../src/app/api/shopify/webhooks/customers/data_request/route");

before(async () => {
  appUninstalledRoute = await import("../src/app/api/shopify/webhooks/app/uninstalled/route");
  shopRedactRoute = await import("../src/app/api/shopify/webhooks/shop/redact/route");
  customersRedactRoute = await import("../src/app/api/shopify/webhooks/customers/redact/route");
  customersDataRequestRoute = await import(
    "../src/app/api/shopify/webhooks/customers/data_request/route"
  );
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADER_HMAC = "x-shopify-hmac-sha256";
const HEADER_SHOP = "x-shopify-shop-domain";
const HEADER_TOPIC = "x-shopify-topic";

const SECRET = "test-webhook-shared-secret-9f3a";

/** Genuine HMAC-SHA256/base64 over raw bytes, exactly as verifyShopifyWebhookHmac computes it. */
function computeHmac(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Runs `fn` with `process.env.SHOPIFY_API_SECRET` set (or deleted), always restoring it after. */
async function withShopifyApiSecret<T>(
  secret: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
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
  /** Omit to send no HMAC header at all (undefined); pass a string (possibly forged) to set it. */
  hmac?: string;
  /** Omit to send no shop-domain header at all. */
  shopDomain?: string;
  /** Omit to send no topic header at all. Never read by verifyShopifyWebhookRequest (see item 8). */
  topic?: string;
}

function buildWebhookRequest(url: string, options: WebhookRequestOptions): NextRequest {
  const headers = new Headers();
  if (options.hmac !== undefined) {
    headers.set(HEADER_HMAC, options.hmac);
  }
  if (options.shopDomain !== undefined) {
    headers.set(HEADER_SHOP, options.shopDomain);
  }
  if (options.topic !== undefined) {
    headers.set(HEADER_TOPIC, options.topic);
  }
  return new NextRequest(url, { method: "POST", headers, body: options.rawBody });
}

/** Captures console.log/warn/error output produced while `fn` runs, then restores the originals. */
async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, logged };
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

interface RouteUnderTest {
  topic: string;
  url: string;
}

// NOTE: deliberately carries only `topic`/`url` — NOT a direct reference to
// e.g. `appUninstalledRoute.POST` — because this array literal is built
// during module-collection time, before the top-level `before()` hook above
// has populated those module bindings (they are still `undefined` at this
// point). Each POST handler is resolved lazily via `getRoutePost()` inside
// the actual (later-running) test bodies instead.
const ROUTES: RouteUnderTest[] = [
  { topic: "app/uninstalled", url: "http://localhost/api/shopify/webhooks/app/uninstalled" },
  { topic: "shop/redact", url: "http://localhost/api/shopify/webhooks/shop/redact" },
  {
    topic: "customers/data_request",
    url: "http://localhost/api/shopify/webhooks/customers/data_request",
  },
  { topic: "customers/redact", url: "http://localhost/api/shopify/webhooks/customers/redact" },
];

/** Resolves a topic's POST handler. Only safe to call from inside a running test (after `before()`). */
function getRoutePost(topic: string): (request: NextRequest) => Promise<Response> {
  switch (topic) {
    case "app/uninstalled":
      return appUninstalledRoute.POST;
    case "shop/redact":
      return shopRedactRoute.POST;
    case "customers/data_request":
      return customersDataRequestRoute.POST;
    case "customers/redact":
      return customersRedactRoute.POST;
    default:
      throw new Error(`getRoutePost: no route registered for topic "${topic}"`);
  }
}

const REPO_ROOT = process.cwd();

function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

// ---------------------------------------------------------------------------
// 1, 5, 7: shared verification helper — precise, topic-agnostic behavior
// ---------------------------------------------------------------------------

describe("verifyShopifyWebhookRequest: core contract shared by all four live topics", () => {
  test("1. a valid signature verifies and yields a normalized (trim+lowercase) shop domain and the correctly parsed payload", async () => {
    const payloadObj = { id: 99, shop_id: 42, nested: { ok: true, values: [1, 2, 3] } };
    const rawBody = JSON.stringify(payloadObj);
    const hmac = computeHmac(rawBody, SECRET);

    await withShopifyApiSecret(SECRET, async () => {
      const request = buildWebhookRequest(
        "http://localhost/api/shopify/webhooks/app/uninstalled",
        { rawBody, hmac, shopDomain: "TEST-Shop.MyShopify.COM" },
      );
      const verification = await verifyShopifyWebhookRequest(request);

      assert.equal(verification.ok, true);
      if (!verification.ok) {
        return;
      }
      assert.equal(verification.shop, "test-shop.myshopify.com");
      assert.deepEqual(verification.payload, payloadObj);
      assert.equal(verification.rawBody, rawBody);
    });
  });

  test("5. a tampered body (valid-looking signature computed over DIFFERENT bytes) is rejected — proves the HMAC is over the raw body, not re-serialized JSON", async () => {
    const signedBody = JSON.stringify({ id: 1, amountCents: 100 });
    const hmac = computeHmac(signedBody, SECRET);
    // Same logical shape, different actual bytes on the wire.
    const tamperedBody = JSON.stringify({ id: 1, amountCents: 100000 });

    await withShopifyApiSecret(SECRET, async () => {
      const request = buildWebhookRequest(
        "http://localhost/api/shopify/webhooks/app/uninstalled",
        { rawBody: tamperedBody, hmac, shopDomain: "test-shop.myshopify.com" },
      );
      const verification = await verifyShopifyWebhookRequest(request);

      assert.equal(verification.ok, false);
      if (verification.ok) {
        return;
      }
      assert.equal(verification.response.status, 401);
      const body = await verification.response.json();
      assert.deepEqual(body, { error: "Invalid Shopify webhook signature." });
    });
  });

  test("7. a malformed JSON body with a genuinely valid signature over those exact bytes does not throw — payload is null", async () => {
    const rawBody = "{this is not valid json";
    const hmac = computeHmac(rawBody, SECRET);

    await withShopifyApiSecret(SECRET, async () => {
      const request = buildWebhookRequest(
        "http://localhost/api/shopify/webhooks/app/uninstalled",
        { rawBody, hmac, shopDomain: "test-shop.myshopify.com" },
      );

      await assert.doesNotReject(async () => {
        const verification = await verifyShopifyWebhookRequest(request);
        assert.equal(verification.ok, true);
        if (!verification.ok) {
          return;
        }
        assert.equal(verification.payload, null);
      });
    });
  });

  test("7b. an empty body with a genuinely valid signature over zero bytes does not throw — payload is null", async () => {
    const rawBody = "";
    const hmac = computeHmac(rawBody, SECRET);

    await withShopifyApiSecret(SECRET, async () => {
      const request = buildWebhookRequest(
        "http://localhost/api/shopify/webhooks/shop/redact",
        { rawBody, hmac, shopDomain: "test-shop.myshopify.com" },
      );
      const verification = await verifyShopifyWebhookRequest(request);
      assert.equal(verification.ok, true);
      if (!verification.ok) {
        return;
      }
      assert.equal(verification.payload, null);
    });
  });
});

// ---------------------------------------------------------------------------
// 6: timing-safe comparison (source inspection, matching the
// tests/timing-safe-equal.test.ts / tests/shopify-scope-drift.test.ts
// precedent of asserting against file contents).
// ---------------------------------------------------------------------------

test("6. verifyShopifyWebhookHmac uses crypto.timingSafeEqual, not a naive === comparison, to compare the HMAC", () => {
  const source = readSource("src/lib/shopify.ts");
  const fnStart = source.indexOf("export function verifyShopifyWebhookHmac");
  assert.notEqual(fnStart, -1, "verifyShopifyWebhookHmac must exist in src/lib/shopify.ts");

  const nextExportIdx = source.indexOf("\nexport ", fnStart + 1);
  const fnBody = source.slice(fnStart, nextExportIdx === -1 ? undefined : nextExportIdx);

  assert.match(fnBody, /crypto\.timingSafeEqual\(/);
  assert.doesNotMatch(fnBody, /expectedBuffer\s*===\s*receivedBuffer/);
  assert.doesNotMatch(fnBody, /options\.hmac\s*===/);
});

// ---------------------------------------------------------------------------
// 2, 3, 4, 9: route-level behavior across all four live topics, restricted
// to paths that never reach a prisma call (see file header).
// ---------------------------------------------------------------------------

describe("2 & 3. invalid or missing signature is rejected with the exact current 401 body, on all four live topics", () => {
  for (const route of ROUTES) {
    test(`${route.topic}: invalid signature -> 401 {error:"Invalid Shopify webhook signature."}`, async () => {
      await withShopifyApiSecret(SECRET, async () => {
        const rawBody = JSON.stringify({ shop_id: 1 });
        const request = buildWebhookRequest(route.url, {
          rawBody,
          hmac: "clearly-not-a-real-signature==",
          shopDomain: "test-shop.myshopify.com",
          topic: route.topic,
        });
        const response = await getRoutePost(route.topic)(request);
        assert.equal(response.status, 401);
        const body = await response.json();
        assert.deepEqual(body, { error: "Invalid Shopify webhook signature." });
      });
    });

    test(`${route.topic}: missing signature header -> the same 401 body`, async () => {
      await withShopifyApiSecret(SECRET, async () => {
        const rawBody = JSON.stringify({ shop_id: 1 });
        const request = buildWebhookRequest(route.url, {
          rawBody,
          shopDomain: "test-shop.myshopify.com",
          topic: route.topic,
          // hmac intentionally omitted
        });
        const response = await getRoutePost(route.topic)(request);
        assert.equal(response.status, 401);
        const body = await response.json();
        assert.deepEqual(body, { error: "Invalid Shopify webhook signature." });
      });
    });
  }
});

describe("4. a missing SHOPIFY_API_SECRET yields the exact current 500 body, on all four live topics", () => {
  for (const route of ROUTES) {
    test(`${route.topic}`, async () => {
      await withShopifyApiSecret(undefined, async () => {
        const rawBody = JSON.stringify({ shop_id: 1 });
        // Even a well-formed-looking hmac must not matter: the secret check runs first.
        const request = buildWebhookRequest(route.url, {
          rawBody,
          hmac: computeHmac(rawBody, "irrelevant-because-secret-is-missing"),
          shopDomain: "test-shop.myshopify.com",
          topic: route.topic,
        });
        const response = await getRoutePost(route.topic)(request);
        assert.equal(response.status, 500);
        const body = await response.json();
        assert.deepEqual(body, { error: "Missing Shopify API secret." });
      });
    });
  }
});

describe("9. success responses remain an EMPTY body with status 200 (no JSON), on all four live topics", () => {
  for (const route of ROUTES) {
    test(`${route.topic}`, async () => {
      await withShopifyApiSecret(SECRET, async () => {
        const rawBody = JSON.stringify({ id: 1 });
        const hmac = computeHmac(rawBody, SECRET);
        // Shop-domain header intentionally omitted: verification.shop becomes
        // "" (falsy), so app/uninstalled and shop/redact's DB-writing
        // business-logic block is skipped and every route falls straight
        // through to the shared `new NextResponse(null, { status: 200 })` —
        // this proves the success contract without ever touching prisma.
        const request = buildWebhookRequest(route.url, { rawBody, hmac, topic: route.topic });
        const response = await getRoutePost(route.topic)(request);
        assert.equal(response.status, 200);
        const text = await response.text();
        assert.equal(text, "", "success body must be empty, not JSON");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 1 & 7 end-to-end on the two topics with no DB-touching success path at
// all (customers/redact, customers/data_request), proving the shared
// helper's shop-domain/payload behavior actually reaches a real route.
// ---------------------------------------------------------------------------

describe("1 & 7 end-to-end (DB-free topics): valid signature carries the correct shop domain into the route; malformed body still succeeds", () => {
  // Same reasoning as ROUTES above: only topic/url here, resolved lazily via
  // getRoutePost() inside the test bodies below.
  const dbFreeRoutes = ROUTES.filter(
    (r) => r.topic === "customers/redact" || r.topic === "customers/data_request",
  );

  for (const route of dbFreeRoutes) {
    test(`${route.topic}: valid signature -> 200, and the audit log carries the normalized shop domain`, async () => {
      await withShopifyApiSecret(SECRET, async () => {
        const rawBody = JSON.stringify({ shop_id: 42, orders_requested: [] });
        const hmac = computeHmac(rawBody, SECRET);
        const request = buildWebhookRequest(route.url, {
          rawBody,
          hmac,
          shopDomain: "END-TO-END-Test.MyShopify.com",
          topic: route.topic,
        });
        const { result: response, logged } = await captureConsole(() =>
          getRoutePost(route.topic)(request),
        );

        assert.equal(response.status, 200);
        assert.equal(await response.text(), "");

        const logLine = logged.find((line) => line.includes(route.topic));
        assert.ok(logLine, "expected a sanitized audit log line for this webhook");
        const parsed = JSON.parse(logLine!) as { shopDomain?: string };
        assert.equal(parsed.shopDomain, "end-to-end-test.myshopify.com");
      });
    });

    test(`${route.topic}: malformed JSON body with a genuinely valid signature -> still 200, never 500`, async () => {
      await withShopifyApiSecret(SECRET, async () => {
        const rawBody = "{not valid json at all";
        const hmac = computeHmac(rawBody, SECRET);
        const request = buildWebhookRequest(route.url, {
          rawBody,
          hmac,
          shopDomain: "test-shop.myshopify.com",
          topic: route.topic,
        });
        const response = await getRoutePost(route.topic)(request);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), "");
      });
    });
  }
});

// ---------------------------------------------------------------------------
// 8: an unknown/forged topic header cannot be silently treated as a known
// one — because there is no header-based topic dispatch anywhere in this
// design. Each live topic is bound to its own dedicated URI.
// ---------------------------------------------------------------------------

describe("8. topic identity is bound to a dedicated URL, not the spoofable x-shopify-topic header", () => {
  test("shopify-webhooks.ts performs no topic-based branching at all — it never reads x-shopify-topic", () => {
    const source = readSource("src/lib/shopify-webhooks.ts");
    assert.doesNotMatch(source, /x-shopify-topic/i);
  });

  test("forging x-shopify-topic to a different live topic does not change which route's logic ran", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const rawBody = JSON.stringify({ id: 1 });
      const hmac = computeHmac(rawBody, SECRET);
      const request = buildWebhookRequest(
        "http://localhost/api/shopify/webhooks/customers/redact",
        {
          rawBody,
          hmac,
          shopDomain: "test-shop.myshopify.com",
          topic: "app/uninstalled", // forged/mismatched header
        },
      );
      const { result: response, logged } = await captureConsole(() =>
        customersRedactRoute.POST(request),
      );

      assert.equal(response.status, 200);
      const logLine = logged.find((line) => line.includes('"topic"'));
      assert.ok(logLine, "expected an audit log line");
      const parsed = JSON.parse(logLine!) as { topic?: string };
      // The route logs its OWN topic constant, never derived from the
      // (forged) request header — proving the header cannot redirect it.
      assert.equal(parsed.topic, "customers/redact");
    });
  });

  test("shopify.app.toml and shopify.app.custom.toml each bind a distinct, dedicated URI per live topic — no shared catch-all endpoint", () => {
    for (const file of ["shopify.app.toml", "shopify.app.custom.toml"]) {
      const source = readSource(file);
      const uriMatches = [...source.matchAll(/uri = "([^"]+)"/g)].map((match) => match[1]);
      assert.equal(uriMatches.length, 8, `expected 8 webhook subscription URIs in ${file}`);
      assert.equal(
        new Set(uriMatches).size,
        uriMatches.length,
        `expected all webhook URIs in ${file} to be distinct (no shared endpoint)`,
      );
      for (const topic of [
        "app/uninstalled",
        "app/scopes_update",
        "shop/redact",
        "customers/redact",
        "customers/data_request",
        "orders/create",
        "orders/updated",
        "refunds/create",
      ]) {
        assert.ok(
          uriMatches.some((uri) => uri.endsWith(`/webhooks/${topic}`)),
          `expected a dedicated URI ending in /webhooks/${topic} in ${file}`,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 10: no secret, HMAC, or raw signature value ever appears in a log line or
// response body, across every case exercised above.
// ---------------------------------------------------------------------------

test("10. no secret, HMAC value, or raw signature appears in any log line or response body", async () => {
  const leakSecret = "leak-check-secret-zzz999-should-never-appear";
  const rawBody = JSON.stringify({ id: 7 });
  const validHmac = computeHmac(rawBody, leakSecret);
  const forgedHmac = "forged-signature-value-should-never-leak-either";
  const captured: string[] = [];

  await withShopifyApiSecret(leakSecret, async () => {
    for (const hmac of [validHmac, forgedHmac, undefined]) {
      const request = buildWebhookRequest(
        "http://localhost/api/shopify/webhooks/customers/redact",
        { rawBody, hmac, shopDomain: "leak-check.myshopify.com" },
      );
      const { result: response, logged } = await captureConsole(() =>
        customersRedactRoute.POST(request),
      );
      captured.push(await response.text(), ...logged);
    }
  });

  // Missing-secret case too.
  await withShopifyApiSecret(undefined, async () => {
    const request = buildWebhookRequest(
      "http://localhost/api/shopify/webhooks/customers/redact",
      { rawBody, hmac: validHmac, shopDomain: "leak-check.myshopify.com" },
    );
    const { result: response, logged } = await captureConsole(() =>
      customersRedactRoute.POST(request),
    );
    captured.push(await response.text(), ...logged);
  });

  const haystack = captured.join("\n");
  assert.doesNotMatch(haystack, new RegExp(escapeRegExp(leakSecret)));
  assert.doesNotMatch(haystack, new RegExp(escapeRegExp(validHmac)));
  assert.doesNotMatch(haystack, new RegExp(escapeRegExp(forgedHmac)));
});

// ---------------------------------------------------------------------------
// Architecture lock: proves the decision to keep webhooks on the existing
// verifyShopifyWebhookRequest helper instead of routing through
// ShopifyCommerceAdapter.verifyAndParseWebhook. If a future refactor tries
// to make the routes look up a CommerceConnection before verifying, or
// tries to make verifyAndParseWebhook depend on a real lookup, these tests
// fail loudly.
// ---------------------------------------------------------------------------

describe("architecture lock: webhook verification does not depend on CommerceConnection", () => {
  test("src/lib/shopify-webhooks.ts never references CommerceConnection, connectionId, or prisma", () => {
    const source = readSource("src/lib/shopify-webhooks.ts");
    assert.doesNotMatch(source, /CommerceConnection/);
    assert.doesNotMatch(source, /connectionId/);
    assert.doesNotMatch(source, /prisma/i);
  });

  test("all four live webhook routes call verifyShopifyWebhookRequest and gate on it BEFORE any prisma usage", () => {
    for (const relPath of [
      "src/app/api/shopify/webhooks/app/uninstalled/route.ts",
      "src/app/api/shopify/webhooks/shop/redact/route.ts",
      "src/app/api/shopify/webhooks/customers/redact/route.ts",
      "src/app/api/shopify/webhooks/customers/data_request/route.ts",
    ]) {
      const source = readSource(relPath);
      const verifyIdx = source.indexOf("verifyShopifyWebhookRequest(request)");
      assert.notEqual(verifyIdx, -1, `${relPath} must call verifyShopifyWebhookRequest(request)`);

      const gateIdx = source.indexOf("if (!verification.ok)");
      assert.notEqual(gateIdx, -1, `${relPath} must gate on !verification.ok`);
      assert.ok(gateIdx > verifyIdx, `${relPath}: the ok-gate must come after the verify call`);

      const firstPrismaIdx = source.indexOf("prisma.");
      if (firstPrismaIdx !== -1) {
        assert.ok(
          firstPrismaIdx > gateIdx,
          `${relPath}: prisma usage must come strictly after the verification gate, never before or instead of it`,
        );
      }
    }
  });

  test("ShopifyCommerceAdapter.verifyAndParseWebhook accepts connectionId but never uses it in its body, and never looks up a connection", () => {
    const source = readSource("src/lib/commerce/providers/shopify-commerce-adapter.ts");
    const sigIdx = source.indexOf("async verifyAndParseWebhook(");
    assert.notEqual(sigIdx, -1, "verifyAndParseWebhook must exist on ShopifyCommerceAdapter");

    const bodyMarker = "Promise<NormalizedWebhookEvent> {";
    const bodyOpenIdx = source.indexOf(bodyMarker, sigIdx);
    assert.notEqual(bodyOpenIdx, -1);

    // Brace-count from the opening `{` to find the exact end of the method
    // body, so this test stays correct even if the method grows.
    let depth = 1;
    let i = bodyOpenIdx + bodyMarker.length;
    while (depth > 0 && i < source.length) {
      if (source[i] === "{") {
        depth++;
      } else if (source[i] === "}") {
        depth--;
      }
      i++;
    }
    const methodBody = source.slice(bodyOpenIdx + bodyMarker.length, i - 1);

    assert.doesNotMatch(
      methodBody,
      /\bconnectionId\b/,
      "connectionId must be unused inside verifyAndParseWebhook's body",
    );
    assert.doesNotMatch(
      methodBody,
      /loadConnection/,
      "verifyAndParseWebhook must not look up a CommerceConnection before or during verification",
    );
  });

  test("the adapter's default webhook verifier is the exact same verifyShopifyWebhookHmac function shopify-webhooks.ts uses", () => {
    const source = readSource("src/lib/commerce/providers/shopify-commerce-adapter.ts");
    assert.match(source, /import\s*\{\s*verifyShopifyWebhookHmac\s*\}\s*from\s*"@\/lib\/shopify"/);
    assert.match(source, /verifyWebhookHmac:\s*verifyShopifyWebhookHmac\s*,?\s*\n/);
  });
});
