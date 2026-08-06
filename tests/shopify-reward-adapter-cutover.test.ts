/**
 * tests/shopify-reward-adapter-cutover.test.ts
 *
 * Coverage for the Shopify reward-redeem discount-issuance cutover
 * (src/app/api/rewards/shopify/redeem/route.ts): discount issuance now
 * routes through the provider-neutral CommerceAdapter registry when a real
 * `CommerceConnection.id` is available (`summary.id !== null`), and falls
 * back to the legacy direct `createShopifyRewardDiscountCode` call
 * otherwise — both funneling into the exact same `DiscountCreationOutcome`
 * shape (see route.ts's own header comment for the contract).
 *
 * Two layers of test:
 *  - UNIT tests exercise `issueDiscountViaAdapter` / `buildCreateDiscountInput`
 *    / `buildIssuedRedemptionData` / `buildRefundedDiscountFailureData`
 *    directly — no DB, no HTTP request, no session. These prove the
 *    error-mapping contract and the "byte-identical outcome shape" claim at
 *    the narrowest possible scope.
 *  - END-TO-END tests drive `redeemImpl` through a fully mocked `prisma`
 *    singleton (the same dependency-injection idiom
 *    tests/integration-coverage.test.ts uses) plus injected
 *    `commerceDepsOverrides`, proving the whole request/response/refund
 *    behavior for both paths.
 *
 * No test in this file opens a real DB connection or makes a real network
 * call — DATABASE_URL is pinned to the deliberately-unreachable blocked
 * placeholder (see src/lib/db-safety.ts), and every Shopify Admin API call
 * goes through a stubbed `globalThis.fetch` or a fully injected fake
 * CommerceAdapter.
 */
process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.SHOPIFY_API_KEY = "test-api-key";
process.env.SHOPIFY_API_SECRET = "test-api-secret";
process.env.APP_ENCRYPTION_KEY = "dummy-encryption-key-at-least-32-chars-long";

import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

import { CommerceProvider } from "@prisma/client";

import { encryptSecret } from "../src/lib/crypto";
import { createShopifyRewardDiscountCode } from "../src/lib/shopify-discounts";
import { ShopifyCommerceAdapter } from "../src/lib/commerce/providers/shopify-commerce-adapter";
import {
  createCommerceAdapterRegistry,
  type CommerceAdapterRegistry,
} from "../src/lib/commerce/registry";
import { defaultCommerceAdapterRegistry } from "../src/lib/commerce/default-registry";
import {
  CommerceConnectionNotFoundError,
  CommerceProviderApiError,
} from "../src/lib/commerce/errors";
import type { CommerceAdapter } from "../src/lib/commerce/adapter";
import type {
  CommerceCapabilities,
  CommerceConnectionSummary,
  CreateDiscountInput,
  ProviderDiscount,
} from "../src/lib/commerce/types";
import type { AuthResolvers, CustomSession } from "../src/lib/auth-session";
// Type-only import: erased at compile time, so this does NOT trigger route.ts
// (and transitively @/lib/prisma) to evaluate before DATABASE_URL is set
// above. The runtime bindings are obtained via dynamic `import()` in
// `before()`, exactly like tests/integration-coverage.test.ts does.
import type {
  DiscountCreationOutcome,
  ShopifyRewardRedeemCommerceDeps,
} from "../src/app/api/rewards/shopify/redeem/route";

// ---------------------------------------------------------------------------
// Runtime bindings resolved in before() (see the type-only import note above)
// ---------------------------------------------------------------------------

let redeemImpl: (
  req: NextRequest,
  deps: AuthResolvers,
  commerceDepsOverrides?: Partial<ShopifyRewardRedeemCommerceDeps>,
) => Promise<Response>;
let issueDiscountViaAdapter: (
  registry: CommerceAdapterRegistry,
  connectionId: string,
  provider: CommerceProvider,
  preResolvedAccessToken: string,
  input: CreateDiscountInput,
) => Promise<DiscountCreationOutcome>;
let buildCreateDiscountInput: (
  discountConfig: Parameters<
    typeof import("../src/app/api/rewards/shopify/redeem/route").buildCreateDiscountInput
  >[0],
  code: string,
  issuedAt: Date,
) => CreateDiscountInput;
let buildIssuedRedemptionData: (
  discount: Extract<DiscountCreationOutcome, { ok: true }>,
) => Record<string, unknown>;
let buildRefundedDiscountFailureData: (
  discount: Extract<DiscountCreationOutcome, { ok: false }>,
) => Record<string, unknown>;

interface MockedPrismaClient {
  brand: Record<string, (...args: unknown[]) => unknown>;
  brandRewardOffer: Record<string, (...args: unknown[]) => unknown>;
  campaign: Record<string, (...args: unknown[]) => unknown>;
  user: Record<string, (...args: unknown[]) => unknown>;
  shopifyRewardRedemption: Record<string, (...args: unknown[]) => unknown>;
  pointTransaction: Record<string, (...args: unknown[]) => unknown>;
  userPointAccount: Record<string, (...args: unknown[]) => unknown>;
  commerceConnection: Record<string, (...args: unknown[]) => unknown>;
  $transaction: (...args: unknown[]) => unknown;
}

let prisma: MockedPrismaClient;

let currentDeps: AuthResolvers = {
  resolveSession: async () => null,
  resolveBrandAdminContext: async () => null,
};

const redeemPOST = (req: NextRequest, overrides?: Partial<ShopifyRewardRedeemCommerceDeps>) =>
  redeemImpl(req, currentDeps, overrides);

