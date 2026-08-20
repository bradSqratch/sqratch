"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type BrandProfileResponse = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  websiteUrl: string | null;
  logoUrl: string | null;
  coverImageUrl: string | null;
  shopifyShopDomain: string | null;
  shopifyInstalledAt: string | null;
  shopifyUninstalledAt: string | null;
  shopifyConnectionStatus: "DISCONNECTED" | "CONNECTED" | "UNINSTALLED";
  shopifyLastProductSyncAt: string | null;
  /** True once the store has granted the read_orders scope. */
  orderAttributionReady: boolean;
  /** True once the store has granted the read_themes scope (scope only — not live embed state). */
  themeVerificationScopeReady: boolean;
  themeTracking: {
    provider: string;
    state: "PERMISSION_REQUIRED" | "NOT_CONFIGURED" | "DISABLED" | "ENABLED" | "UNKNOWN";
  };
  overallConversionTrackingReady: boolean;
  /** True when a connected store still needs to approve a pending Shopify scope prompt. */
  shopifyPermissionsNeedApproval: boolean;
  /**
   * Shopify Admin App Home deep link — opens Shopify's own native permission
   * approval screen when one is pending. Null means the link cannot be
   * offered yet.
   */
  shopifyPermissionApprovalUrl: string | null;
  /**
   * Theme Editor deep link that pre-selects the SQRATCH app-embed block, built
   * and validated server-side. Null means the link cannot be offered yet.
   */
  shopifyAppEmbedDeepLink: string | null;
} | null;

type ShopifyProduct = {
  id: string;
  title: string;
  handle: string;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  priceRange: {
    min: number | null;
    max: number | null;
  };
  variantIds: string[];
};

type BrandShopifyClientProps = {
  isPublicShopifyApp: boolean;
};

