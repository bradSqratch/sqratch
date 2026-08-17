process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/shopify-scopes-update-webhook.test.ts
 *
 * Covers the `app/scopes_update` webhook route
 * (`src/app/api/shopify/webhooks/app/scopes_update/route.ts`) and the
 * compare-and-swap scope write it delegates to
 * (`applyGrantedScopesUpdate` in `src/lib/shopify-token-manager.ts`).
 *
 * TESTING APPROACH — REAL CODE PATH, FAKE STORAGE.
 * Every case below drives the REAL exported `POST` through the REAL
 * `verifyShopifyWebhookRequest` and the REAL `applyGrantedScopesUpdate`.
 * Nothing about verification or the CAS write is stubbed. The only substitution
 * is the Prisma `brand` delegate itself, swapped on the shared prisma singleton
 * exactly as `tests/integration-coverage.test.ts` already does, and backed by an
 * in-memory table whose `updateMany` faithfully evaluates the SAME `where`
 * predicates Prisma would (AND across `id`, `shopifyShopDomain`, and the
 * `{ not: ... }` status filter). That is what makes the tenant-isolation and
 * CAS-scoping assertions meaningful rather than tautological: a route that
 * widened its `where` would actually write more rows in this harness.
 *
 * Every "valid signature" case computes a GENUINE HMAC with node:crypto over
 * the exact raw body bytes — never a stubbed verifier.
 *
 * DATABASE_URL above is a deliberately unroutable address (port 1). No test
 * here reaches a socket: the brand delegate is replaced before the route is
 * imported, and no other delegate is touched by this route.
 */

