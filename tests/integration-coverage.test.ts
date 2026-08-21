process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";

import { test, describe, before, afterEach } from "node:test";
import { strict as assert } from "node:assert";
import { NextRequest } from "next/server";
import * as crypto from "crypto";
import { encryptSecret } from "../src/lib/crypto";
import { getValidAccessToken } from "../src/lib/shopify-token-manager";
import type {
  AuthResolvers,
  CustomSession,
  BrandAdminContext,
} from "../src/lib/auth-session";

interface MockedPrismaClient {
  brand: Record<string, (...args: unknown[]) => unknown>;
  brandMember: Record<string, (...args: unknown[]) => unknown>;
  campaign: Record<string, (...args: unknown[]) => unknown>;
  qRCode: Record<string, (...args: unknown[]) => unknown>;
  qRCodeBatch: Record<string, (...args: unknown[]) => unknown>;
  tokenStore: Record<string, (...args: unknown[]) => unknown>;
  shopifyRewardRedemption: Record<string, (...args: unknown[]) => unknown>;
  pointTransaction: Record<string, (...args: unknown[]) => unknown>;
  user: Record<string, (...args: unknown[]) => unknown>;
  campaignUnlock: Record<string, (...args: unknown[]) => unknown>;
  brandRewardOffer: Record<string, (...args: unknown[]) => unknown>;
  shopifyConnectionEvent: Record<string, (...args: unknown[]) => unknown>;
  commerceConnection: Record<string, (...args: unknown[]) => unknown>;
  commerceConnectionSecret: Record<string, (...args: unknown[]) => unknown>;
  userPointAccount: Record<string, (...args: unknown[]) => unknown>;
  lessonProgress: Record<string, (...args: unknown[]) => unknown>;
  userSession: Record<string, (...args: unknown[]) => unknown>;
  analyticsEvent: Record<string, (...args: unknown[]) => unknown>;
  $transaction: (...args: unknown[]) => unknown;
}

let prisma: MockedPrismaClient;
let appUninstalledPOST: (req: NextRequest) => Promise<Response>;
let shopRedactPOST: (req: NextRequest) => Promise<Response>;
let customersDataRequestPOST: (req: NextRequest) => Promise<Response>;
let customersRedactPOST: (req: NextRequest) => Promise<Response>;
// Route implementation functions accept an explicit AuthResolvers dependency.
let oauthCallbackImpl: (req: NextRequest, deps: AuthResolvers) => Promise<Response>;
let installationsGetImpl: (req: NextRequest, context: { params: Promise<{ installId: string }> }, deps: AuthResolvers) => Promise<Response>;
let installationsPostImpl: (req: NextRequest, context: { params: Promise<{ installId: string }> }, deps: AuthResolvers) => Promise<Response>;
let redeemImpl: (req: NextRequest, deps: AuthResolvers) => Promise<Response>;
let refreshStatusImpl: (req: NextRequest, context: { params: Promise<{ redemptionId: string }> }, deps: AuthResolvers) => Promise<Response>;
let scanImpl: (req: NextRequest, deps: AuthResolvers) => Promise<Response>;
let mergeImpl: (req: NextRequest, deps: AuthResolvers) => Promise<Response>;
let exportBatchImpl: (req: NextRequest, context: { params: Promise<{ id: string }> }, deps: AuthResolvers) => Promise<Response>;
let disconnectEmbeddedConnectedBrand: (input: {
  brandId: string;
  shopDomain: string;
  clientId: string;
}) => Promise<{ count: number }>;
let authOptions: Record<string, unknown> & { callbacks?: Record<string, (...args: unknown[]) => unknown> };

// Per-test injected resolvers, populated by setupMocks/clearMocks.
let currentDeps: AuthResolvers = {
  resolveSession: async () => null,
  resolveBrandAdminContext: async () => null,
};

// Thin wrappers that keep the existing call sites unchanged while threading the
// per-test injected dependencies into the route implementations.
const oauthCallbackGET = (req: NextRequest) => oauthCallbackImpl(req, currentDeps);
const installationsGET = (
  req: NextRequest,
  context: { params: Promise<{ installId: string }> },
) => installationsGetImpl(req, context, currentDeps);
const installationsPOST = (
  req: NextRequest,
  context: { params: Promise<{ installId: string }> },
) => installationsPostImpl(req, context, currentDeps);
const redeemPOST = (req: NextRequest) => redeemImpl(req, currentDeps);
const refreshStatusPOST = (
  req: NextRequest,
  context: { params: Promise<{ redemptionId: string }> },
) => refreshStatusImpl(req, context, currentDeps);
const scanPOST = (req: NextRequest) => scanImpl(req, currentDeps);
const mergePOST = (req: NextRequest) => mergeImpl(req, currentDeps);
const exportGET = (
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) => exportBatchImpl(req, context, currentDeps);

