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

export type NormalizedShopifyProduct = {
  id: string;
  shopifyProductGid: string;
  title: string;
  handle: string;
  productUrl: string;
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
  // source currency from `Brand.shopifyCurrencyCode` instead, storing `null`
  // when that is unknown.
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

  return {
    id: String(product.id),
    shopifyProductGid: String(product.id),
    title: product.title,
    handle: product.handle,
    productUrl:
      product.onlineStoreUrl ||
      `https://${shopDomain}/products/${product.handle}`,
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

export async function fetchNormalizedShopifyProducts(options: {
  shopDomain: string;
  brandId: string;
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
  /** @deprecated Pass brandId instead; encryptedToken is kept for callers
   *  that have not yet been migrated. When brandId is provided the token
   *  manager is used and this field is ignored. */
  encryptedToken?: string;
}) {
  const tokenResult = await getValidAccessToken(options.brandId);

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
      normalizeProduct(product, options.shopDomain, options.currency || "USD"),
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