import { test, describe, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// In-memory Brand table + Prisma delegate stub
// ---------------------------------------------------------------------------

interface FakeBrand {
  id: string;
  shopifyShopDomain: string | null;
  shopifyConnectionStatus: string;
  shopifyGrantedScopes: string | null;
}

interface FindUniqueArgs {
  where: { shopifyShopDomain: string };
  select: Record<string, boolean>;
}

interface UpdateManyArgs {
  where: {
    id?: string;
    shopifyShopDomain?: string;
    shopifyConnectionStatus?: { not?: string };
  };
  data: { shopifyGrantedScopes?: string };
}

let brands: FakeBrand[] = [];
let findUniqueCalls: FindUniqueArgs[] = [];
let updateManyCalls: UpdateManyArgs[] = [];
/** Per-test hooks so a race or a transient failure can be simulated. */
let onFindUnique: ((args: FindUniqueArgs) => void) | null = null;
let updateManyThrows: Error | null = null;

/**
 * Faithful (for the predicates this route uses) evaluation of a Prisma
 * `updateMany` where clause: every stated predicate must hold, AND-wise.
 * A `where` that omitted `id` would therefore genuinely match on domain alone
 * here — which is exactly the widening the CAS tests below are designed to
 * catch rather than assume away.
 */
function matchesWhere(brand: FakeBrand, where: UpdateManyArgs["where"]): boolean {
  if (where.id !== undefined && brand.id !== where.id) return false;
  if (
    where.shopifyShopDomain !== undefined &&
    brand.shopifyShopDomain !== where.shopifyShopDomain
  ) {
    return false;
  }
  const statusNot = where.shopifyConnectionStatus?.not;
  if (statusNot !== undefined && brand.shopifyConnectionStatus === statusNot) {
    return false;
  }
  return true;
}

const brandDelegateStub = {
  findUnique: async (args: FindUniqueArgs) => {
    findUniqueCalls.push(args);
    const match =
      brands.find(
        (brand) => brand.shopifyShopDomain === args.where.shopifyShopDomain,
      ) ?? null;
    // Fires AFTER the row is resolved but BEFORE the caller can write, so a
    // test can mutate the table exactly in the window a real concurrent
    // transaction would.
    onFindUnique?.(args);
    return match ? { id: match.id } : null;
  },
  updateMany: async (args: UpdateManyArgs) => {
    updateManyCalls.push(args);
    if (updateManyThrows) {
      throw updateManyThrows;
    }
    const matched = brands.filter((brand) => matchesWhere(brand, args.where));
    for (const brand of matched) {
      if (args.data.shopifyGrantedScopes !== undefined) {
        brand.shopifyGrantedScopes = args.data.shopifyGrantedScopes;
      }
    }
    return { count: matched.length };
  },
};

// The Phase 12.2 writer first checks the canonical neutral connection cache.
// These legacy-focused cases intentionally model pre-cutover brands, so the
// connection lookup returns no row and the real code exercises its documented
// compatibility mirror path without opening a database socket.
let canonicalConnection: { id: string; brandId: string; grantedScopes: string[] } | null = null;
const commerceConnectionDelegateStub = {
  findUnique: async () => canonicalConnection,
  updateMany: async (args: { data: { grantedScopes?: string[] } }) => {
    if (!canonicalConnection) return { count: 0 };
    canonicalConnection.grantedScopes = args.data.grantedScopes ?? [];
    return { count: 1 };
  },
};

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const HEADER_HMAC = "x-shopify-hmac-sha256";
const HEADER_SHOP = "x-shopify-shop-domain";
const HEADER_TOPIC = "x-shopify-topic";

const SECRET = "test-scopes-update-webhook-secret-4f19";
const ROUTE_URL = "http://localhost/api/shopify/webhooks/app/scopes_update";

const SHOP_A = "brand-a-shop.myshopify.com";
const SHOP_B = "brand-b-shop.myshopify.com";

function computeHmac(rawBody: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
}

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

interface RequestOptions {
  rawBody: string;
  hmac?: string;
  shopDomain?: string;
  topic?: string;
}

function buildRequest(options: RequestOptions): NextRequest {
  const headers = new Headers();
  if (options.hmac !== undefined) headers.set(HEADER_HMAC, options.hmac);
  if (options.shopDomain !== undefined) headers.set(HEADER_SHOP, options.shopDomain);
  if (options.topic !== undefined) headers.set(HEADER_TOPIC, options.topic);
  return new NextRequest(ROUTE_URL, { method: "POST", headers, body: options.rawBody });
}

/** Signs the body for real and posts it. */
function signedRequest(body: unknown, shopDomain: string | undefined): NextRequest {
  const rawBody = JSON.stringify(body);
  return buildRequest({ rawBody, hmac: computeHmac(rawBody, SECRET), shopDomain });
}

async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const logged: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    const result = await fn();
    return { result, logged };
  } finally {
    console.log = originalLog;
  }
}

const REPO_ROOT = process.cwd();
function readSource(relPath: string): string {
  return readFileSync(join(REPO_ROOT, relPath), "utf8");
}

function brand(id: string): FakeBrand {
  const found = brands.find((b) => b.id === id);
  assert.ok(found, `expected fixture brand ${id}`);
  return found!;
}

// ---------------------------------------------------------------------------
// Module wiring: replace the brand delegate BEFORE importing the route.
// ---------------------------------------------------------------------------

let POST: (request: NextRequest) => Promise<Response>;
let extractCurrentScopes: (payload: unknown) => string | null;

before(async () => {
  const prismaModule = (await import("../src/lib/prisma"))
    .default as unknown as Record<string, unknown>;
  prismaModule.brand = brandDelegateStub;
  prismaModule.commerceConnection = commerceConnectionDelegateStub;

  const route = await import("../src/app/api/shopify/webhooks/app/scopes_update/route");
  POST = route.POST as unknown as (request: NextRequest) => Promise<Response>;
  extractCurrentScopes = route.extractCurrentScopes;
});

