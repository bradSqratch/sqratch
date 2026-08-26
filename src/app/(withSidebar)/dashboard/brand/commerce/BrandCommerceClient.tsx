"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { parseCommerce7Diagnostics, type Commerce7Diagnostics } from "./commerce-response-validation";

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
    case "DISCONNECTED":
      return "Disconnected";
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

type Commerce7SettingsSyncResponse = {
  storefrontUrl: string;
  currencyCode: string;
  productRoute: string;
  requiresProductSync: boolean;
};

/**
 * PHASE 20 (settings sync round, Parts 5/6) — read-only Commerce7 store
 * settings, sourced ONLY from Commerce7's own Setting API
 * (`POST /api/brand/commerce/connections/[connectionId]/settings/sync`,
 * see `@/lib/commerce/providers/commerce7-settings-sync`). REPLACES the
 * prior manually-authored storefront form: a Brand Admin can no longer type
 * a Website URL/Currency/Product Route directly — Commerce7 is now the sole
 * source of truth for these three fields, matching what the merchant
 * actually has configured on their own Commerce7 account.
 *
 * Disabled (sync button) whenever the connection is not CONNECTED, since the
 * sync path requires it regardless.
 */
function Commerce7StoreSettingsCard({
  connection,
  onSynced,
}: {
  connection: NonNullable<CommerceConnectionSummary>;
  onSynced(next: Commerce7SettingsSyncResponse): void;
}) {
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const disabled = connection.status !== "CONNECTED";
  const hasSettings = Boolean(connection.storefrontUrl && connection.currencyCode && connection.productRoute);

  async function handleSync() {
    setSyncing(true);
    setError(null);
    setMessage(null);
    try {
      const result = await fetchJson<Commerce7SettingsSyncResponse>(
        `/api/brand/commerce/connections/${connection.connectionId}/settings/sync`,
        { method: "POST" },
      );
      setMessage(
        result.requiresProductSync
          ? "Store settings changed. Sync products to refresh prices and product links."
          : "Commerce7 settings synchronized.",
      );
      onSynced(result);
    } catch (syncError) {
      // The route already returns a sanitized message — never the raw
      // Commerce7 Setting response/body.
      setError(getErrorMessage(syncError, "Could not synchronize settings from Commerce7."));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4 space-y-4">
      <div>
        <p className="text-sm font-semibold text-white/85">Commerce7 store settings</p>
        <p className="mt-1 text-xs leading-5 text-white/50">
          Read directly from your Commerce7 account&apos;s own settings — SQRATCH never guesses or
          lets these be typed manually.
        </p>
      </div>

      {hasSettings ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="block space-y-1 sm:col-span-2">
            <span className="text-xs text-white/55">Website URL</span>
            <p className="text-sm text-white/85">{connection.storefrontUrl}</p>
            <span className="block text-[11px] leading-4 text-white/40">Synced from Commerce7</span>
          </div>
          <div className="block space-y-1">
            <span className="text-xs text-white/55">Currency</span>
            <p className="text-sm text-white/85">{connection.currencyCode}</p>
            <span className="block text-[11px] leading-4 text-white/40">Synced from Commerce7</span>
          </div>
          <div className="block space-y-1">
            <span className="text-xs text-white/55">Product Page Route</span>
            <p className="text-sm text-white/85">{connection.productRoute}</p>
            <span className="block text-[11px] leading-4 text-white/40">Synced from Commerce7</span>
          </div>
        </div>
      ) : (
        <p className="text-sm text-white/55">Not synchronized yet.</p>
      )}

      {disabled ? (
        <p className="text-xs text-amber-300/80">Reconnect this Commerce7 account before syncing settings.</p>
      ) : null}
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      {message ? <p className="text-xs text-emerald-300/90">{message}</p> : null}

      <Button
        onClick={() => void handleSync()}
        disabled={disabled || syncing}
        variant="outline"
        className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
      >
        {syncing ? "Syncing..." : "Sync settings from Commerce7"}
      </Button>
    </div>
  );
}

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
        // `fetchJson` already unwraps this route's `{ data }` envelope
        // (no `meta`) — the resolved value IS the diagnostics object.
        const data = await fetchJson<unknown>(
          `/api/brand/commerce/connections/${connectionId}/diagnostics`,
        );
        if (!cancelled) {
          const parsed = parseCommerce7Diagnostics(data);
          if (!parsed) {
            setError("Readiness diagnostics came back in an unexpected format.");
            return;
          }
          setDiagnostics(parsed);
        }
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

