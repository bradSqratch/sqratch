/**
 * src/lib/commerce/providers/shopify-commerce-adapter.ts
 *
 * `ShopifyCommerceAdapter` implements the provider-neutral `CommerceAdapter`
 * interface (see `../adapter.ts`) by WRAPPING the existing, production-
 * tested Shopify services:
 *   - `@/lib/shopify-products`        (fetchNormalizedShopifyProducts)
 *   - `@/lib/shopify-discounts`       (createShopifyRewardDiscountCode)
 *   - `@/lib/shopify-token-manager`   (getValidAccessToken)
 *   - `@/lib/shopify`                 (verifyShopifyWebhookHmac)
 *
 * This is a WRAPPER, not a rewrite: every Shopify API call, token-refresh
 * decision, and discount-code shape is delegated unchanged to the existing
 * services. Nothing in this file talks to the Shopify Admin API directly.
 *
 * TESTABILITY: every external dependency (the DB read/write for
 * `CommerceConnection`, and the four Shopify services above) is injectable
 * via `ShopifyCommerceAdapterDeps`, following the same dependency-injection
 * idiom already used in this repo — see `TokenEndpointFn` in
 * `shopify-token-manager.ts` and `ReconciliationDeps` in
 * `reward-reconciliation.ts`. Tests construct a `ShopifyCommerceAdapter`
 * with fully injected fakes, so no real DB and no real network is needed.
 *
 * LAZY DEFAULTS: the default `loadConnection` / `markProductSync`
 * implementations import `@/lib/prisma` lazily (inside the function body,
 * exactly like `getDb()` in `shopify-token-manager.ts`) so that importing
 * this module — or constructing an adapter with injected deps — never
 * requires `DATABASE_URL` to be set.
 *
 * SECURITY: no method here ever returns, logs, or serializes an access
 * token, refresh token, encrypted payload, or the Shopify webhook secret.
 * `getConnection()` reads only the `CommerceConnection` row —
 * `CommerceConnectionSecret` is never read by this file.
 */

import { CommerceProvider, type CommerceConnectionStatus, type Prisma } from "@prisma/client";
import type { CommerceAdapter } from "../adapter";
import { CommerceConnectionNotFoundError, CommerceProviderApiError } from "../errors";
import type {
  CommerceCapabilities,
  CommerceConnectionResult,
  CommerceConnectionSummary,
  CommerceProduct,
  CommerceWebhookEventType,
  CreateDiscountInput,
  CreateDiscountOptions,
  NormalizedWebhookEvent,
  ProductSyncResult,
  ProviderDiscount,
  WebhookRequestInput,
} from "../types";

import {
  fetchNormalizedShopifyProducts,
  type NormalizedShopifyProduct,
} from "@/lib/shopify-products";
import { createShopifyRewardDiscountCode } from "@/lib/shopify-discounts";
import {
  getValidAccessToken,
  type GetValidAccessTokenResult,
} from "@/lib/shopify-token-manager";
import { verifyShopifyWebhookHmac } from "@/lib/shopify";

// ---------------------------------------------------------------------------
// Types derived from the wrapped services (never redefined by hand, so this
// file cannot silently drift from the services it wraps).
// ---------------------------------------------------------------------------

type FetchProductsInput = Parameters<typeof fetchNormalizedShopifyProducts>[0];
type FetchProductsResult = Awaited<ReturnType<typeof fetchNormalizedShopifyProducts>>;

type CreateDiscountCodeInput = Parameters<typeof createShopifyRewardDiscountCode>[0];
type CreateDiscountCodeResult = Awaited<ReturnType<typeof createShopifyRewardDiscountCode>>;

type VerifyWebhookHmacInput = Parameters<typeof verifyShopifyWebhookHmac>[0];

/** The subset of a `CommerceConnection` row this adapter needs. Never includes `CommerceConnectionSecret`. */
export type ShopifyCommerceConnectionRow = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: CommerceConnectionStatus;
  displayName: string;
  externalAccountId: string;
  storefrontUrl: string | null;
  isPrimary: boolean;
  grantedScopes: Prisma.JsonValue | null;
  installedAt: Date | null;
  uninstalledAt: Date | null;
  lastProductSyncAt: Date | null;
};

/**
 * Injectable dependencies. Every default implementation below delegates to
 * an existing, unmodified Shopify service — see the file header.
 */