before(async () => {
  const prismaModule = (await import("../src/lib/prisma")).default as unknown as Record<string, unknown>;

  const models = [
    "brand",
    "brandMember",
    "campaign",
    "qRCode",
    "qRCodeBatch",
    "tokenStore",
    "shopifyRewardRedemption",
    "pointTransaction",
    "user",
    "campaignUnlock",
    "brandRewardOffer",
    "lessonProgress",
    "userSession",
    "analyticsEvent",
    "commerceConnection",
    "commerceConnectionSecret",
    "creatorRequest",
    "brandRequest",
    "creatorProfile",
    "experience",
    "campaignExperience",
    "post",
    "postComment",
    "question",
    "questionAnswer",
    "brandRewardOfferProduct",
    "emailVerificationToken",
    "emailQueue",
    "waitlistEntry",
  ];
  const methods = [
    "findFirst",
    "findUnique",
    "findMany",
    "count",
    "create",
    "createMany",
    "update",
    "updateMany",
    "delete",
    "deleteMany",
    "upsert",
    "findUniqueOrThrow",
    "findFirstOrThrow",
  ];

  for (const m of models) {
    const orig = prismaModule[m] as Record<string, unknown>;
    const unwrapped: Record<string, unknown> = {};
    for (const meth of methods) {
      if (orig && typeof orig[meth] === "function") {
        unwrapped[meth] = (orig[meth] as (...args: unknown[]) => unknown).bind(orig);
      }
    }
    prismaModule[m] = unwrapped;
  }

  prismaModule.$transaction = (arg: unknown) => {
    if (typeof arg === "function") {
      return arg(prismaModule);
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return Promise.resolve(null);
  };

  prisma = prismaModule as unknown as MockedPrismaClient;

  // Two-balance point ledger: safe defaults so route tests that don't assert on
  // points never touch the real database. Per-test t.mock.method overrides win.
  prismaModule.userPointAccount = {
    findUnique: async () => ({
      userId: "user",
      spendablePoints: 1_000_000,
      lifetimeEarnedPoints: 0,
      lifetimeSpentPoints: 0,
      lifetimeRefundedPoints: 0,
      version: 0,
    }),
    create: async () => ({
      userId: "user",
      spendablePoints: 0,
      lifetimeEarnedPoints: 0,
      lifetimeSpentPoints: 0,
      lifetimeRefundedPoints: 0,
      version: 0,
    }),
    upsert: async () => ({
      userId: "user",
      spendablePoints: 0,
      lifetimeEarnedPoints: 0,
      lifetimeSpentPoints: 0,
      lifetimeRefundedPoints: 0,
      version: 0,
    }),
    update: async () => ({}),
    updateMany: async () => ({ count: 1 }),
  };
  const pointTx = prismaModule.pointTransaction as Record<string, unknown>;
  pointTx.findUnique = async () => null;
  pointTx.groupBy = async () => [];
  pointTx.create = async () => ({ id: "pt-default" });
  (prismaModule.user as Record<string, unknown>).update = async () => ({});
  // Safe defaults for the Shopify store-compatibility connection-transition
  // helper (src/lib/shopify-connection-transitions.ts), which every
  // connection state change now calls: deactivating reward offers and
  // recording a history event. Individual tests override these with
  // t.mock.method when they need to assert on the specific call.
  (prismaModule.brandRewardOffer as Record<string, unknown>).updateMany =
    async () => ({ count: 0 });
  prismaModule.shopifyConnectionEvent = {
    create: async () => ({ id: "sce-default" }),
    findFirst: async () => null,
    // PHASE 14C-B1: shop/redact resolves historical brand identity from
    // domain-scoped connection-event history — default to "no history"
    // (empty), safe for every test that doesn't model a real redaction.
    findMany: async () => [],
    updateMany: async () => ({ count: 0 }),
  };
  // PHASE 8: the experienceProductLink / lessonProductLink safe-default mocks
  // that used to sit here are gone with those Prisma models
  // (20260808130000_remove_legacy_product_link_snapshots). shop/redact no
  // longer touches either delegate, and the assertions below prove it.
  prismaModule.lesson = {
    findUnique: async () => null,
    findMany: async () => [],
  };
  prismaModule.course = { findUnique: async () => null };
  // Safe default for the provider-neutral commerce-connection mirror lookup
  // (src/lib/commerce/connection-service.ts's getActiveCommerceConnection)
  // that the reward redeem route now consults before falling back to the
  // legacy direct Shopify call. No test here exercises a real
  // CommerceConnection row, so an empty mirror is correct for every
  // existing test — `getActiveCommerceConnection` treats "no row" + a
  // legacy shop domain present as legacy-wins (commerceSummary.id === null),
  // i.e. exactly the pre-cutover legacy path. Individual tests may still
  // override this with `t.mock.method` if they need to assert on the
  // adapter path specifically.
  prismaModule.commerceConnection = {
    findMany: async () => [],
    findUnique: async () => null,
    // PHASE 14B.2: `loadShopifyCredential` joins `secret` via `findFirst`.
    // Null keeps this harness on the classified NO_CONNECTION compatibility
    // branch, which is exactly the "pre-cutover legacy path" this stub already
    // documents itself as modelling.
    findFirst: async () => null,
    update: async () => ({}),
    // PHASE 14B.3: the install route now writes the canonical connection
    // INSIDE its transaction, from install facts. These stay throwing
    // tripwires by default so any OTHER route that starts writing canonical
    // connection rows fails loudly here; the install tests override them
    // with `t.mock.method` and assert on the ordering.
    count: async () => {
      throw new Error("canonical connection must not be counted on the legacy path");
    },
    updateMany: async () => {
      throw new Error("canonical connection must not be updated on the legacy path");
    },
    upsert: async () => {
      throw new Error("canonical connection must not be written on the legacy path");
    },
    // shop/redact's GDPR erasure. Default no-op so the legacy-path redact
    // tests (which assert on the Brand scrub) are unaffected.
    deleteMany: async () => ({ count: 0 }),
  };
  // No canonical secret exists on the legacy path, so the canonical
  // lease/rotation calls must be unreachable. Throwing (rather than returning
  // a benign value) makes a regression that started using the canonical lease
  // for a legacy-compat brand fail loudly instead of passing silently.
  prismaModule.commerceConnectionSecret = {
    findUnique: async () => {
      throw new Error("canonical secret must not be read on the legacy path");
    },
    updateMany: async () => {
      throw new Error("canonical lease must not be used on the legacy path");
    },
    deleteMany: async () => {
      throw new Error("canonical secret must not be cleared on the legacy path");
    },
    upsert: async () => {
      throw new Error("canonical secret must not be written on the legacy path");
    },
  };

  // Import route handlers
  appUninstalledPOST = (await import("../src/app/api/shopify/webhooks/app/uninstalled/route")).POST;
  shopRedactPOST = (await import("../src/app/api/shopify/webhooks/shop/redact/route")).POST;
  customersDataRequestPOST = (await import("../src/app/api/shopify/webhooks/customers/data_request/route")).POST;
  customersRedactPOST = (await import("../src/app/api/shopify/webhooks/customers/redact/route")).POST;

  oauthCallbackImpl = (await import("../src/app/api/shopify/oauth/callback/route")).oauthCallbackImpl;
  const installationsRoute = await import("../src/app/api/shopify/installations/[installId]/route");
  installationsGetImpl = installationsRoute.installationsGetImpl;
  installationsPostImpl = installationsRoute.installationsPostImpl;

  redeemImpl = (await import("../src/app/api/rewards/shopify/redeem/route")).redeemImpl;
  refreshStatusImpl = (await import("../src/app/api/rewards/shopify/redemptions/[redemptionId]/refresh-status/route")).refreshStatusImpl;
  scanImpl = (await import("../src/app/api/public/scan/route")).scanImpl;
  mergeImpl = (await import("../src/app/api/progress/merge/route")).mergeImpl;
  exportBatchImpl = (await import("../src/app/api/brand/qr-batches/[id]/export/route")).exportBatchImpl;
  disconnectEmbeddedConnectedBrand = (
    await import("../src/lib/shopify-embedded-connection")
  ).disconnectEmbeddedConnectedBrand;
  authOptions = (await import("../src/app/api/auth/[...nextauth]/options")).authOptions as never;
});

/**
 * PHASE 14B.3 — models the CANONICAL install write the installations route
 * now performs inside its own transaction, and records an ordered call log so
 * a test can assert that canonical writes happen BEFORE the legacy `Brand`
 * mirror. Returns the log; the caller wires `brand.update` to push into it.
 */
function mockCanonicalInstallWrites(
  t: { mock: { method: (o: object, m: string, i: unknown) => void } },
): string[] {
  const log: string[] = [];
  t.mock.method(prisma.commerceConnection, "findUnique", async () => {
    log.push("canonical:findUnique");
    return null;
  });
  t.mock.method(prisma.commerceConnection, "count", async () => {
    log.push("canonical:count");
    return 0;
  });
  t.mock.method(prisma.commerceConnection, "updateMany", async () => {
    log.push("canonical:clearOtherPrimary");
    return { count: 0 };
  });
  t.mock.method(prisma.commerceConnection, "upsert", async (args: unknown) => {
    const typed = args as {
      create: { externalAccountId: string; brandId: string; status: string };
    };
    log.push(
      `canonical:upsert:${typed.create.brandId}:${typed.create.externalAccountId}:${typed.create.status}`,
    );
    return { id: "conn-canonical" };
  });
  t.mock.method(prisma.commerceConnectionSecret, "upsert", async (args: unknown) => {
    const typed = args as { where: { connectionId: string }; create: { encryptedPayload: string } };
    // The payload must be ENCRYPTED, never a plaintext token.
    assert.ok(!typed.create.encryptedPayload.includes("mock-token"));
    log.push(`canonical:secret:${typed.where.connectionId}`);
    return {};
  });
  return log;
}

// Helpers
function buildWebhookHmac(body: string, secret: string = "test-api-secret"): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

function makeWebhookRequest(
  url: string,
  body: string,
  hmac: string | null,
  shop: string = "store.myshopify.com",
  triggeredAt?: string,
): NextRequest {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (hmac) {
    headers.set("x-shopify-hmac-sha256", hmac);
  }
  headers.set("x-shopify-shop-domain", shop);
  if (triggeredAt) {
    headers.set("x-shopify-triggered-at", triggeredAt);
  }
  return new NextRequest(url, {
    method: "POST",
    headers,
    body: Buffer.from(body),
  });
}

function setupMocks(session: unknown, brandAdminContext: unknown = null) {
  currentDeps = {
    resolveSession: async () => session as CustomSession | null,
    resolveBrandAdminContext: async () =>
      brandAdminContext as BrandAdminContext | null,
  };
}

function clearMocks() {
  currentDeps = {
    resolveSession: async () => null,
    resolveBrandAdminContext: async () => null,
  };
}

describe("Route Scenario 1: Shopify Webhooks", () => {
  test("valid raw-body HMAC is accepted", async () => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/customers/redact", payload, hmac);

    const res = await customersRedactPOST(req);
    assert.equal(res.status, 200);
  });

  test("invalid HMAC is rejected with 401", async () => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = "invalid-hmac-signature";
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/customers/redact", payload, hmac);

    const res = await customersRedactPOST(req);
    assert.equal(res.status, 401);
  });

  // PHASE 14C-A: app/uninstalled is canonical-only now — no legacy `Brand`
  // read or write anywhere in the handler (see route.ts's own header
  // comment). "Clears active credentials" means: the canonical connection's
  // status transitions to UNINSTALLED and its `CommerceConnectionSecret` row
  // is deleted.
  test("app/uninstalled webhook clears active credentials", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/app/uninstalled", payload, hmac, "uninstall-shop.myshopify.com");

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-uninstall",
      brandId: "brand-uninstall",
    }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-uninstall",
      brandId: "brand-uninstall",
      installedAt: null,
    }));

    let statusUpdateCalled = false;
    let capturedData: unknown = null;
    t.mock.method(prisma.commerceConnection, "update", async (args: unknown) => {
      const typedArgs = args as { data?: Record<string, unknown> };
      statusUpdateCalled = true;
      capturedData = typedArgs.data;
      return {};
    });

    let secretDeleted = false;
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => {
      secretDeleted = true;
      return { count: 1 };
    });

    let connectionEventRecorded = false;
    t.mock.method(prisma.shopifyConnectionEvent, "create", async (args: unknown) => {
      const typedArgs = args as { data: { eventType: string } };
      connectionEventRecorded = typedArgs.data.eventType === "UNINSTALLED";
      return {};
    });

    const res = await appUninstalledPOST(req);
    assert.equal(res.status, 200);
    assert.ok(statusUpdateCalled);
    assert.ok(secretDeleted);
    assert.ok(connectionEventRecorded);
    const data = capturedData as { status: string; uninstalledAt?: Date };
    assert.ok(data);
    assert.equal(data.status, "UNINSTALLED");
    assert.ok(data.uninstalledAt instanceof Date);
  });

  test("AE. app/uninstalled revokes the CANONICAL credential first, by shop domain, writing the loss event exactly once", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/app/uninstalled", payload, hmac, "uninstall-shop.myshopify.com");

    const order: string[] = [];

    // A canonical connection EXISTS for the uninstalled shop.
    t.mock.method(prisma.commerceConnection, "findFirst", async (args: unknown) => {
      const typed = args as {
        where: { provider: string; externalAccountId?: string; brandId?: string };
      };
      // Terminal webhooks are shop-keyed, never brand-keyed: after a relink the
      // brand no longer holds this domain, so a brandId selector would revoke
      // the wrong store (or nothing at all).
      assert.equal(typed.where.externalAccountId, "uninstall-shop.myshopify.com");
      assert.equal(typed.where.brandId, undefined);
      order.push("canonical:findFirst");
      return { id: "conn-uninstall", brandId: "brand-uninstall" };
    });
    // Re-selected fresh INSIDE invalidateShopifyCredential's transaction (the
    // P1 freshness fence). `installedAt: null` means the fence never
    // activates here, matching this test sending no `X-Shopify-Triggered-At`.
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-uninstall",
      brandId: "brand-uninstall",
      installedAt: null,
    }));
    t.mock.method(prisma.commerceConnection, "update", async (args: unknown) => {
      const typed = args as { data: { status: string; uninstalledAt?: Date } };
      assert.equal(typed.data.status, "UNINSTALLED");
      assert.ok(typed.data.uninstalledAt instanceof Date);
      order.push("canonical:status");
      return {};
    });
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => {
      order.push("canonical:secretDeleted");
      return { count: 1 };
    });

    const events: string[] = [];
    t.mock.method(prisma.shopifyConnectionEvent, "create", async (args: unknown) => {
      const typed = args as { data: { eventType: string; brandId: string } };
      // No decrypted credential material may ever reach connection history.
      const serialized = JSON.stringify(typed.data);
      assert.doesNotMatch(serialized, /shpat_|shprt_|accessToken|refreshToken/);
      events.push(`${typed.data.eventType}:${typed.data.brandId}`);
      order.push("lossEvent");
      return {};
    });

    const res = await appUninstalledPOST(req);
    assert.equal(res.status, 200);

    // PHASE 14C-A: canonical status transition + secret deletion precede the
    // loss event, and there is no legacy Brand mirror step left at all — the
    // event is written exactly once.
    assert.deepEqual(order, [
      "canonical:findFirst",
      "canonical:status",
      "canonical:secretDeleted",
      "lossEvent",
    ]);
    assert.deepEqual(events, ["UNINSTALLED:brand-uninstall"]);
  });

  test("AQ. P1 FIX (independent review): a REDELIVERED app/uninstalled arriving after a reinstall is ignored end-to-end — no canonical write, no Brand mirror write", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    // Shopify originally triggered this uninstall at 11:00. Retries redeliver
    // the SAME triggered-at. The merchant reinstalled at 12:00 — BEFORE this
    // (delayed) delivery reaches the app.
    const req = makeWebhookRequest(
      "http://localhost/api/shopify/webhooks/app/uninstalled",
      payload,
      hmac,
      "reinstalled-shop.myshopify.com",
      "2026-03-01T11:00:00.000000000Z",
    );

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-reinstalled",
      brandId: "brand-reinstalled",
    }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-reinstalled",
      brandId: "brand-reinstalled",
      // The connection was reinstalled AFTER Shopify triggered this event.
      installedAt: new Date("2026-03-01T12:00:00.000Z"),
    }));

    let canonicalWriteAttempted = false;
    t.mock.method(prisma.commerceConnection, "update", async () => {
      canonicalWriteAttempted = true;
      return {};
    });
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => {
      canonicalWriteAttempted = true;
      return { count: 0 };
    });

    let brandMirrorWriteAttempted = false;
    t.mock.method(prisma.brand, "findUnique", async () => {
      // If the route reaches the legacy Brand lookup at all for a STALE
      // event, that is itself the bug: it means the fence didn't short-
      // circuit the whole handler.
      brandMirrorWriteAttempted = true;
      return null;
    });

    let eventWritten = false;
    t.mock.method(prisma.shopifyConnectionEvent, "create", async () => {
      eventWritten = true;
      return {};
    });

    const res = await appUninstalledPOST(req);

    // Still acknowledged — a genuine, HMAC-verified delivery must not be
    // retried by Shopify just because it turned out to be stale.
    assert.equal(res.status, 200);
    assert.ok(!canonicalWriteAttempted, "the stale event must not touch the canonical connection");
    assert.ok(!brandMirrorWriteAttempted, "the stale event must not touch the legacy Brand mirror either");
    assert.ok(!eventWritten, "no connection-loss event for a state change that never happened");
  });

  // PHASE 14C-B1: identity for the scrub is resolved from domain-scoped
  // history (ShopifyConnectionEvent + ShopifyRewardRedemption), never from
  // `Brand.shopifyShopDomain` — see the route's own header comment. The
  // legacy-mirror clear (`prisma.brand.update`) only fires for brands whose
  // CURRENT mirror still points at this domain.
  test("AF. shop/redact revokes the canonical credential (status + secret) BEFORE erasing the connection row, and touches no Brand at all", async (t) => {
    const payload = JSON.stringify({ shop_id: 1, shop_domain: "redact-shop.myshopify.com" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/shop/redact", payload, hmac, "redact-shop.myshopify.com");

    const order: string[] = [];

    t.mock.method(prisma.tokenStore, "findMany", async () => []);
    t.mock.method(prisma.commerceConnection, "findFirst", async (args: unknown) => {
      const typed = args as { where: { externalAccountId?: string } };
      assert.equal(typed.where.externalAccountId, "redact-shop.myshopify.com");
      return { id: "conn-redact", brandId: "brand-redact" };
    });
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-redact",
      brandId: "brand-redact",
      installedAt: null,
    }));
    t.mock.method(prisma.commerceConnection, "update", async (args: unknown) => {
      const typed = args as { data: { status: string } };
      assert.equal(typed.data.status, "UNINSTALLED");
      order.push("canonical:status");
      return {};
    });
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => {
      order.push("canonical:secretDeleted");
      return { count: 1 };
    });
    t.mock.method(prisma.commerceConnection, "deleteMany", async () => {
      order.push("canonical:rowErased");
      return { count: 1 };
    });

    t.mock.method(prisma.shopifyConnectionEvent, "findMany", async () => [{ brandId: "brand-redact" }]);
    t.mock.method(prisma.shopifyRewardRedemption, "findMany", async () => []);
    // PHASE 14C-B2: Brand carries no Shopify state any more. Any Brand read or
    // write from this handler is now a regression, so both fail the test rather
    // than recording an ordering step.
    t.mock.method(prisma.brand, "findMany", async () => {
      assert.fail("shop/redact must never read Brand after Phase 14C-B2");
      return [];
    });
    t.mock.method(prisma.brand, "update", async () => {
      assert.fail("shop/redact must never write Brand after Phase 14C-B2");
      return {};
    });
    t.mock.method(prisma.shopifyRewardRedemption, "updateMany", async () => ({ count: 0 }));
    t.mock.method(prisma.brandRewardOffer, "updateMany", async () => ({ count: 0 }));
    t.mock.method(prisma.shopifyConnectionEvent, "updateMany", async () => ({ count: 0 }));

    const res = await shopRedactPOST(req);
    assert.equal(res.status, 200);

    // The status transition + secret delete must still land BEFORE the row is
    // erased: erasing first would briefly leave NO_CONNECTION, and any failure
    // after that point would leave the shop with no recorded revocation at all.
    assert.deepEqual(order, [
      "canonical:status",
      "canonical:secretDeleted",
      "canonical:rowErased",
    ]);
  });

  test("AF.1 shop/redact makes a failed final canonical erase retryable, then safely completes the repeated scrub on retry", async (t) => {
    const payload = JSON.stringify({ shop_id: 1, shop_domain: "retry-redact-shop.myshopify.com" });
    const hmac = buildWebhookHmac(payload);

    const order: string[] = [];
    let scrubCount = 0;
    let deleteAttempts = 0;
    let loggedFailure: unknown[] | null = null;

    t.mock.method(prisma.tokenStore, "findMany", async () => []);
    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-retry-redact",
      brandId: "brand-retry-redact",
    }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-retry-redact",
      brandId: "brand-retry-redact",
      installedAt: null,
    }));
    t.mock.method(prisma.commerceConnection, "update", async () => {
      order.push("canonical:status");
      return {};
    });
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => {
      order.push("canonical:secretDeleted");
      return { count: 1 };
    });
    t.mock.method(prisma.shopifyConnectionEvent, "findMany", async () => []);
    t.mock.method(prisma.shopifyRewardRedemption, "findMany", async () => []);
    t.mock.method(prisma.shopifyRewardRedemption, "updateMany", async () => {
      scrubCount += 1;
      return { count: 0 };
    });
    t.mock.method(prisma.brandRewardOffer, "updateMany", async () => {
      scrubCount += 1;
      return { count: 0 };
    });
    t.mock.method(prisma.shopifyConnectionEvent, "updateMany", async () => {
      scrubCount += 1;
      return { count: 0 };
    });
    t.mock.method(prisma.commerceConnection, "deleteMany", async () => {
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        throw new Error("transient database detail must not reach Shopify");
      }
      order.push("canonical:rowErased");
      return { count: 0 }; // Already absent is an idempotent success.
    });
    t.mock.method(console, "error", (...args: unknown[]) => {
      loggedFailure = args;
    });

    const first = await shopRedactPOST(
      makeWebhookRequest(
        "http://localhost/api/shopify/webhooks/shop/redact",
        payload,
        hmac,
        "retry-redact-shop.myshopify.com",
      ),
    );
    assert.equal(first.status, 500, "a failed required erase must not be acknowledged");
    assert.equal(
      await first.text(),
      JSON.stringify({ error: "Shop data erasure could not be completed." }),
    );
    assert.ok(loggedFailure, "failure is logged with a fixed diagnostic");
    assert.doesNotMatch(JSON.stringify(loggedFailure), /transient database detail/);
    assert.deepEqual(order, ["canonical:status", "canonical:secretDeleted"]);
    assert.equal(scrubCount, 4, "the first delivery completed the idempotent scrub before delete failed");

    const second = await shopRedactPOST(
      makeWebhookRequest(
        "http://localhost/api/shopify/webhooks/shop/redact",
        payload,
        hmac,
        "retry-redact-shop.myshopify.com",
      ),
    );
    assert.equal(second.status, 200, "retry succeeds after repeated scrub and noop delete");
    assert.equal(deleteAttempts, 2);
    assert.equal(scrubCount, 8, "the privacy scrub is safely repeatable");
    assert.deepEqual(order, [
      "canonical:status",
      "canonical:secretDeleted",
      "canonical:status",
      "canonical:secretDeleted",
      "canonical:rowErased",
    ]);
  });

  test("duplicate app/uninstalled delivery is idempotent (succeeds without error)", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req1 = makeWebhookRequest("http://localhost/api/shopify/webhooks/app/uninstalled", payload, hmac, "uninstall-shop.myshopify.com");
    const req2 = makeWebhookRequest("http://localhost/api/shopify/webhooks/app/uninstalled", payload, hmac, "uninstall-shop.myshopify.com");

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-uninstall",
      brandId: "brand-uninstall",
    }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-uninstall",
      brandId: "brand-uninstall",
      installedAt: null,
    }));

    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => ({ count: 1 }));

    let callCount = 0;
    t.mock.method(prisma.commerceConnection, "update", async () => {
      callCount++;
      return {};
    });

    const res1 = await appUninstalledPOST(req1);
    assert.equal(res1.status, 200);

    const res2 = await appUninstalledPOST(req2);
    assert.equal(res2.status, 200);

    // Each delivery re-applies the same canonical status transition — a
    // second, identical UNINSTALLED write is a safe no-op, not an error.
    assert.equal(callCount, 2);
  });

  test("uninstall preserves allowed historical business records", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/app/uninstalled", payload, hmac, "uninstall-shop.myshopify.com");

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-uninstall",
      brandId: "brand-uninstall",
    }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-uninstall",
      brandId: "brand-uninstall",
      installedAt: null,
    }));

    let canonicalUpdateCalled = false;
    let otherModelsTouched = false;

    t.mock.method(prisma.commerceConnection, "update", async () => {
      canonicalUpdateCalled = true;
      return {};
    });
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => ({ count: 1 }));

    // We verify no delete calls or mutations on other business models like PointTransaction
    t.mock.method(prisma.pointTransaction, "deleteMany", async () => {
      otherModelsTouched = true;
      return { count: 0 };
    });

    const res = await appUninstalledPOST(req);
    assert.equal(res.status, 200);
    assert.ok(canonicalUpdateCalled);
    assert.ok(!otherModelsTouched);
  });

  test("compliance webhook shop/redact behaves matching the documented data inventory", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/shop/redact", payload, hmac, "redact-shop.myshopify.com");

    let historicalIdentityResolved = false;
    let redemptionAnonymized = false;
    let tokensDeleted = false;

    t.mock.method(prisma.shopifyConnectionEvent, "findMany", async () => {
      historicalIdentityResolved = true;
      return [{ brandId: "brand-123" }];
    });
    t.mock.method(prisma.shopifyRewardRedemption, "findMany", async () => []);

    // PHASE 14C-B2: Brand no longer holds any Shopify column, so the handler
    // must neither read nor write it. Both delegates fail loudly rather than
    // silently recording a flag.
    t.mock.method(prisma.brand, "findMany", async () => {
      assert.fail("shop/redact must never read Brand after Phase 14C-B2");
      return [];
    });
    t.mock.method(prisma.brand, "update", async () => {
      assert.fail("shop/redact must never write Brand after Phase 14C-B2");
      return {};
    });

    t.mock.method(prisma.shopifyRewardRedemption, "updateMany", async (args: unknown) => {
      redemptionAnonymized = true;
      const typedArgs = args as { where: { shopifyShopDomain: string }; data: { shopifyDiscountNodeId: string | null; shopifyDiscountStatus: string | null } };
      assert.equal(typedArgs.where.shopifyShopDomain, "redact-shop.myshopify.com");
      assert.equal(typedArgs.data.shopifyDiscountNodeId, null);
      assert.equal(typedArgs.data.shopifyDiscountStatus, null);
      return { count: 1 };
    });

    let offersDeactivated = false;
    let offerSourceDomainScrubbed = false;
    t.mock.method(prisma.brandRewardOffer, "updateMany", async (args: unknown) => {
      const typedArgs = args as {
        where: { sourceShopDomain?: string };
        data: { isActive?: boolean; sourceShopDomain?: null };
      };
      // PHASE 14C-B1.1: offers are scoped to `sourceShopDomain`, never to
      // `brandId IN historicalBrandIds` — a single call both deactivates and
      // scrubs, since only offers actually tied to this shop are matched.
      assert.equal(typedArgs.where.sourceShopDomain, "redact-shop.myshopify.com");
      assert.equal(typedArgs.data.isActive, false);
      assert.equal(typedArgs.data.sourceShopDomain, null);
      offersDeactivated = true;
      offerSourceDomainScrubbed = true;
      return { count: 1 };
    });

    // PHASE 8: ExperienceProductLink / LessonProductLink no longer exist, so
    // there is nothing to mock and nothing to scrub. The prisma mock object
    // deliberately has NO delegate for either model — if the route regressed
    // and tried to call one, the route would throw on an undefined property
    // and this test would fail rather than silently passing.
    assert.equal(
      (prisma as unknown as Record<string, unknown>).experienceProductLink,
      undefined,
      "no experienceProductLink delegate is mocked, because shop/redact must not touch it",
    );
    assert.equal(
      (prisma as unknown as Record<string, unknown>).lessonProductLink,
      undefined,
      "no lessonProductLink delegate is mocked, because shop/redact must not touch it",
    );

    let connectionEventScrubCalls = 0;
    t.mock.method(prisma.shopifyConnectionEvent, "updateMany", async (args: unknown) => {
      connectionEventScrubCalls += 1;
      const typedArgs = args as {
        where: { shopDomain?: string; previousShopDomain?: string };
        data: Record<string, null>;
      };
      if (typedArgs.where.shopDomain === "redact-shop.myshopify.com") {
        assert.deepEqual(Object.keys(typedArgs.data).sort(), [
          "currencyCode",
          "shopDomain",
          "shopifyClientId",
        ]);
      } else if (typedArgs.where.previousShopDomain === "redact-shop.myshopify.com") {
        assert.deepEqual(Object.keys(typedArgs.data).sort(), [
          "previousCurrencyCode",
          "previousShopDomain",
        ]);
      } else {
        assert.fail("unexpected shopifyConnectionEvent.updateMany where clause");
      }
      return { count: 1 };
    });

    // Service keys are random nonces; the shop lives only inside the token JSON.
    t.mock.method(prisma.tokenStore, "findMany", async () => [
      // Matches this shop → should be deleted.
      {
        service: "shopify_oauth_state:nonce-1",
        token: JSON.stringify({ shop: "redact-shop.myshopify.com" }),
      },
      // Different shop → must be preserved.
      {
        service: "shopify_pending_install:nonce-2",
        token: JSON.stringify({
          shop: "other-shop.myshopify.com",
          encryptedToken: "enc",
        }),
      },
    ]);

    let deletedServices: string[] = [];
    t.mock.method(prisma.tokenStore, "deleteMany", async (args: unknown) => {
      tokensDeleted = true;
      const typedArgs = args as { where: { service: { in: string[] } } };
      deletedServices = typedArgs.where.service.in;
      return { count: deletedServices.length };
    });

    const res = await shopRedactPOST(req);
    assert.equal(res.status, 200);
    assert.ok(historicalIdentityResolved, "historical identity is still resolved from domain-scoped history");
    assert.ok(redemptionAnonymized);
    assert.ok(tokensDeleted);
    assert.ok(offersDeactivated, "the redacted Brand's reward offers are deactivated");
    assert.ok(offerSourceDomainScrubbed, "BrandRewardOffer.sourceShopDomain is scrubbed");
    assert.equal(connectionEventScrubCalls, 2, "both shopDomain and previousShopDomain are scrubbed independently");
    // Only the matching shop's temp token is deleted; the other shop is preserved.
    assert.deepEqual(deletedServices, ["shopify_oauth_state:nonce-1"]);
  });

  test("shop/redact cleans only matching temp tokens even when no brand is linked", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest(
      "http://localhost/api/shopify/webhooks/shop/redact",
      payload,
      hmac,
      "abandoned-shop.myshopify.com",
    );

    // No brand ever historically had this domain (e.g. an OAuth flow that
    // was never completed) — both history sources come back empty, so the
    // legacy-mirror lookup (`prisma.brand.findMany`) is never even reached.
    t.mock.method(prisma.shopifyConnectionEvent, "findMany", async () => []);
    t.mock.method(prisma.shopifyRewardRedemption, "findMany", async () => []);
    t.mock.method(prisma.brand, "findMany", async () => {
      throw new Error("must not be called when no historical brand id was resolved");
    });

    let brandUpdated = false;
    t.mock.method(prisma.brand, "update", async () => {
      brandUpdated = true;
      return {};
    });

    // Domain-keyed operations still run unconditionally even though no
    // historical brand was found.
    t.mock.method(prisma.shopifyRewardRedemption, "updateMany", async () => ({ count: 0 }));
    t.mock.method(prisma.brandRewardOffer, "updateMany", async () => ({ count: 0 }));
    t.mock.method(prisma.shopifyConnectionEvent, "updateMany", async () => ({ count: 0 }));

    t.mock.method(prisma.tokenStore, "findMany", async () => [
      {
        service: "shopify_oauth_state:abc",
        token: JSON.stringify({ shop: "abandoned-shop.myshopify.com" }),
      },
      {
        service: "shopify_pending_install:def",
        token: JSON.stringify({
          shop: "abandoned-shop.myshopify.com",
          encryptedToken: "enc",
        }),
      },
      {
        service: "shopify_oauth_state:ghi",
        token: JSON.stringify({ shop: "unrelated.myshopify.com" }),
      },
      // Unparseable payload — left for TTL expiry, never matched.
      { service: "shopify_pending_install:bad", token: "not-json" },
    ]);

    let deletedServices: string[] = [];
    t.mock.method(prisma.tokenStore, "deleteMany", async (args: unknown) => {
      const typedArgs = args as { where: { service: { in: string[] } } };
      deletedServices = typedArgs.where.service.in;
      return { count: deletedServices.length };
    });

    const res = await shopRedactPOST(req);
    assert.equal(res.status, 200);
    // Brand cleanup is skipped (no brand) but matching temp tokens are removed.
    assert.equal(brandUpdated, false);
    assert.deepEqual(
      [...deletedServices].sort(),
      ["shopify_oauth_state:abc", "shopify_pending_install:def"],
    );
  });

  // PHASE 14C-B1 — required regression coverage for the shop/redact P1 fix
  // (identity resolved from domain-scoped history, never Brand.shopifyShopDomain).

  test("B/D. relink -> delayed old shop/redact still anonymizes historical redemption/offer data for the OLD brand, even though its current Brand mirror points at a NEW shop", async (t) => {
    const payload = JSON.stringify({ shop_id: 1, shop_domain: "old-shop.myshopify.com" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest(
      "http://localhost/api/shopify/webhooks/shop/redact",
      payload,
      hmac,
      "old-shop.myshopify.com",
    );

    // The old shop's own CommerceConnection row still exists (UNINSTALLED,
    // preserved by app/uninstalled's relink policy) -> invalidation succeeds.
    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({ id: "conn-old", brandId: "brand-1" }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-old",
      brandId: "brand-1",
      installedAt: null,
    }));
    t.mock.method(prisma.commerceConnection, "update", async () => ({}));
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => ({ count: 1 }));
    t.mock.method(prisma.commerceConnection, "deleteMany", async () => ({ count: 1 }));
    t.mock.method(prisma.tokenStore, "findMany", async () => []);

    // History resolves brand-1 as having owned old-shop.myshopify.com — via
    // a recorded connection-loss event, exactly what app/uninstalled writes.
    t.mock.method(prisma.shopifyConnectionEvent, "findMany", async () => [{ brandId: "brand-1" }]);
    t.mock.method(prisma.shopifyRewardRedemption, "findMany", async () => [{ brandId: "brand-1" }]);

    // brand-1 has SINCE relinked to a different shop — its live mirror no
    // longer says old-shop.myshopify.com, so the mirror-clear query finds
    // nothing for it.
    t.mock.method(prisma.brand, "findMany", async () => []);

    let brandMirrorUpdated = false;
    t.mock.method(prisma.brand, "update", async () => {
      brandMirrorUpdated = true;
      return {};
    });

    let redemptionAnonymized = false;
    t.mock.method(prisma.shopifyRewardRedemption, "updateMany", async (args: unknown) => {
      const typed = args as { where: { shopifyShopDomain: string } };
      assert.equal(typed.where.shopifyShopDomain, "old-shop.myshopify.com");
      redemptionAnonymized = true;
      return { count: 1 };
    });

    // PHASE 14C-B1.1: offer cleanup is scoped to `sourceShopDomain`, never to
    // `brandId IN historicalBrandIds` — brand-1's offer(s) still tied to
    // old-shop.myshopify.com (sourceShopDomain never resaved elsewhere) must
    // still be deactivated and scrubbed by this delayed redact.
    let offersDeactivatedForOldShop = false;
    t.mock.method(prisma.brandRewardOffer, "updateMany", async (args: unknown) => {
      const typed = args as {
        where: { sourceShopDomain?: string };
        data: { isActive?: boolean; sourceShopDomain?: null };
      };
      assert.equal(typed.where.sourceShopDomain, "old-shop.myshopify.com");
      assert.equal(typed.data.isActive, false);
      assert.equal(typed.data.sourceShopDomain, null);
      offersDeactivatedForOldShop = true;
      return { count: 1 };
    });
    t.mock.method(prisma.shopifyConnectionEvent, "updateMany", async () => ({ count: 0 }));

    const res = await shopRedactPOST(req);
    assert.equal(res.status, 200);
    assert.ok(redemptionAnonymized, "historical redemption data for the old shop must still be anonymized");
    assert.ok(offersDeactivatedForOldShop, "offers still tied to the old shop domain must still be deactivated and scrubbed");
    assert.equal(
      brandMirrorUpdated,
      false,
      "the relinked brand's CURRENT mirror (now pointing at a new shop) must never be touched",
    );
  });

  test("C. a delayed shop/redact predating a reinstall does NOT revoke the new connection credential", async (t) => {
    const payload = JSON.stringify({ shop_id: 1, shop_domain: "reinstalled-shop.myshopify.com" });
    const hmac = buildWebhookHmac(payload);
    // Shopify triggered this redact BEFORE the reinstall.
    const req = makeWebhookRequest(
      "http://localhost/api/shopify/webhooks/shop/redact",
      payload,
      hmac,
      "reinstalled-shop.myshopify.com",
      "2026-03-01T11:00:00.000000000Z",
    );

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({ id: "conn-reinstalled", brandId: "brand-1" }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-reinstalled",
      brandId: "brand-1",
      // Reinstalled AFTER Shopify triggered this event.
      installedAt: new Date("2026-03-01T12:00:00.000Z"),
    }));

    let canonicalWriteAttempted = false;
    t.mock.method(prisma.commerceConnection, "update", async () => {
      canonicalWriteAttempted = true;
      return {};
    });
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => {
      canonicalWriteAttempted = true;
      return { count: 0 };
    });
    t.mock.method(prisma.commerceConnection, "deleteMany", async () => {
      canonicalWriteAttempted = true;
      return { count: 0 };
    });

    let historyQueried = false;
    t.mock.method(prisma.shopifyConnectionEvent, "findMany", async () => {
      historyQueried = true;
      return [];
    });
    t.mock.method(prisma.shopifyRewardRedemption, "findMany", async () => {
      historyQueried = true;
      return [];
    });

    let brandTouched = false;
    t.mock.method(prisma.brand, "update", async () => {
      brandTouched = true;
      return {};
    });

    t.mock.method(prisma.tokenStore, "findMany", async () => []);

    const res = await shopRedactPOST(req);
    assert.equal(res.status, 200);
    assert.equal(canonicalWriteAttempted, false, "a stale event must never touch the canonical connection");
    assert.equal(
      historyQueried,
      false,
      "a stale event must short-circuit before even resolving historical identity",
    );
    assert.equal(brandTouched, false, "a stale event must never touch any Brand mirror");
  });

  test("E. no cross-brand cleanup: redacting one shop never touches an unrelated brand's offers or redemptions", async (t) => {
    const payload = JSON.stringify({ shop_id: 1, shop_domain: "target-shop.myshopify.com" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest(
      "http://localhost/api/shopify/webhooks/shop/redact",
      payload,
      hmac,
      "target-shop.myshopify.com",
    );

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({ id: "conn-target", brandId: "brand-target" }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-target",
      brandId: "brand-target",
      installedAt: null,
    }));
    t.mock.method(prisma.commerceConnection, "update", async () => ({}));
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => ({ count: 1 }));
    t.mock.method(prisma.commerceConnection, "deleteMany", async () => ({ count: 1 }));
    t.mock.method(prisma.tokenStore, "findMany", async () => []);

    t.mock.method(prisma.shopifyConnectionEvent, "findMany", async () => [{ brandId: "brand-target" }]);
    t.mock.method(prisma.shopifyRewardRedemption, "findMany", async () => [{ brandId: "brand-target" }]);
    t.mock.method(prisma.brand, "findMany", async () => [{ id: "brand-target" }]);
    t.mock.method(prisma.brand, "update", async (args: unknown) => {
      const typed = args as { where: { id: string } };
      assert.equal(typed.where.id, "brand-target", "only the target brand's mirror may ever be cleared");
      return {};
    });

    t.mock.method(prisma.shopifyRewardRedemption, "updateMany", async (args: unknown) => {
      const typed = args as { where: { shopifyShopDomain: string } };
      assert.equal(typed.where.shopifyShopDomain, "target-shop.myshopify.com");
      return { count: 1 };
    });
    t.mock.method(prisma.brandRewardOffer, "updateMany", async (args: unknown) => {
      const typed = args as { where: { sourceShopDomain?: string } };
      assert.equal(
        typed.where.sourceShopDomain,
        "target-shop.myshopify.com",
        "offer deactivation must be scoped to this shop domain, never to any brand id set",
      );
      return { count: 1 };
    });
    t.mock.method(prisma.shopifyConnectionEvent, "updateMany", async () => ({ count: 0 }));

    const res = await shopRedactPOST(req);
    assert.equal(res.status, 200);
  });

  test("F. brand relinked old-shop -> new-shop and resaved an offer against the new shop: a delayed redact of the OLD shop must not touch that live offer", async (t) => {
    const payload = JSON.stringify({ shop_id: 1, shop_domain: "old-shop2.myshopify.com" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest(
      "http://localhost/api/shopify/webhooks/shop/redact",
      payload,
      hmac,
      "old-shop2.myshopify.com",
    );

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({ id: "conn-old2", brandId: "brand-2" }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-old2",
      brandId: "brand-2",
      installedAt: null,
    }));
    t.mock.method(prisma.commerceConnection, "update", async () => ({}));
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => ({ count: 1 }));
    t.mock.method(prisma.commerceConnection, "deleteMany", async () => ({ count: 1 }));
    t.mock.method(prisma.tokenStore, "findMany", async () => []);

    // brand-2 is historically resolved (it once owned old-shop2) even though
    // it has since relinked to new-shop2 and its live mirror now says so.
    t.mock.method(prisma.shopifyConnectionEvent, "findMany", async () => [{ brandId: "brand-2" }]);
    t.mock.method(prisma.shopifyRewardRedemption, "findMany", async () => []);
    t.mock.method(prisma.brand, "findMany", async () => []);
    t.mock.method(prisma.brand, "update", async () => {
      assert.fail("brand-2's current mirror (now pointing at new-shop2) must never be touched");
      return {};
    });
    t.mock.method(prisma.shopifyRewardRedemption, "updateMany", async () => ({ count: 0 }));

    // The only offer.updateMany call this redact issues is scoped to
    // old-shop2.myshopify.com. brand-2's offer that was resaved against
    // new-shop2 (sourceShopDomain === "new-shop2.myshopify.com") therefore
    // never matches this where clause and is never touched by this call.
    let offerUpdateCalls = 0;
    t.mock.method(prisma.brandRewardOffer, "updateMany", async (args: unknown) => {
      offerUpdateCalls += 1;
      const typed = args as { where: { sourceShopDomain?: string } };
      assert.equal(typed.where.sourceShopDomain, "old-shop2.myshopify.com");
      return { count: 0 };
    });
    t.mock.method(prisma.shopifyConnectionEvent, "updateMany", async () => ({ count: 0 }));

    const res = await shopRedactPOST(req);
    assert.equal(res.status, 200);
    assert.equal(offerUpdateCalls, 1, "exactly one offer updateMany call, scoped only to the redacted domain");
  });

  test("G. an offer with a null sourceShopDomain is never matched by any shop/redact call", async (t) => {
    const payload = JSON.stringify({ shop_id: 1, shop_domain: "some-shop.myshopify.com" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest(
      "http://localhost/api/shopify/webhooks/shop/redact",
      payload,
      hmac,
      "some-shop.myshopify.com",
    );

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({ id: "conn-3", brandId: "brand-3" }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-3",
      brandId: "brand-3",
      installedAt: null,
    }));
    t.mock.method(prisma.commerceConnection, "update", async () => ({}));
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => ({ count: 1 }));
    t.mock.method(prisma.commerceConnection, "deleteMany", async () => ({ count: 1 }));
    t.mock.method(prisma.tokenStore, "findMany", async () => []);

    t.mock.method(prisma.shopifyConnectionEvent, "findMany", async () => [{ brandId: "brand-3" }]);
    t.mock.method(prisma.shopifyRewardRedemption, "findMany", async () => []);
    t.mock.method(prisma.brand, "findMany", async () => []);
    t.mock.method(prisma.brand, "update", async () => ({}));
    t.mock.method(prisma.shopifyRewardRedemption, "updateMany", async () => ({ count: 0 }));

    // brand-3 has an offer created while never connected (sourceShopDomain
    // stays null forever until it is next saved while connected). A
    // Prisma `where: { sourceShopDomain: "some-shop.myshopify.com" }` filter
    // can never match a null column value, so this offer is untouched
    // by construction — asserted here by checking the where clause itself,
    // never by simulating actual row matching (this test doesn't need a DB).
    t.mock.method(prisma.brandRewardOffer, "updateMany", async (args: unknown) => {
      const typed = args as { where: { sourceShopDomain?: string | null } };
      assert.notEqual(typed.where.sourceShopDomain, null, "the filter itself must never be null-inclusive");
      assert.equal(typed.where.sourceShopDomain, "some-shop.myshopify.com");
      return { count: 0 };
    });
    t.mock.method(prisma.shopifyConnectionEvent, "updateMany", async () => ({ count: 0 }));

    const res = await shopRedactPOST(req);
    assert.equal(res.status, 200);
  });

  test("H. a SPECIFIC_PRODUCTS offer tied to the redacted shop is deactivated and scrubbed identically to an ALL_PRODUCTS offer", async (t) => {
    const payload = JSON.stringify({ shop_id: 1, shop_domain: "products-shop.myshopify.com" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest(
      "http://localhost/api/shopify/webhooks/shop/redact",
      payload,
      hmac,
      "products-shop.myshopify.com",
    );

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({ id: "conn-4", brandId: "brand-4" }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-4",
      brandId: "brand-4",
      installedAt: null,
    }));
    t.mock.method(prisma.commerceConnection, "update", async () => ({}));
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => ({ count: 1 }));
    t.mock.method(prisma.commerceConnection, "deleteMany", async () => ({ count: 1 }));
    t.mock.method(prisma.tokenStore, "findMany", async () => []);

    t.mock.method(prisma.shopifyConnectionEvent, "findMany", async () => [{ brandId: "brand-4" }]);
    t.mock.method(prisma.shopifyRewardRedemption, "findMany", async () => []);
    t.mock.method(prisma.brand, "findMany", async () => []);
    t.mock.method(prisma.brand, "update", async () => ({}));
    t.mock.method(prisma.shopifyRewardRedemption, "updateMany", async () => ({ count: 0 }));

    // The route's Prisma predicate never references `appliesTo` — it is a
    // plain `sourceShopDomain` filter, so it matches a SPECIFIC_PRODUCTS
    // offer (whose sourceShopDomain is populated identically to an
    // ALL_PRODUCTS offer per src/lib/reward-offers.ts) exactly the same way.
    let offerUpdateCalls = 0;
    t.mock.method(prisma.brandRewardOffer, "updateMany", async (args: unknown) => {
      offerUpdateCalls += 1;
      const typed = args as {
        where: { sourceShopDomain?: string; appliesTo?: unknown };
        data: { isActive?: boolean; sourceShopDomain?: null };
      };
      assert.equal(typed.where.sourceShopDomain, "products-shop.myshopify.com");
      assert.equal(typed.where.appliesTo, undefined, "the predicate must not filter on appliesTo");
      assert.equal(typed.data.isActive, false);
      assert.equal(typed.data.sourceShopDomain, null);
      return { count: 1 };
    });
    t.mock.method(prisma.shopifyConnectionEvent, "updateMany", async () => ({ count: 0 }));

    const res = await shopRedactPOST(req);
    assert.equal(res.status, 200);
    assert.equal(offerUpdateCalls, 1);
  });

  test("customers/data_request compliance webhook returns 200 with no data found", async () => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/customers/data_request", payload, hmac);

    const res = await customersDataRequestPOST(req);
    assert.equal(res.status, 200);
  });
});

