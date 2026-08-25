import { NextRequest, NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import {
  configureCommerce7Storefront,
  type Commerce7StorefrontConfigurationResult,
} from "@/lib/commerce/providers/commerce7-storefront-configuration";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
} from "@/lib/commerce/errors";

/**
 * `PUT /api/brand/commerce/connections/[connectionId]/configuration`
 *
 * PHASE 16 BIG ROUND / SUBPHASE 1 — lets a Brand Admin explicitly configure
 * a CONNECTED Commerce7 connection's storefront URL, product-page route, and
 * currency. Every field is validated and persisted by
 * `configureCommerce7Storefront` (`@/lib/commerce/providers/commerce7-storefront-configuration`),
 * which this route never reimplements or bypasses — this file is
 * intentionally thin: auth, param/body extraction, and HTTP status mapping
 * only.
 *
 * Deliberately Commerce7-only: `configureCommerce7Storefront` itself rejects
 * any connection whose `provider !== COMMERCE7` via
 * `CommerceConnectionMismatchError` — a Shopify connectionId can never reach
 * this write path, since Shopify's storefront URL is provider-derived, not
 * merchant-configured (see `deriveShopifyStorefrontUrl` in
 * `connection-service.ts`).
 */
export type Commerce7ConfigurationDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  configure(
    input: Parameters<typeof configureCommerce7Storefront>[0],
  ): Promise<Commerce7StorefrontConfigurationResult>;
};

const DEFAULT_DEPS: Commerce7ConfigurationDeps = {
  getContext: getBrandManagementContext,
  configure: configureCommerce7Storefront,
};

export async function PUT(
  request: NextRequest,
  context: { params: Promise<{ connectionId: string }> },
) {
  const { connectionId } = await context.params;
  const body = await request.json().catch(() => null);
  return commerce7ConfigurationPutImpl({}, connectionId, body);
}

export async function commerce7ConfigurationPutImpl(
  overrides: Partial<Commerce7ConfigurationDeps> = {},
  connectionId?: string,
  body?: unknown,
) {
  const deps: Commerce7ConfigurationDeps = { ...DEFAULT_DEPS, ...overrides };

  try {
    const context = await deps.getContext();

    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    if (!connectionId || typeof connectionId !== "string" || !connectionId.trim()) {
      return NextResponse.json(
        { error: "A commerce connection id is required." },
        { status: 400 },
      );
    }

    const parsed = body as
      | { storefrontUrl?: unknown; productRoute?: unknown; currencyCode?: unknown }
      | null;

    if (
      !parsed ||
      typeof parsed.storefrontUrl !== "string" ||
      typeof parsed.productRoute !== "string" ||
      typeof parsed.currencyCode !== "string"
    ) {
      return NextResponse.json(
        { error: "storefrontUrl, productRoute, and currencyCode are all required." },
        { status: 400 },
      );
    }

    const brand = context.membership.brand;

    let result: Commerce7StorefrontConfigurationResult;
    try {
      result = await deps.configure({
        brandId: brand.id,
        connectionId,
        storefrontUrl: parsed.storefrontUrl,
        productRoute: parsed.productRoute,
        currencyCode: parsed.currencyCode,
      });
    } catch (error) {
      // A caller-selected connectionId that does not exist, or does not
      // belong to this brand — deliberately indistinguishable to the caller.
      if (error instanceof CommerceConnectionNotFoundError) {
        return NextResponse.json(
          { error: "That commerce connection was not found.", code: error.code },
          { status: 404 },
        );
      }
      // The connection is real and owned but is not a Commerce7 connection.
      if (error instanceof CommerceConnectionMismatchError) {
        return NextResponse.json(
          { error: "That connection is not a Commerce7 connection.", code: error.code },
          { status: 400 },
        );
      }
      // The connection is real, owned, and Commerce7 — but not CONNECTED.
      if (error instanceof CommerceConnectionNotReadyError) {
        return NextResponse.json(
          { error: "Commerce connection is not connected.", code: error.code },
          { status: 409 },
        );
      }
      throw error;
    }

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, field: result.field },
        { status: 400 },
      );
    }

    return NextResponse.json({
      data: {
        storefrontUrl: result.storefrontUrl,
        productRoute: result.productRoute,
        currencyCode: result.currencyCode,
        requiresProductSync: result.requiresProductSync,
      },
    });
  } catch (error) {
    console.error("[brand/commerce/connections/[connectionId]/configuration][PUT] Error:", error);
    return NextResponse.json(
      { error: "Failed to update commerce configuration." },
      { status: 500 },
    );
  }
}