function setupSession(userId: string) {
  currentDeps = {
    resolveSession: async () =>
      ({ user: { id: userId, role: "USER" } }) as unknown as CustomSession,
    resolveBrandAdminContext: async () => null,
  };
}

function clearSession() {
  currentDeps = {
    resolveSession: async () => null,
    resolveBrandAdminContext: async () => null,
  };
}

before(async () => {
  const prismaModule = (await import("../src/lib/prisma")).default as unknown as Record<
    string,
    unknown
  >;

  const stub = (model: string, method: string) => async () => {
    throw new Error(
      `Unexpected call to prisma.${model}.${method} in tests/shopify-reward-adapter-cutover.test.ts — mock it explicitly.`,
    );
  };

  for (const model of ["brand", "brandRewardOffer", "campaign", "user", "shopifyRewardRedemption", "commerceConnection"]) {
    prismaModule[model] = {
      findUnique: stub(model, "findUnique"),
      findUniqueOrThrow: stub(model, "findUniqueOrThrow"),
      findMany: stub(model, "findMany"),
      create: stub(model, "create"),
      update: stub(model, "update"),
      count: async () => 0,
    };
  }

  prismaModule.$transaction = (arg: unknown) => {
    if (typeof arg === "function") {
      return (arg as (tx: unknown) => unknown)(prismaModule);
    }
    if (Array.isArray(arg)) {
      return Promise.all(arg);
    }
    return Promise.resolve(null);
  };

  // Safe, always-succeeding defaults for the point ledger — individual
  // tests override with t.mock.method only when asserting on a refund.
  prismaModule.userPointAccount = {
    findUnique: async () => ({
      userId: "user-1",
      spendablePoints: 1_000_000,
      lifetimeEarnedPoints: 1_000_000,
      lifetimeSpentPoints: 0,
      lifetimeRefundedPoints: 0,
      version: 0,
    }),
    updateMany: async () => ({ count: 1 }),
    update: async () => ({}),
  };
  prismaModule.pointTransaction = {
    findUnique: async () => null,
    create: async () => ({ id: "pt-default" }),
  };

  prisma = prismaModule as unknown as MockedPrismaClient;

  const route = await import("../src/app/api/rewards/shopify/redeem/route");
  redeemImpl = route.redeemImpl;
  issueDiscountViaAdapter = route.issueDiscountViaAdapter;
  buildCreateDiscountInput = route.buildCreateDiscountInput;
  buildIssuedRedemptionData = route.buildIssuedRedemptionData as typeof buildIssuedRedemptionData;
  buildRefundedDiscountFailureData =
    route.buildRefundedDiscountFailureData as typeof buildRefundedDiscountFailureData;
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function makeJsonRequest(url: string, body: unknown): NextRequest {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  return new NextRequest(url, { method: "POST", headers, body: JSON.stringify(body) });
}

const SHOP_DOMAIN = "test-shop.myshopify.com";

function defaultOffer(overrides: Record<string, unknown> = {}) {
  return {
    id: "offer-1",
    brandId: "brand-1",
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
      id: "brand-1",
      name: "Brand Test",
      shopifyShopDomain: SHOP_DOMAIN,
      shopifyAdminAccessTokenEncrypted: encryptSecret("token-abc"),
      shopifyConnectionStatus: "CONNECTED",
      shopifyCurrencyCode: "USD",
    },
    products: [],
    ...overrides,
  };
}

function connectedBrandRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "brand-1",
    shopifyShopDomain: SHOP_DOMAIN,
    shopifyAdminAccessTokenEncrypted: encryptSecret("token-abc"),
    shopifyConnectionStatus: "CONNECTED",
    shopifyAuthMode: "LEGACY_OFFLINE",
    shopifyAccessTokenExpiresAt: null,
    shopifyRefreshTokenEncrypted: null,
    shopifyRefreshTokenExpiresAt: null,
    shopifyGrantedScopes: null,
    shopifyClientId: null,
    shopifyTokenRefreshLockedUntil: null,
    shopifyTokenRefreshLockId: null,
    ...overrides,
  };
}

function successfulDiscountFetchResponse() {
  return {
    ok: true,
    json: async () => ({
      data: {
        discountCodeBasicCreate: {
          // Deliberately omits `codeDiscount.startsAt`/`endsAt` — Shopify's
          // response always echoes back the requested values (see
          // src/lib/shopify-discounts.ts), so leaving them out here makes
          // createShopifyRewardDiscountCode fall back to the exact
          // caller-supplied `startsAt`/computed `endsAt`, keeping the
          // response deterministic (no wall-clock dependency) regardless of
          // which of two calls in the same test ran first.
          codeDiscountNode: { id: "gid://shopify/DiscountCodeNode/1" },
          userErrors: [],
        },
      },
    }),
  } as Response;
}

function failedDiscountFetchResponse(message = "Some Shopify error") {
  return {
    ok: true,
    json: async () => ({
      data: {
        discountCodeBasicCreate: {
          codeDiscountNode: null,
          userErrors: [{ message, field: [] }],
        },
      },
    }),
  } as Response;
}

