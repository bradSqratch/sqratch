"use client";

import { useEffect, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";

type CommerceConnectionSummary = {
  connectionId: string;
  provider: "SHOPIFY" | "COMMERCE7";
  status: "PENDING" | "CONNECTED" | "REQUIRES_RECONNECT" | "DISCONNECTED" | "UNINSTALLED" | "ERROR";
  displayName: string;
  externalAccountId: string;
  isConnected: boolean;
  lastProductSyncAt: string | null;
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

            <Button asChild className="rounded-full border border-white bg-white text-black hover:bg-white/90">
              <a href="/dashboard/brand/products">View products</a>
            </Button>
          </div>
        )}
      </PageCard>
    </BrandPageShell>
  );
}