beforeEach(() => {
  brands = [
    {
      id: "brand-a",
      shopifyShopDomain: SHOP_A,
      shopifyConnectionStatus: "CONNECTED",
      shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
    },
    {
      id: "brand-b",
      shopifyShopDomain: SHOP_B,
      shopifyConnectionStatus: "CONNECTED",
      shopifyGrantedScopes: "read_products",
    },
  ];
  findUniqueCalls = [];
  updateManyCalls = [];
  onFindUnique = null;
  updateManyThrows = null;
  canonicalConnection = null;
});

// ---------------------------------------------------------------------------
// 1. Valid HMAC + known shop -> 200 and the cached scopes match `current`.
// ---------------------------------------------------------------------------

describe("1. valid signature + known shop domain synchronizes the cached scopes", () => {
  test("200 and shopifyGrantedScopes becomes the comma-joined `current` list", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const payload = {
        id: 9001,
        shop_id: "gid://shopify/Shop/1",
        previous: ["read_products", "read_discounts", "write_discounts"],
  current: ["read_products", "read_orders", "read_themes", "read_discounts", "write_discounts"],
        updated_at: "2026-08-16T10:00:00Z",
      };

      const { result: response } = await captureConsole(() =>
        POST(signedRequest(payload, SHOP_A)),
      );

      assert.equal(response.status, 200);
      assert.equal(await response.text(), "");
      assert.equal(
        brand("brand-a").shopifyGrantedScopes,
        "read_products,read_orders,read_themes,read_discounts,write_discounts",
      );
    });
  });

  test("the shop domain header is matched case-insensitively, exactly as the sibling routes normalize it", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const { result: response, logged } = await captureConsole(() =>
        POST(signedRequest({ current: ["read_orders"] }, "BRAND-A-Shop.MyShopify.com")),
      );

      assert.equal(response.status, 200);
      assert.equal(brand("brand-a").shopifyGrantedScopes, "read_orders");
      // The lookup key handed to Prisma is the normalized form, never the raw header.
      assert.equal(findUniqueCalls[0].where.shopifyShopDomain, SHOP_A);
      const line = logged.find((l) => l.includes("app/scopes_update"));
      assert.ok(line, "expected a sanitized audit log line");
      assert.equal((JSON.parse(line!) as { shopDomain?: string }).shopDomain, SHOP_A);
    });
  });

  test("an empty `current` array is honored as a real revocation, stored as an empty string", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const response = (await captureConsole(() => POST(signedRequest({ current: [] }, SHOP_A))))
        .result;

      assert.equal(response.status, 200);
      assert.equal(brand("brand-a").shopifyGrantedScopes, "");
    });
  });

  test("repeating the identical delivery is idempotent — the second write lands the same value", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const payload = { current: ["read_products", "read_orders"] };
      await captureConsole(() => POST(signedRequest(payload, SHOP_A)));
      await captureConsole(() => POST(signedRequest(payload, SHOP_A)));

      assert.equal(brand("brand-a").shopifyGrantedScopes, "read_products,read_orders");
      assert.equal(updateManyCalls.length, 2);
    });
  });

  test("a real CommerceConnection receives the canonical JSON scope array", async () => {
    canonicalConnection = { id: "connection-a", brandId: "brand-a", grantedScopes: ["read_products"] };
    await withShopifyApiSecret(SECRET, async () => {
      const response = await POST(signedRequest({ current: ["read_products", "read_themes"] }, SHOP_A));
      assert.equal(response.status, 200);
      assert.deepEqual(canonicalConnection?.grantedScopes, ["read_products", "read_themes"]);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Invalid / missing HMAC -> 401 and NO write.
// ---------------------------------------------------------------------------

describe("2. signature failure rejects with 401 before any storage access", () => {
  test("an invalid signature returns 401 and never reads or writes a brand row", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const rawBody = JSON.stringify({ current: ["read_orders"] });
      const response = await POST(
        buildRequest({
          rawBody,
          hmac: computeHmac(rawBody, "a-completely-different-secret"),
          shopDomain: SHOP_A,
        }),
      );

      assert.equal(response.status, 401);
      assert.equal(findUniqueCalls.length, 0);
      assert.equal(updateManyCalls.length, 0);
      assert.equal(
        brand("brand-a").shopifyGrantedScopes,
        "read_products,read_discounts,write_discounts",
      );
    });
  });

  test("a missing signature header returns 401 and never reads or writes a brand row", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const response = await POST(
        buildRequest({
          rawBody: JSON.stringify({ current: ["read_orders"] }),
          shopDomain: SHOP_A,
        }),
      );

      assert.equal(response.status, 401);
      assert.equal(findUniqueCalls.length, 0);
      assert.equal(updateManyCalls.length, 0);
    });
  });

  test("a signature valid for a DIFFERENT body cannot authorize this body (no byte substitution)", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const signedBody = JSON.stringify({ current: ["read_products"] });
      const swappedBody = JSON.stringify({ current: ["read_orders", "write_discounts"] });
      const response = await POST(
        buildRequest({
          rawBody: swappedBody,
          hmac: computeHmac(signedBody, SECRET),
          shopDomain: SHOP_A,
        }),
      );

      assert.equal(response.status, 401);
      assert.equal(updateManyCalls.length, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// 3. Valid HMAC + unknown shop -> 200, deterministic no-op.
// ---------------------------------------------------------------------------

describe("3. an unknown shop is a deterministic no-op, acknowledged with 200", () => {
  test("unknown shop domain: 200, lookup attempted, no write, no other row disturbed", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const { result: response, logged } = await captureConsole(() =>
        POST(signedRequest({ current: ["read_orders"] }, "never-installed.myshopify.com")),
      );

      assert.equal(response.status, 200);
      assert.equal(findUniqueCalls.length, 1);
      assert.equal(updateManyCalls.length, 0);
      assert.equal(
        brand("brand-a").shopifyGrantedScopes,
        "read_products,read_discounts,write_discounts",
      );
      assert.equal(brand("brand-b").shopifyGrantedScopes, "read_products");
      const line = logged.find((l) => l.includes("app/scopes_update"));
      assert.equal((JSON.parse(line!) as { outcome?: string }).outcome, "UNKNOWN_SHOP");
    });
  });

  test("no shop domain header at all: 200, and no storage access whatsoever", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const rawBody = JSON.stringify({ current: ["read_orders"] });
      const { result: response } = await captureConsole(() =>
        POST(buildRequest({ rawBody, hmac: computeHmac(rawBody, SECRET) })),
      );

      assert.equal(response.status, 200);
      assert.equal(findUniqueCalls.length, 0);
      assert.equal(updateManyCalls.length, 0);
    });
  });

  test("malformed JSON with a genuinely valid signature: 200, never 500, and no write", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const rawBody = "{not valid json at all";
      const { result: response } = await captureConsole(() =>
        POST(buildRequest({ rawBody, hmac: computeHmac(rawBody, SECRET), shopDomain: SHOP_A })),
      );

      assert.equal(response.status, 200);
      assert.equal(updateManyCalls.length, 0);
      assert.equal(
        brand("brand-a").shopifyGrantedScopes,
        "read_products,read_discounts,write_discounts",
      );
    });
  });

  test("a verified payload with no usable `current` list writes nothing", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      for (const payload of [
        { previous: ["read_products"] },
        { current: "read_products,read_orders" },
        { current: ["read_products", 42] },
        { current: null },
      ]) {
        updateManyCalls = [];
        const { result: response } = await captureConsole(() =>
          POST(signedRequest(payload, SHOP_A)),
        );
        assert.equal(response.status, 200, `expected 200 for ${JSON.stringify(payload)}`);
        assert.equal(
          updateManyCalls.length,
          0,
          `expected no write for ${JSON.stringify(payload)}`,
        );
      }
      assert.equal(
        brand("brand-a").shopifyGrantedScopes,
        "read_products,read_discounts,write_discounts",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 4. TENANT ISOLATION.
// ---------------------------------------------------------------------------

describe("4. tenant isolation: a signed payload for shop A can never reach brand B", () => {
  /**
   * The payload is genuinely, correctly signed for Brand A's shop domain, and
   * every field an attacker (or a confused integration) might hope is used for
   * row selection is set to point at Brand B: `shop_id`, `id`, `brand_id`,
   * `shop_domain`, `myshopify_domain`, even a nested `brand` object. The route
   * reads NONE of them — the only identity input is the verified
   * `X-Shopify-Shop-Domain` header — so Brand B must come out byte-identical.
   */
  test("adversarial body fields naming brand B are ignored; only brand A is written", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const payload = {
        id: "brand-b",
        shop_id: "brand-b",
        brand_id: "brand-b",
        brandId: "brand-b",
        shop_domain: SHOP_B,
        myshopify_domain: SHOP_B,
        shop: SHOP_B,
        brand: { id: "brand-b", shopifyShopDomain: SHOP_B },
        previous: ["read_products"],
        current: ["read_products", "read_orders"],
      };

      const { result: response } = await captureConsole(() =>
        POST(signedRequest(payload, SHOP_A)),
      );

      assert.equal(response.status, 200);
      // A got the new list...
      assert.equal(brand("brand-a").shopifyGrantedScopes, "read_products,read_orders");
      // ...and B is untouched, exactly as seeded.
      assert.equal(brand("brand-b").shopifyGrantedScopes, "read_products");
      assert.equal(brand("brand-b").shopifyConnectionStatus, "CONNECTED");
      assert.equal(brand("brand-b").shopifyShopDomain, SHOP_B);
    });
  });

  test("the header, not the body, decides the tenant — signing for B writes B and leaves A alone", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const payload = { shop_domain: SHOP_A, id: "brand-a", current: ["read_orders"] };

      const { result: response } = await captureConsole(() =>
        POST(signedRequest(payload, SHOP_B)),
      );

      assert.equal(response.status, 200);
      assert.equal(brand("brand-b").shopifyGrantedScopes, "read_orders");
      assert.equal(
        brand("brand-a").shopifyGrantedScopes,
        "read_products,read_discounts,write_discounts",
      );
    });
  });

  test("exactly one row is ever matched by the write", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      await captureConsole(() => POST(signedRequest({ current: ["read_orders"] }, SHOP_A)));

      assert.equal(updateManyCalls.length, 1);
      const matched = brands.filter((b) => matchesWhere(b, updateManyCalls[0].where));
      assert.deepEqual(
        matched.map((b) => b.id),
        ["brand-a"],
      );
    });
  });
});