/** Wires shopifyRewardRedemption.findUnique/create/update for a full redeemImpl run. Returns the captured `update` data payloads in call order. */
function wireRedemption(
  t: import("node:test").TestContext,
  row: {
    id: string;
    code: string;
    offerId: string;
    pointsCost: number;
    discountType: string;
    discountAmountCents: number | null;
    discountPercentageBasisPoints: number | null;
    currencyCode: string;
  },
): Array<Record<string, unknown>> {
  const updateCalls: Array<Record<string, unknown>> = [];

  t.mock.method(prisma.shopifyRewardRedemption, "findUnique", async (args: unknown) => {
    const typedArgs = args as { where?: { id?: string } };
    if (typedArgs?.where?.id) {
      // Status-check read inside the refund transaction.
      return { status: "POINTS_DEBITED" };
    }
    // Idempotency pre-check — no existing row.
    return null;
  });

  t.mock.method(prisma.shopifyRewardRedemption, "create", async () => ({
    id: row.id,
    userId: "user-1",
    brandId: "brand-1",
    offerId: row.offerId,
    code: row.code,
    status: "PENDING",
    pointsCost: row.pointsCost,
    discountType: row.discountType,
    discountAmountCents: row.discountAmountCents,
    discountPercentageBasisPoints: row.discountPercentageBasisPoints,
    currencyCode: row.currencyCode,
  }));

  t.mock.method(prisma.shopifyRewardRedemption, "update", async (args: unknown) => {
    const typedArgs = args as { data: Record<string, unknown> };
    updateCalls.push(typedArgs.data);
    return {
      id: row.id,
      code: row.code,
      status: typedArgs.data.status ?? "ISSUED",
      pointsCost: row.pointsCost,
      discountType: row.discountType,
      discountAmountCents: row.discountAmountCents,
      discountPercentageBasisPoints: row.discountPercentageBasisPoints,
      currencyCode: row.currencyCode,
      issuedAt: typedArgs.data.issuedAt ?? null,
      expiresAt: typedArgs.data.expiresAt ?? null,
      usedAt: null,
      errorMessage: typedArgs.data.errorMessage ?? null,
    };
  });

  return updateCalls;
}

function makeConnectionSummary(
  overrides: Partial<CommerceConnectionSummary> = {},
): CommerceConnectionSummary {
  return {
    id: "conn-1",
    brandId: "brand-1",
    provider: CommerceProvider.SHOPIFY,
    status: "CONNECTED",
    displayName: "test-shop",
    externalAccountId: SHOP_DOMAIN,
    storefrontUrl: `https://${SHOP_DOMAIN}`,
    isPrimary: true,
    grantedScopes: [],
    installedAt: null,
    uninstalledAt: null,
    lastProductSyncAt: null,
    isLegacyFallback: false,
    ...overrides,
  };
}

/** A fake CommerceAdapter with every method throwing unless overridden — same "loud on unexpected call" idiom as tests/shopify-commerce-adapter.test.ts. */
function makeFakeAdapter(overrides: Partial<CommerceAdapter> = {}): CommerceAdapter {
  const capabilities: CommerceCapabilities = {
    canSyncProducts: false,
    canCreateDiscount: true,
    canRevokeDiscount: false,
    canVerifyWebhooks: false,
  };
  return {
    provider: CommerceProvider.SHOPIFY,
    getCapabilities: () => capabilities,
    getConnection: async () => {
      throw new Error("getConnection not stubbed for this test");
    },
    syncProducts: async () => {
      throw new Error("syncProducts not stubbed for this test");
    },
    createDiscount: async () => {
      throw new Error("createDiscount not stubbed for this test");
    },
    ...overrides,
  };
}

// ===========================================================================
// UNIT: issueDiscountViaAdapter / buildCreateDiscountInput /
// buildIssuedRedemptionData / buildRefundedDiscountFailureData
// No DB, no HTTP request, no session — pure exercise of the cutover contract.
// ===========================================================================