describe("Route Scenario 2: Embedded Shopify Installation", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearMocks();
  });

  test("embedded disconnect deactivates offers and records one DISCONNECTED event", async (t) => {
    // PHASE 14C-A: eligibility resolves canonical-first through
    // findEmbeddedConnectedBrand -> CommerceConnection[provider,externalAccountId];
    // `commerceConnection.findUnique` is called with EITHER that composite
    // key (eligibility) or a plain `{id}` (invalidateShopifyCredential's own
    // internal freshness re-read inside its transaction).
    t.mock.method(prisma.commerceConnection, "findUnique", async (args: unknown) => {
      const typed = args as {
        where: {
          provider_externalAccountId?: { provider: string; externalAccountId: string };
          id?: string;
        };
      };
      if (typed.where.provider_externalAccountId) {
        return {
          brandId: "brand-embedded",
          status: "CONNECTED",
          providerClientId: "client-embedded",
          providerMetadata: { authMode: "EXPIRING_OFFLINE", currencyCode: "CAD" },
        };
      }
      return { id: "conn-embedded", brandId: "brand-embedded", installedAt: null };
    });
    t.mock.method(prisma.brand, "findUnique", async () => ({
      id: "brand-embedded",
      name: "Embedded Brand",
    }));
    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-embedded",
      brandId: "brand-embedded",
    }));
    t.mock.method(prisma.commerceConnection, "update", async (args: unknown) => {
      const typed = args as { data: { status: string } };
      assert.equal(typed.data.status, "DISCONNECTED");
      return {};
    });
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => ({ count: 1 }));

    let deactivateCalled = false;
    t.mock.method(prisma.brandRewardOffer, "updateMany", async (args: unknown) => {
      deactivateCalled = true;
      const typedArgs = args as { where: { brandId: string }; data: { isActive: boolean } };
      assert.equal(typedArgs.where.brandId, "brand-embedded");
      assert.equal(typedArgs.data.isActive, false);
      return { count: 1 };
    });

    let eventRecorded = false;
    t.mock.method(prisma.shopifyConnectionEvent, "create", async (args: unknown) => {
      eventRecorded = true;
      const typedArgs = args as {
        data: { brandId: string; eventType: string; shopDomain: string; currencyCode: string };
      };
      assert.equal(typedArgs.data.brandId, "brand-embedded");
      assert.equal(typedArgs.data.eventType, "DISCONNECTED");
      assert.equal(typedArgs.data.shopDomain, "embedded-shop.myshopify.com");
      assert.equal(typedArgs.data.currencyCode, "CAD");
      return {};
    });

    const result = await disconnectEmbeddedConnectedBrand({
      brandId: "brand-embedded",
      shopDomain: "embedded-shop.myshopify.com",
      clientId: "client-embedded",
    });

    assert.equal(result.count, 1);
    assert.ok(deactivateCalled);
    assert.ok(eventRecorded);
  });

  test("AG. embedded disconnect revokes the CANONICAL credential first, and only for an eligible connection", async (t) => {
    const order: string[] = [];

    // PHASE 14B.4B: eligibility now resolves canonical-first through
    // findEmbeddedConnectedBrand -> CommerceConnection[provider,externalAccountId],
    // never an independent Brand.shopify* predicate.
    t.mock.method(prisma.commerceConnection, "findUnique", async (args: unknown) => {
      const typed = args as {
        where: {
          provider_externalAccountId?: { provider: string; externalAccountId: string };
          id?: string;
        };
      };
      if (typed.where.provider_externalAccountId) {
        // findEmbeddedConnectedBrand's canonical eligibility lookup.
        assert.equal(typed.where.provider_externalAccountId.provider, "SHOPIFY");
        assert.equal(
          typed.where.provider_externalAccountId.externalAccountId,
          "embedded-shop.myshopify.com",
        );
        order.push("eligibilityCheck:connFindUnique");
        return {
          brandId: "brand-embedded",
          status: "CONNECTED",
          providerClientId: "client-embedded",
          providerMetadata: { authMode: "EXPIRING_OFFLINE" },
        };
      }
      // invalidateShopifyCredential's own internal freshness re-read
      // (by id, inside its transaction) — see its P1 staleness fence.
      return { id: "conn-embedded", brandId: "brand-embedded", installedAt: null };
    });
    t.mock.method(prisma.brand, "findUnique", async (args: unknown) => {
      const typed = args as { where: { id: string } };
      assert.equal(typed.where.id, "brand-embedded");
      order.push("eligibilityCheck:brandFindUnique");
      return { id: "brand-embedded", name: "Embedded Brand" };
    });
    // invalidateShopifyCredential's OWN internal lookup, keyed by brandId —
    // distinct from the eligibility check above.
    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-embedded",
      brandId: "brand-embedded",
    }));
    t.mock.method(prisma.commerceConnection, "update", async (args: unknown) => {
      const typed = args as { data: { status: string } };
      assert.equal(typed.data.status, "DISCONNECTED");
      order.push("canonical:status");
      return {};
    });
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async () => {
      order.push("canonical:secretDeleted");
      return { count: 1 };
    });
    t.mock.method(prisma.brandRewardOffer, "updateMany", async () => ({ count: 1 }));
    t.mock.method(prisma.shopifyConnectionEvent, "create", async () => {
      order.push("lossEvent");
      return {};
    });

    const result = await disconnectEmbeddedConnectedBrand({
      brandId: "brand-embedded",
      shopDomain: "embedded-shop.myshopify.com",
      clientId: "client-embedded",
    });

    assert.equal(result.count, 1);
    // PHASE 14C-A: no legacy Brand mirror step left at all — canonical
    // eligibility, canonical status/secret revocation, then the loss event.
    assert.deepEqual(order, [
      "eligibilityCheck:connFindUnique",
      "eligibilityCheck:brandFindUnique",
      "canonical:status",
      "canonical:secretDeleted",
      "lossEvent",
    ]);
  });

  test("embedded disconnect is idempotent: a second call on an already-disconnected brand writes nothing", async (t) => {
    // CAS conditions no longer match (already disconnected) — updateMany
    // matches zero rows.
    t.mock.method(prisma.brand, "findFirst", async () => null);
    t.mock.method(prisma.brand, "updateMany", async () => ({ count: 0 }));

    let deactivateCalled = false;
    t.mock.method(prisma.brandRewardOffer, "updateMany", async () => {
      deactivateCalled = true;
      return { count: 0 };
    });

    let eventRecorded = false;
    t.mock.method(prisma.shopifyConnectionEvent, "create", async () => {
      eventRecorded = true;
      return {};
    });

    const result = await disconnectEmbeddedConnectedBrand({
      brandId: "brand-embedded",
      shopDomain: "embedded-shop.myshopify.com",
      clientId: "client-embedded",
    });

    assert.equal(result.count, 0);
    assert.ok(!deactivateCalled, "no offer deactivation on a no-op disconnect");
    assert.ok(!eventRecorded, "no duplicate history event on a no-op disconnect");
  });

  test("valid signature and token exchange callback redirects to install selection page", async (t) => {
    const stateVal = "state-fresh-123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    
    // Construct search params to sign
    const params = {
      shop: "test-install.myshopify.com",
      code: "oauth-auth-code-123",
      state: stateVal,
      timestamp,
    };
    
    const hmac = crypto.createHmac("sha256", "test-api-secret")
      .update(`code=${params.code}&shop=${params.shop}&state=${params.state}&timestamp=${params.timestamp}`)
      .digest("hex");

    const callbackUrl = `http://localhost/api/shopify/oauth/callback?shop=${params.shop}&code=${params.code}&state=${params.state}&timestamp=${params.timestamp}&hmac=${hmac}`;
    const req = new NextRequest(callbackUrl);

    // Mock prisma check for OAuth state
    t.mock.method(prisma.tokenStore, "findUnique", async () => ({
      service: `shopify_oauth_state:${stateVal}`,
      token: JSON.stringify({ shop: "test-install.myshopify.com" }),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }));

    t.mock.method(prisma.tokenStore, "deleteMany", async () => ({
      count: 1,
    }));

    t.mock.method(prisma.tokenStore, "create", async () => ({}));

    // Mock fetch for token exchange
    globalThis.fetch = async (urlStr) => {
      if (urlStr.toString().includes("/oauth/access_token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "access-token-999",
            scope: "read_products,read_orders,read_themes,read_discounts,write_discounts",
          }),
        } as Response;
      }
      return new Response();
    };

    setupMocks({ user: { id: "user-123", role: "BRAND_ADMIN" } });

    const res = await oauthCallbackGET(req);
    assert.equal(res.status, 307);
    assert.ok(res.headers.get("location")?.includes("/dashboard/brand/shopify/install?install="));
  });

  test("invalid signature is rejected with redirect containing error", async () => {
    const callbackUrl = `http://localhost/api/shopify/oauth/callback?shop=test-install.myshopify.com&code=123&state=state123&timestamp=${Math.floor(Date.now()/1000)}&hmac=wrong-hmac`;
    const req = new NextRequest(callbackUrl);

    const res = await oauthCallbackGET(req);
    assert.equal(res.status, 307);
    assert.ok(res.headers.get("location")?.includes("error=invalid_hmac"));
  });

  test("expired or missing state is rejected with redirect containing error", async (t) => {
    const stateVal = "state-expired";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const params = {
      shop: "test-install.myshopify.com",
      code: "123",
      state: stateVal,
      timestamp,
    };
    const hmac = crypto.createHmac("sha256", "test-api-secret")
      .update(`code=${params.code}&shop=${params.shop}&state=${params.state}&timestamp=${params.timestamp}`)
      .digest("hex");

    const callbackUrl = `http://localhost/api/shopify/oauth/callback?shop=${params.shop}&code=${params.code}&state=${params.state}&timestamp=${params.timestamp}&hmac=${hmac}`;
    const req = new NextRequest(callbackUrl);

    t.mock.method(prisma.tokenStore, "findUnique", async () => null); // missing state record

    const res = await oauthCallbackGET(req);
    assert.equal(res.status, 307);
    assert.ok(res.headers.get("location")?.includes("error=expired_oauth_state"));
  });

  test("missing required scopes redirects with error", async (t) => {
    const stateVal = "state-fresh-123";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const params = {
      shop: "test-install.myshopify.com",
      code: "123",
      state: stateVal,
      timestamp,
    };
    const hmac = crypto.createHmac("sha256", "test-api-secret")
      .update(`code=${params.code}&shop=${params.shop}&state=${params.state}&timestamp=${params.timestamp}`)
      .digest("hex");

    const callbackUrl = `http://localhost/api/shopify/oauth/callback?shop=${params.shop}&code=${params.code}&state=${params.state}&timestamp=${params.timestamp}&hmac=${hmac}`;
    const req = new NextRequest(callbackUrl);

    t.mock.method(prisma.tokenStore, "findUnique", async () => ({
      service: `shopify_oauth_state:${stateVal}`,
      token: JSON.stringify({ shop: "test-install.myshopify.com" }),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }));
    t.mock.method(prisma.tokenStore, "deleteMany", async () => ({ count: 1 }));

    // Mock token exchange returning incomplete scope
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        access_token: "access-token-999",
        scope: "read_products", // write_discounts missing
      }),
    } as Response);

    const res = await oauthCallbackGET(req);
    assert.equal(res.status, 307);
    assert.ok(res.headers.get("location")?.includes("error=insufficient_scopes"));
  });

  test("installation session retrieval (GET) returns brand list and shopify information", async (t) => {
    const req = new NextRequest("http://localhost/api/shopify/installations/install-session-id");
    setupMocks(
      { user: { id: "user-123", role: "BRAND_ADMIN" } },
      {
        userId: "user-123",
        membership: {
          id: "member-123",
          role: "ADMIN",
          brand: { id: "brand-123", name: "Brand Test", slug: "brand-test" },
        },
        brands: [{ id: "brand-123", name: "Brand Test", slug: "brand-test", membershipRole: "ADMIN" }],
        selectionRequired: false,
      },
    );

    t.mock.method(prisma.tokenStore, "findUnique", async () => ({
      service: "shopify_pending_install:install-session-id",
      token: JSON.stringify({ shop: "test-install.myshopify.com", encryptedToken: encryptSecret("mock-token") }),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }));

    const res = await installationsGET(req, { params: Promise.resolve({ installId: "install-session-id" }) });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.shop, "test-install.myshopify.com");
    assert.equal(json.data.brands.length, 1);
    assert.equal(json.data.activeBrandId, "brand-123");
  });

  test("installation linking rejects a brand outside the eligible membership list", async (t) => {
    const req = new NextRequest("http://localhost/api/shopify/installations/install-session-id", {
      method: "POST",
      body: JSON.stringify({ brandId: "brand-not-authorized" }),
    });

    setupMocks(
      { user: { id: "user-123", role: "BRAND_ADMIN" } },
      {
        userId: "user-123",
        membership: {
          id: "member-123",
          role: "ADMIN",
          brand: { id: "brand-123", name: "Authorized Brand", slug: "authorized-brand" },
        },
        brands: [{ id: "brand-123", name: "Authorized Brand", slug: "authorized-brand", membershipRole: "ADMIN" }],
        selectionRequired: false,
      },
    );

    t.mock.method(prisma.tokenStore, "findUnique", async () => ({
      service: "shopify_pending_install:install-session-id",
      token: JSON.stringify({ shop: "test-install.myshopify.com", encryptedToken: encryptSecret("mock-token") }),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }));

    t.mock.method(prisma.brandMember, "findMany", async (args: unknown) => {
      const where = (args as { where?: { brandId?: string } }).where;
      return where?.brandId === "brand-not-authorized"
        ? []
        : [{ id: "member-123", brand: { id: "brand-123", name: "Authorized Brand" } }];
    });

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: { shop: { currencyCode: "USD" } } }),
    } as Response);

    const res = await installationsPOST(req, { params: Promise.resolve({ installId: "install-session-id" }) });
    assert.equal(res.status, 403);
    const json = await res.json();
    assert.equal(json.error, "You are not authorized for this brand.");
  });

  test("linking a brand (POST) performs oauth relink and currency fetch", async (t) => {
    const req = new NextRequest("http://localhost/api/shopify/installations/install-session-id", {
      method: "POST",
      body: JSON.stringify({ brandId: "brand-123" }),
    });

    setupMocks(
      { user: { id: "user-123", role: "BRAND_ADMIN" } },
      {
        userId: "user-123",
        membership: {
          id: "member-123",
          role: "ADMIN",
          brand: { id: "brand-123", name: "Brand Test", slug: "brand-test" },
        },
        brands: [{ id: "brand-123", name: "Brand Test", slug: "brand-test", membershipRole: "ADMIN" }],
        selectionRequired: false,
      },
    );

    t.mock.method(prisma.tokenStore, "findUnique", async () => ({
      service: "shopify_pending_install:install-session-id",
      token: JSON.stringify({ shop: "test-install.myshopify.com", encryptedToken: encryptSecret("mock-token") }),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }));

    t.mock.method(prisma.brandMember, "findMany", async () => [
      {
        id: "member-123",
        brand: { id: "brand-123", name: "Brand Test" },
      },
    ]);

    // PHASE 14C-A: conflict/prior-connection detection is canonical-only now
    // (`tx.commerceConnection.findFirst`), which defaults to `null` in
    // `before()` — no conflicting owner, and brand-123 has no prior Shopify
    // connection.
    t.mock.method(prisma.brand, "findUniqueOrThrow", async () => ({
      name: "Brand Test",
      slug: "brand-test",
    }));

    const callLog = mockCanonicalInstallWrites(t);

    t.mock.method(prisma.tokenStore, "delete", async () => ({}));

    // Mock fetch for GraphQL currency code query
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          shop: {
            currencyCode: "USD",
          },
        },
      }),
    } as Response);

    const res = await installationsPOST(req, { params: Promise.resolve({ installId: "install-session-id" }) });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.brand.id, "brand-123");

    // Y. CANONICAL-ONLY INSTALL (PHASE 14C-A). The canonical connection AND
    // its credential are the only write — no legacy Brand mirror step is
    // left at all — and the connection is created CONNECTED for the
    // destination brand.
    assert.deepEqual(callLog, [
      "canonical:findUnique",
      "canonical:count",
      "canonical:clearOtherPrimary",
      "canonical:upsert:brand-123:test-install.myshopify.com:CONNECTED",
      "canonical:secret:conn-canonical",
    ]);
  });

  test("duplicate shop link connects conflict fails with 409", async (t) => {
    const req = new NextRequest("http://localhost/api/shopify/installations/install-session-id", {
      method: "POST",
      body: JSON.stringify({ brandId: "brand-123" }),
    });

    setupMocks(
      { user: { id: "user-123", role: "BRAND_ADMIN" } },
      {
        userId: "user-123",
        membership: {
          id: "member-123",
          role: "ADMIN",
          brand: { id: "brand-123", name: "Brand Test", slug: "brand-test" },
        },
        brands: [{ id: "brand-123", name: "Brand Test", slug: "brand-test", membershipRole: "ADMIN" }],
        selectionRequired: false,
      },
    );

    t.mock.method(prisma.tokenStore, "findUnique", async () => ({
      service: "shopify_pending_install:install-session-id",
      token: JSON.stringify({ shop: "test-install.myshopify.com", encryptedToken: encryptSecret("mock-token") }),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }));

    t.mock.method(prisma.brandMember, "findMany", async () => [
      {
        id: "member-123",
        brand: { id: "brand-123" },
      },
    ]);

    // Active conflicting shop domain linked to another brand's canonical connection.
    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-456",
      brandId: "brand-456",
      status: "CONNECTED",
      providerClientId: null,
      providerMetadata: null,
    }));

    const res = await installationsPOST(req, { params: Promise.resolve({ installId: "install-session-id" }) });
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.ok(json.error.includes("already linked to another brand"));
  });

  test("uninstall followed by reinstall releases duplicate link and succeeds", async (t) => {
    const req = new NextRequest("http://localhost/api/shopify/installations/install-session-id", {
      method: "POST",
      body: JSON.stringify({ brandId: "brand-123" }),
    });

    setupMocks(
      { user: { id: "user-123", role: "BRAND_ADMIN" } },
      {
        userId: "user-123",
        membership: {
          id: "member-123",
          role: "ADMIN",
          brand: { id: "brand-123", name: "Brand Test", slug: "brand-test" },
        },
        brands: [{ id: "brand-123", name: "Brand Test", slug: "brand-test", membershipRole: "ADMIN" }],
        selectionRequired: false,
      },
    );

    t.mock.method(prisma.tokenStore, "findUnique", async () => ({
      service: "shopify_pending_install:install-session-id",
      token: JSON.stringify({ shop: "test-install.myshopify.com", encryptedToken: encryptSecret("mock-token") }),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }));

    t.mock.method(prisma.brandMember, "findMany", async () => [
      {
        id: "member-123",
        brand: { id: "brand-123" },
      },
    ]);

    // Conflicting shop link's canonical connection is UNINSTALLED (so we can
    // relink it) — distinguish the owner-conflict lookup (keyed on
    // externalAccountId) from the destination's own prior-connection lookup
    // (keyed on brandId), which the SAME `findFirst` delegate also serves.
    t.mock.method(prisma.commerceConnection, "findFirst", async (args: unknown) => {
      const typed = args as { where: { externalAccountId?: string; brandId?: string } };
      if (typed.where.externalAccountId !== undefined) {
        return {
          id: "conn-456",
          brandId: "brand-456",
          status: "UNINSTALLED",
          providerClientId: "old-client",
          providerMetadata: { currencyCode: "CAD" },
        };
      }
      // brand-123 (destination) has no prior Shopify connection.
      return null;
    });

    t.mock.method(prisma.brand, "findUniqueOrThrow", async () => ({
      name: "Brand Test",
      slug: "brand-test",
    }));

    let conflictingBrandLossRecorded = false;
    t.mock.method(prisma.shopifyConnectionEvent, "create", async (args: unknown) => {
      const typed = args as { data: { brandId: string; eventType: string } };
      if (typed.data.brandId === "brand-456" && typed.data.eventType === "DISCONNECTED") {
        conflictingBrandLossRecorded = true;
      }
      return {};
    });

    const callLog = mockCanonicalInstallWrites(t);

    t.mock.method(prisma.tokenStore, "delete", async () => ({}));

    // Mock fetch for GraphQL currency code query
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          shop: {
            currencyCode: "USD",
          },
        },
      }),
    } as Response);

    const res = await installationsPOST(req, { params: Promise.resolve({ installId: "install-session-id" }) });
    assert.equal(res.status, 200);
    assert.ok(conflictingBrandLossRecorded);

    // Z. RELINK is canonical-only too (PHASE 14C-A): the previous owner's
    // loss is recorded (offers deactivated, DISCONNECTED event), then the
    // SAME canonical connection row (keyed on shop domain) is reassigned to
    // the destination brand with a fresh credential — no legacy Brand mirror
    // write anywhere.
    assert.deepEqual(callLog, [
      "canonical:findUnique",
      "canonical:count",
      "canonical:clearOtherPrimary",
      "canonical:upsert:brand-123:test-install.myshopify.com:CONNECTED",
      "canonical:secret:conn-canonical",
    ]);
  });
});