// ---------------------------------------------------------------------------
// 5. The CAS write is scoped by the RESOLVED ROW'S OWN ID.
// ---------------------------------------------------------------------------

describe("5. the scope write is a compare-and-swap pinned to the resolved row's id", () => {
  test("the updateMany where clause carries the resolved id plus the CAS guards, and nothing else", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      await captureConsole(() => POST(signedRequest({ current: ["read_orders"] }, SHOP_A)));

      assert.equal(updateManyCalls.length, 1);
      const { where, data } = updateManyCalls[0];

      // Pinned to the row resolved from the VERIFIED shop domain — not to the
      // domain string alone, and not to anything the payload supplied.
      assert.equal(where.id, "brand-a");
      assert.equal(where.shopifyShopDomain, SHOP_A);
      assert.deepEqual(where.shopifyConnectionStatus, { not: "UNINSTALLED" });
      assert.deepEqual(Object.keys(where).sort(), [
        "id",
        "shopifyConnectionStatus",
        "shopifyShopDomain",
      ]);

      // And the write itself touches ONLY the cached scope column — no status
      // transition, no token field, no other column.
      assert.deepEqual(Object.keys(data), ["shopifyGrantedScopes"]);
    });
  });

  test("a relink race between the lookup and the write matches nothing: SUPERSEDED, 200, no cross-write", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      // Simulate a concurrent relink/redact: the row's domain moves out from
      // under us AFTER it was resolved. The CAS guard must make the write a
      // no-op rather than landing on a shop it was not authenticated for.
      onFindUnique = () => {
        brand("brand-a").shopifyShopDomain = "relinked-elsewhere.myshopify.com";
      };

      const { result: response, logged } = await captureConsole(() =>
        POST(signedRequest({ current: ["read_orders"] }, SHOP_A)),
      );

      assert.equal(response.status, 200);
      assert.equal(updateManyCalls.length, 1);
      assert.equal(
        brand("brand-a").shopifyGrantedScopes,
        "read_products,read_discounts,write_discounts",
      );
      assert.equal(brand("brand-b").shopifyGrantedScopes, "read_products");
      const line = logged.find((l) => l.includes("app/scopes_update"));
      assert.equal((JSON.parse(line!) as { outcome?: string }).outcome, "SUPERSEDED");
    });
  });

  test("a late delivery cannot resurrect scopes on an already-uninstalled row", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      // app/uninstalled ran first: it clears scopes but PRESERVES the domain.
      brand("brand-a").shopifyConnectionStatus = "UNINSTALLED";
      brand("brand-a").shopifyGrantedScopes = null;

      const { result: response } = await captureConsole(() =>
        POST(signedRequest({ current: ["read_products", "read_orders"] }, SHOP_A)),
      );

      assert.equal(response.status, 200);
      assert.equal(brand("brand-a").shopifyGrantedScopes, null);
    });
  });
});

