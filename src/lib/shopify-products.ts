import { decryptSecret } from "@/lib/crypto";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

type ShopifyProductImage = {
  src: string | null;
};

type ShopifyProductVariant = {
  id: number | string;
  price: string | null;
};

type ShopifyProduct = {
  id: number | string;
  title: string;
  handle: string;
  images?: ShopifyProductImage[];
  variants?: ShopifyProductVariant[];
};

type ShopifyProductsResponse = {
  products?: ShopifyProduct[];
  errors?: string | string[] | Record<string, string>;
};

export type NormalizedShopifyProduct = {
  id: string;
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
  const prices = (product.variants || [])
    .map((variant) => Number(variant.price || 0))
    .filter((price) => Number.isFinite(price));
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;
  const images = (product.images || [])
    .map((image) => image.src)
    .filter((src): src is string => Boolean(src));

  return {
    id: String(product.id),
    title: product.title,
    handle: product.handle,
    productUrl: `https://${shopDomain}/products/${product.handle}`,
    images,
    imageUrl: images[0] || null,
    priceRange: {
      min: minPrice,
      max: maxPrice,
    },
    priceText: formatPriceText(prices, currency),
    currency,
    variantIds: (product.variants || []).map((variant) => String(variant.id)),
  };
}

export async function fetchNormalizedShopifyProducts(options: {
  shopDomain: string;
  encryptedToken: string;
  limit?: number;
  currency?: string;
}) {
  const accessToken = decryptSecret(options.encryptedToken);
  const response = await fetch(
    `https://${options.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=${options.limit || 100}`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    },
  );

  const json = (await response.json().catch(() => null)) as
    | ShopifyProductsResponse
    | null;

  if (!response.ok || !json?.products) {
    return {
      ok: false as const,
      status: response.status || 500,
      error: json?.errors || "Failed to fetch Shopify products.",
    };
  }

  return {
    ok: true as const,
    items: json.products.map((product) =>
      normalizeProduct(product, options.shopDomain, options.currency || "USD"),
    ),
  };
}
