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
import {
  SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE,
  buildThemeEditorAppEmbedDeepLink,
  buildShopifyAdminAppHomeDeepLink,
} from "@/lib/commerce/shopify-app-embed";
import { getShopifyThemeTrackingReadiness } from "@/lib/commerce/providers/shopify-theme-readiness";
import { reconcileShopifyConnectionScopes } from "@/lib/shopify-token-manager";
import type {
  CommerceConnectionSummary,
  CommerceThemeTrackingReadiness,
} from "@/lib/commerce/types";

/** The `Brand.shopify*` columns not selected by `getBrandManagementContext`. */
type BrandTokenExtra = {
  shopifyAuthMode: ShopifyAuthMode;
  shopifyAccessTokenExpiresAt: Date | null;
  shopifyGrantedScopes: string | null;
  /** Client id of the app this brand installed under, stamped at connect time. */
  shopifyClientId: string | null;
};

export type BrandShopifyStatusDeps = {
  /** Resolves the acting brand-admin context. Defaults to `getBrandManagementContext`. */
  getContext(): Promise<BrandAdminContext | null>;
  /** Loads the token-derived `Brand` columns `getBrandManagementContext` doesn't select. */
  findTokenExtra(brandId: string): Promise<BrandTokenExtra | null>;
  /** Resolves the brand's provider-neutral Shopify connection summary. */
  getConnectionSummary(brandId: string): Promise<CommerceConnectionSummary | null>;
  getThemeReadiness?(input: {
    brandId: string;
    shopDomain: string;
    apiKey: string;
    grantedScopes: string[];
  }): Promise<CommerceThemeTrackingReadiness>;
  /**
   * Attempts to heal a false, scope-drift-caused `REQUIRES_RECONNECT` by
   * proving the stored credential still works against Shopify and
   * reconciling `CommerceConnection.grantedScopes` to Shopify's authoritative
   * set. Only ever called when the stored status is `REQUIRES_RECONNECT`.
   * Optional so a test can omit it entirely when reconciliation isn't the
   * behavior under test. Defaults to `reconcileShopifyConnectionScopes`.
   */
  reconcileScopes?(
    brandId: string,
  ): Promise<{ healedConnection: boolean; grantedScopes: string[] } | null>;
};

async function defaultFindTokenExtra(brandId: string): Promise<BrandTokenExtra | null> {
  return prisma.brand.findUnique({
    where: { id: brandId },
    select: {
      shopifyAuthMode: true,
      shopifyAccessTokenExpiresAt: true,
      shopifyGrantedScopes: true,
      shopifyClientId: true,
    },
  });
}

async function defaultReconcileScopes(
  brandId: string,
): Promise<{ healedConnection: boolean; grantedScopes: string[] } | null> {
  const result = await reconcileShopifyConnectionScopes(brandId);
  return result.outcome === "RECONCILED"
    ? { healedConnection: result.healedConnection, grantedScopes: result.grantedScopes }
    : null;
}