// ---------------------------------------------------------------------------
// 6. Retry semantics: transient storage failure -> 500.
// ---------------------------------------------------------------------------

describe("6. only a transient storage failure asks Shopify to retry", () => {
  test("a thrown DB error returns 500 so the delivery is retried", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      updateManyThrows = new Error("connection terminated unexpectedly");

      const { result: response, logged } = await captureConsole(() =>
        POST(signedRequest({ current: ["read_orders"] }, SHOP_A)),
      );

      assert.equal(response.status, 500);
      const line = logged.find((l) => l.includes("app/scopes_update"));
      assert.equal((JSON.parse(line!) as { outcome?: string }).outcome, "WRITE_FAILED");
      // The failure text must not leak into the log line.
      assert.ok(!logged.join("\n").includes("connection terminated"));
    });
  });

  test("the same delivery succeeds on retry once storage recovers", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const payload = { current: ["read_products", "read_orders"] };

      updateManyThrows = new Error("transient");
      const first = (await captureConsole(() => POST(signedRequest(payload, SHOP_A)))).result;
      assert.equal(first.status, 500);

      updateManyThrows = null;
      const second = (await captureConsole(() => POST(signedRequest(payload, SHOP_A)))).result;
      assert.equal(second.status, 200);
      assert.equal(brand("brand-a").shopifyGrantedScopes, "read_products,read_orders");
    });
  });
});

