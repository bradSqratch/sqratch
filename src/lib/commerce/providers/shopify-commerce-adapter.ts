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
 * token, refresh token, or encrypted payload.
 * `getConnection()` reads only the `CommerceConnection` row —
 * `CommerceConnectionSecret` is never read by this file.
 */

import {
  CommerceProvider,
  type CommerceConnectionStatus,
  type Prisma,
} from "@prisma/client";
import { extractCurrencyCodeFromProviderMetadata } from "../connection-resolver";
import type { CommerceAdapter } from "../adapter";
import {
  CommerceConnectionNotFoundError,
  CommerceProviderApiError,
} from "../errors";
import type {
  CommerceCapabilities,
  CommerceConnectionResult,
  CommerceConnectionSummary,
  CommerceProduct,
  CreateDiscountInput,
  GetDiscountInput,
  ProductSyncPageRequest,
  ProductSyncPreparationRequest,
  ProductSyncPageResult,
  ProductSyncResult,
  ProviderDiscount,
  ProviderDiscountLookup,
} from "../types";

import {
  fetchPublishedShopifyProductIds,
  fetchNormalizedShopifyProducts,
  type NormalizedShopifyProduct,
} from "@/lib/shopify-products";
import {
  createShopifyRewardDiscountCode,
  getShopifyDiscountByCode,
  getShopifyDiscountUsageStatus,
} from "@/lib/shopify-discounts";
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
type FetchProductsResult = Awaited<
  ReturnType<typeof fetchNormalizedShopifyProducts>
>;
type FetchPublishedProductIdsInput = Parameters<
  typeof fetchPublishedShopifyProductIds
>[0];
type FetchPublishedProductIdsResult = Awaited<
  ReturnType<typeof fetchPublishedShopifyProductIds>
>;

type CreateDiscountCodeInput = Parameters<
  typeof createShopifyRewardDiscountCode
>[0];
type CreateDiscountCodeResult = Awaited<
  ReturnType<typeof createShopifyRewardDiscountCode>
>;
type LookupDiscountByCodeInput = Parameters<typeof getShopifyDiscountByCode>[0];
type LookupDiscountByCodeResult = Awaited<
  ReturnType<typeof getShopifyDiscountByCode>
>;
type LookupDiscountByNodeIdInput = Parameters<
  typeof getShopifyDiscountUsageStatus
>[0];
type LookupDiscountByNodeIdResult = Awaited<
  ReturnType<typeof getShopifyDiscountUsageStatus>
>;
type VerifyWebhookHmacInput = Parameters<typeof verifyShopifyWebhookHmac>[0];

/** Shopify transport only; intentionally not part of CommerceAdapter. */
export type ShopifyWebhookRequest = {
  rawBody: string;
  headers: Record<string, string>;
};
export type ShopifyVerifiedWebhook = {
  provider: typeof CommerceProvider.SHOPIFY;
  type:
    | "APP_UNINSTALLED"
    | "ACCOUNT_REDACT"
    | "CUSTOMER_DATA_REQUEST"
    | "CUSTOMER_REDACT";
  externalAccountId: string;
  payload: unknown;
};

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
  providerMetadata: Prisma.JsonValue | null;
};

/**
 * Injectable dependencies. Every default implementation below delegates to
 * an existing, unmodified Shopify service — see the file header.
 */