const DEFAULT_DEPS: BrandShopifyStatusDeps = {
  getContext: getBrandManagementContext,
  findTokenExtra: defaultFindTokenExtra,
    getConnectionSummary: (brandId) =>
    getActiveCommerceConnection(brandId, CommerceProvider.SHOPIFY),
  getThemeReadiness: (input) => getShopifyThemeTrackingReadiness(input),
  reconcileScopes: defaultReconcileScopes,
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

    // Mutable local views of legacy connection status: `brand` itself (from
    // `getContext()`, already fetched above) is never re-read, so a
    // successful healing attempt below is reflected by reassigning these
    // rather than re-running full context/session resolution a second time.
    let legacyConnectionStatus: string = brand.shopifyConnectionStatus;
    let requiresReconnect = legacyConnectionStatus === "REQUIRES_RECONNECT";

    // SAFETY NET against a missed/delayed `app/scopes_update` delivery (see
    // that route's file header), and the HEALING PATH for a connection that
    // was ALREADY stuck in a false, scope-drift-caused `REQUIRES_RECONNECT`
    // before that root cause was fixed (see
    // `reconcileShopifyConnectionScopes`'s doc comment in
    // `shopify-token-manager.ts`). Only ever attempted when the stored status
    // is currently `REQUIRES_RECONNECT` — a normal `CONNECTED` load never
    // pays for the extra live Shopify API call this can make. Never throws:
    // a failed reconciliation attempt (genuine credential failure, or a
    // transient error) leaves every field exactly as it already was, so this
    // route's response is never worse than before the attempt.
    if (requiresReconnect && deps.reconcileScopes) {
      const reconciled = await deps.reconcileScopes(brand.id).catch(() => null);
      if (reconciled?.healedConnection) {
        legacyConnectionStatus = "CONNECTED";
        requiresReconnect = false;
      }
    }

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
      summary.status === mapLegacyShopifyStatusToCommerceStatus(legacyConnectionStatus) &&
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
    const shopifyConnectionStatus = mirrorTrusted ? summary.status : legacyConnectionStatus;
    const shopifyLastProductSyncAt = mirrorTrusted
      ? summary.lastProductSyncAt
      : brand.shopifyLastProductSyncAt;

    // Additive: the Theme Editor deep link that opens this shop's current
    // theme with the SQRATCH app-embed block pre-selected, so the merchant can
    // activate storefront conversion tracking in one click. Derived only from
    // this brand's OWN stored shop domain + install-time client id — never
    // from request input (this route takes none) — and the builder is a pure,
    // strictly validating function (see shopify-app-embed.ts). It is null
    // whenever either column is absent (brand never fully connected) or the
    // builder rejects the pair; a null link simply means the UI cannot offer
    // the button yet, and must never be an error for this route.
    const deepLink =
      shopifyShopDomain && brandExtra?.shopifyClientId
        ? buildThemeEditorAppEmbedDeepLink({
            shopDomain: shopifyShopDomain,
            apiKey: brandExtra.shopifyClientId,
            blockHandle: SQRATCH_ATTRIBUTION_EMBED_BLOCK_HANDLE,
          })
        : null;
    const shopifyAppEmbedDeepLink =
      deepLink !== null && deepLink.ok ? deepLink.url : null;

    // Additive: the Shopify Admin App Home deep link used for the "Approve
    // Shopify permissions" CTA. Opening this URL is sufficient by itself —
    // under Shopify-managed installation, Shopify shows its OWN native
    // permission-approval screen at this exact URL whenever a scope approval
    // is pending, before letting the merchant into the app (see
    // shopify-app-embed.ts's file header). Same trusted-inputs-only,
    // server-derived construction as the Theme Editor link above; null under
    // the same conditions.
    const appHomeLink =
      shopifyShopDomain && brandExtra?.shopifyClientId
        ? buildShopifyAdminAppHomeDeepLink({
            shopDomain: shopifyShopDomain,
            apiKey: brandExtra.shopifyClientId,
          })
        : null;
    const shopifyPermissionApprovalUrl =
      appHomeLink !== null && appHomeLink.ok ? appHomeLink.url : null;

    const canonicalGrantedScopes = summary?.grantedScopes ?? [];
    const orderAttributionReady = canonicalGrantedScopes.includes("read_orders");
    const themeVerificationScopeReady = canonicalGrantedScopes.includes("read_themes");
    const themeTracking =
      shopifyShopDomain && brandExtra?.shopifyClientId && deps.getThemeReadiness
        ? await deps.getThemeReadiness({
            brandId: brand.id,
            shopDomain: shopifyShopDomain,
            apiKey: brandExtra.shopifyClientId,
            grantedScopes: canonicalGrantedScopes,
          })
        : {
            provider: CommerceProvider.SHOPIFY,
            state: canonicalGrantedScopes.includes("read_themes")
              ? "UNKNOWN"
              : "PERMISSION_REQUIRED",
          } as CommerceThemeTrackingReadiness;

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
        // Additive capability: legacy installs keep product sync/rewards but
        // cannot receive conversion attribution until they grant read_orders.
        orderAttributionReady,
        // Additive capability: whether read_themes is granted (scope-only —
        // NOT whether the app embed is actually enabled; that is the live,
        // separately-inspected `themeTracking.state` below).
        themeVerificationScopeReady,
        themeTracking,
        overallConversionTrackingReady:
          orderAttributionReady && themeTracking.state === "ENABLED",
        // True when the merchant still needs to approve a Shopify managed-
        // installation scope prompt (read_orders and/or read_themes not yet
        // granted) for a connection that is otherwise healthy. Never true
        // for a disconnected/uninstalled/genuinely-broken connection — the
        // UI's Approve-permissions CTA is only meaningful for an
        // already-connected store.
        shopifyPermissionsNeedApproval:
          shopifyConnectionStatus === "CONNECTED" &&
          (!orderAttributionReady || !themeVerificationScopeReady),
        // Deep link into Shopify Admin's App Home — Shopify shows its own
        // native permission-approval screen here when one is pending. Null
        // under the same conditions as shopifyAppEmbedDeepLink.
        shopifyPermissionApprovalUrl,
        // Additive capability: null until both the shop domain and the
        // install-time client id are present and pass validation.
        shopifyAppEmbedDeepLink,
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
