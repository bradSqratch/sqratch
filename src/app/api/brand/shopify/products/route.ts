import { NextResponse } from "next/server";
import { CommerceProvider } from "@prisma/client";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { fetchNormalizedShopifyProducts } from "@/lib/shopify-products";
import { getActiveCommerceConnection } from "@/lib/commerce/connection-service";
import { defaultCommerceAdapterRegistry } from "@/lib/commerce/default-registry";
import {
  CommerceConnectionNotFoundError,
  CommerceProviderApiError,
} from "@/lib/commerce/errors";
import type { CommerceAdapterRegistry } from "@/lib/commerce/registry";
import type { CommerceConnectionSummary, CommerceProduct } from "@/lib/commerce/types";

/**
 * The exact response product shape this route has always returned —
 * `id` and `shopifyProductGid` are the SAME underlying value (see
 * `src/lib/commerce/types.ts`'s `CommerceProduct.externalId` doc comment for
 * why: Shopify's own `NormalizedShopifyProduct.id` and `.shopifyProductGid`
 * are always `String(product.id)`, assigned to both). Both response fields
 * are kept because `src/app/(withSidebar)/dashboard/brand/rewards/page.tsx`
 * reads `shopifyProductGid` and
 * `src/app/(withSidebar)/dashboard/brand/shopify/BrandShopifyClient.tsx`
 * reads `id` — dropping either would break a real caller.
 */
type ShopifyProductResponseItem = {
  id: string;
  shopifyProductGid: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  priceRange: { min: number | null; max: number | null };
  variantIds: string[];
};

type ProductsFetchOutcome =
  | { ok: true; items: ShopifyProductResponseItem[]; hasNextPage: boolean; limit: number }
  | { ok: false; error: string; status: number };

export type BrandShopifyProductsDeps = {
  /** Resolves the acting brand-admin context. Defaults to `getBrandManagementContext`. */
  getContext(): Promise<BrandAdminContext | null>;
  /** Resolves the brand's provider-neutral Shopify connection summary. */
  getConnectionSummary(brandId: string): Promise<CommerceConnectionSummary | null>;
  /** Adapter registry used for provider selection — never hard-coded. */
  registry: CommerceAdapterRegistry;
  /** The legacy direct-fetch path, used whenever there is no real `CommerceConnection.id` to hand the adapter. */
  fetchProductsDirect: typeof fetchNormalizedShopifyProducts;
  /** Stamps the legacy `Brand.shopifyLastProductSyncAt` / `shopifyConnectionStatus` columns after a successful sync. */
  markLegacyProductSync(brandId: string): Promise<void>;
};

async function defaultMarkLegacyProductSync(brandId: string): Promise<void> {
  await prisma.brand.update({
    where: { id: brandId },
    data: {
      shopifyLastProductSyncAt: new Date(),
      shopifyConnectionStatus: "CONNECTED",
    },
  });
}

const DEFAULT_DEPS: BrandShopifyProductsDeps = {
  getContext: getBrandManagementContext,
  getConnectionSummary: (brandId) =>
    getActiveCommerceConnection(brandId, CommerceProvider.SHOPIFY),
  registry: defaultCommerceAdapterRegistry,
  fetchProductsDirect: fetchNormalizedShopifyProducts,
  markLegacyProductSync: defaultMarkLegacyProductSync,
};

function mapCommerceProducts(
  products: CommerceProduct[],
): ShopifyProductResponseItem[] {
  return products.map((product) => ({
    id: product.externalId,
    shopifyProductGid: product.externalId,
    title: product.title,
    handle: product.handle,
    productUrl: product.productUrl,
    imageUrl: product.imageUrl,
    images: product.images,
    priceRange: product.priceRange,
    variantIds: product.externalVariantIds,
  }));
}

/**
 * The legacy direct-fetch path — byte-for-byte the same call and mapping
 * this route used before the Phase-2 cutover. Used whenever the resolved
 * connection summary has no real `CommerceConnection.id` to hand the adapter
 * (`summary === null` or `summary.id === null`, i.e. a legacy fallback).
 */
async function runDirectFetch(
  deps: BrandShopifyProductsDeps,
  shopDomain: string,
  brandId: string,
): Promise<ProductsFetchOutcome> {
  const products = await deps.fetchProductsDirect({
    shopDomain,
    brandId,
    limit: 100,
  });

  if (!products.ok) {
    return { ok: false, error: products.error, status: products.status };
  }

  return {
    ok: true,
    items: products.items.map((product) => ({
      id: product.id,
      shopifyProductGid: product.shopifyProductGid,
      title: product.title,
      handle: product.handle,
      productUrl: product.productUrl,
      imageUrl: product.imageUrl,
      images: product.images,
      priceRange: product.priceRange,
      variantIds: product.variantIds,
    })),
    hasNextPage: products.hasNextPage,
    limit: products.limit,
  };
}