// Helper to construct a request
function makeJsonRequest(url: string, body: unknown, method: string = "POST", cookies: Record<string, string> = {}): NextRequest {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  const cookieStrings: string[] = [];
  for (const [name, val] of Object.entries(cookies)) {
    cookieStrings.push(`${name}=${val}`);
  }
  if (cookieStrings.length > 0) {
    headers.set("cookie", cookieStrings.join("; "));
  }
  return new NextRequest(url, {
    method,
    headers,
    body: JSON.stringify(body),
  });
}

describe("Route Scenario 3: Shopify Token Refresh", () => {
  afterEach(() => {
    clearMocks();
  });

  // PHASE 14C-A: `getValidAccessToken` resolves and rotates the credential
  // canonically now — `CommerceConnection` + `CommerceConnectionSecret`
  // (whose `refreshLockId`/`refreshLockedUntil` columns ARE the CAS lease;
  // see shopify-credential-store.ts) — there is no `Brand.shopify*` fallback
  // or mirror write left in this path at all.
  function encodeExpiringCredential(fields: {
    accessToken: string;
    accessTokenExpiresAt: Date;
    refreshToken: string;
    refreshTokenExpiresAt: Date;
  }): string {
    return encryptSecret(
      JSON.stringify({
        accessToken: fields.accessToken,
        accessTokenExpiresAt: fields.accessTokenExpiresAt.toISOString(),
        refreshToken: fields.refreshToken,
        refreshTokenExpiresAt: fields.refreshTokenExpiresAt.toISOString(),
        authMode: "EXPIRING_OFFLINE",
      }),
    );
  }

  const SUFFICIENT_SCOPES = [
    "read_products",
    "read_orders",
    "read_themes",
    "read_discounts",
    "write_discounts",
  ];

  test("single-request refresh updates stale token", async (t) => {
    const brandId = "brand-refresh-1";
    const connectionId = "conn-refresh-1";
    let encryptedPayload = encodeExpiringCredential({
      accessToken: "old-access-token",
      accessTokenExpiresAt: new Date(Date.now() - 10000), // expired
      refreshToken: "old-refresh-token",
      refreshTokenExpiresAt: new Date(Date.now() + 1000000),
    });

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: connectionId,
      brandId,
      status: "CONNECTED",
      externalAccountId: "test-shop.myshopify.com",
      providerClientId: "client-id",
      grantedScopes: SUFFICIENT_SCOPES,
      providerMetadata: null,
      secret: { encryptedPayload },
    }));

    let lockId: string | null = null;
    t.mock.method(prisma.commerceConnectionSecret, "updateMany", async (args: unknown) => {
      const typed = args as { where: { refreshLockId?: string }; data: Record<string, unknown> };
      if (typed.data.refreshLockId && typed.data.refreshLockedUntil) {
        lockId = typed.data.refreshLockId as string;
        return { count: 1 };
      }
      if (typed.where.refreshLockId !== lockId) return { count: 0 };
      if (typeof typed.data.encryptedPayload === "string") {
        encryptedPayload = typed.data.encryptedPayload;
      }
      return { count: 1 };
    });
    t.mock.method(prisma.commerceConnection, "update", async () => ({}));

    const mockTokenEndpoint = async (shop: string, body: Record<string, string | number>) => {
      assert.equal(shop, "test-shop.myshopify.com");
      assert.equal(body.refresh_token, "old-refresh-token");
      return {
        access_token: "new-access-token",
        scope: SUFFICIENT_SCOPES.join(","),
        expires_in: 3600,
        refresh_token: "new-refresh-token",
        refresh_token_expires_in: 86400,
      };
    };

    const res = await getValidAccessToken(brandId, { tokenEndpoint: mockTokenEndpoint });
    assert.ok(res.ok);
    assert.equal((res as { accessToken?: string }).accessToken, "new-access-token");
  });

  test("concurrent refresh locks: second request waits and re-reads", async (t) => {
    const brandId = "brand-refresh-2";
    const connectionId = "conn-refresh-2";
    let encryptedPayload = encodeExpiringCredential({
      accessToken: "old-access-token",
      accessTokenExpiresAt: new Date(Date.now() - 10000), // expired
      refreshToken: "old-refresh-token",
      refreshTokenExpiresAt: new Date(Date.now() + 1000000),
    });

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: connectionId,
      brandId,
      status: "CONNECTED",
      externalAccountId: "test-shop.myshopify.com",
      providerClientId: "client-id",
      grantedScopes: SUFFICIENT_SCOPES,
      providerMetadata: null,
      secret: { encryptedPayload },
    }));

    // Another caller already holds the lease — this request can never win it.
    t.mock.method(prisma.commerceConnectionSecret, "updateMany", async () => ({ count: 0 }));

    // The FIRST poll (isCredentialRefreshLeaseHeld) observes the concurrent
    // winner having already finished: the lease is released and the new
    // token is already in place.
    t.mock.method(prisma.commerceConnectionSecret, "findUnique", async () => {
      encryptedPayload = encodeExpiringCredential({
        accessToken: "concurrent-new-token",
        accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
        refreshToken: "old-refresh-token",
        refreshTokenExpiresAt: new Date(Date.now() + 1000000),
      });
      return { refreshLockedUntil: null };
    });

    const mockTokenEndpoint = async () => {
      throw new Error("Should not be called");
    };

    const res = await getValidAccessToken(brandId, { tokenEndpoint: mockTokenEndpoint });
    assert.ok(res.ok);
    assert.equal((res as { accessToken?: string }).accessToken, "concurrent-new-token");
  });

  test("stale writer protection: retrieves winner token", async (t) => {
    const brandId = "brand-refresh-3";
    const connectionId = "conn-refresh-3";

    let findFirstCallCount = 0;
    t.mock.method(prisma.commerceConnection, "findFirst", async () => {
      findFirstCallCount++;
      const encryptedPayload =
        findFirstCallCount > 1
          ? encodeExpiringCredential({
              accessToken: "winner-token",
              accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
              refreshToken: "old-refresh-token",
              refreshTokenExpiresAt: new Date(Date.now() + 1000000),
            })
          : encodeExpiringCredential({
              accessToken: "old-access-token",
              accessTokenExpiresAt: new Date(Date.now() - 10000), // expired
              refreshToken: "old-refresh-token",
              refreshTokenExpiresAt: new Date(Date.now() + 1000000),
            });
      return {
        id: connectionId,
        brandId,
        status: "CONNECTED",
        externalAccountId: "test-shop.myshopify.com",
        providerClientId: "client-id",
        grantedScopes: SUFFICIENT_SCOPES,
        providerMetadata: null,
        secret: { encryptedPayload },
      };
    });

    t.mock.method(prisma.commerceConnectionSecret, "updateMany", async (args: unknown) => {
      const typed = args as { data: Record<string, unknown> };
      // This caller wins the lease...
      if (typed.data.refreshLockId && typed.data.refreshLockedUntil) return { count: 1 };
      // ...but loses the persist race — another writer took over the lease first.
      return { count: 0 };
    });

    const mockTokenEndpoint = async () => ({
      access_token: "failed-stale-token",
      scope: SUFFICIENT_SCOPES.join(","),
      expires_in: 3600,
      refresh_token: "new-refresh-token",
      refresh_token_expires_in: 86400,
    });

    const res = await getValidAccessToken(brandId, { tokenEndpoint: mockTokenEndpoint });
    assert.ok(res.ok);
    assert.equal((res as { accessToken?: string }).accessToken, "winner-token");
  });

  test("brand isolation: Brand A refresh does not touch Brand B", async (t) => {
    t.mock.method(prisma.commerceConnection, "findFirst", async (args: unknown) => {
      const typedArgs = args as { where: { brandId: string } };
      if (typedArgs.where.brandId !== "brand-A") return null;
      return {
        id: "conn-A",
        brandId: "brand-A",
        status: "CONNECTED",
        externalAccountId: "shop-A.myshopify.com",
        providerClientId: "client-A",
        grantedScopes: SUFFICIENT_SCOPES,
        providerMetadata: null,
        secret: {
          encryptedPayload: encodeExpiringCredential({
            accessToken: "token-A",
            accessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
            refreshToken: "refresh-A",
            refreshTokenExpiresAt: new Date(Date.now() + 1000000),
          }),
        },
      };
    });

    const res = await getValidAccessToken("brand-A");
    assert.ok(res.ok);
    assert.equal((res as { accessToken?: string }).accessToken, "token-A");
  });

  test("REQUIRES_RECONNECT transition on permanent failure (400)", async (t) => {
    const brandId = "brand-reconnect";
    const connectionId = "conn-reconnect";

    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: connectionId,
      brandId,
      status: "CONNECTED",
      externalAccountId: "test-shop.myshopify.com",
      providerClientId: "client-id",
      grantedScopes: SUFFICIENT_SCOPES,
      providerMetadata: null,
      secret: {
        encryptedPayload: encodeExpiringCredential({
          accessToken: "old-access-token",
          accessTokenExpiresAt: new Date(Date.now() - 10000), // expired
          refreshToken: "old-refresh-token",
          refreshTokenExpiresAt: new Date(Date.now() + 1000000),
        }),
      },
    }));

    t.mock.method(prisma.commerceConnectionSecret, "updateMany", async (args: unknown) => {
      const typed = args as { data: Record<string, unknown> };
      // Lease acquire succeeds; there is no persist call on this failure path.
      if (typed.data.refreshLockId && typed.data.refreshLockedUntil) return { count: 1 };
      return { count: 0 };
    });

    let markRequiresReconnectCalled = false;
    t.mock.method(prisma.commerceConnectionSecret, "deleteMany", async (args: unknown) => {
      const typed = args as { where: { connectionId: string } };
      assert.equal(typed.where.connectionId, connectionId);
      markRequiresReconnectCalled = true;
      return { count: 1 };
    });

    t.mock.method(prisma.commerceConnection, "update", async (args: unknown) => {
      assert.ok(markRequiresReconnectCalled);
      const typedArgs = args as { data: { status: string } };
      assert.equal(typedArgs.data.status, "REQUIRES_RECONNECT");
      return {};
    });

    let offersDeactivatedAfterGuard = false;
    t.mock.method(prisma.brandRewardOffer, "updateMany", async (args: unknown) => {
      // Must only happen once the guarded compare-and-swap transition above
      // has already succeeded.
      assert.ok(markRequiresReconnectCalled);
      const typedArgs = args as { where: { brandId: string }; data: { isActive: boolean } };
      assert.equal(typedArgs.where.brandId, brandId);
      assert.equal(typedArgs.data.isActive, false);
      offersDeactivatedAfterGuard = true;
      return { count: 1 };
    });

    let eventRecordedAfterGuard = false;
    t.mock.method(prisma.shopifyConnectionEvent, "create", async (args: unknown) => {
      assert.ok(markRequiresReconnectCalled);
      const typedArgs = args as {
        data: { brandId: string; eventType: string; shopDomain: string };
      };
      assert.equal(typedArgs.data.brandId, brandId);
      assert.equal(typedArgs.data.eventType, "REQUIRES_RECONNECT");
      assert.equal(typedArgs.data.shopDomain, "test-shop.myshopify.com");
      eventRecordedAfterGuard = true;
      return {};
    });

    const mockTokenEndpoint = async () => {
      const err = new Error("Shopify token endpoint responded with 400");
      (err as { status?: number }).status = 400;
      throw err;
    };

    const res = await getValidAccessToken(brandId, { tokenEndpoint: mockTokenEndpoint });
    assert.ok(!res.ok);
    if (!res.ok) {
      assert.equal((res as { reason?: string }).reason, "NEEDS_RECONNECT");
    }
    assert.ok(markRequiresReconnectCalled);
    assert.ok(offersDeactivatedAfterGuard);
    assert.ok(eventRecordedAfterGuard);
  });
});