describe("Shopify reward adapter cutover — unit contract", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("adapter path (real ShopifyCommerceAdapter) and legacy path persist byte-identical data for the same Shopify response", async () => {
    globalThis.fetch = (async () => successfulDiscountFetchResponse()) as typeof fetch;

    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    const discountConfig = {
      brandName: "Brand Test",
      title: "10% Off",
      codeValidDays: 7,
      discountType: "PERCENTAGE" as const,
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      appliesTo: "ALL_PRODUCTS" as const,
      shopifyProductGids: [] as string[],
      minimumSubtotalCents: null,
    };

    const legacyOutcome = await createShopifyRewardDiscountCode({
      shopDomain: SHOP_DOMAIN,
      accessToken: "token-abc",
      title: `${discountConfig.brandName} - ${discountConfig.title}`,
      code: "TEST-CODE-1",
      issuedAt,
      codeValidDays: discountConfig.codeValidDays,
      discountType: discountConfig.discountType,
      discountAmountCents: discountConfig.discountAmountCents,
      discountPercentageBasisPoints: discountConfig.discountPercentageBasisPoints,
      appliesTo: discountConfig.appliesTo,
      shopifyProductGids: discountConfig.shopifyProductGids,
      minimumSubtotalCents: discountConfig.minimumSubtotalCents,
    });
    assert.equal(legacyOutcome.ok, true);

    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        new ShopifyCommerceAdapter({
          loadConnection: async () => ({
            id: "conn-1",
            brandId: "brand-1",
            provider: CommerceProvider.SHOPIFY,
            status: "CONNECTED",
            displayName: "test-shop",
            externalAccountId: SHOP_DOMAIN,
            storefrontUrl: null,
            isPrimary: true,
            grantedScopes: null,
            installedAt: null,
            uninstalledAt: null,
            lastProductSyncAt: null,
          }),
        }),
    });

    const adapterOutcome = await issueDiscountViaAdapter(
      registry,
      "conn-1",
      CommerceProvider.SHOPIFY,
      "token-abc",
      buildCreateDiscountInput(discountConfig, "TEST-CODE-1", issuedAt),
    );
    assert.equal(adapterOutcome.ok, true);

    const legacyPersisted = buildIssuedRedemptionData(
      legacyOutcome as Extract<DiscountCreationOutcome, { ok: true }>,
    );
    const adapterPersisted = buildIssuedRedemptionData(
      adapterOutcome as Extract<DiscountCreationOutcome, { ok: true }>,
    );

    assert.deepEqual(adapterPersisted, legacyPersisted);
  });

  test("fixed-amount discount fields are forwarded unchanged through the adapter to Shopify", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return successfulDiscountFetchResponse();
    }) as typeof fetch;

    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    const discountConfig = {
      brandName: "Brand Test",
      title: "$5 Off",
      codeValidDays: 3,
      discountType: "FIXED_AMOUNT" as const,
      discountAmountCents: 500,
      discountPercentageBasisPoints: null,
      appliesTo: "ALL_PRODUCTS" as const,
      shopifyProductGids: [] as string[],
      minimumSubtotalCents: null,
    };

    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        new ShopifyCommerceAdapter({
          loadConnection: async () => ({
            id: "conn-1",
            brandId: "brand-1",
            provider: CommerceProvider.SHOPIFY,
            status: "CONNECTED",
            displayName: "test-shop",
            externalAccountId: SHOP_DOMAIN,
            storefrontUrl: null,
            isPrimary: true,
            grantedScopes: null,
            installedAt: null,
            uninstalledAt: null,
            lastProductSyncAt: null,
          }),
        }),
    });

    const outcome = await issueDiscountViaAdapter(
      registry,
      "conn-1",
      CommerceProvider.SHOPIFY,
      "token-abc",
      buildCreateDiscountInput(discountConfig, "TEST-FIXED", issuedAt),
    );

    assert.equal(outcome.ok, true);
    const variables = (capturedBody as unknown as { variables: { basicCodeDiscount: Record<string, unknown> } }).variables.basicCodeDiscount;
    assert.deepEqual(variables.customerGets, {
      value: { discountAmount: { amount: "5.00", appliesOnEachItem: false } },
      items: { all: true },
    });
    // usageLimit: 1 (single-use) semantics preserved unchanged by the cutover.
    assert.equal(variables.usageLimit, 1);
  });

  test("product targeting: SPECIFIC_PRODUCTS + shopifyProductGids forwards as externalProductIds -> productsToAdd", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return successfulDiscountFetchResponse();
    }) as typeof fetch;

    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    const discountConfig = {
      brandName: "Brand Test",
      title: "10% Off Select Items",
      codeValidDays: 7,
      discountType: "PERCENTAGE" as const,
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      appliesTo: "SPECIFIC_PRODUCTS" as const,
      shopifyProductGids: ["gid://shopify/Product/1", "gid://shopify/Product/2"],
      minimumSubtotalCents: null,
    };

    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        new ShopifyCommerceAdapter({
          loadConnection: async () => ({
            id: "conn-1",
            brandId: "brand-1",
            provider: CommerceProvider.SHOPIFY,
            status: "CONNECTED",
            displayName: "test-shop",
            externalAccountId: SHOP_DOMAIN,
            storefrontUrl: null,
            isPrimary: true,
            grantedScopes: null,
            installedAt: null,
            uninstalledAt: null,
            lastProductSyncAt: null,
          }),
        }),
    });

    const input = buildCreateDiscountInput(discountConfig, "TEST-PRODUCTS", issuedAt);
    assert.deepEqual(input.externalProductIds, discountConfig.shopifyProductGids);

    const outcome = await issueDiscountViaAdapter(
      registry,
      "conn-1",
      CommerceProvider.SHOPIFY,
      "token-abc",
      input,
    );
    assert.equal(outcome.ok, true);

    const variables = (capturedBody as unknown as { variables: { basicCodeDiscount: Record<string, unknown> } }).variables.basicCodeDiscount;
    assert.deepEqual(variables.customerGets, {
      value: { percentage: 0.1 },
      items: { products: { productsToAdd: discountConfig.shopifyProductGids } },
    });
  });

  test("minimum-subtotal is forwarded as a subtotal >= requirement", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return successfulDiscountFetchResponse();
    }) as typeof fetch;

    const issuedAt = new Date("2026-01-01T00:00:00.000Z");
    const discountConfig = {
      brandName: "Brand Test",
      title: "$5 Off $50+",
      codeValidDays: 7,
      discountType: "FIXED_AMOUNT" as const,
      discountAmountCents: 500,
      discountPercentageBasisPoints: null,
      appliesTo: "ALL_PRODUCTS" as const,
      shopifyProductGids: [] as string[],
      minimumSubtotalCents: 5000,
    };

    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        new ShopifyCommerceAdapter({
          loadConnection: async () => ({
            id: "conn-1",
            brandId: "brand-1",
            provider: CommerceProvider.SHOPIFY,
            status: "CONNECTED",
            displayName: "test-shop",
            externalAccountId: SHOP_DOMAIN,
            storefrontUrl: null,
            isPrimary: true,
            grantedScopes: null,
            installedAt: null,
            uninstalledAt: null,
            lastProductSyncAt: null,
          }),
        }),
    });

    const outcome = await issueDiscountViaAdapter(
      registry,
      "conn-1",
      CommerceProvider.SHOPIFY,
      "token-abc",
      buildCreateDiscountInput(discountConfig, "TEST-MIN-SUBTOTAL", issuedAt),
    );
    assert.equal(outcome.ok, true);

    const variables = (capturedBody as unknown as { variables: { basicCodeDiscount: Record<string, unknown> } }).variables.basicCodeDiscount;
    assert.deepEqual(variables.minimumRequirement, {
      subtotal: { greaterThanOrEqualToSubtotal: "50.00" },
    });
  });

  test("CommerceProviderApiError -> ok:false with the provider's httpStatus/message/userErrors carried through", async () => {
    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        makeFakeAdapter({
          createDiscount: async () => {
            throw new CommerceProviderApiError(
              CommerceProvider.SHOPIFY,
              "Shopify said no.",
              undefined,
              502,
              [{ message: "Shopify said no.", field: [] }],
            );
          },
        }),
    });

    const outcome = await issueDiscountViaAdapter(
      registry,
      "conn-1",
      CommerceProvider.SHOPIFY,
      "token-abc",
      buildCreateDiscountInput(
        {
          brandName: "Brand",
          title: "X",
          codeValidDays: 7,
          discountType: "PERCENTAGE",
          discountAmountCents: null,
          discountPercentageBasisPoints: 1000,
          appliesTo: "ALL_PRODUCTS",
          shopifyProductGids: [],
          minimumSubtotalCents: null,
        },
        "CODE",
        new Date(),
      ),
    );

    assert.deepEqual(outcome, {
      ok: false,
      status: 502,
      error: "Shopify said no.",
      userErrors: [{ message: "Shopify said no.", field: [] }],
    });
    // Confirms the refund-path persisted shape matches today's contract too.
    assert.deepEqual(
      buildRefundedDiscountFailureData(outcome as Extract<DiscountCreationOutcome, { ok: false }>),
      {
        status: "REFUNDED",
        errorMessage: "Shopify said no.",
        shopifyUserErrors: [{ message: "Shopify said no.", field: [] }],
      },
    );
  });

  test("CommerceProviderApiError with no httpStatus defaults to 502", async () => {
    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        makeFakeAdapter({
          createDiscount: async () => {
            throw new CommerceProviderApiError(CommerceProvider.SHOPIFY, "No status given.");
          },
        }),
    });

    const outcome = await issueDiscountViaAdapter(
      registry,
      "conn-1",
      CommerceProvider.SHOPIFY,
      "token-abc",
      buildCreateDiscountInput(
        {
          brandName: "Brand",
          title: "X",
          codeValidDays: 7,
          discountType: "PERCENTAGE",
          discountAmountCents: null,
          discountPercentageBasisPoints: 1000,
          appliesTo: "ALL_PRODUCTS",
          shopifyProductGids: [],
          minimumSubtotalCents: null,
        },
        "CODE",
        new Date(),
      ),
    );

    assert.equal(outcome.ok, false);
    assert.equal((outcome as { status: number }).status, 502);
  });

  test("CommerceConnectionNotFoundError -> ok:false, status 502", async () => {
    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        makeFakeAdapter({
          createDiscount: async () => {
            throw new CommerceConnectionNotFoundError("conn-missing");
          },
        }),
    });

    const outcome = await issueDiscountViaAdapter(
      registry,
      "conn-missing",
      CommerceProvider.SHOPIFY,
      "token-abc",
      buildCreateDiscountInput(
        {
          brandName: "Brand",
          title: "X",
          codeValidDays: 7,
          discountType: "PERCENTAGE",
          discountAmountCents: null,
          discountPercentageBasisPoints: 1000,
          appliesTo: "ALL_PRODUCTS",
          shopifyProductGids: [],
          minimumSubtotalCents: null,
        },
        "CODE",
        new Date(),
      ),
    );

    assert.equal(outcome.ok, false);
    assert.equal((outcome as { status: number }).status, 502);
  });

  test("canCreateDiscount:false -> UnsupportedCapabilityError -> ok:false, status 502 (fails safe, never calls createDiscount)", async () => {
    let createDiscountCalled = false;
    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        makeFakeAdapter({
          getCapabilities: () => ({
            canSyncProducts: false,
            canCreateDiscount: false,
            canRevokeDiscount: false,
            canVerifyWebhooks: false,
          }),
          createDiscount: async () => {
            createDiscountCalled = true;
            throw new Error("must never be reached");
          },
        }),
    });

    const outcome = await issueDiscountViaAdapter(
      registry,
      "conn-1",
      CommerceProvider.SHOPIFY,
      "token-abc",
      buildCreateDiscountInput(
        {
          brandName: "Brand",
          title: "X",
          codeValidDays: 7,
          discountType: "PERCENTAGE",
          discountAmountCents: null,
          discountPercentageBasisPoints: 1000,
          appliesTo: "ALL_PRODUCTS",
          shopifyProductGids: [],
          minimumSubtotalCents: null,
        },
        "CODE",
        new Date(),
      ),
    );

    assert.equal(createDiscountCalled, false);
    assert.equal(outcome.ok, false);
    assert.equal((outcome as { status: number }).status, 502);
    assert.ok(outcome.ok === false && outcome.error.includes("createDiscount"));
  });

  test("provider selection goes through the registry, not a hard-coded adapter (a custom registry's adapter is the one invoked)", async () => {
    let sentinelCalled = false;
    const sentinelDiscount: ProviderDiscount = {
      externalDiscountId: "gid://shopify/DiscountCodeNode/sentinel",
      code: "SENTINEL",
      expiresAt: null,
    };
    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        makeFakeAdapter({
          createDiscount: async () => {
            sentinelCalled = true;
            return sentinelDiscount;
          },
        }),
    });

    const outcome = await issueDiscountViaAdapter(
      registry,
      "conn-1",
      CommerceProvider.SHOPIFY,
      "token-abc",
      buildCreateDiscountInput(
        {
          brandName: "Brand",
          title: "X",
          codeValidDays: 7,
          discountType: "PERCENTAGE",
          discountAmountCents: null,
          discountPercentageBasisPoints: 1000,
          appliesTo: "ALL_PRODUCTS",
          shopifyProductGids: [],
          minimumSubtotalCents: null,
        },
        "CODE",
        new Date(),
      ),
    );

    assert.ok(sentinelCalled, "the registry-resolved fake adapter, not a hard-coded one, was invoked");
    assert.equal(outcome.ok, true);
    assert.ok(outcome.ok === true && outcome.discountNodeId === sentinelDiscount.externalDiscountId);
  });

  test("COMMERCE7 has no registered adapter (defaultCommerceAdapterRegistry) -> UnsupportedProviderError -> ok:false 502, and no network call is ever made", async () => {
    let fetchCalled = false;
    const originalGlobalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("must never be called for an unsupported provider");
    }) as typeof fetch;

    try {
      const outcome = await issueDiscountViaAdapter(
        defaultCommerceAdapterRegistry,
        "conn-1",
        CommerceProvider.COMMERCE7,
        "token-abc",
        buildCreateDiscountInput(
          {
            brandName: "Brand",
            title: "X",
            codeValidDays: 7,
            discountType: "PERCENTAGE",
            discountAmountCents: null,
            discountPercentageBasisPoints: 1000,
            appliesTo: "ALL_PRODUCTS",
            shopifyProductGids: [],
            minimumSubtotalCents: null,
          },
          "CODE",
          new Date(),
        ),
      );

      assert.equal(outcome.ok, false);
      assert.equal((outcome as { status: number }).status, 502);
      assert.equal(fetchCalled, false, "COMMERCE7 has no adapter — this must never reach the network");
    } finally {
      globalThis.fetch = originalGlobalFetch;
    }
  });
});

