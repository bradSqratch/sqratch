import { getValidAccessToken } from "@/lib/shopify-token-manager";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

type ShopifyProductImage = {
  url: string | null;
};

type ShopifyProductVariant = {
  id: number | string;
  price: string | null;
  sku?: string | null;
};

type ShopifyProduct = {
  id: number | string;
  title: string;
  handle: string;
  onlineStoreUrl?: string | null;
  // Additive fields (Task 1) — all covered by the existing `read_products`
  // scope (verified against https://shopify.dev/docs/api/admin-graphql
  // /latest/objects/Product, which states "Requires read_products access
  // scope" for the Product object as a whole; none of these four fields, nor
  // ProductVariant.sku below, sit behind a narrower/additional scope the way
  // inventory fields do behind `read_inventory`).
  description?: string | null;
  status?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  images?: {
    nodes?: ShopifyProductImage[];
  };
  variants?: {
    nodes?: ShopifyProductVariant[];
  };
  featuredImage?: ShopifyProductImage | null;
};

type ShopifyProductsResponse = {
  data?: {
    products?: {
      nodes?: ShopifyProduct[];
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
      };
    };
  };
  errors?: Array<{ message?: string }> | string | Record<string, string>;
};

type ShopifyPublishedProductIdsResponse = {
  data?: {
    products?: {
      nodes?: Array<{ id?: number | string | null }>;
      pageInfo?: {
        hasNextPage?: boolean;
        endCursor?: string | null;
      };
    };
  };
  errors?: ShopifyProductsResponse["errors"];
};

export type NormalizedShopifyProduct = {
  id: string;
  shopifyProductGid: string;
  title: string;
  handle: string;
  productUrl: string;
  /**
   * Defined only when the caller supplied a complete, provider-confirmed
   * Online Store publication set. This is intentionally NOT inferred from
   * `onlineStoreUrl`: password-protected development stores return that URL as
   * null even for products published to the Online Store.
   */
  hasProviderStorefrontPublication?: boolean;
  /** Whether `productUrl` was supplied by Shopify rather than synthesized. */
  hasProviderSuppliedStorefrontUrl: boolean;
  images: string[];
  imageUrl: string | null;
  priceRange: {
    min: number | null;
    max: number | null;
  };
  priceText: string | null;
  // WARNING: unless a caller explicitly supplies `options.currency`, this
  // value is a hardcoded default ("USD"), NOT the store's actual currency —
  // see `fetchNormalizedShopifyProducts` below. It is safe to use for
  // `priceText` display formatting (its only current consumer) but MUST NOT
  // be persisted as a product's real currency. A persistence layer should
  // source currency from the canonical `CommerceConnectionSummary.currencyCode`
  // instead (see `src/lib/commerce/product-sync.ts`), storing `null` when
  // that is unknown.
  currency: string;
  variantIds: string[];
  /**
   * RAW decimal price strings exactly as Shopify returned them (e.g.
   * "19.99"), preserved alongside the existing float `priceRange` so a
   * persistence layer can convert to exact integer minor units via
   * `src/lib/commerce/money.ts` instead of re-deriving from the (already
   * lossy, float) `priceRange` above. `priceRange`/`priceText` are NOT
   * derived from these — both pipelines run independently off the same
   * source variant prices.
   */
  priceRangeRaw: {
    min: string | null;
    max: string | null;
  };
  /** Product description as plain text (Shopify's `description` field, not `descriptionHtml`). */
  descriptionText: string | null;
  /** Shopify's product `status` (e.g. "ACTIVE" | "DRAFT" | "ARCHIVED"), passed through verbatim. */
  status: string | null;
  /** Parsed `Product.createdAt`; `null` if missing or unparseable. */
  providerCreatedAt: Date | null;
  /** Parsed `Product.updatedAt`; `null` if missing or unparseable. */
  providerUpdatedAt: Date | null;
  /**
   * Product-level SKU: the first non-empty `sku` among the product's
   * variants, in the order Shopify returned them. Shopify has no
   * product-level SKU field — SKUs live on variants — so this is a
   * best-effort single representative value for products that (as is
   * common for this catalog) have exactly one variant. A product with
   * multiple differently-SKU'd variants only surfaces its first variant's
   * SKU here; callers needing every variant's SKU must fetch variants
   * directly (out of scope for this normalized shape).
   */
  sku: string | null;
};