describe("Route Scenario 4: Reward Redemption", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearMocks();
  });

  /**
   * PHASE 14B.4B: the redeem route's connection gate now resolves through
   * `getActiveCommerceConnection`, which reads `CommerceConnection` FIRST —
   * mocks a matching CONNECTED row so tests written against the legacy
   * `offer.brand.shopify*` gate keep exercising the SAME "connected" state
   * canonically instead of falling through to a real (blocked) DB read.
   */
  function mockCanonicalConnection(
    t: { mock: { method: (o: object, m: string, i: unknown) => void } },
    input: { brandId: string; shopDomain: string; currencyCode: string | null },
  ) {
    t.mock.method(prisma.commerceConnection, "findMany", async () => [
      {
        id: `conn-${input.brandId}`,
        brandId: input.brandId,
        provider: "SHOPIFY",
        status: "CONNECTED",
        displayName: input.shopDomain,
        externalAccountId: input.shopDomain,
        storefrontUrl: `https://${input.shopDomain}`,
        isPrimary: true,
        grantedScopes: [],
        installedAt: new Date("2026-01-01T00:00:00Z"),
        uninstalledAt: null,
        lastProductSyncAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
        providerMetadata: { authMode: "LEGACY_OFFLINE", currencyCode: input.currencyCode },
      },
    ]);
  }

  test("point checks: returns 409 when user has insufficient points", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });
    mockCanonicalConnection(t, {
      brandId: "brand-123",
      shopDomain: "test-shop.myshopify.com",
      currencyCode: "USD",
    });

    t.mock.method(prisma.shopifyRewardRedemption, "findUnique", async () => null);

    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => ({
      id: "offer-123",
      brandId: "brand-123",
      pointsCost: 100,
      isActive: true,
      claimStartsAt: null,
      claimEndsAt: null,
      maxTotalRedemptions: null,
      maxRedemptionsPerUser: null,
      codePrefix: "TEST",
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
      minimumSubtotalCents: null,
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
      brand: {
        id: "brand-123",
        name: "Brand Test",
        shopifyShopDomain: "test-shop.myshopify.com",
        shopifyAdminAccessTokenEncrypted: encryptSecret("token-123"),
        shopifyConnectionStatus: "CONNECTED",
        shopifyCurrencyCode: "USD",
      },
      products: [],
    }));

    t.mock.method(prisma.user, "findUnique", async () => ({
      id: "user-123",
    }));

    t.mock.method(prisma.userPointAccount, "findUnique", async () => ({
      userId: "user-123",
      spendablePoints: 50,
      lifetimeEarnedPoints: 50,
      lifetimeSpentPoints: 0,
      lifetimeRefundedPoints: 0,
      version: 0,
    }));

    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-123",
      brandId: "brand-123",
      unlocks: [{ id: "unlock-123" }],
    }));

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-123",
      idempotencyKey: "idem-key-1",
      campaignId: "campaign-123",
    });

    const res = await redeemPOST(req);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(json.error, "Not enough SQRATCH points for this reward.");
  });

  test("redemption blocks a fixed-amount reward whose currency no longer matches the connected store", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });
    // Store currency has drifted to CAD since this USD offer was created —
    // the canonical connection is what the route now checks against.
    mockCanonicalConnection(t, {
      brandId: "brand-123",
      shopDomain: "test-shop.myshopify.com",
      currencyCode: "CAD",
    });

    t.mock.method(prisma.shopifyRewardRedemption, "findUnique", async () => null);

    let pointsDebited = false;
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => ({
      id: "offer-currency-mismatch",
      brandId: "brand-123",
      pointsCost: 50,
      isActive: true,
      claimStartsAt: null,
      claimEndsAt: null,
      maxTotalRedemptions: null,
      maxRedemptionsPerUser: null,
      codePrefix: "TEST",
      discountType: "FIXED_AMOUNT",
      discountAmountCents: 1000,
      discountPercentageBasisPoints: null,
      currencyCode: "USD",
      minimumSubtotalCents: null,
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
      brand: {
        id: "brand-123",
        name: "Brand Test",
        shopifyShopDomain: "test-shop.myshopify.com",
        shopifyAdminAccessTokenEncrypted: encryptSecret("token-123"),
        shopifyConnectionStatus: "CONNECTED",
        // Store currency has drifted to CAD since this USD offer was created.
        shopifyCurrencyCode: "CAD",
      },
      products: [],
    }));

    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-123" }));
    t.mock.method(prisma.userPointAccount, "findUnique", async () => ({
      userId: "user-123",
      spendablePoints: 200,
      lifetimeEarnedPoints: 200,
      lifetimeSpentPoints: 0,
      lifetimeRefundedPoints: 0,
      version: 0,
    }));
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-123",
      brandId: "brand-123",
      unlocks: [{ id: "unlock-123" }],
    }));
    t.mock.method(prisma.pointTransaction, "create", async () => {
      pointsDebited = true;
      return {};
    });

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-currency-mismatch",
      idempotencyKey: "idem-key-currency-mismatch",
      campaignId: "campaign-123",
    });

    const res = await redeemPOST(req);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(
      json.error,
      "Reward currency does not match the Shopify store currency. Please contact the brand.",
    );
    assert.ok(!pointsDebited, "no point debit occurs when compatibility fails");
  });

  test("redemption allows a percentage reward with no minimum subtotal despite a stored currency difference", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });
    // Store currency has drifted to CAD, but this offer isn't currency-dependent.
    mockCanonicalConnection(t, {
      brandId: "brand-123",
      shopDomain: "test-shop.myshopify.com",
      currencyCode: "CAD",
    });
    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-brand-123",
      brandId: "brand-123",
      status: "CONNECTED",
      externalAccountId: "test-shop.myshopify.com",
      providerClientId: null,
      grantedScopes: [],
      providerMetadata: null,
      secret: {
        encryptedPayload: encryptSecret(
          JSON.stringify({
            accessToken: "token-123",
            accessTokenExpiresAt: null,
            refreshToken: null,
            refreshTokenExpiresAt: null,
            authMode: "LEGACY_OFFLINE",
          }),
        ),
      },
    }));
    // A real canonical connection (via mockCanonicalConnection's `findMany`)
    // means the route takes the ADAPTER discount-issuance path — the
    // adapter's own `loadConnection` reads `commerceConnection.findUnique`
    // by id, separately from the credential/gate lookups above.
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-brand-123",
      brandId: "brand-123",
      provider: "SHOPIFY",
      status: "CONNECTED",
      displayName: "test-shop.myshopify.com",
      externalAccountId: "test-shop.myshopify.com",
      storefrontUrl: "https://test-shop.myshopify.com",
      isPrimary: true,
      grantedScopes: [],
      installedAt: new Date("2026-01-01T00:00:00Z"),
      uninstalledAt: null,
      lastProductSyncAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      providerMetadata: null,
    }));

    t.mock.method(prisma.shopifyRewardRedemption, "findUnique", async () => null);

    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => ({
      id: "offer-percentage-ok",
      brandId: "brand-123",
      pointsCost: 50,
      isActive: true,
      claimStartsAt: null,
      claimEndsAt: null,
      maxTotalRedemptions: null,
      maxRedemptionsPerUser: null,
      codePrefix: "TEST",
      codeValidDays: 7,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
      minimumSubtotalCents: null,
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
      brand: {
        id: "brand-123",
        name: "Brand Test",
        shopifyShopDomain: "test-shop.myshopify.com",
        shopifyAdminAccessTokenEncrypted: encryptSecret("token-123"),
        shopifyConnectionStatus: "CONNECTED",
        // Store currency differs from the offer's stored currency, but this
        // offer isn't currency-dependent — must not be blocked.
        shopifyCurrencyCode: "CAD",
      },
      products: [],
    }));

    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-123",
      brandId: "brand-123",
      unlocks: [{ id: "unlock-123" }],
    }));
    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-123" }));
    t.mock.method(prisma.shopifyRewardRedemption, "create", async () => ({
      id: "redemption-percentage-ok",
      userId: "user-123",
      brandId: "brand-123",
      offerId: "offer-percentage-ok",
      code: "TEST-CODE-OK",
      status: "PENDING",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
    }));
    t.mock.method(prisma.pointTransaction, "create", async () => ({}));
    t.mock.method(prisma.shopifyRewardRedemption, "update", async (args: unknown) => {
      const typedArgs = args as { data: { status?: string } };
      return {
        id: "redemption-percentage-ok",
        code: "TEST-CODE-OK",
        status: typedArgs.data.status || "ISSUED",
        pointsCost: 50,
        discountType: "PERCENTAGE",
        discountAmountCents: null,
        discountPercentageBasisPoints: 1000,
        currencyCode: "USD",
        issuedAt: new Date(),
        expiresAt: new Date(),
        usedAt: null,
      };
    });
    t.mock.method(prisma.brand, "findUnique", async () => ({
      id: "brand-123",
      shopifyShopDomain: "test-shop.myshopify.com",
      shopifyAdminAccessTokenEncrypted: encryptSecret("token-123"),
      shopifyConnectionStatus: "CONNECTED",
      shopifyAuthMode: "LEGACY_OFFLINE",
      shopifyAccessTokenExpiresAt: null,
      shopifyRefreshTokenEncrypted: null,
      shopifyRefreshTokenExpiresAt: null,
      shopifyGrantedScopes: null,
      shopifyClientId: null,
      shopifyTokenRefreshLockedUntil: null,
      shopifyTokenRefreshLockId: null,
    }));

    globalThis.fetch = async () =>
      ({
        ok: true,
        json: async () => ({
          data: {
            discountCodeBasicCreate: {
              codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" },
              userErrors: [],
            },
          },
        }),
      }) as Response;

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-percentage-ok",
      idempotencyKey: "idem-key-percentage-ok",
      campaignId: "campaign-123",
    });

    const res = await redeemPOST(req);
    assert.equal(res.status, 200);
  });

  test("redemption blocks a specific-products reward whose sourceShopDomain no longer matches the connected store", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });
    mockCanonicalConnection(t, {
      brandId: "brand-123",
      shopDomain: "test-shop.myshopify.com",
      currencyCode: "CAD",
    });

    t.mock.method(prisma.shopifyRewardRedemption, "findUnique", async () => null);

    let pointsDebited = false;
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => ({
      id: "offer-stale-products",
      brandId: "brand-123",
      pointsCost: 50,
      isActive: true,
      claimStartsAt: null,
      claimEndsAt: null,
      maxTotalRedemptions: null,
      maxRedemptionsPerUser: null,
      codePrefix: "TEST",
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "CAD",
      minimumSubtotalCents: null,
      appliesTo: "SPECIFIC_PRODUCTS",
      // Belongs to a previous store, not the currently connected one.
      sourceShopDomain: "old-shop.myshopify.com",
      brand: {
        id: "brand-123",
        name: "Brand Test",
        shopifyShopDomain: "test-shop.myshopify.com",
        shopifyAdminAccessTokenEncrypted: encryptSecret("token-123"),
        shopifyConnectionStatus: "CONNECTED",
        shopifyCurrencyCode: "CAD",
      },
      products: [{ shopifyProductGid: "gid://shopify/Product/1" }],
    }));

    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-123" }));
    t.mock.method(prisma.userPointAccount, "findUnique", async () => ({
      userId: "user-123",
      spendablePoints: 200,
      lifetimeEarnedPoints: 200,
      lifetimeSpentPoints: 0,
      lifetimeRefundedPoints: 0,
      version: 0,
    }));
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-123",
      brandId: "brand-123",
      unlocks: [{ id: "unlock-123" }],
    }));
    t.mock.method(prisma.pointTransaction, "create", async () => {
      pointsDebited = true;
      return {};
    });

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-stale-products",
      idempotencyKey: "idem-key-stale-products",
      campaignId: "campaign-123",
    });

    const res = await redeemPOST(req);
    assert.equal(res.status, 409);
    const json = await res.json();
    assert.equal(
      json.error,
      "This reward's products are not available for the connected Shopify store.",
    );
    assert.ok(!pointsDebited, "no point debit occurs when compatibility fails");
  });

  test("cross-brand rewards remain blocked even when the campaign is unlocked", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });

    t.mock.method(prisma.shopifyRewardRedemption, "findUnique", async () => null);
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => ({
      id: "offer-other-brand",
      brandId: "brand-other",
      pointsCost: 10,
      isActive: true,
      claimStartsAt: null,
      claimEndsAt: null,
      maxTotalRedemptions: null,
      maxRedemptionsPerUser: null,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
      minimumSubtotalCents: null,
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
      brand: {
        id: "brand-other",
        name: "Other Brand",
        shopifyShopDomain: "other.myshopify.com",
        shopifyAdminAccessTokenEncrypted: encryptSecret("token-other"),
        shopifyConnectionStatus: "CONNECTED",
        shopifyCurrencyCode: "USD",
      },
      products: [],
    }));
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-123",
      brandId: "brand-123",
      unlocks: [{ id: "unlock-123" }],
    }));

    const response = await redeemPOST(
      makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
        offerId: "offer-other-brand",
        idempotencyKey: "idem-key-cross-brand",
        campaignId: "campaign-123",
      }),
    );

    assert.equal(response.status, 403);
    assert.equal(
      (await response.json()).error,
      "Unlock this experience before claiming rewards.",
    );
  });

  test("double click / concurrent calls returns existing redemption (idempotency)", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });

    t.mock.method(prisma.shopifyRewardRedemption, "findUnique", async () => ({
      id: "redemption-existing",
      userId: "user-123",
      offerId: "offer-123",
      code: "TEST-CODE",
      status: "ISSUED",
      pointsCost: 100,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
      issuedAt: new Date(),
      expiresAt: null,
      usedAt: null,
      errorMessage: null,
    }));

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-123",
      idempotencyKey: "idem-key-2",
    });

    const res = await redeemPOST(req);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.code, "TEST-CODE");
    assert.equal(json.data.status, "ISSUED");
  });

  test("successful redemption creates shopify discount and debits points", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });
    mockCanonicalConnection(t, {
      brandId: "brand-123",
      shopDomain: "test-shop.myshopify.com",
      currencyCode: "USD",
    });
    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-brand-123",
      brandId: "brand-123",
      status: "CONNECTED",
      externalAccountId: "test-shop.myshopify.com",
      providerClientId: null,
      grantedScopes: [],
      providerMetadata: null,
      secret: {
        encryptedPayload: encryptSecret(
          JSON.stringify({
            accessToken: "token-123",
            accessTokenExpiresAt: null,
            refreshToken: null,
            refreshTokenExpiresAt: null,
            authMode: "LEGACY_OFFLINE",
          }),
        ),
      },
    }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-brand-123",
      brandId: "brand-123",
      provider: "SHOPIFY",
      status: "CONNECTED",
      displayName: "test-shop.myshopify.com",
      externalAccountId: "test-shop.myshopify.com",
      storefrontUrl: "https://test-shop.myshopify.com",
      isPrimary: true,
      grantedScopes: [],
      installedAt: new Date("2026-01-01T00:00:00Z"),
      uninstalledAt: null,
      lastProductSyncAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      providerMetadata: null,
    }));

    t.mock.method(prisma.shopifyRewardRedemption, "findUnique", async () => null);

    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => ({
      id: "offer-123",
      brandId: "brand-123",
      pointsCost: 50,
      isActive: true,
      claimStartsAt: null,
      claimEndsAt: null,
      maxTotalRedemptions: null,
      maxRedemptionsPerUser: null,
      codePrefix: "TEST",
      codeValidDays: 7,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
      minimumSubtotalCents: null,
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
      brand: {
        id: "brand-123",
        name: "Brand Test",
        shopifyShopDomain: "test-shop.myshopify.com",
        shopifyAdminAccessTokenEncrypted: encryptSecret("token-123"),
        shopifyConnectionStatus: "CONNECTED",
        shopifyCurrencyCode: "USD",
      },
      products: [],
    }));

    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-123",
      brandId: "brand-123",
      unlocks: [{ id: "unlock-123" }],
    }));

    t.mock.method(prisma.user, "findUnique", async () => ({
      id: "user-123",
    }));

    t.mock.method(prisma.shopifyRewardRedemption, "create", async () => ({
      id: "redemption-new",
      userId: "user-123",
      brandId: "brand-123",
      offerId: "offer-123",
      code: "TEST-CODE-NEW",
      status: "PENDING",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
    }));

    t.mock.method(prisma.pointTransaction, "create", async () => ({}));

    let redemptionUpdatedToIssued = false;
    t.mock.method(prisma.shopifyRewardRedemption, "update", async (args: unknown) => {
      const typedArgs = args as { data: { status?: string } };
      if (typedArgs.data.status === "ISSUED") {
        redemptionUpdatedToIssued = true;
      }
      return {
        id: "redemption-new",
        code: "TEST-CODE-NEW",
        status: typedArgs.data.status || "ISSUED",
        pointsCost: 50,
        discountType: "PERCENTAGE",
        discountAmountCents: null,
        discountPercentageBasisPoints: 1000,
        currencyCode: "USD",
        issuedAt: new Date(),
        expiresAt: new Date(),
        usedAt: null,
      };
    });

    t.mock.method(prisma.brand, "findUnique", async () => ({
      id: "brand-123",
      shopifyShopDomain: "test-shop.myshopify.com",
      shopifyAdminAccessTokenEncrypted: encryptSecret("token-123"),
      shopifyConnectionStatus: "CONNECTED",
      shopifyAuthMode: "LEGACY_OFFLINE",
    }));

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: {
              id: "gid://shopify/DiscountCodeNode/999",
              codeDiscount: {
                startsAt: new Date().toISOString(),
                endsAt: new Date().toISOString(),
              },
            },
            userErrors: [],
          },
        },
      }),
    } as Response);

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-123",
      idempotencyKey: "idem-key-3",
      campaignId: "campaign-123",
    });

    const res = await redeemPOST(req);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.code, "TEST-CODE-NEW");
    assert.ok(redemptionUpdatedToIssued);
  });

  test("Shopify failure causes points refund and records REFUNDED status", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });
    mockCanonicalConnection(t, {
      brandId: "brand-123",
      shopDomain: "test-shop.myshopify.com",
      currencyCode: "USD",
    });
    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-brand-123",
      brandId: "brand-123",
      status: "CONNECTED",
      externalAccountId: "test-shop.myshopify.com",
      providerClientId: null,
      grantedScopes: [],
      providerMetadata: null,
      secret: {
        encryptedPayload: encryptSecret(
          JSON.stringify({
            accessToken: "token-123",
            accessTokenExpiresAt: null,
            refreshToken: null,
            refreshTokenExpiresAt: null,
            authMode: "LEGACY_OFFLINE",
          }),
        ),
      },
    }));
    t.mock.method(prisma.commerceConnection, "findUnique", async () => ({
      id: "conn-brand-123",
      brandId: "brand-123",
      provider: "SHOPIFY",
      status: "CONNECTED",
      displayName: "test-shop.myshopify.com",
      externalAccountId: "test-shop.myshopify.com",
      storefrontUrl: "https://test-shop.myshopify.com",
      isPrimary: true,
      grantedScopes: [],
      installedAt: new Date("2026-01-01T00:00:00Z"),
      uninstalledAt: null,
      lastProductSyncAt: null,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      providerMetadata: null,
    }));

    t.mock.method(prisma.shopifyRewardRedemption, "findUnique", async (args: unknown) => {
      const typedArgs = args as { where?: { id?: string } };
      if (typedArgs?.where?.id) {
        return {
          id: typedArgs.where.id,
          status: "POINTS_DEBITED",
          pointsCost: 50,
          userId: "user-123",
          offerId: "offer-123",
          code: "TEST-CODE-FAIL",
          discountType: "PERCENTAGE",
          discountAmountCents: null,
          discountPercentageBasisPoints: 1000,
          currencyCode: "USD",
        };
      }
      return null;
    });

    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => ({
      id: "offer-123",
      brandId: "brand-123",
      pointsCost: 50,
      isActive: true,
      claimStartsAt: null,
      claimEndsAt: null,
      maxTotalRedemptions: null,
      maxRedemptionsPerUser: null,
      codePrefix: "TEST",
      codeValidDays: 7,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
      minimumSubtotalCents: null,
      appliesTo: "ALL_PRODUCTS",
      sourceShopDomain: null,
      brand: {
        id: "brand-123",
        name: "Brand Test",
        shopifyShopDomain: "test-shop.myshopify.com",
        shopifyAdminAccessTokenEncrypted: encryptSecret("token-123"),
        shopifyConnectionStatus: "CONNECTED",
        shopifyCurrencyCode: "USD",
      },
      products: [],
    }));

    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-123",
      brandId: "brand-123",
      unlocks: [{ id: "unlock-123" }],
    }));

    t.mock.method(prisma.user, "findUnique", async () => ({
      id: "user-123",
    }));

    t.mock.method(prisma.shopifyRewardRedemption, "create", async () => ({
      id: "redemption-fail",
      userId: "user-123",
      brandId: "brand-123",
      offerId: "offer-123",
      code: "TEST-CODE-FAIL",
      status: "PENDING",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
    }));

    t.mock.method(prisma.pointTransaction, "create", async () => ({}));

    let pointsRefunded = false;
    let statusRefunded = false;

    t.mock.method(prisma.userPointAccount, "update", async () => {
      pointsRefunded = true;
      return {
        userId: "user-123",
        spendablePoints: 250,
        lifetimeEarnedPoints: 0,
        lifetimeSpentPoints: 50,
        lifetimeRefundedPoints: 50,
        version: 1,
      };
    });

    t.mock.method(prisma.shopifyRewardRedemption, "update", async (args: unknown) => {
      const typedArgs = args as { data: { status?: string } };
      if (typedArgs.data.status === "REFUNDED") {
        statusRefunded = true;
      }
      return {
        id: "redemption-fail",
        code: "TEST-CODE-FAIL",
        status: "REFUNDED",
        pointsCost: 50,
        discountType: "PERCENTAGE",
        discountAmountCents: null,
        discountPercentageBasisPoints: 1000,
        currencyCode: "USD",
      };
    });

    t.mock.method(prisma.brand, "findUnique", async () => ({
      id: "brand-123",
      shopifyShopDomain: "test-shop.myshopify.com",
      shopifyAdminAccessTokenEncrypted: encryptSecret("token-123"),
      shopifyConnectionStatus: "CONNECTED",
      shopifyAuthMode: "LEGACY_OFFLINE",
    }));

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          discountCodeBasicCreate: {
            codeDiscountNode: null,
            userErrors: [{ message: "Some Shopify error code", field: [] }],
          },
        },
      }),
    } as Response);

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-123",
      idempotencyKey: "idem-key-4",
      campaignId: "campaign-123",
    });

    const res = await redeemPOST(req);
    assert.equal(res.status, 502);
    assert.ok(pointsRefunded);
    assert.ok(statusRefunded);
  });

  // PHASE 14C-A: the refresh-status route resolves connectivity through
  // canonical `getActiveCommerceConnection` (no Brand fallback), guarded
  // against the redemption's OWN historical `shopifyShopDomain` snapshot
  // (not `Brand.shopifyShopDomain`), and the access token through canonical
  // `getValidAccessToken`.
  test("stuck redemption status refresh is derived as USED", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });
    mockCanonicalConnection(t, {
      brandId: "brand-123",
      shopDomain: "test-shop.myshopify.com",
      currencyCode: "USD",
    });
    t.mock.method(prisma.commerceConnection, "findFirst", async () => ({
      id: "conn-brand-123",
      brandId: "brand-123",
      status: "CONNECTED",
      externalAccountId: "test-shop.myshopify.com",
      providerClientId: null,
      grantedScopes: [],
      providerMetadata: null,
      secret: {
        encryptedPayload: encryptSecret(
          JSON.stringify({
            accessToken: "token-123",
            accessTokenExpiresAt: null,
            refreshToken: null,
            refreshTokenExpiresAt: null,
            authMode: "LEGACY_OFFLINE",
          }),
        ),
      },
    }));

    t.mock.method(prisma.shopifyRewardRedemption, "findFirst", async () => ({
      id: "redemption-refresh",
      userId: "user-123",
      brandId: "brand-123",
      shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/123",
      shopifyShopDomain: "test-shop.myshopify.com",
      status: "ISSUED",
      code: "TEST-CODE-REFRESH",
    }));

    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({
        data: {
          node: {
            id: "gid://shopify/DiscountCodeNode/123",
            codeDiscount: {
              status: "ACTIVE",
              asyncUsageCount: 1,
              usageLimit: 1,
              endsAt: new Date().toISOString(),
            },
          },
        },
      }),
    } as Response);

    let statusUpdatedToUsed = false;
    t.mock.method(prisma.shopifyRewardRedemption, "update", async (args: unknown) => {
      const typedArgs = args as { data: { status?: string } };
      if (typedArgs.data.status === "USED") {
        statusUpdatedToUsed = true;
      }
      return {
        id: "redemption-refresh",
        code: "TEST-CODE-REFRESH",
        status: "USED",
      };
    });

    const req = new NextRequest("http://localhost/api/rewards/shopify/redemptions/redemption-refresh/refresh-status", {
      method: "POST",
    });

    const res = await refreshStatusPOST(req, { params: Promise.resolve({ redemptionId: "redemption-refresh" }) });
    assert.equal(res.status, 200);
    assert.ok(statusUpdatedToUsed);
  });
});