export type ShopifyCommerceAdapterDeps = {
  /** Loads a `CommerceConnection` row by id, or `null` if it does not exist. */
  loadConnection(connectionId: string): Promise<ShopifyCommerceConnectionRow | null>;
  /** Resolves a valid Shopify access token for a brand. Defaults to `getValidAccessToken`. */
  getAccessToken(brandId: string): Promise<GetValidAccessTokenResult>;
  /** Fetches the live product catalog. Defaults to `fetchNormalizedShopifyProducts`. */
  fetchProducts(input: FetchProductsInput): Promise<FetchProductsResult>;
  /** Creates a discount code on Shopify. Defaults to `createShopifyRewardDiscountCode`. */
  createDiscountCode(input: CreateDiscountCodeInput): Promise<CreateDiscountCodeResult>;
  /** Verifies a webhook HMAC. Defaults to `verifyShopifyWebhookHmac`. */
  verifyWebhookHmac(input: VerifyWebhookHmacInput): boolean;
  /** Stamps `CommerceConnection.lastProductSyncAt` after a successful sync. */
  markProductSync(connectionId: string, syncedAt: Date): Promise<void>;
};

// ---------------------------------------------------------------------------
// Default dependency implementations (lazy prisma import — see file header)
// ---------------------------------------------------------------------------

async function defaultLoadConnection(
  connectionId: string,
): Promise<ShopifyCommerceConnectionRow | null> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.commerceConnection.findUnique({
    where: { id: connectionId },
    select: {
      id: true,
      brandId: true,
      provider: true,
      status: true,
      displayName: true,
      externalAccountId: true,
      storefrontUrl: true,
      isPrimary: true,
      grantedScopes: true,
      installedAt: true,
      uninstalledAt: true,
      lastProductSyncAt: true,
    },
  });
}

async function defaultMarkProductSync(
  connectionId: string,
  syncedAt: Date,
): Promise<void> {
  const { default: prisma } = await import("@/lib/prisma");
  await prisma.commerceConnection.update({
    where: { id: connectionId },
    data: { lastProductSyncAt: syncedAt },
  });
}

const DEFAULT_DEPS: ShopifyCommerceAdapterDeps = {
  loadConnection: defaultLoadConnection,
  getAccessToken: getValidAccessToken,
  fetchProducts: fetchNormalizedShopifyProducts,
  createDiscountCode: createShopifyRewardDiscountCode,
  verifyWebhookHmac: verifyShopifyWebhookHmac,
  markProductSync: defaultMarkProductSync,
};

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes `CommerceConnection.grantedScopes` (a `Json?` column) to a
 * `string[]`, tolerating both shapes seen in this codebase: the legacy
 * `Brand.shopifyGrantedScopes` column is a comma-separated string, while the
 * new Json column may hold a genuine array. Anything else (null, object,
 * numbers, etc.) normalizes to `[]` rather than throwing.
 */
function normalizeGrantedScopes(raw: Prisma.JsonValue | null | undefined): string[] {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  if (Array.isArray(raw)) {
    return raw.filter(
      (scope): scope is string => typeof scope === "string" && scope.trim().length > 0,
    );
  }

  return [];
}

function toCommerceConnectionSummary(
  row: ShopifyCommerceConnectionRow,
): CommerceConnectionSummary {
  return {
    id: row.id,
    brandId: row.brandId,
    provider: row.provider,
    status: row.status,
    displayName: row.displayName,
    externalAccountId: row.externalAccountId,
    storefrontUrl: row.storefrontUrl,
    isPrimary: row.isPrimary,
    grantedScopes: normalizeGrantedScopes(row.grantedScopes),
    installedAt: row.installedAt,
    uninstalledAt: row.uninstalledAt,
    lastProductSyncAt: row.lastProductSyncAt,
    isLegacyFallback: false,
  };
}

function toCommerceProduct(product: NormalizedShopifyProduct): CommerceProduct {
  return {
    // `product.id` and `product.shopifyProductGid` are always the same
    // value (see `normalizeProduct` in shopify-products.ts, which assigns
    // `String(product.id)` to both) — `externalId` is that single value,
    // and callers needing either the neutral "id" or the Shopify-specific
    // "shopifyProductGid" read it from here.
    externalId: product.shopifyProductGid,
    title: product.title,
    handle: product.handle,
    productUrl: product.productUrl,
    imageUrl: product.imageUrl,
    images: product.images,
    priceText: product.priceText,
    currency: product.currency,
    priceRange: product.priceRange,
    externalVariantIds: product.variantIds,
    descriptionText: product.descriptionText,
    sku: product.sku,
    status: product.status,
    providerCreatedAt: product.providerCreatedAt,
    providerUpdatedAt: product.providerUpdatedAt,
    priceRangeRaw: product.priceRangeRaw,
  };
}

