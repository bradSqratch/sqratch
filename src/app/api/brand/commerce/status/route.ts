import { NextResponse } from "next/server";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import { getActiveCommerceConnectionAnyProvider } from "@/lib/commerce/connection-service";
import type { CommerceConnectionSummary } from "@/lib/commerce/types";

/**
 * PHASE 16C2 — `GET /api/brand/commerce/status`.
 *
 * The provider-neutral counterpart to `/api/brand/shopify/status`: it reports
 * WHICHEVER commerce connection is actually active for the brand — Shopify,
 * Commerce7, or none — using the exact same field names regardless of
 * provider. It does NOT replace `/api/brand/shopify/status`: that route's
 * OAuth-approval / theme-embed / scope-reconciliation fields are legitimately
 * Shopify-specific and stay there unchanged. This route exists so a
 * provider-neutral surface (the Products page's connection summary, a future
 * "Commerce" dashboard card) never has to hard-code "Shopify" to know whether
 * the brand is connected to anything at all.
 */
export type BrandCommerceStatusDeps = {
  getContext(): Promise<BrandAdminContext | null>;
  getConnection(brandId: string): Promise<CommerceConnectionSummary | null>;
};

const DEFAULT_DEPS: BrandCommerceStatusDeps = {
  getContext: getBrandManagementContext,
  getConnection: (brandId) => getActiveCommerceConnectionAnyProvider(brandId),
};

export async function GET() {
  return commerceStatusGetImpl();
}

export async function commerceStatusGetImpl(
  overrides: Partial<BrandCommerceStatusDeps> = {},
) {
  const deps: BrandCommerceStatusDeps = { ...DEFAULT_DEPS, ...overrides };

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
    const connection = await deps.getConnection(brand.id);

    return NextResponse.json({
      data: {
        id: brand.id,
        name: brand.name,
        connection: connection
          ? {
              connectionId: connection.id,
              provider: connection.provider,
              status: connection.status,
              displayName: connection.displayName,
              externalAccountId: connection.externalAccountId,
              isConnected: connection.status === "CONNECTED",
              lastProductSyncAt: connection.lastProductSyncAt,
              // PHASE 16 BIG ROUND / SUBPHASE 1 — no secrets: storefrontUrl,
              // currencyCode, and productRoute are merchant-facing
              // configuration values, not credentials, and are needed to
              // pre-fill the Commerce7 storefront-configuration form.
              storefrontUrl: connection.storefrontUrl,
              currencyCode: connection.currencyCode,
              productRoute: connection.productRoute ?? null,
            }
          : null,
      },
    });
  } catch (error) {
    console.error("[brand/commerce/status][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load commerce status." },
      { status: 500 },
    );
  }
}
