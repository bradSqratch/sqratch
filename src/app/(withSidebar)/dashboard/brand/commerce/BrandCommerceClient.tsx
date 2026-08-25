"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type CommerceConnectionSummary = {
  connectionId: string;
  provider: "SHOPIFY" | "COMMERCE7";
  status: "PENDING" | "CONNECTED" | "REQUIRES_RECONNECT" | "DISCONNECTED" | "UNINSTALLED" | "ERROR";
  displayName: string;
  externalAccountId: string;
  isConnected: boolean;
  lastProductSyncAt: string | null;
  storefrontUrl: string | null;
  currencyCode: string | null;
  productRoute: string | null;
} | null;

type BrandCommerceStatusResponse = {
  id: string;
  name: string;
  connection: CommerceConnectionSummary;
} | null;

const PROVIDER_LABELS: Record<string, string> = {
  SHOPIFY: "Shopify",
  COMMERCE7: "Commerce7",
};

function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

function statusLabel(status: string): string {
  switch (status) {
    case "CONNECTED":
      return "Connected";
    case "REQUIRES_RECONNECT":
      return "Needs reconnect";
    case "UNINSTALLED":
      return "Uninstalled";
    case "PENDING":
      return "Pending";
    case "ERROR":
      return "Error";
    default:
      return "Not connected";
  }
}