/** Case-insensitive header lookup — inbound webhook headers may arrive in any case. */
function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
): string | null {
  const target = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return headers[key];
    }
  }
  return null;
}

/**
 * Neutral event-type mapping for the webhook topics handled today (see
 * `src/lib/shopify-webhooks.ts` callers under
 * `src/app/api/shopify/webhooks/**`): app/uninstalled + the 3 GDPR/mandatory
 * compliance topics.
 */
const WEBHOOK_TOPIC_MAP: Record<string, CommerceWebhookEventType> = {
  "app/uninstalled": "APP_UNINSTALLED",
  "shop/redact": "ACCOUNT_REDACT",
  "customers/data_request": "CUSTOMER_DATA_REQUEST",
  "customers/redact": "CUSTOMER_REDACT",
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ShopifyCommerceAdapter implements CommerceAdapter {
  readonly provider = CommerceProvider.SHOPIFY;

  private readonly deps: ShopifyCommerceAdapterDeps;

  constructor(deps: Partial<ShopifyCommerceAdapterDeps> = {}) {
    this.deps = { ...DEFAULT_DEPS, ...deps };
  }

  getCapabilities(): CommerceCapabilities {
    return {
      canSyncProducts: true,
      canCreateDiscount: true,
      // No provider call today deactivates/revokes a discount code (there is
      // no discountCodeDeactivate call anywhere in this codebase) — keep
      // this false and omit revokeDiscount below until that exists.
      canRevokeDiscount: false,
      canVerifyWebhooks: true,
    };
  }

  async getConnection(connectionId: string): Promise<CommerceConnectionResult> {
    const row = await this.deps.loadConnection(connectionId);

    if (!row) {
      return { ok: false, reason: "NOT_FOUND" };
    }

    if (row.status !== "CONNECTED") {
      return { ok: false, reason: "NOT_CONNECTED" };
    }

    return { ok: true, connection: toCommerceConnectionSummary(row) };
  }

  async syncProducts(connectionId: string): Promise<ProductSyncResult> {
    const row = await this.deps.loadConnection(connectionId);

    if (!row) {
      throw new CommerceConnectionNotFoundError(connectionId);
    }

    const result = await this.deps.fetchProducts({
      shopDomain: row.externalAccountId,
      brandId: row.brandId,
    });

    if (!result.ok) {
      // `result.error` comes from `fetchNormalizedShopifyProducts`'s ok:false
      // branches, which are either a fixed "not connected"/"needs reconnect"
      // string or a Shopify GraphQL user-error message — never a token.
      // `result.status` is carried through as `httpStatus` so a caller (the
      // brand/shopify/products route) can reproduce the exact status code
      // the direct-fetch path would have returned for the same failure.
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        result.error || "Failed to sync Shopify products.",
        undefined,
        result.status,
      );
    }

    const syncedAt = new Date();
    const products = result.items.map(toCommerceProduct);

    await this.deps.markProductSync(connectionId, syncedAt);

    return {
      connectionId,
      provider: CommerceProvider.SHOPIFY,
      products,
      productCount: products.length,
      syncedAt,
      hasNextPage: result.hasNextPage,
      limit: result.limit,
    };
  }

  async createDiscount(
    connectionId: string,
    input: CreateDiscountInput,
    options?: CreateDiscountOptions,
  ): Promise<ProviderDiscount> {
    const row = await this.deps.loadConnection(connectionId);

    if (!row) {
      throw new CommerceConnectionNotFoundError(connectionId);
    }

    // When the caller has already resolved a valid access token (see
    // `CreateDiscountOptions.preResolvedAccessToken`'s doc comment in
    // `../types.ts`), use it as-is instead of resolving a second one. This
    // is what lets a money-path caller like
    // `src/app/api/rewards/shopify/redeem/route.ts` keep its own
    // `getValidAccessToken` call — and its own NEEDS_RECONNECT/NOT_CONNECTED
    // refund handling — as the ONLY token resolution for a given request,
    // rather than this adapter independently resolving (and potentially
    // re-refreshing) a second one.
    const accessToken = options?.preResolvedAccessToken
      ? options.preResolvedAccessToken
      : this.resolveAccessToken(await this.deps.getAccessToken(row.brandId));

    // Field mapping matches exactly what
    // `src/app/api/rewards/shopify/redeem/route.ts` passes to
    // `createShopifyRewardDiscountCode` today — no additional options, so
    // the existing single-use (usageLimit: 1) semantics are preserved
    // unchanged (that value is hardcoded inside `createShopifyRewardDiscountCode`
    // itself, which this adapter does not touch).
    const result = await this.deps.createDiscountCode({
      shopDomain: row.externalAccountId,
      accessToken,
      title: input.title,
      code: input.code,
      issuedAt: input.issuedAt,
      codeValidDays: input.validDays,
      discountType: input.discountType,
      discountAmountCents: input.discountAmountCents,
      discountPercentageBasisPoints: input.discountPercentageBasisPoints,
      appliesTo: input.appliesTo,
      shopifyProductGids: input.externalProductIds,
      minimumSubtotalCents: input.minimumSubtotalCents,
    });

    if (!result.ok) {
      // `result.error` is a Shopify GraphQL/user-error message — never a
      // token. `result.status` / `result.userErrors` are carried through as
      // `httpStatus` / `details` so a caller (the redeem route) can
      // reproduce the exact status code and persisted diagnostic detail the
      // direct-call path would have produced for the same failure.
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        result.error || "Failed to create Shopify discount code.",
        undefined,
        result.status,
        result.userErrors,
      );
    }

    return {
      externalDiscountId: result.discountNodeId,
      code: result.code,
      expiresAt: result.endsAt,
    };
  }

  // revokeDiscount is intentionally NOT implemented — canRevokeDiscount is
  // false and no provider call for it exists anywhere in this codebase.

  async verifyAndParseWebhook(
    // Webhook verification is scoped to the shared app secret + the
    // `x-shopify-shop-domain` header, not to a specific `CommerceConnection`
    // row — exactly like `verifyShopifyWebhookRequest` today (see
    // `src/app/api/shopify/webhooks/**/route.ts`, none of which look up a
    // connection before verifying). `connectionId` is accepted to satisfy
    // the neutral `CommerceAdapter` interface but is not otherwise used.
    connectionId: string,
    input: WebhookRequestInput,
  ): Promise<NormalizedWebhookEvent> {
    const secret = process.env.SHOPIFY_API_SECRET;

    if (!secret) {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        "Missing Shopify API secret.",
      );
    }

    const hmac = getHeaderCaseInsensitive(input.headers, "x-shopify-hmac-sha256");
    const verified = this.deps.verifyWebhookHmac({
      rawBody: input.rawBody,
      hmac,
      secret,
    });

    if (!verified) {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        "Invalid Shopify webhook signature.",
      );
    }

    const topic = getHeaderCaseInsensitive(input.headers, "x-shopify-topic");
    const type = topic ? WEBHOOK_TOPIC_MAP[topic] : undefined;

    if (!type) {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        `Unrecognized Shopify webhook topic: "${topic ?? "(missing)"}".`,
      );
    }

    const externalAccountId = (
      getHeaderCaseInsensitive(input.headers, "x-shopify-shop-domain") || ""
    )
      .trim()
      .toLowerCase();

    let payload: unknown = null;
    try {
      payload = input.rawBody ? JSON.parse(input.rawBody) : null;
    } catch {
      payload = null;
    }

    return {
      provider: CommerceProvider.SHOPIFY,
      type,
      externalAccountId,
      receivedAt: new Date(),
      payload,
    };
  }

  /**
   * Handles every variant of `GetValidAccessTokenResult` explicitly. The
   * `never` assignment below is an exhaustiveness guard: if that union ever
   * grows beyond `NEEDS_RECONNECT` / `NOT_CONNECTED`, this file fails to
   * compile until it is updated to handle the new case.
   */
  private resolveAccessToken(result: GetValidAccessTokenResult): string {
    if (result.ok) {
      return result.accessToken;
    }

    if (result.reason === "NEEDS_RECONNECT") {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        "Shopify connection requires reconnection.",
        result.reason,
      );
    }

    if (result.reason === "NOT_CONNECTED") {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        "Shopify is not connected for this brand.",
        result.reason,
      );
    }

    const exhaustiveCheck: never = result.reason;
    throw new CommerceProviderApiError(
      CommerceProvider.SHOPIFY,
      `Unknown Shopify token error: ${String(exhaustiveCheck)}`,
    );
  }
}