describe("Route Scenario 5: QR Redemption and Unlock", () => {
  afterEach(() => {
    clearMocks();
  });

  test("public scan (POST) on NEW QR: redeems and awards points", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER", email: "test@user.com" } });

    t.mock.method(prisma.qRCode, "findUnique", async () => ({
      id: "qr-123",
      qrCodeData: "qr-data-123",
      status: "NEW",
      campaignId: "campaign-123",
      campaign: {
        id: "campaign-123",
        slug: "campaign-slug",
        brandId: "brand-123",
        brand: {
          id: "brand-123",
          name: "Brand A",
          slug: "brand-a",
        },
      },
    }));

    t.mock.method(prisma.userSession, "upsert", async () => ({}));
    t.mock.method(prisma.campaignUnlock, "findFirst", async () => null);
    t.mock.method(prisma.campaignUnlock, "create", async () => ({}));

    let qrCodeStatusUpdated = false;
    t.mock.method(prisma.qRCode, "updateMany", async () => {
      qrCodeStatusUpdated = true;
      return { count: 1 };
    });

    let pointsAwarded = false;
    t.mock.method(prisma.userPointAccount, "update", async () => {
      pointsAwarded = true;
      return {
        userId: "user-123",
        spendablePoints: 1,
        lifetimeEarnedPoints: 1,
        lifetimeSpentPoints: 0,
        lifetimeRefundedPoints: 0,
        version: 1,
      };
    });

    t.mock.method(prisma.pointTransaction, "create", async () => ({}));
    t.mock.method(prisma.analyticsEvent, "create", async () => ({}));

    const req = makeJsonRequest("http://localhost/api/public/scan", {
      qrCodeData: "qr-data-123",
    });

    const res = await scanPOST(req);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.campaignSlug, "campaign-slug");
    assert.ok(qrCodeStatusUpdated);
    assert.ok(pointsAwarded);
  });

  test("public scan (POST) on already USED QR: acts as repeat scan (idempotent)", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });

    t.mock.method(prisma.qRCode, "findUnique", async () => ({
      id: "qr-123",
      qrCodeData: "qr-data-123",
      status: "USED",
      campaignId: "campaign-123",
      campaign: {
        id: "campaign-123",
        slug: "campaign-slug",
        brandId: "brand-123",
      },
    }));

    let updateManyCalled = false;
    t.mock.method(prisma.qRCode, "updateMany", async () => {
      updateManyCalled = true;
      return { count: 0 };
    });

    t.mock.method(prisma.analyticsEvent, "create", async () => ({}));

    const req = makeJsonRequest("http://localhost/api/public/scan", {
      qrCodeData: "qr-data-123",
    });

    const res = await scanPOST(req);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.ok(!updateManyCalled);
  });

  test("anonymous progress merge merges lessons and unlocks to user", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER", email: "test@user.com" } });

    t.mock.method(prisma.lessonProgress, "findMany", async () => [
      { id: "anon-progress-1", lessonId: "lesson-1", lastPositionSeconds: 120, isCompleted: true },
    ]);

    t.mock.method(prisma.campaignUnlock, "findMany", async () => [
      { id: "anon-unlock-1", campaignId: "campaign-123", qrCodeId: "qr-123", anonKey: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    ]);

    t.mock.method(prisma.lessonProgress, "findUnique", async () => null);
    t.mock.method(prisma.lessonProgress, "create", async () => ({}));
    t.mock.method(prisma.lessonProgress, "deleteMany", async () => ({ count: 1 }));

    t.mock.method(prisma.campaignUnlock, "findFirst", async () => null);
    t.mock.method(prisma.qRCode, "updateMany", async () => ({ count: 1 }));
    t.mock.method(prisma.qRCode, "findUnique", async () => ({ status: "USED", redeemedById: "user-123" }));
    t.mock.method(prisma.user, "update", async () => ({ id: "user-123" }));
    t.mock.method(prisma.pointTransaction, "create", async () => ({}));

    let unlockUpdated = false;
    t.mock.method(prisma.campaignUnlock, "update", async () => {
      unlockUpdated = true;
      return { id: "anon-unlock-1" };
    });

    t.mock.method(prisma.userSession, "updateMany", async () => ({ count: 1 }));

    const req = makeJsonRequest("http://localhost/api/progress/merge", {}, "POST", {
      sqr_session: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    const res = await mergePOST(req);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.data.mergedLessons, 1);
    assert.equal(json.data.mergedUnlocks, 1);
    assert.ok(unlockUpdated);
  });
});