export type ShopifyCommerceAdapterDeps = {
  /** Loads a `CommerceConnection` row by id, or `null` if it does not exist. */
  loadConnection(
    connectionId: string,
  ): Promise<ShopifyCommerceConnectionRow | null>;
  /** Resolves a valid Shopify access token for a brand. Defaults to `getValidAccessToken`. */
  getAccessToken(
    brandId: string,
    options?: { connectionId?: string; expectedExternalAccountId?: string },
  ): Promise<GetValidAccessTokenResult>;
  /** Fetches the live product catalog. Defaults to `fetchNormalizedShopifyProducts`. */
  fetchProducts(input: FetchProductsInput): Promise<FetchProductsResult>;
  /** Fetches the complete provider-confirmed Online Store publication set. */
  fetchPublishedProductIds(
    input: FetchPublishedProductIdsInput,
  ): Promise<FetchPublishedProductIdsResult>;
  /** Creates a discount code on Shopify. Defaults to `createShopifyRewardDiscountCode`. */
  createDiscountCode(
    input: CreateDiscountCodeInput,
  ): Promise<CreateDiscountCodeResult>;
  /** Reads an existing discount by its provider node ID. */
  lookupDiscountByNodeId(
    input: LookupDiscountByNodeIdInput,
  ): Promise<LookupDiscountByNodeIdResult>;
  /** Reads an existing discount by its human-facing code. */
  lookupDiscountByCode(
    input: LookupDiscountByCodeInput,
  ): Promise<LookupDiscountByCodeResult>;
  /** Shopify transport verification; routes own Shopify compliance semantics. */
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
  return prisma.commerceConnection.findFirst({
    where: { id: connectionId, provider: CommerceProvider.SHOPIFY },
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
      providerMetadata: true,
    },
  });
}

async function defaultMarkProductSync(
  connectionId: string,
  syncedAt: Date,
): Promise<void> {
  const { default: prisma } = await import("@/lib/prisma");
  await prisma.commerceConnection.updateMany({
    where: { id: connectionId, provider: CommerceProvider.SHOPIFY },
    data: { lastProductSyncAt: syncedAt },
  });
}

const DEFAULT_DEPS: ShopifyCommerceAdapterDeps = {
  loadConnection: defaultLoadConnection,
  getAccessToken: getValidAccessToken,
  fetchProducts: fetchNormalizedShopifyProducts,
  fetchPublishedProductIds: fetchPublishedShopifyProductIds,
  createDiscountCode: createShopifyRewardDiscountCode,
  lookupDiscountByNodeId: getShopifyDiscountUsageStatus,
  lookupDiscountByCode: getShopifyDiscountByCode,
  verifyWebhookHmac: verifyShopifyWebhookHmac,
  markProductSync: defaultMarkProductSync,
};

// ---------------------------------------------------------------------------
// Pure mapping helpers
// ---------------------------------------------------------------------------

/**
 * Normalizes `CommerceConnection.grantedScopes` (a `Json?` column) to a
 * `string[]`. Canonical writes use a JSON array; the string branch tolerates
 * older serialized values without creating a second scope authority.
 * Anything else (null, object, numbers, etc.) normalizes to `[]` rather than
 * throwing.
 */
function normalizeGrantedScopes(
  raw: Prisma.JsonValue | null | undefined,
): string[] {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0);
  }

  if (Array.isArray(raw)) {
    return raw.filter(
      (scope): scope is string =>
        typeof scope === "string" && scope.trim().length > 0,
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
    currencyCode: extractCurrencyCodeFromProviderMetadata(row.providerMetadata),
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
    // The provider-confirmed storefront-publication fact is deliberately
    // separate from the actual/fallback navigation URL above.
    ...(typeof product.hasProviderStorefrontPublication === "boolean"
      ? {
          hasProviderStorefrontPublication:
            product.hasProviderStorefrontPublication,
        }
      : {}),
    hasProviderSuppliedStorefrontUrl: product.hasProviderSuppliedStorefrontUrl,
  };
}

type ShopifyProductSyncContext = {
  publishedProductIds: ReadonlySet<string>;
};

function getShopifyProductSyncContext(
  value: unknown,
): ShopifyProductSyncContext | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const productIds = (value as { publishedProductIds?: unknown })
    .publishedProductIds;
  return productIds instanceof Set ? { publishedProductIds: productIds } : null;
}

function getHeaderCaseInsensitive(
  headers: Record<string, string>,
  name: string,
): string | null {
  const target = name.toLowerCase();
  return (
    Object.entries(headers).find(
      ([key]) => key.toLowerCase() === target,
    )?.[1] ?? null
  );
}