export function formatPriceText(
  prices: number[],
  currency = "USD",
): string | null {
  const numericPrices = prices.filter((price) => Number.isFinite(price));

  if (numericPrices.length === 0) {
    return null;
  }

  const minPrice = Math.min(...numericPrices);
  const maxPrice = Math.max(...numericPrices);
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  });

  if (minPrice === maxPrice) {
    return formatter.format(minPrice);
  }

  return `${formatter.format(minPrice)} - ${formatter.format(maxPrice)}`;
}

/** Parses a Shopify ISO timestamp string; returns `null` for missing/invalid input rather than an Invalid Date. */
function parseShopifyDate(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeProduct(
  product: ShopifyProduct,
  shopDomain: string,
  currency = "USD",
  publishedProductIds?: ReadonlySet<string>,
): NormalizedShopifyProduct {
  const variants = product.variants?.nodes || [];
  const imageNodes = product.images?.nodes || [];
  const rawPrices = variants.map((variant) => variant.price);
  const prices = rawPrices
    .map((price) =>
      price === null || price === undefined || price === ""
        ? Number.NaN
        : Number(price),
    )
    .filter((price) => Number.isFinite(price));
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const images = [
    product.featuredImage?.url || null,
    ...imageNodes.map((image) => image.url),
  ]
    .filter((src): src is string => Boolean(src));

  // Raw min/max price strings, independent of the float `prices` derivation
  // above — matched to whichever variant produced the float min/max so the
  // raw string is the exact source Shopify sent, not a re-stringified float.
  const numericRawPrices = variants
    .map((variant) => ({
      raw: variant.price ?? null,
      value:
        variant.price === null || variant.price === undefined || variant.price === ""
          ? Number.NaN
          : Number(variant.price),
    }))
    .filter((entry) => Number.isFinite(entry.value));
  const minRaw =
    minPrice === null
      ? null
      : numericRawPrices.find((entry) => entry.value === minPrice)?.raw ?? null;
  const maxRaw =
    maxPrice === null
      ? null
      : numericRawPrices.find((entry) => entry.value === maxPrice)?.raw ?? null;

  const sku =
    variants.map((variant) => variant.sku).find((value) => Boolean(value && value.trim())) ||
    null;

  // Use Shopify's actual URL when it is available. A password-protected
  // development store legitimately returns null here even for Online
  // Store-published products, so this URL is navigation data only — never
  // publication authorization.
  const providerStorefrontUrl =
    typeof product.onlineStoreUrl === "string" && product.onlineStoreUrl.trim().length > 0
      ? product.onlineStoreUrl.trim()
      : null;
  const providerStorefrontPublication =
    publishedProductIds?.has(String(product.id));

  return {
    id: String(product.id),
    shopifyProductGid: String(product.id),
    title: product.title,
    handle: product.handle,
    // Kept as-is for reward code and the brand product picker, which require
    // a non-null URL. The fallback is NOT evidence that a product is
    // published; the optional provider publication fact below is the only
    // public-click authorization signal.
    productUrl:
      providerStorefrontUrl ||
      `https://${shopDomain}/products/${product.handle}`,
    ...(publishedProductIds
      ? { hasProviderStorefrontPublication: providerStorefrontPublication === true }
      : {}),
    hasProviderSuppliedStorefrontUrl: providerStorefrontUrl !== null,
    images,
    imageUrl: images[0] || null,
    priceRange: {
      min: minPrice,
      max: maxPrice,
    },
    priceText: formatPriceText(prices, currency),
    currency,
    variantIds: variants.map((variant) => String(variant.id)),
    priceRangeRaw: {
      min: minRaw,
      max: maxRaw,
    },
    descriptionText: product.description ?? null,
    status: product.status ?? null,
    providerCreatedAt: parseShopifyDate(product.createdAt),
    providerUpdatedAt: parseShopifyDate(product.updatedAt),
    sku,
  };
}

function formatShopifyErrors(errors: ShopifyProductsResponse["errors"]) {
  if (!errors) {
    return "Failed to fetch Shopify products.";
  }

  if (typeof errors === "string") {
    return errors;
  }

  if (Array.isArray(errors)) {
    return errors
      .map((error) => error.message)
      .filter(Boolean)
      .join(" ");
  }

  return "Failed to fetch Shopify products.";
}

function boundedPositiveInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return fallback;
  }
  return Math.min(Math.floor(value), maximum);
}