// ---------------------------------------------------------------------------
// 7. Payload extraction (pure).
// ---------------------------------------------------------------------------

describe("7. extractCurrentScopes reads only the post-change `current` list", () => {
  test("reads `current`, ignores `previous`, and joins in storage form", () => {
    assert.equal(
      extractCurrentScopes({
        previous: ["read_products"],
        current: ["read_products", "read_orders"],
      }),
      "read_products,read_orders",
    );
  });

  test("trims handles and drops empty entries", () => {
    assert.equal(
      extractCurrentScopes({ current: ["  read_products ", "", "read_orders"] }),
      "read_products,read_orders",
    );
  });

  test("returns null for every shape that is not a `current` string array", () => {
    for (const payload of [
      null,
      undefined,
      "read_products",
      42,
      [],
      ["read_products"],
      {},
      { current: null },
      { current: "read_products" },
      { current: { 0: "read_products" } },
      { current: ["read_products", null] },
      { current: ["read_products", { scope: "read_orders" }] },
    ]) {
      assert.equal(
        extractCurrentScopes(payload),
        null,
        `expected null for ${JSON.stringify(payload)}`,
      );
    }
  });

  test("an empty array is a valid empty grant, not a malformed payload", () => {
    assert.equal(extractCurrentScopes({ current: [] }), "");
  });

  test("the produced string is exactly what the scope readers consume", async () => {
    const { hasSufficientScopes, hasOrderAttributionScope } = await import(
      "../src/lib/shopify-token-manager"
    );
    const full = extractCurrentScopes({
      current: ["read_products", "read_orders", "read_themes", "read_discounts", "write_discounts"],
    });
    assert.equal(hasSufficientScopes(full), true);
    assert.equal(hasOrderAttributionScope(full), true);

    const withoutOrders = extractCurrentScopes({
      current: ["read_products", "read_themes", "read_discounts", "write_discounts"],
    });
    assert.equal(hasSufficientScopes(withoutOrders), true);
    assert.equal(hasOrderAttributionScope(withoutOrders), false);

    assert.equal(hasSufficientScopes(extractCurrentScopes({ current: [] })), false);
  });
});

