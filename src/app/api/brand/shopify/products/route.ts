import { NextResponse } from "next/server";
import { CommerceProvider } from "@prisma/client";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  getActiveCommerceConnection,
  isConnectionUsable,
} from "@/lib/commerce/connection-service";
import { defaultCommerceAdapterRegistry } from "@/lib/commerce/default-registry";
import {
  CommerceConnectionNotFoundError,
  CommerceProviderApiError,
} from "@/lib/commerce/errors";
import type { CommerceAdapterRegistry } from "@/lib/commerce/registry";
import type {
  CommerceConnectionSummary,
  CommerceProduct,
} from "@/lib/commerce/types";

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
  | {
      ok: true;
      items: ShopifyProductResponseItem[];
      hasNextPage: boolean;
      limit: number;
    }
  | { ok: false; error: string; status: number };

export type BrandShopifyProductsDeps = {
  /** Resolves the acting brand-admin context. Defaults to `getBrandManagementContext`. */
  getContext(): Promise<BrandAdminContext | null>;
  /** Resolves the brand's provider-neutral Shopify connection summary. */
  getConnectionSummary(
    brandId: string,
  ): Promise<CommerceConnectionSummary | null>;
  /** Adapter registry used for provider selection — never hard-coded. */
  registry: CommerceAdapterRegistry;
};

const DEFAULT_DEPS: BrandShopifyProductsDeps = {
  getContext: getBrandManagementContext,
  getConnectionSummary: (brandId) =>
    getActiveCommerceConnection(brandId, CommerceProvider.SHOPIFY),
  registry: defaultCommerceAdapterRegistry,
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
 * The adapter path — provider selection goes through the registry
 * (`deps.registry.get`), never a hard-coded `new ShopifyCommerceAdapter()`.
 * The resolved summary always carries a real `CommerceConnection.id`.
 *
 * Capability-checked: `adapter.getCapabilities().products.sync` is
 * consulted before calling `syncProducts` rather than assuming support, so a
 * provider that is registered but does not support product sync fails with
 * a typed error instead of an unchecked method call. `deps.registry.get`
 * itself throws `UnsupportedProviderError` for a provider with no adapter at
 * all (e.g. COMMERCE7 today) — deliberately NOT caught here. It propagates
 * to the route's outer catch and surfaces as the generic 500.
 */
async function runAdapterSync(
  deps: BrandShopifyProductsDeps,
  summary: CommerceConnectionSummary,
): Promise<ProductsFetchOutcome> {
  try {
    const adapter = deps.registry.get(summary.provider);
    const capabilities = adapter.getCapabilities();

    if (!capabilities.products.sync) {
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
      return {
        ok: false,
        error: error.message,
        status: error.httpStatus ?? 500,
      };
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
        {
          error: failure.error,
          ...(failure.code ? { code: failure.code } : {}),
        },
        { status: failure.status },
      );
    }

    const brand = context.membership.brand;

    // CANONICAL GATE. `getActiveCommerceConnection` is the sole authority
    // (see connection-service.ts): the connection resolves from
    // `CommerceConnection` or not at all. PHASE 14C-B2 dropped the legacy
    // `Brand.shopify*` columns outright, so there is no fallback source left.
    // `isConnectionUsable` reproduces the exact three-part gate this route
    // used to hand-roll against those columns (domain present + credential
    // present + status CONNECTED) — see its own doc comment in
    // connection-service.ts for the write-path invariant that makes
    // `status === "CONNECTED"` alone equivalent to all three.
    const summary = await deps.getConnectionSummary(brand.id);
    if (!summary || !isConnectionUsable(summary)) {
      return NextResponse.json(
        { error: "Shopify is not connected for this brand." },
        { status: 400 },
      );
    }

    const outcome = await runAdapterSync(deps, summary);

    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.error },
        { status: outcome.status },
      );
    }

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