describe("Route Scenario 6: QR Exports", () => {
  afterEach(() => {
    clearMocks();
  });

  test("export returns 401 if unauthorized", async () => {
    setupMocks(null);
    const req = new NextRequest("http://localhost/api/brand/qr-batches/batch-123/export");
    const res = await exportGET(req, { params: Promise.resolve({ id: "batch-123" }) });
    assert.equal(res.status, 401);
  });

  test("export returns 403 if user is not BRAND_ADMIN or ADMIN", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });
    t.mock.method(prisma.qRCodeBatch, "findUnique", async () => ({
      id: "batch-123",
      campaign: {
        id: "campaign-123",
        brandId: "brand-123",
      },
    }));
    const req = new NextRequest("http://localhost/api/brand/qr-batches/batch-123/export");
    const res = await exportGET(req, { params: Promise.resolve({ id: "batch-123" }) });
    assert.equal(res.status, 403);
  });

  test("export enforces 5000 hard maximum and protects PII", async (t) => {
    setupMocks(
      { user: { id: "user-123", role: "ADMIN" } },
      { membership: { brand: { id: "brand-123" } } },
    );

    t.mock.method(prisma.qRCodeBatch, "findUnique", async () => ({
      id: "batch-123",
      campaign: {
        id: "campaign-123",
        brandId: "brand-123",
      },
    }));

    t.mock.method(prisma.qRCode, "count", async () => 6000);

    const req = new NextRequest("http://localhost/api/brand/qr-batches/batch-123/export");
    const res = await exportGET(req, { params: Promise.resolve({ id: "batch-123" }) });
    assert.equal(res.status, 400);
    const json = await res.json();
    assert.ok(json.error.includes("Export size too large"));
  });

  test("successful export returns CSV with only public fields (no PII)", async (t) => {
    setupMocks(
      { user: { id: "user-123", role: "BRAND_ADMIN" } },
      { membership: { brand: { id: "brand-123" } } }
    );

    t.mock.method(prisma.qRCodeBatch, "findUnique", async () => ({
      id: "batch-123",
      campaign: {
        id: "campaign-123",
        brandId: "brand-123",
      },
    }));

    t.mock.method(prisma.qRCode, "count", async () => 2);

    t.mock.method(prisma.qRCode, "findMany", async () => [
      { qrCodeData: "secret-token-1", qrCodeUrl: "http://qr1.com", status: "NEW" },
      { qrCodeData: "secret-token-2", qrCodeUrl: "http://qr2.com", status: "USED" },
    ]);

    t.mock.method(prisma.qRCodeBatch, "update", async () => ({}));

    const req = new NextRequest("http://localhost/api/brand/qr-batches/batch-123/export");
    const res = await exportGET(req, { params: Promise.resolve({ id: "batch-123" }) });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "text/csv; charset=utf-8");

    const text = await res.text();
    assert.ok(text.includes("QR Code Data,QR Code URL,Status,Scan Redirect URL"));
    assert.ok(text.includes("secret-token-1"));
    assert.ok(text.includes("secret-token-2"));
    assert.ok(text.includes("NEW"));
    assert.ok(text.includes("REDEEMED"));
    assert.ok(!text.includes("email"));
    assert.ok(!text.includes("userId"));
  });
});