/**
 * The adapter path — provider selection goes through the registry
 * (`deps.registry.get`), never a hard-coded `new ShopifyCommerceAdapter()`.
 * Only reachable when the resolved summary carries a real
 * `CommerceConnection.id` (`summary.id !== null`).
 *
 * Capability-checked: `adapter.getCapabilities().canSyncProducts` is
 * consulted before calling `syncProducts` rather than assuming support, so a
 * provider that is registered but does not support product sync fails with
 * a typed error instead of an unchecked method call. `deps.registry.get`
 * itself throws `UnsupportedProviderError` for a provider with no adapter at
 * all (e.g. COMMERCE7 today) — deliberately NOT caught here, so it never
 * gets mapped onto the Shopify-specific direct-fetch fallback (that would
 * silently call the Shopify Admin API for a non-Shopify connection). It
 * propagates to the route's outer catch and surfaces as the generic 500,
 * exactly like any other unexpected error — see the route's error-mapping
 * comment.
 */
async function runAdapterSync(
  deps: BrandShopifyProductsDeps,
  summary: CommerceConnectionSummary & { id: string },
): Promise<ProductsFetchOutcome> {
  try {
    const adapter = deps.registry.get(summary.provider);
    const capabilities = adapter.getCapabilities();

    if (!capabilities.canSyncProducts) {
      throw new CommerceProviderApiError(
        summary.provider,
        `Provider "${summary.provider}" does not support product sync.`,
      );
    }

    const result = await adapter.syncProducts(summary.id);

    return {
      ok: true,
      items: mapCommerceProducts(result.products),
      hasNextPage: result.hasNextPage,
      limit: result.limit,
    };
  } catch (error) {
    // Map the adapter's typed errors back onto EXACTLY the body/status the
    // pre-cutover direct-fetch path produced for the equivalent failure.
    if (error instanceof CommerceProviderApiError) {
      // `httpStatus` is set by ShopifyCommerceAdapter.syncProducts from
      // fetchNormalizedShopifyProducts's own `status` field (see
      // shopify-commerce-adapter.ts) — the exact status the direct path
      // would have returned for the same upstream failure. Falls back to
      // 500 only for an error with no upstream status to carry (e.g. the
      // "provider does not support product sync" error synthesized above,
      // which has no direct-path equivalent).
      return { ok: false, error: error.message, status: error.httpStatus ?? 500 };
    }
    if (error instanceof CommerceConnectionNotFoundError) {
      // No equivalent in the direct-fetch path — this can only happen if
      // the CommerceConnection row disappeared between resolving the
      // summary and the adapter loading it by id (e.g. a concurrent
      // disconnect). Reproduce the SAME body/status the route's own
      // connectivity gate below uses for "not connected", since that is
      // exactly what this situation means from the caller's perspective.
      return {
        ok: false,
        error: "Shopify is not connected for this brand.",
        status: 400,
      };
    }
    throw error;
  }
}

async function resolveProducts(
  deps: BrandShopifyProductsDeps,
  brandId: string,
  shopDomain: string,
): Promise<ProductsFetchOutcome> {
  const summary = await deps.getConnectionSummary(brandId);

  // `syncProducts` needs a REAL `CommerceConnection.id`. When the resolved
  // summary is a legacy fallback (`id === null` — no mirror row yet, or the
  // mirror's shop domain disagreed with legacy and getActiveCommerceConnection
  // already fell back to legacy), there is no id to hand the adapter, so this
  // falls back to the direct `fetchNormalizedShopifyProducts` path — the
  // exact path this route used before the cutover. `summary === null` is
  // folded into the same fallback: it should not occur here (the
  // connectivity gate below already confirmed legacy has a shop domain and a
  // CONNECTED status for this exact brandId/provider), but if it ever did,
  // legacy is still the correct source of truth to fall back to.
  if (summary && summary.id !== null) {
    return runAdapterSync(deps, { ...summary, id: summary.id });
  }

  return runDirectFetch(deps, shopDomain, brandId);
}

export async function GET() {
  return productsGetImpl();
}

export async function productsGetImpl(
  overrides: Partial<BrandShopifyProductsDeps> = {},
) {
  const deps: BrandShopifyProductsDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const context = await deps.getContext();

    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    const brand = context.membership.brand;

    if (
      !brand.shopifyShopDomain ||
      !brand.shopifyAdminAccessTokenEncrypted ||
      brand.shopifyConnectionStatus !== "CONNECTED"
    ) {
      return NextResponse.json(
        { error: "Shopify is not connected for this brand." },
        { status: 400 },
      );
    }

    const outcome = await resolveProducts(deps, brand.id, brand.shopifyShopDomain);

    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.error }, { status: outcome.status });
    }

    // PRESERVED SIDE EFFECT: the legacy Brand columns are stamped exactly as
    // before, on every successful sync regardless of which path produced it
    // (adapter or direct-fetch). When the adapter path was used, it has
    // ALREADY separately stamped CommerceConnection.lastProductSyncAt inside
    // ShopifyCommerceAdapter.syncProducts (via its own markProductSync dep)
    // — this is a required dual-write, not a duplicate: legacy stays
    // authoritative for every route that reads Brand.shopify* directly, and
    // the mirror stays current for the neutral service.
    await deps.markLegacyProductSync(brand.id);

    return NextResponse.json({
      data: outcome.items,
      meta: {
        hasNextPage: outcome.hasNextPage,
        limit: outcome.limit,
      },
    });
  } catch (error) {
    console.error("[brand/shopify/products][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load Shopify products." },
      { status: 500 },
    );
  }
}