// ===========================================================================
// END-TO-END: redeemImpl, full mocked prisma + auth harness
// ===========================================================================

describe("Shopify reward adapter cutover — end-to-end redeem route", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearSession();
  });

  test("legacy path (no CommerceConnection.id, default deps) issues a discount exactly as before the cutover", async (t) => {
    setupSession("user-1");
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => defaultOffer());
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-1",
      brandId: "brand-1",
      unlocks: [{ id: "unlock-1" }],
    }));
    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-1" }));
    t.mock.method(prisma.brand, "findUnique", async () => connectedBrandRow());
    t.mock.method(prisma.commerceConnection, "findMany", async () => []);
    const updateCalls = wireRedemption(t, {
      id: "redemption-legacy",
      code: "TEST-LEGACY",
      offerId: "offer-1",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
    });

    globalThis.fetch = (async () => successfulDiscountFetchResponse()) as typeof fetch;

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-1",
      idempotencyKey: "idem-legacy",
      campaignId: "campaign-1",
    });

    const res = await redeemPOST(req);
    assert.equal(res.status, 200);
    const json = (await res.json()) as { data: { status: string } };
    assert.equal(json.data.status, "ISSUED");
    assert.ok(updateCalls.some((call) => call.status === "ISSUED"));
  });

  test("legacy path Shopify failure -> refund + REFUNDED + 502, unaffected by the cutover", async (t) => {
    setupSession("user-1");
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => defaultOffer());
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-1",
      brandId: "brand-1",
      unlocks: [{ id: "unlock-1" }],
    }));
    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-1" }));
    t.mock.method(prisma.brand, "findUnique", async () => connectedBrandRow());
    t.mock.method(prisma.commerceConnection, "findMany", async () => []);
    const updateCalls = wireRedemption(t, {
      id: "redemption-legacy-fail",
      code: "TEST-LEGACY-FAIL",
      offerId: "offer-1",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
    });

    let pointsRefunded = false;
    t.mock.method(prisma.userPointAccount, "update", async () => {
      pointsRefunded = true;
      return {};
    });

    globalThis.fetch = (async () => failedDiscountFetchResponse("Legacy Shopify error")) as typeof fetch;

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-1",
      idempotencyKey: "idem-legacy-fail",
      campaignId: "campaign-1",
    });

    const res = await redeemPOST(req);
    assert.equal(res.status, 502);
    const json = (await res.json()) as { error: string; data: { status: string } };
    assert.equal(json.error, "Could not create the Shopify discount code. Points were refunded.");
    assert.equal(json.data.status, "REFUNDED");
    assert.ok(pointsRefunded);
    assert.ok(updateCalls.some((call) => call.status === "REFUNDED"));
  });

  test("adapter path (summary.id set, injected registry) issues via the adapter, never touching the legacy fetch call", async (t) => {
    setupSession("user-1");
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => defaultOffer());
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-1",
      brandId: "brand-1",
      unlocks: [{ id: "unlock-1" }],
    }));
    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-1" }));
    t.mock.method(prisma.brand, "findUnique", async () => connectedBrandRow());
    const updateCalls = wireRedemption(t, {
      id: "redemption-adapter",
      code: "TEST-ADAPTER",
      offerId: "offer-1",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
    });

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("legacy path must not be reached when summary.id is set");
    }) as typeof fetch;

    let adapterCalled = false;
    let receivedPreResolvedToken: string | undefined;
    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        makeFakeAdapter({
          createDiscount: async (_connectionId, _input, options) => {
            adapterCalled = true;
            receivedPreResolvedToken = options?.preResolvedAccessToken;
            return {
              externalDiscountId: "gid://shopify/DiscountCodeNode/adapter",
              code: "TEST-ADAPTER",
              expiresAt: new Date("2026-02-01T00:00:00.000Z"),
            };
          },
        }),
    });

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-1",
      idempotencyKey: "idem-adapter",
      campaignId: "campaign-1",
    });

    const res = await redeemPOST(req, {
      getConnectionSummary: async () => makeConnectionSummary(),
      registry,
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as { data: { status: string } };
    assert.equal(json.data.status, "ISSUED");
    assert.ok(adapterCalled, "the injected adapter must have been invoked");
    assert.equal(fetchCalled, false, "the legacy direct-fetch path must not run when the adapter path is taken");
    assert.equal(receivedPreResolvedToken, "token-abc", "the adapter must receive the route's already-resolved token");
    assert.ok(updateCalls.some((call) => call.status === "ISSUED"));
  });

  test("adapter error -> points refunded, status REFUNDED, and the exact 502 response the legacy path would have produced", async (t) => {
    setupSession("user-1");
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => defaultOffer());
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-1",
      brandId: "brand-1",
      unlocks: [{ id: "unlock-1" }],
    }));
    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-1" }));
    t.mock.method(prisma.brand, "findUnique", async () => connectedBrandRow());
    const updateCalls = wireRedemption(t, {
      id: "redemption-adapter-fail",
      code: "TEST-ADAPTER-FAIL",
      offerId: "offer-1",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
    });

    let pointsRefunded = false;
    t.mock.method(prisma.userPointAccount, "update", async () => {
      pointsRefunded = true;
      return {};
    });

    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        makeFakeAdapter({
          createDiscount: async () => {
            throw new CommerceProviderApiError(
              CommerceProvider.SHOPIFY,
              "Adapter-side Shopify failure.",
              undefined,
              502,
              [{ message: "Adapter-side Shopify failure.", field: [] }],
            );
          },
        }),
    });

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-1",
      idempotencyKey: "idem-adapter-fail",
      campaignId: "campaign-1",
    });

    const res = await redeemPOST(req, {
      getConnectionSummary: async () => makeConnectionSummary(),
      registry,
    });

    assert.equal(res.status, 502);
    const json = (await res.json()) as { error: string; data: { status: string } };
    assert.equal(json.error, "Could not create the Shopify discount code. Points were refunded.");
    assert.equal(json.data.status, "REFUNDED");
    assert.ok(pointsRefunded);
    assert.ok(updateCalls.some((call) => call.status === "REFUNDED"));
  });

  test("canCreateDiscount:false end-to-end -> fails safely with a refund, never calls the fake adapter's createDiscount", async (t) => {
    setupSession("user-1");
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => defaultOffer());
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-1",
      brandId: "brand-1",
      unlocks: [{ id: "unlock-1" }],
    }));
    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-1" }));
    t.mock.method(prisma.brand, "findUnique", async () => connectedBrandRow());
    wireRedemption(t, {
      id: "redemption-no-capability",
      code: "TEST-NO-CAP",
      offerId: "offer-1",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
    });

    let pointsRefunded = false;
    t.mock.method(prisma.userPointAccount, "update", async () => {
      pointsRefunded = true;
      return {};
    });

    let createDiscountCalled = false;
    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        makeFakeAdapter({
          getCapabilities: () => ({
            canSyncProducts: false,
            canCreateDiscount: false,
            canRevokeDiscount: false,
            canVerifyWebhooks: false,
          }),
          createDiscount: async () => {
            createDiscountCalled = true;
            throw new Error("must never be reached");
          },
        }),
    });

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-1",
      idempotencyKey: "idem-no-cap",
      campaignId: "campaign-1",
    });

    const res = await redeemPOST(req, {
      getConnectionSummary: async () => makeConnectionSummary(),
      registry,
    });

    assert.equal(res.status, 502);
    assert.equal(createDiscountCalled, false);
    assert.ok(pointsRefunded);
    const json = (await res.json()) as { data: { status: string } };
    assert.equal(json.data.status, "REFUNDED");
  });

  test("token unavailable (NOT_CONNECTED) -> identical refund/502 response regardless of which discount path would have run", async (t) => {
    setupSession("user-1");
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => defaultOffer());
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-1",
      brandId: "brand-1",
      unlocks: [{ id: "unlock-1" }],
    }));
    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-1" }));
    // getValidAccessToken's own reload sees no brand at all -> NOT_CONNECTED,
    // which must be caught BEFORE either discount-issuance path runs.
    t.mock.method(prisma.brand, "findUnique", async () => null);
    const updateCalls = wireRedemption(t, {
      id: "redemption-token-fail",
      code: "TEST-TOKEN-FAIL",
      offerId: "offer-1",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
    });

    let pointsRefunded = false;
    t.mock.method(prisma.userPointAccount, "update", async () => {
      pointsRefunded = true;
      return {};
    });

    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      throw new Error("must never reach Shopify when the token itself is unavailable");
    }) as typeof fetch;

    let mirrorCalled = false;
    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-1",
      idempotencyKey: "idem-token-fail",
      campaignId: "campaign-1",
    });

    const res = await redeemPOST(req, {
      getConnectionSummary: async () => {
        mirrorCalled = true;
        return makeConnectionSummary();
      },
    });

    assert.equal(res.status, 502);
    const json = (await res.json()) as { error: string; data: { status: string } };
    assert.equal(json.error, "Could not create the Shopify discount code. Points were refunded.");
    assert.equal(json.data.status, "REFUNDED");
    assert.ok(pointsRefunded);
    assert.equal(fetchCalled, false);
    assert.equal(mirrorCalled, false, "the commerce-connection mirror must not even be consulted once the token resolution itself has failed");
    assert.ok(updateCalls.some((call) => call.status === "REFUNDED"));
  });

  test("idempotency is unchanged by the cutover: a repeated request with the same key returns the cached redemption without a second discount call", async (t) => {
    setupSession("user-1");
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => defaultOffer());
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-1",
      brandId: "brand-1",
      unlocks: [{ id: "unlock-1" }],
    }));
    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-1" }));
    t.mock.method(prisma.brand, "findUnique", async () => connectedBrandRow());

    let existingRow: Record<string, unknown> | null = null;
    t.mock.method(prisma.shopifyRewardRedemption, "findUnique", async (args: unknown) => {
      const typedArgs = args as { where?: { idempotencyKey?: string; id?: string } };
      if (typedArgs?.where?.id) {
        return { status: "POINTS_DEBITED" };
      }
      return existingRow;
    });
    t.mock.method(prisma.shopifyRewardRedemption, "create", async () => {
      const row = {
        id: "redemption-idem",
        userId: "user-1",
        brandId: "brand-1",
        offerId: "offer-1",
        code: "TEST-IDEM",
        status: "PENDING",
        pointsCost: 50,
        discountType: "PERCENTAGE",
        discountAmountCents: null,
        discountPercentageBasisPoints: 1000,
        currencyCode: "USD",
      };
      existingRow = row;
      return row;
    });
    t.mock.method(prisma.shopifyRewardRedemption, "update", async (args: unknown) => {
      const typedArgs = args as { data: Record<string, unknown> };
      const updated = {
        id: "redemption-idem",
        userId: "user-1",
        offerId: "offer-1",
        code: "TEST-IDEM",
        status: typedArgs.data.status ?? "ISSUED",
        pointsCost: 50,
        discountType: "PERCENTAGE",
        discountAmountCents: null,
        discountPercentageBasisPoints: 1000,
        currencyCode: "USD",
        issuedAt: typedArgs.data.issuedAt ?? null,
        expiresAt: typedArgs.data.expiresAt ?? null,
        usedAt: null,
      };
      existingRow = updated;
      return updated;
    });

    let discountCallCount = 0;
    const registry = createCommerceAdapterRegistry({
      [CommerceProvider.SHOPIFY]: () =>
        makeFakeAdapter({
          createDiscount: async () => {
            discountCallCount += 1;
            return {
              externalDiscountId: "gid://shopify/DiscountCodeNode/idem",
              code: "TEST-IDEM",
              expiresAt: null,
            };
          },
        }),
    });

    const commerceOverrides: Partial<ShopifyRewardRedeemCommerceDeps> = {
      getConnectionSummary: async () => makeConnectionSummary(),
      registry,
    };

    const req1 = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-1",
      idempotencyKey: "idem-repeat",
      campaignId: "campaign-1",
    });
    const res1 = await redeemPOST(req1, commerceOverrides);
    assert.equal(res1.status, 200);
    assert.equal(discountCallCount, 1);

    const req2 = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-1",
      idempotencyKey: "idem-repeat",
      campaignId: "campaign-1",
    });
    const res2 = await redeemPOST(req2, commerceOverrides);
    assert.equal(res2.status, 200);
    // No second discount call — the cached row was returned directly.
    assert.equal(discountCallCount, 1);

    const json1 = (await res1.json()) as { data: { id: string } };
    const json2 = (await res2.json()) as { data: { id: string } };
    assert.equal(json1.data.id, json2.data.id);
  });

  test("Priority-1 property: a throwing commerce-connection mirror lookup still lets the redemption succeed via the legacy fallback", async (t) => {
    setupSession("user-1");
    t.mock.method(prisma.brandRewardOffer, "findUnique", async () => defaultOffer());
    t.mock.method(prisma.campaign, "findUnique", async () => ({
      id: "campaign-1",
      brandId: "brand-1",
      unlocks: [{ id: "unlock-1" }],
    }));
    t.mock.method(prisma.user, "findUnique", async () => ({ id: "user-1" }));
    t.mock.method(prisma.brand, "findUnique", async () => connectedBrandRow());
    const updateCalls = wireRedemption(t, {
      id: "redemption-mirror-throws",
      code: "TEST-MIRROR-THROWS",
      offerId: "offer-1",
      pointsCost: 50,
      discountType: "PERCENTAGE",
      discountAmountCents: null,
      discountPercentageBasisPoints: 1000,
      currencyCode: "USD",
    });

    globalThis.fetch = (async () => successfulDiscountFetchResponse()) as typeof fetch;

    const req = makeJsonRequest("http://localhost/api/rewards/shopify/redeem", {
      offerId: "offer-1",
      idempotencyKey: "idem-mirror-throws",
      campaignId: "campaign-1",
    });

    const res = await redeemPOST(req, {
      getConnectionSummary: async () => {
        throw new Error("simulated CommerceConnection mirror outage (e.g. DB unreachable)");
      },
    });

    assert.equal(res.status, 200);
    const json = (await res.json()) as { data: { status: string } };
    assert.equal(json.data.status, "ISSUED");
    assert.ok(updateCalls.some((call) => call.status === "ISSUED"));
  });
});