export function BrandShopifyClient({
  isPublicShopifyApp,
}: BrandShopifyClientProps) {
  const searchParams = useSearchParams();
  const [brand, setBrand] = useState<BrandProfileResponse>(null);
  const [shopDomain, setShopDomain] = useState("");
  const [products, setProducts] = useState<ShopifyProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const isConnected = Boolean(
    brand?.shopifyConnectionStatus === "CONNECTED" && brand?.shopifyShopDomain,
  );

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      setMessage(null);

      const oauthError = searchParams.get("error");

      if (oauthError) {
        setError(`Shopify connection failed: ${oauthError.replaceAll("_", " ")}`);
      }

      try {
        const brandData =
          await fetchJson<BrandProfileResponse>("/api/brand/shopify/status");
        setBrand(brandData);
        if (brandData?.shopifyShopDomain) {
          setShopDomain(brandData.shopifyShopDomain);
        }

        if (brandData?.shopifyConnectionStatus === "CONNECTED") {
          if (searchParams.get("connected") === "1") {
            setMessage("Shopify connected successfully.");
          }
        } else if (brandData?.shopifyConnectionStatus === "UNINSTALLED") {
          setMessage(
            "Shopify app was uninstalled from the store. Reconnect to fetch products.",
          );
        } else if (brandData?.shopifyConnectionStatus === "DISCONNECTED") {
          setMessage("Shopify disconnected.");
        }
      } catch (loadError) {
        setError(getErrorMessage(loadError, "Failed to load Shopify status."));
      } finally {
        setLoading(false);
      }
    }

    void load();
  }, [searchParams]);

  async function syncProducts() {
    setSyncing(true);
    setError(null);

    try {
      const productData = await fetchJson<ShopifyProduct[]>(
        "/api/brand/shopify/products",
      );
      setProducts(productData);
    } catch (syncError) {
      setError(getErrorMessage(syncError, "Failed to fetch Shopify products."));
    } finally {
      setSyncing(false);
    }
  }

  async function disconnectShopify() {
    setDisconnecting(true);
    setError(null);
    setMessage(null);

    try {
      const updated = await fetchJson<{
        shopifyShopDomain: string | null;
        shopifyInstalledAt: string | null;
        shopifyUninstalledAt: string | null;
        shopifyConnectionStatus: "DISCONNECTED" | "CONNECTED" | "UNINSTALLED";
        shopifyLastProductSyncAt: string | null;
      }>("/api/brand/shopify/disconnect", {
        method: "POST",
      });

      setBrand((current) =>
        current
          ? {
              ...current,
              ...updated,
            }
          : current,
      );
      setProducts([]);
      setMessage("Shopify disconnected.");
    } catch (disconnectError) {
      setError(
        getErrorMessage(disconnectError, "Failed to disconnect Shopify."),
      );
    } finally {
      setDisconnecting(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Bounded status polling after "Approve Shopify permissions" — Shopify's
  // native approval screen opens in a NEW tab, so this tab has no other way
  // to learn when the merchant finishes. Polls every 4s for at most ~2
  // minutes; stops early once permissions read ready, on unmount, or at the
  // timeout. "Refresh status" (below) remains the always-available manual
  // fallback — polling never replaces it, only supplements it.
  // ---------------------------------------------------------------------------
  const POLL_INTERVAL_MS = 4000;
  const POLL_TIMEOUT_MS = 120_000;
  const [isPollingApproval, setIsPollingApproval] = useState(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const stopApprovalPolling = useCallback(() => {
    if (pollIntervalRef.current !== null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    if (pollTimeoutRef.current !== null) {
      clearTimeout(pollTimeoutRef.current);
      pollTimeoutRef.current = null;
    }
    setIsPollingApproval(false);
  }, []);

  // Always clear any pending timers on unmount — never let a poll interval
  // outlive the component (e.g. after navigating away from this page).
  useEffect(() => {
    return () => {
      if (pollIntervalRef.current !== null) clearInterval(pollIntervalRef.current);
      if (pollTimeoutRef.current !== null) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  const startApprovalPolling = useCallback(() => {
    stopApprovalPolling();
    setIsPollingApproval(true);

    pollIntervalRef.current = setInterval(() => {
      void (async () => {
        try {
          const brandData =
            await fetchJson<BrandProfileResponse>("/api/brand/shopify/status");
          setBrand(brandData);
          if (brandData && !brandData.shopifyPermissionsNeedApproval) {
            stopApprovalPolling();
          }
        } catch {
          // A transient failure during a background poll should not surface
          // as a page error — "Refresh status" remains available, and the
          // next tick simply tries again.
        }
      })();
    }, POLL_INTERVAL_MS);

    pollTimeoutRef.current = setTimeout(() => {
      stopApprovalPolling();
    }, POLL_TIMEOUT_MS);
  }, [stopApprovalPolling]);

  function themeTrackingLabel(state: NonNullable<BrandProfileResponse>["themeTracking"]["state"] | undefined) {
    switch (state) {
      case "ENABLED": return "Enabled";
      case "DISABLED": return "Disabled";
      case "NOT_CONFIGURED": return "Not configured";
      case "PERMISSION_REQUIRED": return "Needs approval";
      default: return "Unknown";
    }
  }

  return (
    <BrandPageShell
      title="Shopify Connect"
      description="Connect the brand Shopify store, view the current connection status, and sync products into the dashboard."
    >
      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading Shopify status...</p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Status</p>
                <p className="mt-2 text-2xl font-semibold">
                  {brand?.shopifyConnectionStatus === "CONNECTED"
                    ? "Connected"
                    : brand?.shopifyConnectionStatus === "UNINSTALLED"
                      ? "Uninstalled"
                      : "Not connected"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Shop domain</p>
                <p className="mt-2 text-sm text-white/80">
                  {brand?.shopifyShopDomain || "Not set"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Last sync</p>
                <p className="mt-2 text-sm text-white/80">
                  {brand?.shopifyLastProductSyncAt
                    ? new Date(brand.shopifyLastProductSyncAt).toLocaleString()
                    : "Never"}
                </p>
              </div>
            </div>

            {isPublicShopifyApp ? (
              <div className="rounded-2xl border border-[#b7a6e8]/20 bg-[#b7a6e8]/10 p-4 text-sm leading-6 text-white/75">
                To connect Shopify, install or open SQRATCH from your Shopify
                Admin. The store connection is completed from the embedded
                SQRATCH app.
              </div>
            ) : (
              <div className="space-y-2">
                <label className="text-sm text-white/70">Shopify domain</label>
                <Input
                  value={shopDomain}
                  onChange={(event) => setShopDomain(event.target.value)}
                  placeholder="your-store.myshopify.com"
                  className="border-white/10 bg-black/20 text-white"
                />
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              {!isPublicShopifyApp ? (
                <Button
                  type="button"
                  onClick={() => {
                    window.location.href = `/api/shopify/oauth/start?shop=${encodeURIComponent(
                      shopDomain,
                    )}`;
                  }}
                  disabled={!shopDomain.trim() || isConnected}
                  className="rounded-full border border-white bg-white text-black"
                >
                  {isConnected ? "Shopify Connected" : "Connect Shopify"}
                </Button>
              ) : null}

              <Button
                type="button"
                variant="outline"
                onClick={() => void syncProducts()}
                disabled={syncing || !isConnected}
                className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
              >
                {syncing ? "Syncing..." : "Fetch products"}
              </Button>

              {isConnected ? (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => void disconnectShopify()}
                  disabled={disconnecting}
                  className="rounded-full border border-red-500/40 bg-red-500 text-white hover:bg-red-500/90"
                >
                  {disconnecting ? "Disconnecting..." : "Disconnect Shopify"}
                </Button>
              ) : null}
            </div>

            {error && <p className="text-sm text-red-300">{error}</p>}
            {message && <p className="text-sm text-emerald-300">{message}</p>}
          </div>
        )}
      </PageCard>

      {isConnected && (
        <PageCard>
          <h2 className="text-xl font-semibold">Conversion tracking</h2>
          <p className="mt-2 text-sm text-white/55">
            Creator-driven orders are attributed once every step below is in
            place. The final step is enabled inside the Shopify Theme Editor.
          </p>

          {brand?.shopifyPermissionsNeedApproval && (
            <div className="mt-5 rounded-2xl border border-amber-400/30 bg-amber-400/10 p-4">
              <h3 className="text-sm font-semibold text-amber-200">
                Shopify permissions need updating
              </h3>
              <p className="mt-2 text-sm leading-6 text-white/75">
                {[
                  !brand.orderAttributionReady ? "Order conversion access" : null,
                  !brand.themeVerificationScopeReady ? "Theme verification access" : null,
                ]
                  .filter(Boolean)
                  .join(" and ")}
                {" "}
                {!brand.orderAttributionReady && !brand.themeVerificationScopeReady ? "are" : "is"}{" "}
                waiting on your approval in Shopify. This does not affect your
                existing product catalog or reward redemptions.
              </p>
              {brand.shopifyPermissionApprovalUrl ? (
                <div className="mt-3 space-y-2">
                  <Button
                    asChild
                    className="rounded-full border border-white bg-white text-black"
                  >
                    <a
                      href={brand.shopifyPermissionApprovalUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={() => startApprovalPolling()}
                    >
                      Approve Shopify permissions
                    </a>
                  </Button>
                  <p className="text-xs text-white/55">
                    This opens SQRATCH in Shopify Admin, where Shopify shows its
                    own permission screen. Review it there and press{" "}
                    <span className="font-medium text-white/75">Update</span>.
                    {isPollingApproval
                      ? " Checking for approval automatically..."
                      : null}
                  </p>
                </div>
              ) : (
                <p className="mt-3 text-xs text-white/55">
                  The approval link becomes available once the store
                  connection finishes installing.
                </p>
              )}
            </div>
          )}

          <div className="mt-5 divide-y divide-white/10 overflow-hidden rounded-2xl border border-white/10 bg-black/20">
            {[
              {
                label: "Shopify connection",
                value:
                  brand?.shopifyConnectionStatus === "CONNECTED"
                    ? "Connected"
                    : brand?.shopifyConnectionStatus === "UNINSTALLED"
                      ? "Uninstalled"
                      : "Not connected",
                ready: brand?.shopifyConnectionStatus === "CONNECTED",
              },
              {
                label: "Product catalog",
                value: brand?.shopifyLastProductSyncAt
                  ? "Ready"
                  : "Not yet synced",
                ready: Boolean(brand?.shopifyLastProductSyncAt),
              },
              {
                label: "Order access",
                value: brand?.orderAttributionReady ? "Ready" : "Needs approval",
                ready: Boolean(brand?.orderAttributionReady),
              },
              {
                label: "Theme verification access",
                value: brand?.themeVerificationScopeReady ? "Ready" : "Needs approval",
                ready: Boolean(brand?.themeVerificationScopeReady),
              },
              {
                label: "Storefront conversion tracking",
                value: themeTrackingLabel(brand?.themeTracking?.state),
                ready: brand?.themeTracking?.state === "ENABLED",
              },
              {
                label: "Overall conversion tracking",
                value: brand?.overallConversionTrackingReady ? "Ready" : "Not ready",
                ready: Boolean(brand?.overallConversionTrackingReady),
              },
            ].map((row) => (
              <div
                key={row.label}
                className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
              >
                <p className="text-sm text-white/55">{row.label}</p>
                <p
                  className={`text-sm ${
                    row.ready ? "text-emerald-300" : "text-amber-300"
                  }`}
                >
                  {row.value}
                </p>
              </div>
            ))}
          </div>

          <Button
            type="button"
            variant="outline"
            onClick={() => window.location.reload()}
            className="mt-4 rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
          >
            Refresh status
          </Button>

          {brand?.shopifyAppEmbedDeepLink ? (
            <div className="mt-5 space-y-3">
              <Button
                asChild
                className="rounded-full border border-white bg-white text-black"
              >
                <a
                  href={brand.shopifyAppEmbedDeepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Enable conversion tracking
                </a>
              </Button>
              <p className="text-sm text-white/55">
                This opens Shopify&apos;s Theme Editor with the SQRATCH block
                ready to enable. Press Save in the editor to activate it.
              </p>
            </div>
          ) : (
            <p className="mt-5 text-sm text-white/55">
              The Theme Editor link becomes available once the store connection
              finishes installing.
            </p>
          )}
        </PageCard>
      )}

      {products.length > 0 && (
        <PageCard>
          <h2 className="text-xl font-semibold">Products</h2>
          <p className="mt-2 text-sm text-white/55">
            Showing up to 100 active Shopify products. Draft, archived, and
            disconnected store products are not shown.
          </p>
          <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {products.map((product) => (
              <div
                key={product.id}
                className="rounded-2xl border border-white/10 bg-black/20 p-4"
              >
                {product.imageUrl ? (
                  <Image
                    src={product.imageUrl}
                    alt={product.title}
                    width={480}
                    height={288}
                    className="mb-4 h-36 w-full rounded-xl border border-white/10 object-cover"
                  />
                ) : (
                  <div className="mb-4 flex h-36 w-full items-center justify-center rounded-xl border border-white/10 bg-white/5 text-xs uppercase tracking-[0.2em] text-white/35">
                    No image
                  </div>
                )}
                <h3 className="font-medium">{product.title}</h3>
                <p className="mt-2 text-sm text-white/55">
                  {product.priceRange.min !== null
                    ? `$${product.priceRange.min}${
                        product.priceRange.max !== null &&
                        product.priceRange.max !== product.priceRange.min
                          ? ` - $${product.priceRange.max}`
                          : ""
                      }`
                    : "No price range"}
                </p>
                <p className="mt-2 text-xs text-white/45">
                  {product.variantIds.length} variants
                </p>
                <a
                  href={product.productUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-4 inline-flex text-sm text-sky-300 underline"
                >
                  Open product
                </a>
              </div>
            ))}
          </div>
        </PageCard>
      )}
    </BrandPageShell>
  );
}
