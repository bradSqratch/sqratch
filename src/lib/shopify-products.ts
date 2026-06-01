import { decryptSecret } from "@/lib/crypto";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

type ShopifyProductImage = {
  url: string | null;
};

type ShopifyProductVariant = {
  id: number | string;
  price: string | null;
};

type ShopifyProduct = {
  id: number | string;
  title: string;
  handle: string;
  onlineStoreUrl?: string | null;
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
  currency: string;
  variantIds: string[];
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

function normalizeProduct(
  product: ShopifyProduct,
  shopDomain: string,
  currency = "USD",
): NormalizedShopifyProduct {
  const variants = product.variants?.nodes || [];
  const imageNodes = product.images?.nodes || [];
  const prices = variants
    .map((variant) =>
      variant.price === null || variant.price === ""
        ? Number.NaN
        : Number(variant.price),
    )
    .filter((price) => Number.isFinite(price));
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const images = [
    product.featuredImage?.url || null,
    ...imageNodes.map((image) => image.url),
  ]
    .filter((src): src is string => Boolean(src));

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

export async function fetchNormalizedShopifyProducts(options: {
  shopDomain: string;
  encryptedToken: string;
  limit?: number;
  currency?: string;
}) {
  const accessToken = decryptSecret(options.encryptedToken);
  const response = await fetch(
    `https://${options.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`,
    {
      method: "POST",
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `
          query SqratchProducts($first: Int!) {
            products(first: $first, query: "status:active") {
              nodes {
                id
                title
                handle
                onlineStoreUrl
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
                  }
                }
              }
              pageInfo {
                hasNextPage
              }
            }
          }
        `,
        variables: {
          first: options.limit || 100,
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
  };
}
