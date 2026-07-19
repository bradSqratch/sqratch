process.env.DATABASE_URL = "postgres://dummy:dummy@localhost:5432/dummy";
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
  experienceProductLink: Record<string, (...args: unknown[]) => unknown>;
  lessonProductLink: Record<string, (...args: unknown[]) => unknown>;
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
    updateMany: async () => ({ count: 0 }),
  };
  // Safe defaults for the shop/redact source-domain scrubbing added in
  // src/app/api/shopify/webhooks/shop/redact/route.ts.
  prismaModule.experienceProductLink = {
    updateMany: async () => ({ count: 0 }),
  };
  prismaModule.lessonProductLink = {
    updateMany: async () => ({ count: 0 }),
  };
  prismaModule.lesson = {
    findUnique: async () => null,
    findMany: async () => [],
  };
  prismaModule.course = { findUnique: async () => null };

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

// Helpers
function buildWebhookHmac(body: string, secret: string = "test-api-secret"): string {
  return crypto.createHmac("sha256", secret).update(body).digest("base64");
}

function makeWebhookRequest(url: string, body: string, hmac: string | null, shop: string = "store.myshopify.com"): NextRequest {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (hmac) {
    headers.set("x-shopify-hmac-sha256", hmac);
  }
  headers.set("x-shopify-shop-domain", shop);
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

  test("app/uninstalled webhook clears active credentials", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/app/uninstalled", payload, hmac, "uninstall-shop.myshopify.com");

    t.mock.method(prisma.brand, "findUnique", async () => ({
      id: "brand-uninstall",
      shopifyCurrencyCode: "USD",
      shopifyClientId: "client-x",
    }));

    let updateCalled = false;
    let capturedData: unknown = null;

    t.mock.method(prisma.brand, "update", async (args: unknown) => {
      const typedArgs = args as { data?: Record<string, unknown> };
      updateCalled = true;
      capturedData = typedArgs.data;
      return { id: "brand-uninstall" };
    });

    let connectionEventRecorded = false;
    t.mock.method(prisma.shopifyConnectionEvent, "create", async (args: unknown) => {
      const typedArgs = args as { data: { eventType: string } };
      connectionEventRecorded = typedArgs.data.eventType === "UNINSTALLED";
      return {};
    });

    const res = await appUninstalledPOST(req);
    assert.equal(res.status, 200);
    assert.ok(updateCalled);
    assert.ok(connectionEventRecorded);
    const data = capturedData as { shopifyConnectionStatus: string; shopifyAdminAccessTokenEncrypted: string | null; shopifyRefreshTokenEncrypted: string | null };
    assert.ok(data);
    assert.equal(data.shopifyConnectionStatus, "UNINSTALLED");
    assert.equal(data.shopifyAdminAccessTokenEncrypted, null);
    assert.equal(data.shopifyRefreshTokenEncrypted, null);
  });

  test("duplicate app/uninstalled delivery is idempotent (succeeds without error)", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req1 = makeWebhookRequest("http://localhost/api/shopify/webhooks/app/uninstalled", payload, hmac, "uninstall-shop.myshopify.com");
    const req2 = makeWebhookRequest("http://localhost/api/shopify/webhooks/app/uninstalled", payload, hmac, "uninstall-shop.myshopify.com");

    t.mock.method(prisma.brand, "findUnique", async () => ({
      id: "brand-uninstall",
      shopifyCurrencyCode: "USD",
      shopifyClientId: "client-x",
    }));

    let callCount = 0;
    t.mock.method(prisma.brand, "update", async () => {
      callCount++;
      return { id: "brand-uninstall" };
    });

    const res1 = await appUninstalledPOST(req1);
    assert.equal(res1.status, 200);

    const res2 = await appUninstalledPOST(req2);
    assert.equal(res2.status, 200);

    assert.equal(callCount, 2);
  });

  test("uninstall preserves allowed historical business records", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/app/uninstalled", payload, hmac, "uninstall-shop.myshopify.com");

    t.mock.method(prisma.brand, "findUnique", async () => ({
      id: "brand-uninstall",
      shopifyCurrencyCode: "USD",
      shopifyClientId: "client-x",
    }));

    let brandUpdateCalled = false;
    let otherModelsTouched = false;

    t.mock.method(prisma.brand, "update", async () => {
      brandUpdateCalled = true;
      return { id: "brand-uninstall" };
    });

    // We verify no delete calls or mutations on other business models like PointTransaction
    t.mock.method(prisma.pointTransaction, "deleteMany", async () => {
      otherModelsTouched = true;
      return { count: 0 };
    });

    const res = await appUninstalledPOST(req);
    assert.equal(res.status, 200);
    assert.ok(brandUpdateCalled);
    assert.ok(!otherModelsTouched);
  });

  test("compliance webhook shop/redact behaves matching the documented data inventory", async (t) => {
    const payload = JSON.stringify({ test: "data" });
    const hmac = buildWebhookHmac(payload);
    const req = makeWebhookRequest("http://localhost/api/shopify/webhooks/shop/redact", payload, hmac, "redact-shop.myshopify.com");

    let brandFound = false;
    let brandUpdated = false;
    let redemptionAnonymized = false;
    let tokensDeleted = false;

    t.mock.method(prisma.brand, "findFirst", async () => {
      brandFound = true;
      return { id: "brand-123" };
    });

    t.mock.method(prisma.brand, "update", async (args: unknown) => {
      brandUpdated = true;
      const typedArgs = args as { where: { id: string }; data: { shopifyShopDomain: string | null; shopifyConnectionStatus: string } };
      assert.equal(typedArgs.where.id, "brand-123");
      assert.equal(typedArgs.data.shopifyShopDomain, null);
      assert.equal(typedArgs.data.shopifyConnectionStatus, "UNINSTALLED");
      return { id: "brand-123" };
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
        where: { brandId?: string; sourceShopDomain?: string };
        data: { isActive?: boolean; sourceShopDomain?: null };
      };
      if (typedArgs.where.brandId === "brand-123") {
        assert.equal(typedArgs.data.isActive, false);
        offersDeactivated = true;
      } else if (typedArgs.where.sourceShopDomain === "redact-shop.myshopify.com") {
        assert.equal(typedArgs.data.sourceShopDomain, null);
        offerSourceDomainScrubbed = true;
      }
      return { count: 1 };
    });

    let experienceLinksScrubbed = false;
    t.mock.method(prisma.experienceProductLink, "updateMany", async (args: unknown) => {
      const typedArgs = args as { where: { sourceShopDomain: string }; data: { sourceShopDomain: null } };
      assert.equal(typedArgs.where.sourceShopDomain, "redact-shop.myshopify.com");
      assert.equal(typedArgs.data.sourceShopDomain, null);
      experienceLinksScrubbed = true;
      return { count: 1 };
    });

    let lessonLinksScrubbed = false;
    t.mock.method(prisma.lessonProductLink, "updateMany", async (args: unknown) => {
      const typedArgs = args as { where: { sourceShopDomain: string }; data: { sourceShopDomain: null } };
      assert.equal(typedArgs.where.sourceShopDomain, "redact-shop.myshopify.com");
      assert.equal(typedArgs.data.sourceShopDomain, null);
      lessonLinksScrubbed = true;
      return { count: 1 };
    });

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
    assert.ok(brandFound);
    assert.ok(brandUpdated);
    assert.ok(redemptionAnonymized);
    assert.ok(tokensDeleted);
    assert.ok(offersDeactivated, "the redacted Brand's reward offers are deactivated");
    assert.ok(offerSourceDomainScrubbed, "BrandRewardOffer.sourceShopDomain is scrubbed");
    assert.ok(experienceLinksScrubbed, "ExperienceProductLink.sourceShopDomain is scrubbed");
    assert.ok(lessonLinksScrubbed, "LessonProductLink.sourceShopDomain is scrubbed");
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

    // No brand holds this domain (e.g. an OAuth flow that was never completed).
    t.mock.method(prisma.brand, "findFirst", async () => null);

    let brandUpdated = false;
    t.mock.method(prisma.brand, "update", async () => {
      brandUpdated = true;
      return {};
    });

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
    t.mock.method(prisma.brand, "findFirst", async () => ({
      shopifyCurrencyCode: "CAD",
    }));
    t.mock.method(prisma.brand, "updateMany", async () => ({ count: 1 }));

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
            scope: "read_products,read_discounts,write_discounts",
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
    setupMocks({ user: { id: "user-123", role: "BRAND_ADMIN" } });

    t.mock.method(prisma.tokenStore, "findUnique", async () => ({
      service: "shopify_pending_install:install-session-id",
      token: JSON.stringify({ shop: "test-install.myshopify.com", encryptedToken: encryptSecret("mock-token") }),
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    }));

    t.mock.method(prisma.brandMember, "findMany", async () => [
      {
        id: "member-123",
        role: "ADMIN",
        brand: { id: "brand-123", name: "Brand Test", slug: "brand-test" },
      },
    ]);

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

    setupMocks({ user: { id: "user-123", role: "BRAND_ADMIN" } });

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

    setupMocks({ user: { id: "user-123", role: "BRAND_ADMIN" } });

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

    t.mock.method(prisma.brand, "findFirst", async () => null); // no conflicting shop link
    t.mock.method(prisma.brand, "findUnique", async () => null); // brand-123 has no prior Shopify connection

    t.mock.method(prisma.brand, "update", async (args: unknown) => {
      const typedArgs = args as { where: { id: string }; data: { shopifyShopDomain: string; shopifyCurrencyCode: string } };
      assert.equal(typedArgs.where.id, "brand-123");
      assert.equal(typedArgs.data.shopifyShopDomain, "test-install.myshopify.com");
      assert.equal(typedArgs.data.shopifyCurrencyCode, "USD");
      return { id: "brand-123", name: "Brand Test", slug: "brand-test" };
    });

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
  });

  test("duplicate shop link connects conflict fails with 409", async (t) => {
    const req = new NextRequest("http://localhost/api/shopify/installations/install-session-id", {
      method: "POST",
      body: JSON.stringify({ brandId: "brand-123" }),
    });

    setupMocks({ user: { id: "user-123", role: "BRAND_ADMIN" } });

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

    // Active conflicting shop domain linked to another brand
    t.mock.method(prisma.brand, "findFirst", async () => ({
      id: "brand-456",
      shopifyConnectionStatus: "CONNECTED",
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

    setupMocks({ user: { id: "user-123", role: "BRAND_ADMIN" } });

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

    // Conflicting shop link is UNINSTALLED (so we can relink it)
    t.mock.method(prisma.brand, "findFirst", async () => ({
      id: "brand-456",
      shopifyConnectionStatus: "UNINSTALLED",
    }));

    t.mock.method(prisma.brand, "findUnique", async (args: unknown) => {
      const typedArgs = args as { where: { id: string } };
      if (typedArgs.where.id === "brand-456") {
        return {
          shopifyShopDomain: "test-install.myshopify.com",
          shopifyCurrencyCode: "CAD",
          shopifyClientId: "old-client",
        };
      }
      return null; // brand-123 (destination) has no prior Shopify connection
    });

    let conflictingBrandCleared = false;
    let mainBrandUpdated = false;

    // We override brand.update and brand.updateMany to check relink transaction
    t.mock.method(prisma.brand, "update", async (args: unknown) => {
      const typedArgs = args as { where: { id: string }; data: { shopifyShopDomain: string | null } };
      // First transaction call clears conflicting brand-456, second links brand-123
      if (typedArgs.where.id === "brand-456") {
        conflictingBrandCleared = true;
        assert.equal(typedArgs.data.shopifyShopDomain, null);
      } else if (typedArgs.where.id === "brand-123") {
        mainBrandUpdated = true;
        assert.equal(typedArgs.data.shopifyShopDomain, "test-install.myshopify.com");
      }
      return { id: typedArgs.where.id };
    });

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
    assert.ok(conflictingBrandCleared);
    assert.ok(mainBrandUpdated);
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

  test("single-request refresh updates stale token", async (t) => {
    const brandId = "brand-refresh-1";
    const brandRecord = {
      id: brandId,
      shopifyShopDomain: "test-shop.myshopify.com",
      shopifyAdminAccessTokenEncrypted: encryptSecret("old-access-token"),
      shopifyConnectionStatus: "CONNECTED",
      shopifyAuthMode: "EXPIRING_OFFLINE",
      shopifyAccessTokenExpiresAt: new Date(Date.now() - 10000), // expired
      shopifyRefreshTokenEncrypted: encryptSecret("old-refresh-token"),
      shopifyRefreshTokenExpiresAt: new Date(Date.now() + 1000000),
      shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
      shopifyClientId: "client-id",
      shopifyTokenRefreshLockedUntil: null as Date | null,
      shopifyTokenRefreshLockId: null as string | null,
    };

    t.mock.method(prisma.brand, "findUnique", async () => brandRecord);

    let lockId: string | null = null;
    t.mock.method(prisma.brand, "updateMany", async (args: unknown) => {
      const typedArgs = args as { data: Record<string, unknown>; where: Record<string, unknown> };
      if (typedArgs.data.shopifyTokenRefreshLockId) {
        lockId = typedArgs.data.shopifyTokenRefreshLockId as string;
        brandRecord.shopifyTokenRefreshLockedUntil = typedArgs.data.shopifyTokenRefreshLockedUntil as Date;
        brandRecord.shopifyTokenRefreshLockId = lockId;
        return { count: 1 };
      }
      if (typedArgs.where.shopifyTokenRefreshLockId === lockId) {
        brandRecord.shopifyAdminAccessTokenEncrypted = typedArgs.data.shopifyAdminAccessTokenEncrypted as string;
        brandRecord.shopifyAccessTokenExpiresAt = typedArgs.data.shopifyAccessTokenExpiresAt as Date;
        brandRecord.shopifyRefreshTokenEncrypted = typedArgs.data.shopifyRefreshTokenEncrypted as string;
        brandRecord.shopifyRefreshTokenExpiresAt = typedArgs.data.shopifyRefreshTokenExpiresAt as Date;
        brandRecord.shopifyTokenRefreshLockedUntil = null;
        brandRecord.shopifyTokenRefreshLockId = null;
        return { count: 1 };
      }
      return { count: 0 };
    });

    const mockTokenEndpoint = async (shop: string, body: Record<string, string | number>) => {
      assert.equal(shop, "test-shop.myshopify.com");
      assert.equal(body.refresh_token, "old-refresh-token");
      return {
        access_token: "new-access-token",
        scope: "read_products,read_discounts,write_discounts",
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
    const brandRecord = {
      id: brandId,
      shopifyShopDomain: "test-shop.myshopify.com",
      shopifyAdminAccessTokenEncrypted: encryptSecret("old-access-token"),
      shopifyConnectionStatus: "CONNECTED",
      shopifyAuthMode: "EXPIRING_OFFLINE",
      shopifyAccessTokenExpiresAt: new Date(Date.now() - 10000), // expired
      shopifyRefreshTokenEncrypted: encryptSecret("old-refresh-token"),
      shopifyRefreshTokenExpiresAt: new Date(Date.now() + 1000000),
      shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
      shopifyClientId: "client-id",
      shopifyTokenRefreshLockedUntil: null as Date | null,
      shopifyTokenRefreshLockId: null as string | null,
    };

    let findUniqueCallCount = 0;
    t.mock.method(prisma.brand, "findUnique", async () => {
      findUniqueCallCount++;
      if (findUniqueCallCount > 1) {
        brandRecord.shopifyAdminAccessTokenEncrypted = encryptSecret("concurrent-new-token");
        brandRecord.shopifyAccessTokenExpiresAt = new Date(Date.now() + 3600 * 1000);
        brandRecord.shopifyTokenRefreshLockedUntil = null;
        brandRecord.shopifyTokenRefreshLockId = null;
      }
      return brandRecord;
    });

    t.mock.method(prisma.brand, "updateMany", async () => {
      brandRecord.shopifyTokenRefreshLockedUntil = new Date(Date.now() + 30000);
      brandRecord.shopifyTokenRefreshLockId = "other-lock-id";
      return { count: 0 };
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
    const brandRecord = {
      id: brandId,
      shopifyShopDomain: "test-shop.myshopify.com",
      shopifyAdminAccessTokenEncrypted: encryptSecret("old-access-token"),
      shopifyConnectionStatus: "CONNECTED",
      shopifyAuthMode: "EXPIRING_OFFLINE",
      shopifyAccessTokenExpiresAt: new Date(Date.now() - 10000), // expired
      shopifyRefreshTokenEncrypted: encryptSecret("old-refresh-token"),
      shopifyRefreshTokenExpiresAt: new Date(Date.now() + 1000000),
      shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
      shopifyClientId: "client-id",
      shopifyTokenRefreshLockedUntil: null as Date | null,
      shopifyTokenRefreshLockId: null as string | null,
    };

    let findUniqueCallCount = 0;
    t.mock.method(prisma.brand, "findUnique", async () => {
      findUniqueCallCount++;
      if (findUniqueCallCount > 1) {
        return {
          ...brandRecord,
          shopifyAdminAccessTokenEncrypted: encryptSecret("winner-token"),
          shopifyAccessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
          shopifyConnectionStatus: "CONNECTED",
        };
      }
      return brandRecord;
    });

    t.mock.method(prisma.brand, "updateMany", async (args: unknown) => {
      const typedArgs = args as { data: Record<string, unknown> };
      if (typedArgs.data.shopifyTokenRefreshLockId) {
        brandRecord.shopifyTokenRefreshLockedUntil = typedArgs.data.shopifyTokenRefreshLockedUntil as Date;
        brandRecord.shopifyTokenRefreshLockId = typedArgs.data.shopifyTokenRefreshLockId as string;
        return { count: 1 };
      }
      return { count: 0 };
    });

    const mockTokenEndpoint = async () => ({
      access_token: "failed-stale-token",
      scope: "read_products,read_discounts,write_discounts",
      expires_in: 3600,
      refresh_token: "new-refresh-token",
      refresh_token_expires_in: 86400,
    });

    const res = await getValidAccessToken(brandId, { tokenEndpoint: mockTokenEndpoint });
    assert.ok(res.ok);
    assert.equal((res as { accessToken?: string }).accessToken, "winner-token");
  });

  test("brand isolation: Brand A refresh does not touch Brand B", async (t) => {
    const brandRecordA = {
      id: "brand-A",
      shopifyShopDomain: "shop-A.myshopify.com",
      shopifyAdminAccessTokenEncrypted: encryptSecret("token-A"),
      shopifyConnectionStatus: "CONNECTED",
      shopifyAuthMode: "EXPIRING_OFFLINE",
      shopifyAccessTokenExpiresAt: new Date(Date.now() + 3600 * 1000),
      shopifyRefreshTokenEncrypted: encryptSecret("refresh-A"),
      shopifyRefreshTokenExpiresAt: new Date(Date.now() + 1000000),
      shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
      shopifyClientId: "client-A",
      shopifyTokenRefreshLockedUntil: null as Date | null,
      shopifyTokenRefreshLockId: null as string | null,
    };

    t.mock.method(prisma.brand, "findUnique", async (args: unknown) => {
      const typedArgs = args as { where: { id: string } };
      if (typedArgs.where.id === "brand-A") return brandRecordA;
      return null;
    });

    const res = await getValidAccessToken("brand-A");
    assert.ok(res.ok);
    assert.equal((res as { accessToken?: string }).accessToken, "token-A");
  });

  test("REQUIRES_RECONNECT transition on permanent failure (400)", async (t) => {
    const brandId = "brand-reconnect";
    const brandRecord = {
      id: brandId,
      shopifyShopDomain: "test-shop.myshopify.com",
      shopifyAdminAccessTokenEncrypted: encryptSecret("old-access-token") as string | null,
      shopifyConnectionStatus: "CONNECTED",
      shopifyAuthMode: "EXPIRING_OFFLINE",
      shopifyAccessTokenExpiresAt: new Date(Date.now() - 10000), // expired
      shopifyRefreshTokenEncrypted: encryptSecret("old-refresh-token") as string | null,
      shopifyRefreshTokenExpiresAt: new Date(Date.now() + 1000000),
      shopifyGrantedScopes: "read_products,read_discounts,write_discounts",
      shopifyClientId: "client-id",
      shopifyTokenRefreshLockedUntil: null as Date | null,
      shopifyTokenRefreshLockId: null as string | null,
    };

    t.mock.method(prisma.brand, "findUnique", async () => brandRecord);

    let lockId: string | null = null;
    let markRequiresReconnectCalled = false;

    t.mock.method(prisma.brand, "updateMany", async (args: unknown) => {
      const typedArgs = args as { data: Record<string, unknown> };
      if (typedArgs.data.shopifyTokenRefreshLockId) {
        lockId = typedArgs.data.shopifyTokenRefreshLockId as string;
        brandRecord.shopifyTokenRefreshLockedUntil = typedArgs.data.shopifyTokenRefreshLockedUntil as Date;
        brandRecord.shopifyTokenRefreshLockId = lockId;
        return { count: 1 };
      }
      if (typedArgs.data.shopifyConnectionStatus === "REQUIRES_RECONNECT") {
        markRequiresReconnectCalled = true;
        brandRecord.shopifyConnectionStatus = "REQUIRES_RECONNECT";
        brandRecord.shopifyAdminAccessTokenEncrypted = null;
        brandRecord.shopifyRefreshTokenEncrypted = null;
        return { count: 1 };
      }
      return { count: 0 };
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

  test("point checks: returns 409 when user has insufficient points", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });

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

  test("stuck redemption status refresh is derived as USED", async (t) => {
    setupMocks({ user: { id: "user-123", role: "USER" } });

    t.mock.method(prisma.shopifyRewardRedemption, "findFirst", async () => ({
      id: "redemption-refresh",
      userId: "user-123",
      brandId: "brand-123",
      shopifyDiscountNodeId: "gid://shopify/DiscountCodeNode/123",
      status: "ISSUED",
      code: "TEST-CODE-REFRESH",
      brand: {
        shopifyShopDomain: "test-shop.myshopify.com",
        shopifyAdminAccessTokenEncrypted: encryptSecret("token-123"),
        shopifyConnectionStatus: "CONNECTED",
      },
    }));

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
