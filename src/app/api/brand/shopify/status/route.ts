import { NextResponse } from "next/server";
import { CommerceProvider, type ShopifyAuthMode } from "@prisma/client";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { getActiveCommerceConnection } from "@/lib/commerce/connection-service";
import { mapLegacyShopifyStatusToCommerceStatus } from "@/lib/commerce/connection-resolver";
import type { CommerceConnectionSummary } from "@/lib/commerce/types";

/** The `Brand.shopify*` token-derived columns not selected by `getBrandManagementContext`. */
type BrandTokenExtra = {
  shopifyAuthMode: ShopifyAuthMode;
  shopifyAccessTokenExpiresAt: Date | null;
  shopifyGrantedScopes: string | null;
};

export type BrandShopifyStatusDeps = {
  /** Resolves the acting brand-admin context. Defaults to `getBrandManagementContext`. */
  getContext(): Promise<BrandAdminContext | null>;
  /** Loads the token-derived `Brand` columns `getBrandManagementContext` doesn't select. */
  findTokenExtra(brandId: string): Promise<BrandTokenExtra | null>;
  /** Resolves the brand's provider-neutral Shopify connection summary. */
  getConnectionSummary(brandId: string): Promise<CommerceConnectionSummary | null>;
};

async function defaultFindTokenExtra(brandId: string): Promise<BrandTokenExtra | null> {
  return prisma.brand.findUnique({
    where: { id: brandId },
    select: {
      shopifyAuthMode: true,
      shopifyAccessTokenExpiresAt: true,
      shopifyGrantedScopes: true,
    },
  });
}

const DEFAULT_DEPS: BrandShopifyStatusDeps = {
  getContext: getBrandManagementContext,
  findTokenExtra: defaultFindTokenExtra,
  getConnectionSummary: (brandId) =>
    getActiveCommerceConnection(brandId, CommerceProvider.SHOPIFY),
};

/** `Date | null` equality by timestamp — `null` only equals `null`. */
function sameInstant(a: Date | null, b: Date | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.getTime() === b.getTime();
}

export async function GET() {
  return statusGetImpl();
}

export async function statusGetImpl(overrides: Partial<BrandShopifyStatusDeps> = {}) {
  const deps: BrandShopifyStatusDeps = { ...DEFAULT_DEPS, ...overrides };

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

    // Fetch the additional fields that brand-auth doesn't include in its
    // select. Token-derived (hasShopifyAccessToken, shopifyAuthMode,
    // shopifyAccessTokenExpiresAt, shopifyGrantedScopes, requiresReconnect)
    // — these stay legacy-authoritative for the whole of Phase 2; this
    // route never reads CommerceConnectionSecret.
    const brandExtra = await deps.findTokenExtra(brand.id);

    const requiresReconnect =
      brand.shopifyConnectionStatus === "REQUIRES_RECONNECT";

    // Connection identity/metadata (shop domain, install/uninstall
    // timestamps, status, last product sync) is sourced from the
    // provider-neutral service. `CommerceConnectionSummary` has no
    // credential field and — by construction — carries no
    // `shopifyDisconnectedAt` / `shopifyCurrencyCode` at all (see
    // src/lib/commerce/types.ts), so those two fields always come straight
    // from the legacy Brand columns already loaded by
    // getBrandManagementContext; there is nothing to cut over for them.
    //
    // For the remaining fields, `getActiveCommerceConnection`'s own
    // consistency check (see connection-service.ts's file header) only
    // verifies that the mirror's shop domain agrees with legacy — it does
    // NOT re-verify that the mirror's status/timestamps are still in sync
    // (the CommerceConnection dual-write is best-effort and can lag or fail
    // independently of the legacy write it mirrors). So each field below is
    // only taken from the summary once it is verified, field-by-field, to
    // already equal what legacy says; on any mismatch this falls back to
    // the legacy value. Per the Phase-2 instruction that correctness beats
    // architectural purity for this route, that means the emitted response
    // is always identical to the legacy-only computation this route used
    // before the cutover — a later reconciliation tool, not this route, is
    // responsible for actually repairing a stale mirror.
    const summary = await deps.getConnectionSummary(brand.id);
    const mirrorTrusted =
      summary !== null &&
      !summary.isLegacyFallback &&
      summary.status === mapLegacyShopifyStatusToCommerceStatus(brand.shopifyConnectionStatus) &&
      sameInstant(summary.installedAt, brand.shopifyInstalledAt) &&
      sameInstant(summary.uninstalledAt, brand.shopifyUninstalledAt) &&
      sameInstant(summary.lastProductSyncAt, brand.shopifyLastProductSyncAt);

    // shopifyShopDomain deliberately stays on the legacy literal value even
    // when the mirror is otherwise trusted: `CommerceConnection.externalAccountId`
    // is written normalized (trim + lowercase — see
    // connection-sync.ts's normalizeExternalAccountId), while legacy
    // `Brand.shopifyShopDomain` has no such normalization guarantee at this
    // layer. Preferring legacy here removes any risk of a case-only diff
    // changing this user-visible field, at zero cost (both already refer to
    // the same shop).
    const shopifyShopDomain = brand.shopifyShopDomain;
    const shopifyInstalledAt = mirrorTrusted ? summary.installedAt : brand.shopifyInstalledAt;
    const shopifyUninstalledAt = mirrorTrusted ? summary.uninstalledAt : brand.shopifyUninstalledAt;
    const shopifyConnectionStatus = mirrorTrusted ? summary.status : brand.shopifyConnectionStatus;
    const shopifyLastProductSyncAt = mirrorTrusted
      ? summary.lastProductSyncAt
      : brand.shopifyLastProductSyncAt;

    return NextResponse.json({
      data: {
        id: brand.id,
        name: brand.name,
        slug: brand.slug,
        shopifyShopDomain,
        shopifyInstalledAt,
        shopifyDisconnectedAt: brand.shopifyDisconnectedAt,
        shopifyUninstalledAt,
        shopifyConnectionStatus,
        hasShopifyAccessToken: Boolean(
          brand.shopifyAdminAccessTokenEncrypted,
        ),
        shopifyLastProductSyncAt,
        shopifyCurrencyCode: brand.shopifyCurrencyCode,
        // Additive fields — token mode and reconnect state. Legacy-only, per
        // the Phase-2 instruction that token-derived fields never come from
        // the neutral service (which never reads CommerceConnectionSecret).
        shopifyAuthMode: brandExtra?.shopifyAuthMode ?? "LEGACY_OFFLINE",
        shopifyAccessTokenExpiresAt: brandExtra?.shopifyAccessTokenExpiresAt ?? null,
        shopifyGrantedScopes: brandExtra?.shopifyGrantedScopes ?? null,
        requiresReconnect,
      },
    });
  } catch (error) {
    console.error("[brand/shopify/status][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load Shopify status." },
      { status: 500 },
    );
  }
}