type Commerce7DisconnectResponse = { status: "DISCONNECTED" | "ALREADY_DISCONNECTED"; connectionId: string };

/**
 * PHASE 20 HOTFIX (Parts 5/6/8) — the Brand-admin-controlled Commerce7
 * disconnect/reconnect surface. Shown only for a COMMERCE7 connection;
 * Shopify's connect/disconnect lifecycle stays entirely on
 * `/dashboard/brand/shopify` and never routes through here.
 */
function Commerce7ConnectionLifecycleControl({
  connection,
  onChanged,
}: {
  connection: NonNullable<CommerceConnectionSummary>;
  onChanged(): void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appNotInstalled, setAppNotInstalled] = useState(false);

  async function handleDisconnect() {
    const confirmed = window.confirm(
      "Disconnect this Commerce7 store from SQRATCH?\n\n" +
        "Historical products, orders, and analytics will be preserved. " +
        "New syncs, public product links, and order ingestion will stop until you reconnect.",
    );
    if (!confirmed) return;

    setBusy(true);
    setError(null);
    try {
      await fetchJson<Commerce7DisconnectResponse>(
        `/api/brand/commerce/connections/${connection.connectionId}/disconnect`,
        { method: "POST" },
      );
      onChanged();
    } catch (disconnectError) {
      setError(getErrorMessage(disconnectError, "Failed to disconnect Commerce7."));
    } finally {
      setBusy(false);
    }
  }

  async function handleReconnect() {
    setBusy(true);
    setError(null);
    setAppNotInstalled(false);
    try {
      // Raw fetch (not the unwrapping `fetchJson`) — the 409 APP_NOT_INSTALLED
      // response carries a `code` this handler needs to branch on directly,
      // which `fetchJson`'s throw-on-error path does not preserve.
      const response = await fetch(
        `/api/brand/commerce/connections/${connection.connectionId}/reconnect`,
        { method: "POST", credentials: "include" },
      );
      const json = await response.json().catch(() => null);
      if (!response.ok) {
        if (response.status === 409 && json?.code === "APP_NOT_INSTALLED") {
          setAppNotInstalled(true);
          return;
        }
        throw new Error(json?.error || "Failed to reconnect Commerce7.");
      }
      onChanged();
    } catch (reconnectError) {
      setError(getErrorMessage(reconnectError, "Failed to reconnect Commerce7."));
    } finally {
      setBusy(false);
    }
  }

  if (connection.status === "CONNECTED") {
    return (
      <div className="space-y-2">
        <Button
          onClick={() => void handleDisconnect()}
          disabled={busy}
          variant="outline"
          className="rounded-full border-red-400/30 bg-transparent text-red-200 hover:bg-red-400/10"
        >
          {busy ? "Disconnecting..." : "Disconnect Commerce7"}
        </Button>
        {error ? <p className="text-xs text-red-300">{error}</p> : null}
        <p className="text-[11px] leading-4 text-white/40">
          To connect a different Commerce7 store, disconnect this store first, then open/install
          SQRATCH from the other Commerce7 account and link it to this Brand.
        </p>
      </div>
    );
  }

  if (connection.status === "DISCONNECTED") {
    return (
      <div className="space-y-2">
        <Button
          onClick={() => void handleReconnect()}
          disabled={busy}
          className="rounded-full border border-white bg-white text-black hover:bg-white/90"
        >
          {busy ? "Reconnecting..." : "Reconnect"}
        </Button>
        {appNotInstalled ? (
          <p className="text-xs text-amber-300/80">
            SQRATCH is no longer installed in this Commerce7 account. Reinstall it from Commerce7
            Apps &amp; Extensions.
          </p>
        ) : error ? (
          <p className="text-xs text-red-300">{error}</p>
        ) : null}
        <p className="text-[11px] leading-4 text-white/40">
          You can also connect a different Commerce7 store by opening SQRATCH from that Commerce7
          account.
        </p>
      </div>
    );
  }

  return null;
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

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchJson<BrandCommerceStatusResponse>(
        "/api/brand/commerce/status",
      );
      setStatus(data);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load commerce status."));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

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
                <Commerce7StoreSettingsCard
                  connection={connection}
                  onSynced={(next) =>
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
                <Commerce7ConnectionLifecycleControl connection={connection} onChanged={load} />
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