function formatDateTime(value: string | null): string {
  if (!value) return "Never";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

type Commerce7ConfigurationResponse = {
  storefrontUrl: string;
  productRoute: string;
  currencyCode: string;
  requiresProductSync: boolean;
};

/**
 * PHASE 16 BIG ROUND / SUBPHASE 1 — the Commerce7-only storefront
 * configuration form. Never rendered for a SHOPIFY connection (Shopify's
 * storefront URL is provider-derived, not merchant-configured — see
 * `deriveShopifyStorefrontUrl` in `connection-service.ts`). Disabled
 * (fields + Save) whenever the connection is not CONNECTED, since the write
 * path (`configureCommerce7Storefront`) rejects a non-CONNECTED connection
 * regardless.
 */
function Commerce7StorefrontConfigForm({
  connection,
  onSaved,
}: {
  connection: NonNullable<CommerceConnectionSummary>;
  onSaved(next: Commerce7ConfigurationResponse): void;
}) {
  const [storefrontUrl, setStorefrontUrl] = useState(connection.storefrontUrl ?? "");
  const [productRoute, setProductRoute] = useState(connection.productRoute ?? "");
  const [currencyCode, setCurrencyCode] = useState(connection.currencyCode ?? "");
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);

  const disabled = connection.status !== "CONNECTED";

  async function handleSave() {
    setSaving(true);
    setFormError(null);
    setSavedMessage(null);
    try {
      const result = await fetchJson<Commerce7ConfigurationResponse>(
        `/api/brand/commerce/connections/${connection.connectionId}/configuration`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storefrontUrl, productRoute, currencyCode }),
        },
      );
      setStorefrontUrl(result.storefrontUrl);
      setProductRoute(result.productRoute);
      setCurrencyCode(result.currencyCode);
      setSavedMessage(
        result.requiresProductSync
          ? "Saved. Run a product sync to apply the new configuration to your catalog."
          : "Saved.",
      );
      onSaved(result);
    } catch (saveError) {
      setFormError(getErrorMessage(saveError, "Failed to save storefront configuration."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4 space-y-4">
      <div>
        <p className="text-sm font-semibold text-white/85">Commerce7 storefront settings</p>
        <p className="mt-1 text-xs leading-5 text-white/50">
          SQRATCH cannot automatically detect your Commerce7 storefront address.
          Enter it exactly as customers see it, along with the URL prefix your
          site uses for product pages and the currency you sell in. Saving a
          changed value clears previously-synced prices and public product
          links for this connection until you sync again.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1 sm:col-span-2">
          <span className="text-xs text-white/55">Website URL</span>
          <Input
            value={storefrontUrl}
            onChange={(e) => setStorefrontUrl(e.target.value)}
            placeholder="https://www.yourwinery.com"
            disabled={disabled || saving}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-white/55">Product page route</span>
          <Input
            value={productRoute}
            onChange={(e) => setProductRoute(e.target.value)}
            placeholder="/product"
            disabled={disabled || saving}
          />
        </label>
        <label className="block space-y-1">
          <span className="text-xs text-white/55">Currency</span>
          <Input
            value={currencyCode}
            onChange={(e) => setCurrencyCode(e.target.value.toUpperCase())}
            placeholder="USD"
            maxLength={3}
            disabled={disabled || saving}
          />
        </label>
      </div>

      {disabled ? (
        <p className="text-xs text-amber-300/80">
          Reconnect this Commerce7 account before configuring storefront settings.
        </p>
      ) : null}
      {formError ? <p className="text-xs text-red-300">{formError}</p> : null}
      {savedMessage ? <p className="text-xs text-emerald-300/90">{savedMessage}</p> : null}

      <Button
        onClick={handleSave}
        disabled={disabled || saving}
        className="rounded-full border border-white bg-white text-black hover:bg-white/90"
      >
        {saving ? "Saving..." : "Save"}
      </Button>
    </div>
  );
}

type Commerce7Diagnostics = {
  connectionId: string;
  connected: boolean;
  storefrontUrlConfigured: boolean;
  productRouteConfigured: boolean;
  currencyConfigured: boolean;
  productsSynced: boolean;
  lastProductSyncAt: string | null;
  orderReceiverConfigured: boolean;
  latestOrderIngestedAt: string | null;
  latestWebhookProcessedAt: string | null;
  latestFailedWebhookEvent: { receivedAt: string; failureSummary: string | null } | null;
  orderReadOperational: boolean;
};

function ChecklistRow({ ok, label, detail }: { ok: boolean | null; label: string; detail?: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div>
        <p className="text-sm text-white/80">{label}</p>
        {detail ? <p className="mt-0.5 text-xs text-white/45">{detail}</p> : null}
      </div>
      <span
        className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs ${
          ok === null
            ? "border-white/15 bg-white/5 text-white/50"
            : ok
              ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200/90"
              : "border-amber-400/25 bg-amber-400/10 text-amber-200/90"
        }`}
      >
        {ok === null ? "—" : ok ? "✓" : "Not yet"}
      </span>
    </div>
  );
}

/**
 * PHASE 19 — PART 15: a Commerce7 setup/readiness checklist, backed by the
 * sanitized diagnostics endpoint (`GET
 * /api/brand/commerce/connections/[connectionId]/diagnostics`). Never
 * claims Commerce7's own webhook subscription is verified — SQRATCH cannot
 * observe that fact, so that line is always static, unconditional guidance
 * to check Commerce7 directly, never a computed checkmark.
 */
function Commerce7ReadinessChecklist({ connectionId }: { connectionId: string }) {
  const [diagnostics, setDiagnostics] = useState<Commerce7Diagnostics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchJson<{ data: Commerce7Diagnostics }>(
          `/api/brand/commerce/connections/${connectionId}/diagnostics`,
        );
        if (!cancelled) setDiagnostics(data.data);
      } catch (loadError) {
        if (!cancelled) setError(getErrorMessage(loadError, "Failed to load readiness checklist."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4 space-y-3">
      <p className="text-sm font-semibold text-white/85">Commerce7 readiness</p>
      {loading ? (
        <p className="text-sm text-white/65">Loading...</p>
      ) : error ? (
        <p className="text-sm text-red-300">{error}</p>
      ) : diagnostics ? (
        <div className="divide-y divide-white/5">
          <ChecklistRow ok={diagnostics.connected} label="Connection" />
          <ChecklistRow ok={diagnostics.storefrontUrlConfigured} label="Website URL configured" />
          <ChecklistRow ok={diagnostics.productRouteConfigured} label="Product route configured" />
          <ChecklistRow ok={diagnostics.currencyConfigured} label="Currency configured" />
          <ChecklistRow
            ok={diagnostics.productsSynced}
            label="Products synced"
            detail={`Last sync: ${formatDateTime(diagnostics.lastProductSyncAt)}`}
          />
          <ChecklistRow
            ok={diagnostics.orderReceiverConfigured}
            label="SQRATCH order webhook receiver"
            detail="Reflects only SQRATCH's own receiver readiness."
          />
          <ChecklistRow
            ok={null}
            label="Commerce7 webhook subscription"
            detail="Not observable from SQRATCH — verify directly in your Commerce7 admin."
          />
          <ChecklistRow
            ok={diagnostics.latestOrderIngestedAt !== null}
            label="Orders ingested"
            detail={`Last order: ${formatDateTime(diagnostics.latestOrderIngestedAt)}`}
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * PHASE 16C2 — provider-neutral "Store" landing page. Reads
 * `/api/brand/commerce/status` (whichever provider the brand actually uses)
 * rather than assuming Shopify. This is deliberately a thin STATUS surface,
 * not a second connect flow: Shopify connection/OAuth management stays on
 * `/dashboard/brand/shopify` (linked below when relevant), and Commerce7
 * connection happens through the Commerce7 Admin Extension, not a SQRATCH
 * page.
 */
export function BrandCommerceClient() {
  const [status, setStatus] = useState<BrandCommerceStatusResponse>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchJson<BrandCommerceStatusResponse>(
          "/api/brand/commerce/status",
        );
        if (!cancelled) setStatus(data);
      } catch (loadError) {
        if (!cancelled) {
          setError(getErrorMessage(loadError, "Failed to load commerce status."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const connection = status?.connection ?? null;

  return (
    <BrandPageShell
      title="Store"
      description="The commerce store connected to this brand — whichever provider it uses."
    >
      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading store status...</p>
        ) : error ? (
          <p className="text-sm text-red-300">{error}</p>
        ) : (
          <div className="space-y-5">
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Provider</p>
                <p className="mt-2 text-2xl font-semibold">
                  {connection ? providerLabel(connection.provider) : "Not connected"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Status</p>
                <p className="mt-2 text-2xl font-semibold">
                  {connection ? statusLabel(connection.status) : "Not connected"}
                </p>
              </div>
              <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
                <p className="text-sm text-white/55">Last product sync</p>
                <p className="mt-2 text-sm text-white/80">
                  {formatDateTime(connection?.lastProductSyncAt ?? null)}
                </p>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="text-sm text-white/55">Connected account</p>
              <p className="mt-2 text-sm text-white/80">
                {connection
                  ? `${connection.displayName} (${connection.externalAccountId})`
                  : "No store connected yet."}
              </p>
            </div>

            {connection?.provider === "COMMERCE7" ? (
              <>
                <Commerce7StorefrontConfigForm
                  connection={connection}
                  onSaved={(next) =>
                    setStatus((prev) =>
                      prev?.connection
                        ? {
                            ...prev,
                            connection: {
                              ...prev.connection,
                              storefrontUrl: next.storefrontUrl,
                              productRoute: next.productRoute,
                              currencyCode: next.currencyCode,
                            },
                          }
                        : prev,
                    )
                  }
                />
                <Commerce7ReadinessChecklist connectionId={connection.connectionId} />
              </>
            ) : null}

            {!connection ? (
              <p className="text-xs leading-5 text-white/50">
                Connect Shopify from the{" "}
                <a href="/dashboard/brand/shopify" className="underline hover:text-white/80">
                  Shopify page
                </a>
                , or install the SQRATCH app from your Commerce7 admin and link
                it to this brand.
              </p>
            ) : connection.provider === "SHOPIFY" ? (
              <Button asChild variant="outline" className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10">
                <a href="/dashboard/brand/shopify">Manage Shopify connection</a>
              </Button>
            ) : null}

            <div className="flex flex-wrap gap-3">
              <Button asChild className="rounded-full border border-white bg-white text-black hover:bg-white/90">
                <a href="/dashboard/brand/products">View products</a>
              </Button>
              {connection ? (
                <Button
                  asChild
                  variant="outline"
                  className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                >
                  <Link href="/dashboard/brand/commerce/orders">Order operations</Link>
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </PageCard>
    </BrandPageShell>
  );
}