// ---------------------------------------------------------------------------
// 8. Configuration + design locks.
// ---------------------------------------------------------------------------

describe("8. the topic is declared in both configs and bound to this route by PATH", () => {
  test("both Shopify configs subscribe app/scopes_update to this route's dedicated URI", () => {
    for (const file of ["shopify.app.toml", "shopify.app.custom.toml"]) {
      const source = readSource(file);
      const uris = [...source.matchAll(/uri = "([^"]+)"/g)].map((m) => m[1]);
      const scopesUpdateUris = uris.filter((uri) =>
        uri.endsWith("/api/shopify/webhooks/app/scopes_update"),
      );
      assert.equal(scopesUpdateUris.length, 1, `expected exactly one app/scopes_update URI in ${file}`);
      assert.match(source, /topics = \[ "app\/scopes_update" \]/);
      // It is an app-lifecycle topic, not a GDPR compliance topic.
      assert.doesNotMatch(source, /compliance_topics = \[ "app\/scopes_update" \]/);
    }
  });

  test("the route never dispatches on the spoofable x-shopify-topic header", () => {
    const source = readSource("src/app/api/shopify/webhooks/app/scopes_update/route.ts");
    assert.doesNotMatch(source, /request\.headers\.get\(\s*["']x-shopify-topic/i);
  });

  test("a forged x-shopify-topic header changes nothing about what this route does", async () => {
    await withShopifyApiSecret(SECRET, async () => {
      const rawBody = JSON.stringify({ current: ["read_orders"] });
      const { result: response, logged } = await captureConsole(() =>
        POST(
          buildRequest({
            rawBody,
            hmac: computeHmac(rawBody, SECRET),
            shopDomain: SHOP_A,
            topic: "app/uninstalled", // forged
          }),
        ),
      );

      assert.equal(response.status, 200);
      assert.equal(brand("brand-a").shopifyGrantedScopes, "read_orders");
      const line = logged.find((l) => l.includes('"topic"'));
      assert.equal((JSON.parse(line!) as { topic?: string }).topic, "app/scopes_update");
    });
  });

  test("this webhook performs no authorization or status transition — it is a passive cache sync", () => {
    const source = readSource("src/app/api/shopify/webhooks/app/scopes_update/route.ts");
    // No connection-status writes, no reward/points side effects, no token work.
    assert.doesNotMatch(source, /shopifyConnectionStatus:\s*"/);
    assert.doesNotMatch(source, /recordShopifyConnectionLoss/);
    assert.doesNotMatch(source, /brandRewardOffer/);
    assert.doesNotMatch(source, /AccessToken/);
  });
});