const SHOPIFY_WEBHOOK_TOPIC_MAP = {
  "app/uninstalled": "APP_UNINSTALLED",
  "shop/redact": "ACCOUNT_REDACT",
  "customers/data_request": "CUSTOMER_DATA_REQUEST",
  "customers/redact": "CUSTOMER_REDACT",
} as const;

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
      products: { sync: true, publicDestinations: true },
      rewards: {
        create: true,
        lookup: true,
        usageLookup: true,
        revoke: false,
        fixedAmount: true,
        percentage: true,
        minimumSubtotal: true,
        productSpecific: true,
        singleUse: true,
      },
    };
  }

  private async loadShopifyConnection(
    connectionId: string,
  ): Promise<ShopifyCommerceConnectionRow | null> {
    const row = await this.deps.loadConnection(connectionId);
    return row?.provider === CommerceProvider.SHOPIFY ? row : null;
  }

  async getConnection(connectionId: string): Promise<CommerceConnectionResult> {
    const row = await this.loadShopifyConnection(connectionId);

    if (!row) {
      return { ok: false, reason: "NOT_FOUND" };
    }

    if (row.status !== "CONNECTED") {
      return { ok: false, reason: "NOT_CONNECTED" };
    }

    return { ok: true, connection: toCommerceConnectionSummary(row) };
  }

  async syncProducts(connectionId: string): Promise<ProductSyncResult> {
    const row = await this.loadShopifyConnection(connectionId);

    if (!row) {
      throw new CommerceConnectionNotFoundError(connectionId);
    }

    const result = await this.deps.fetchProducts({
      shopDomain: row.externalAccountId,
      brandId: row.brandId,
      connectionId: row.id,
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

  /**
   * A complete `published_status:published` scan is a prerequisite for
   * persisted Shopify catalog pages. It runs once per logical sync and its
   * opaque result is passed back to `fetchProductPage`; a failure means no
   * catalog row is written with incomplete publication evidence.
   */
  async prepareProductSync(
    connectionId: string,
    request: ProductSyncPreparationRequest,
  ): Promise<ShopifyProductSyncContext> {
    const row = await this.loadShopifyConnection(connectionId);
    if (!row) {
      throw new CommerceConnectionNotFoundError(connectionId);
    }

    const publicationScan = await this.deps.fetchPublishedProductIds({
      shopDomain: row.externalAccountId,
      brandId: row.brandId,
      connectionId: row.id,
      limit: request.limit,
      maxPages: request.maxPages,
      maxProducts: request.maxProducts,
      signal: request.signal,
    });
    if (!publicationScan.ok) {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        publicationScan.error ||
          "Failed to retrieve Shopify Online Store publication information.",
        undefined,
        publicationScan.status,
      );
    }

    return { publishedProductIds: publicationScan.productIds };
  }

  /**
   * The persisted-catalog service calls this method repeatedly with opaque
   * cursors. `syncProducts` above intentionally remains a one-page wrapper:
   * dashboard Shopify route responses keep their established contract.
   */
  async fetchProductPage(
    connectionId: string,
    request: ProductSyncPageRequest,
  ): Promise<ProductSyncPageResult> {
    const row = await this.loadShopifyConnection(connectionId);

    if (!row) {
      throw new CommerceConnectionNotFoundError(connectionId);
    }

    const syncContext = getShopifyProductSyncContext(request.syncContext);
    if (!syncContext) {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        "Shopify product page requested without complete publication evidence.",
      );
    }

    const result = await this.deps.fetchProducts({
      shopDomain: row.externalAccountId,
      brandId: row.brandId,
      connectionId: row.id,
      ...(request.cursor ? { after: request.cursor } : {}),
      ...(request.limit ? { limit: request.limit } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      publishedProductIds: syncContext.publishedProductIds,
    });

    if (!result.ok) {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        result.error || "Failed to fetch Shopify products.",
        undefined,
        result.status,
      );
    }

    // Shopify can include an endCursor for the final returned edge even when
    // `hasNextPage` is false. The neutral contract treats a cursor as
    // actionable only when another page exists: complete pages MUST expose
    // `nextCursor: null` so the catalog collector cannot mistake a final
    // edge cursor for an incomplete traversal.
    const hasNextPage = result.hasNextPage === true;
    const nextCursor =
      hasNextPage &&
      typeof result.endCursor === "string" &&
      result.endCursor.trim().length > 0
        ? result.endCursor
        : null;

    return {
      products: result.items.map(toCommerceProduct),
      nextCursor,
      isComplete: !hasNextPage,
      fetchedAt: new Date(),
      limit: result.limit,
    };
  }

  async completeProductSync(
    connectionId: string,
    completedAt: Date,
  ): Promise<void> {
    await this.deps.markProductSync(connectionId, completedAt);
  }

  async createDiscount(
    connectionId: string,
    input: CreateDiscountInput,
  ): Promise<ProviderDiscount> {
    const row = await this.loadShopifyConnection(connectionId);

    if (!row) {
      throw new CommerceConnectionNotFoundError(connectionId);
    }

    const accessToken = this.resolveAccessToken(
      await this.deps.getAccessToken(row.brandId, {
        connectionId,
        expectedExternalAccountId: row.externalAccountId,
      }),
    );

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
      // preserve the Shopify transport's status and diagnostic detail.
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

  async getDiscount(
    connectionId: string,
    input: GetDiscountInput,
  ): Promise<ProviderDiscountLookup> {
    const row = await this.loadShopifyConnection(connectionId);
    if (!row) {
      throw new CommerceConnectionNotFoundError(connectionId);
    }
    if (row.status !== "CONNECTED") {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        "Shopify connection is not available.",
      );
    }

    const accessToken = this.resolveAccessToken(
      await this.deps.getAccessToken(row.brandId, {
        connectionId,
        expectedExternalAccountId: row.externalAccountId,
      }),
    );

    if (input.externalDiscountId) {
      const result = await this.deps.lookupDiscountByNodeId({
        shopDomain: row.externalAccountId,
        accessToken,
        discountNodeId: input.externalDiscountId,
      });
      if (!result.ok) {
        throw new CommerceProviderApiError(
          CommerceProvider.SHOPIFY,
          result.error,
          undefined,
          result.status,
        );
      }
      return {
        exists: true,
        externalDiscountId: input.externalDiscountId,
        externalStatus: result.status,
        usageCount: result.asyncUsageCount,
        expiresAt: result.endsAt,
      };
    }

    if (!input.code) {
      return { exists: false };
    }
    const result = await this.deps.lookupDiscountByCode({
      shopDomain: row.externalAccountId,
      accessToken,
      code: input.code,
    });
    if (!result.ok) {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        result.error,
        undefined,
        result.status,
      );
    }
    if (!result.exists) {
      return { exists: false };
    }
    return {
      exists: true,
      externalDiscountId: result.discountNodeId,
      externalStatus: result.status,
      usageCount: result.asyncUsageCount,
      expiresAt: result.endsAt,
    };
  }

  // revokeDiscount is intentionally NOT implemented — rewards.revoke is
  // false and no provider call for it exists anywhere in this codebase.

  /** Shopify-only verification retained for existing Shopify webhook routes. */
  async verifyAndParseWebhook(
    _connectionId: string,
    input: ShopifyWebhookRequest,
  ): Promise<ShopifyVerifiedWebhook> {
    const secret = process.env.SHOPIFY_API_SECRET;
    if (!secret)
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        "Missing Shopify API secret.",
      );
    if (
      !this.deps.verifyWebhookHmac({
        rawBody: input.rawBody,
        hmac: getHeaderCaseInsensitive(input.headers, "x-shopify-hmac-sha256"),
        secret,
      })
    ) {
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        "Invalid Shopify webhook signature.",
      );
    }
    const type =
      SHOPIFY_WEBHOOK_TOPIC_MAP[
        getHeaderCaseInsensitive(
          input.headers,
          "x-shopify-topic",
        ) as keyof typeof SHOPIFY_WEBHOOK_TOPIC_MAP
      ];
    if (!type)
      throw new CommerceProviderApiError(
        CommerceProvider.SHOPIFY,
        "Unrecognized Shopify webhook topic.",
      );
    let payload: unknown = null;
    try {
      payload = input.rawBody ? JSON.parse(input.rawBody) : null;
    } catch {
      payload = null;
    }
    return {
      provider: CommerceProvider.SHOPIFY,
      type,
      externalAccountId: (
        getHeaderCaseInsensitive(input.headers, "x-shopify-shop-domain") ?? ""
      )
        .trim()
        .toLowerCase(),
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
