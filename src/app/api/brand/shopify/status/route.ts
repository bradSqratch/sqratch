import { NextResponse } from "next/server";
import { CommerceProvider } from "@prisma/client";
import {
  getBrandContextFailure,
  getBrandManagementContext,
  type BrandAdminContext,
} from "@/lib/brand-auth";
import { getActiveCommerceConnection } from "@/lib/commerce/connection-service";
import { loadShopifyCredential } from "@/lib/commerce/providers/shopify-credential-store";
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

/**
 * PHASE 14C-A — no `Brand.shopify*` field is read anywhere in this route.
 * Every readiness/status/scope/token/client-id field comes from
 * `CommerceConnection` (via `getActiveCommerceConnection`) and
 * `CommerceConnectionSecret` classification (via `loadShopifyCredential`).
 */
export type BrandShopifyStatusDeps = {
  /** Resolves the acting brand-admin context. Defaults to `getBrandManagementContext`. */
  getContext(): Promise<BrandAdminContext | null>;
  /** Resolves the brand's provider-neutral Shopify connection summary. */
  getConnectionSummary(brandId: string): Promise<CommerceConnectionSummary | null>;
  /** Classifies the canonical Shopify credential (presence, authMode, expiry, scopes). Defaults to `loadShopifyCredential`. */
  getCredential(brandId: string): ReturnType<typeof loadShopifyCredential>;
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
   * set. Only ever called when the CANONICAL status is `REQUIRES_RECONNECT`.
   * Optional so a test can omit it entirely when reconciliation isn't the
   * behavior under test. Defaults to `reconcileShopifyConnectionScopes`.
   */
  reconcileScopes?(
    brandId: string,
  ): Promise<{ healedConnection: boolean; grantedScopes: string[] } | null>;
};

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
  getConnectionSummary: (brandId) =>
    getActiveCommerceConnection(brandId, CommerceProvider.SHOPIFY),
  getCredential: (brandId) => loadShopifyCredential(brandId),
  getThemeReadiness: (input) => getShopifyThemeTrackingReadiness(input),
  reconcileScopes: defaultReconcileScopes,
};

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

    // CANONICAL FIRST. `getActiveCommerceConnection` is genuinely
    // canonical-first as of Phase 14B.4B: a `CommerceConnection` row always
    // wins when one exists, with no legacy-agreement check — a stale
    // `Brand.shopify*` mirror can no longer override or disagree-with-and-win
    // over it. Legacy is consulted only for a genuine pre-cutover brand (no
    // canonical row at all), inside `getActiveCommerceConnection` itself.
    const summary = await deps.getConnectionSummary(brand.id);
    let connectionStatus: string = summary?.status ?? "DISCONNECTED";
    let requiresReconnect = connectionStatus === "REQUIRES_RECONNECT";
    let reconciledScopes: string[] | null = null;

    // SAFETY NET against a missed/delayed `app/scopes_update` delivery (see
    // that route's file header), and the HEALING PATH for a connection that
    // was ALREADY stuck in a false, scope-drift-caused `REQUIRES_RECONNECT`
    // before that root cause was fixed (see
    // `reconcileShopifyConnectionScopes`'s doc comment in
    // `shopify-token-manager.ts`). Only ever attempted when the CANONICAL
    // status is currently `REQUIRES_RECONNECT` — a normal `CONNECTED` load
    // never pays for the extra live Shopify API call this can make. Never
    // throws: a failed reconciliation attempt (genuine credential failure, or
    // a transient error) leaves every field exactly as it already was, so
    // this route's response is never worse than before the attempt.
    if (requiresReconnect && deps.reconcileScopes) {
      const reconciled = await deps.reconcileScopes(brand.id).catch(() => null);
      if (reconciled?.healedConnection) {
        connectionStatus = "CONNECTED";
        requiresReconnect = false;
        reconciledScopes = reconciled.grantedScopes;
      }
    }

    // Canonical credential classification — presence, auth mode, expiry.
    // NEVER reads `Brand.shopifyAdminAccessTokenEncrypted`; token PRESENCE is
    // read from `CommerceConnectionSecret`'s mere existence via
    // `loadShopifyCredential`, never decrypted for display purposes beyond
    // what that function already returns for expiry/authMode. Fetched AFTER
    // the healing attempt above so a status heal is reflected here too (a
    // heal never rewrites the credential itself — see
    // `healShopifyCredentialConnected` — only status, so freshness here is
    // about the status/summary having just changed, not the credential).
    const credential = await deps.getCredential(brand.id);
    const hasShopifyAccessToken =
      credential.outcome === "OK" && credential.credential.accessToken !== null;
    const shopifyAuthMode = credential.outcome === "OK" ? credential.credential.authMode : "LEGACY_OFFLINE";
    const shopifyAccessTokenExpiresAt =
      credential.outcome === "OK" ? credential.credential.accessTokenExpiresAt : null;

    const providerClientId =
      credential.outcome === "OK" ? credential.credential.providerClientId : null;

    const shopifyShopDomain = summary?.externalAccountId ?? null;
    const canonicalGrantedScopes = reconciledScopes ?? summary?.grantedScopes ?? [];
    const shopifyGrantedScopes =
      canonicalGrantedScopes.length > 0 ? canonicalGrantedScopes.join(",") : null;

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
      shopifyShopDomain && providerClientId
        ? buildThemeEditorAppEmbedDeepLink({
            shopDomain: shopifyShopDomain,
            apiKey: providerClientId,
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
      shopifyShopDomain && providerClientId
        ? buildShopifyAdminAppHomeDeepLink({
            shopDomain: shopifyShopDomain,
            apiKey: providerClientId,
          })
        : null;
    const shopifyPermissionApprovalUrl =
      appHomeLink !== null && appHomeLink.ok ? appHomeLink.url : null;

    const orderAttributionReady = canonicalGrantedScopes.includes("read_orders");
    const themeVerificationScopeReady = canonicalGrantedScopes.includes("read_themes");
    const themeTracking =
      shopifyShopDomain && providerClientId && deps.getThemeReadiness
        ? await deps.getThemeReadiness({
            brandId: brand.id,
            shopDomain: shopifyShopDomain,
            apiKey: providerClientId,
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
        shopifyInstalledAt: summary?.installedAt ?? null,
        shopifyUninstalledAt: summary?.uninstalledAt ?? null,
        shopifyConnectionStatus: connectionStatus,
        hasShopifyAccessToken,
        shopifyLastProductSyncAt: summary?.lastProductSyncAt ?? null,
        // The single canonical currency representation — see
        // `CommerceConnectionSummary.currencyCode`'s doc comment.
        shopifyCurrencyCode: summary?.currencyCode ?? null,
        shopifyAuthMode,
        shopifyAccessTokenExpiresAt,
        shopifyGrantedScopes,
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
          connectionStatus === "CONNECTED" &&
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