// The GraphQL query text is shared by every call (single-page and
// paginated) so the two code paths can never drift from each other.
const PRODUCTS_QUERY = `
  query SqratchProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "status:active") {
      nodes {
        id
        title
        handle
        onlineStoreUrl
        description
        status
        createdAt
        updatedAt
        featuredImage {
          url
        }
        images(first: 10) {
          nodes {
            url
          }
        }
        variants(first: 100) {
          nodes {
            id
            price
            sku
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

// This is deliberately a separate, complete scan. Shopify documents
// `published_status:published` / `visible` as products published to the
// Online Store, unlike `online_store_channel`, which also includes products
// merely added to that channel. It requires only the existing read_products
// capability of the `products` query; it does not enumerate Publication rows.
const PUBLISHED_PRODUCT_IDS_QUERY = `
  query SqratchPublishedOnlineStoreProducts($first: Int!, $after: String) {
    products(first: $first, after: $after, query: "published_status:published") {
      nodes {
        id
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export type ShopifyPublishedProductIdsResult =
  | {
      ok: true;
      productIds: ReadonlySet<string>;
      pagesFetched: number;
      limit: number;
    }
  | {
      ok: false;
      status: number;
      tokenReason?: "NOT_CONNECTED" | "NEEDS_RECONNECT";
      error: string;
    };

/**
 * Retrieves the full provider-confirmed set of product IDs published to the
 * Online Store. Any malformed cursor, loop, page cap, product cap, request
 * failure, or abort is an error — callers must not treat an incomplete set as
 * proof that every missing product is unpublished.
 */
export async function fetchPublishedShopifyProductIds(options: {
  shopDomain: string;
  brandId: string;
  connectionId: string;
  limit?: number;
  maxPages?: number;
  maxProducts?: number;
  signal?: AbortSignal;
}): Promise<ShopifyPublishedProductIdsResult> {
  const tokenResult = await getValidAccessToken(options.brandId, {
    connectionId: options.connectionId,
    expectedExternalAccountId: options.shopDomain,
  });
  if (!tokenResult.ok) {
    return {
      ok: false,
      status: 401,
      tokenReason: tokenResult.reason,
      error:
        tokenResult.reason === "NEEDS_RECONNECT"
          ? "Shopify connection requires reconnection."
          : "Shopify is not connected.",
    };
  }

  const limit = boundedPositiveInteger(options.limit, 100, 100);
  const maxPages = boundedPositiveInteger(options.maxPages, 100, 10_000);
  const maxProducts = boundedPositiveInteger(options.maxProducts, 10_000, 1_000_000);
  const productIds = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | null = null;
  let pagesFetched = 0;
  let observedProducts = 0;

  while (pagesFetched < maxPages) {
    let response: Response;
    try {
      response = await fetch(
        `https://${options.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
        {
          method: "POST",
          headers: {
            "X-Shopify-Access-Token": tokenResult.accessToken,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            query: PUBLISHED_PRODUCT_IDS_QUERY,
            variables: { first: limit, after },
          }),
          cache: "no-store",
          signal: options.signal,
        },
      );
    } catch {
      return {
        ok: false,
        status: options.signal?.aborted ? 504 : 502,
        error: options.signal?.aborted
          ? "Shopify published-product scan timed out."
          : "Failed to fetch Shopify published-product information.",
      };
    }

    const json = (await response.json().catch(() => null)) as ShopifyPublishedProductIdsResponse | null;
    const products = json?.data?.products?.nodes;
    if (!response.ok || json?.errors || !products) {
      return {
        ok: false,
        status: response.ok ? 502 : response.status || 500,
        error: formatShopifyErrors(json?.errors),
      };
    }

    for (const product of products) {
      if (product?.id === null || product?.id === undefined || String(product.id).trim().length === 0) {
        return { ok: false, status: 502, error: "Shopify published-product scan returned an invalid product ID." };
      }
      observedProducts += 1;
      if (observedProducts > maxProducts) {
        return { ok: false, status: 502, error: "Shopify published-product scan exceeded its product limit." };
      }
      productIds.add(String(product.id));
    }

    pagesFetched += 1;
    const hasNextPage = json?.data?.products?.pageInfo?.hasNextPage === true;
    if (!hasNextPage) {
      return { ok: true, productIds, pagesFetched, limit };
    }

    const nextCursor = json?.data?.products?.pageInfo?.endCursor;
    if (typeof nextCursor !== "string" || nextCursor.trim().length === 0) {
      return { ok: false, status: 502, error: "Shopify published-product scan returned a missing cursor." };
    }
    if (seenCursors.has(nextCursor)) {
      return { ok: false, status: 502, error: "Shopify published-product scan returned a repeated cursor." };
    }
    seenCursors.add(nextCursor);
    after = nextCursor;
  }

  return { ok: false, status: 502, error: "Shopify published-product scan exceeded its page limit." };
}

export async function fetchNormalizedShopifyProducts(options: {
  shopDomain: string;
  brandId: string;
  connectionId: string;
  limit?: number;
  currency?: string;
  /**
   * Cursor pagination (Task 2, additive): when provided, fetches the page
   * starting after this cursor (Shopify's `pageInfo.endCursor` from a prior
   * call). Omitted/undefined preserves the exact pre-existing single-page,
   * first-page behavior for every current caller (the products route,
   * `ShopifyCommerceAdapter.syncProducts`, the creator/public product
   * routes, and `reward-offers.ts`) — none of them pass `after`, so they are
   * byte-identical to before this change.
   */
  after?: string;
  /** Optional cancellation signal used by bounded catalog synchronization. */
  signal?: AbortSignal;
  /**
   * A complete publication set obtained through
   * `fetchPublishedShopifyProductIds`. Supplying a partial set is forbidden:
   * missing members would otherwise be incorrectly treated as unpublished.
   */
  publishedProductIds?: ReadonlySet<string>;
}) {
  const tokenResult = await getValidAccessToken(options.brandId, {
    connectionId: options.connectionId,
    expectedExternalAccountId: options.shopDomain,
  });

  if (!tokenResult.ok) {
    return {
      ok: false as const,
      status: 401,
      tokenReason: tokenResult.reason,
      error:
        tokenResult.reason === "NEEDS_RECONNECT"
          ? "Shopify connection requires reconnection."
          : "Shopify is not connected.",
    };
  }

  const accessToken = tokenResult.accessToken;
  const response = await fetch(
    `https://${options.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: PRODUCTS_QUERY,
        variables: {
          first: options.limit || 100,
          after: options.after ?? null,
        },
      }),
      cache: "no-store",
      signal: options.signal,
    },
  );

  const json = (await response.json().catch(() => null)) as
    | ShopifyProductsResponse
    | null;

  const products = json?.data?.products?.nodes;

  if (!response.ok || json?.errors || !products) {
    return {
      ok: false as const,
      status: response.ok ? 502 : response.status || 500,
      tokenReason: undefined,
      error: formatShopifyErrors(json?.errors),
    };
  }

  return {
    ok: true as const,
    items: products.map((product) =>
      normalizeProduct(
        product,
        options.shopDomain,
        options.currency || "USD",
        options.publishedProductIds,
      ),
    ),
    hasNextPage: Boolean(json?.data?.products?.pageInfo?.hasNextPage),
    limit: options.limit || 100,
    // Additive field: `pageInfo.endCursor`, needed to fetch the next page.
    // `null` when there is no further page (or none was returned).
    endCursor: json?.data?.products?.pageInfo?.endCursor ?? null,
  };
}

/**
 * Fetches the FULL catalog across multiple pages by repeatedly calling
 * `fetchNormalizedShopifyProducts` with the previous page's `endCursor`,
 * bounded by `maxPages` so a runaway/huge catalog can never loop forever.
 *
 * This is a NEW, separate function — it does not change
 * `fetchNormalizedShopifyProducts`'s behavior or return shape for existing
 * callers in any way; it is purely additive.
 *
 * Stops when: a page reports `hasNextPage: false`, `maxPages` pages have
 * been fetched, or a page fetch fails (in which case the failure is
 * returned immediately with whatever items were already accumulated
 * discarded, mirroring the all-or-nothing semantics of a single failed
 * fetch — a caller that wants partial results on a mid-catalog failure is
 * not a use case here, since the persistence workstream that this function
 * exists for needs a consistent full-catalog snapshot).
 */
export async function fetchAllNormalizedShopifyProducts(options: {
  shopDomain: string;
  brandId: string;
  connectionId: string;
  /** Page size per request. Defaults to 100 (Shopify's practical per-page ceiling used elsewhere in this file). */
  pageSize?: number;
  currency?: string;
  /** Hard cap on the number of pages fetched, regardless of `hasNextPage`. Defaults to 50 (up to 5,000 products at the default page size of 100). */
  maxPages?: number;
}) {
  const pageSize = options.pageSize || 100;
  const maxPages = options.maxPages ?? 50;

  const items: NormalizedShopifyProduct[] = [];
  let after: string | undefined;
  let pagesFetched = 0;

  // Pessimistic default: only cleared to `false` when a page EXPLICITLY
  // reports the catalog is exhausted (`hasNextPage: false`). Every other
  // exit path — the `maxPages` bound reached while pages remain, or a page
  // reporting `hasNextPage: true` with no `endCursor` to continue from (an
  // anomalous provider response this module must never trust as "done") —
  // leaves this `true`, correctly reporting the fetch as truncated rather
  // than claimed-complete. See the Phase 3 review's M3: a false "complete"
  // here would (if this function is ever wired into a production sync path)
  // feed `product-sync.ts`'s truncation guard and mark every unfetched
  // product unavailable in a single pass — exactly the catastrophic outcome
  // that guard exists to prevent.
  let truncated = true;

  while (pagesFetched < maxPages) {
    const page = await fetchNormalizedShopifyProducts({
      shopDomain: options.shopDomain,
      brandId: options.brandId,
      connectionId: options.connectionId,
      limit: pageSize,
      currency: options.currency,
      after,
    });

    if (!page.ok) {
      return page;
    }

    items.push(...page.items);
    pagesFetched += 1;

    if (!page.hasNextPage) {
      truncated = false;
      break;
    }

    if (!page.endCursor) {
      // Shopify reported more pages exist (`hasNextPage: true`) but gave no
      // cursor to continue from. There is nothing safe to page from here —
      // stop, but this is NEVER a complete fetch, so `truncated` stays
      // `true` (do not fall through to `after = page.endCursor`, which
      // would be `undefined`).
      break;
    }

    after = page.endCursor;
  }

  return {
    ok: true as const,
    items,
    hasNextPage: truncated,
    limit: pageSize,
    pagesFetched,
  };
}