describe("Route Scenario 7: Session/Account Behavior", () => {
  afterEach(() => {
    clearMocks();
  });

  test("JWT callback updates role and isActive if interval has elapsed", async (t) => {
    const jwtCallback = authOptions.callbacks?.jwt;
    if (typeof jwtCallback !== "function") {
      assert.fail("jwt callback is not a function");
    }

    const token = {
      id: "user-123",
      role: "USER",
      isActive: true,
      roleCheckedAt: Date.now() - 10 * 60 * 1000,
    };

    t.mock.method(prisma.user, "findUnique", async () => ({
      role: "ADMIN",
      isActive: true,
      isEmailVerified: true,
    }));

    const result = (await jwtCallback({
      token,
      user: undefined as never,
      account: null as never,
      profile: null as never,
      trigger: "update" as never,
    })) as { role?: string; isActive?: boolean; roleCheckedAt?: number };
    assert.equal(result.role, "ADMIN");
    assert.equal(result.isActive, true);
    assert.ok((result.roleCheckedAt as number) > Date.now() - 1000);
  });

  test("JWT callback invalidates session of deactivated user", async (t) => {
    const jwtCallback = authOptions.callbacks?.jwt;
    if (typeof jwtCallback !== "function") {
      assert.fail("jwt callback is not a function");
    }

    const token = {
      id: "user-123",
      role: "USER",
      isActive: true,
      roleCheckedAt: Date.now() - 10 * 60 * 1000,
    };

    t.mock.method(prisma.user, "findUnique", async () => ({
      role: "USER",
      isActive: false,
      isEmailVerified: true,
    }));

    const result = (await jwtCallback({
      token,
      user: undefined as never,
      account: null as never,
      profile: null as never,
      trigger: "update" as never,
    })) as { accountInvalidated?: boolean; id?: string; role?: string };
    assert.equal(result.accountInvalidated, true);
    assert.equal(result.id, undefined);
    assert.equal(result.role, undefined);
  });

  test("Session callback returns undefined user if account is invalidated", async () => {
    const sessionCallback = authOptions.callbacks?.session;
    if (typeof sessionCallback !== "function") {
      assert.fail("session callback is not a function");
    }

    const token = {
      accountInvalidated: true,
    };

    const session = {
      user: {
        name: "Test User",
      },
      expires: "expiry",
    };

    const result = (await sessionCallback({
      session: session as never,
      token: token as never,
      user: undefined as never,
      newSession: undefined as never,
      trigger: "update" as never,
    })) as { user?: unknown };
    assert.equal(result.user, undefined);
  });
});
