"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BrandPageShell } from "@/components/brand/page-shell";
import { getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { formatMoneyDisplay } from "@/lib/commerce/money";

type CommerceProvider = "SHOPIFY" | "COMMERCE7";

type OrderDetailLineItem = {
  id: string;
  title: string | null;
  sku: string | null;
  quantity: number;
  unitPriceMinor: string | null;
  totalMinor: string | null;
  externalProductId: string | null;
  externalVariantId: string | null;
  connectedProductId: string | null;
};

type OrderDetail = {
  id: string;
  connectionId: string;
  provider: CommerceProvider;
  connectionDisplayName: string;
  connectionExternalAccountId: string;
  orderNumber: string | null;
  orderDate: string;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  currencyCode: string | null;
  /**
   * PHASE 19 REPAIR (P1-3): the EXACT persisted exponent — never assume 2
   * decimal places or derive one from `currencyCode` client-side.
   */
  minorUnitExponent: number | null;
  subtotalMinor: string | null;
  shippingMinor: string | null;
  taxMinor: string | null;
  totalMinor: string | null;
  totalRefundedMinor: string | null;
  netRevenueMinor: string | null;
  attributed: boolean;
  createdAt: string;
  updatedAt: string;
  lineItems: OrderDetailLineItem[];
};

const PROVIDER_LABELS: Record<CommerceProvider, string> = {
  SHOPIFY: "Shopify",
  COMMERCE7: "Commerce7",
};

const FINANCIAL_STATUS_LABELS: Record<string, string> = {
  PENDING: "Pending",
  AUTHORIZED: "Authorized",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Refunded",
  VOIDED: "Voided",
};

const FULFILLMENT_STATUS_LABELS: Record<string, string> = {
  UNFULFILLED: "Unfulfilled",
  PARTIALLY_FULFILLED: "Partially fulfilled",
  FULFILLED: "Fulfilled",
  RESTOCKED: "Restocked",
};

function formatDateTime(value: string | null): string {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function OrderDetailClient({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      setNotFound(false);
      try {
        const response = await fetch(`/api/brand/commerce/orders/${orderId}`, { credentials: "include" });
        if (response.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        const json = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(json?.error ?? "Failed to load order.");
        }
        if (!cancelled) setOrder(json?.data ?? null);
      } catch (loadError) {
        if (!cancelled) setError(getErrorMessage(loadError, "Failed to load order."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [orderId]);

  return (
    <BrandPageShell title="Order detail" description="Financial summary, line items, and attribution for one order.">
      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading order...</p>
        ) : notFound ? (
          <p className="text-sm text-white/65">That order was not found.</p>
        ) : error ? (
          <p className="text-sm text-red-300">{error}</p>
        ) : !order ? (
          <p className="text-sm text-white/65">That order was not found.</p>
        ) : (
          <div className="space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-2xl font-semibold text-white/90">
                  Order {order.orderNumber ?? `#${order.id.slice(0, 8)}`}
                </p>
                <p className="mt-1 text-sm text-white/55">
                  {PROVIDER_LABELS[order.provider]} — {order.connectionDisplayName} (
                  {order.connectionExternalAccountId})
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/70">
                  {order.financialStatus ? FINANCIAL_STATUS_LABELS[order.financialStatus] ?? order.financialStatus : "Unknown"}
                </span>
                <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/70">
                  {order.fulfillmentStatus
                    ? FULFILLMENT_STATUS_LABELS[order.fulfillmentStatus] ?? order.fulfillmentStatus
                    : "Unknown"}
                </span>
                <span
                  className={`rounded-full border px-3 py-1 text-xs ${
                    order.attributed
                      ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-200/90"
                      : "border-white/15 bg-white/5 text-white/60"
                  }`}
                >
                  {order.attributed ? "Attributed" : "Unattributed"}
                </span>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <p className="text-xs text-white/50">Order date</p>
                <p className="mt-1 text-sm text-white/80">{formatDateTime(order.orderDate)}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <p className="text-xs text-white/50">Last updated</p>
                <p className="mt-1 text-sm text-white/80">{formatDateTime(order.updatedAt)}</p>
              </div>
              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <p className="text-xs text-white/50">Currency</p>
                <p className="mt-1 text-sm text-white/80">{order.currencyCode ?? "Unknown"}</p>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="text-sm font-semibold text-white/85">Financial summary</p>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-white/50">Subtotal</p>
                  <p className="mt-1 text-sm text-white/80">{formatMoneyDisplay(order.subtotalMinor, order.currencyCode, order.minorUnitExponent)}</p>
                </div>
                <div>
                  <p className="text-xs text-white/50">Shipping</p>
                  <p className="mt-1 text-sm text-white/80">{formatMoneyDisplay(order.shippingMinor, order.currencyCode, order.minorUnitExponent)}</p>
                </div>
                <div>
                  <p className="text-xs text-white/50">Tax</p>
                  <p className="mt-1 text-sm text-white/80">{formatMoneyDisplay(order.taxMinor, order.currencyCode, order.minorUnitExponent)}</p>
                </div>
                <div>
                  <p className="text-xs text-white/50">Total</p>
                  <p className="mt-1 text-sm font-semibold text-white/90">
                    {formatMoneyDisplay(order.totalMinor, order.currencyCode, order.minorUnitExponent)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-white/50">Refunded</p>
                  <p className="mt-1 text-sm text-white/80">{formatMoneyDisplay(order.totalRefundedMinor, order.currencyCode, order.minorUnitExponent)}</p>
                </div>
                <div>
                  <p className="text-xs text-white/50">Net revenue</p>
                  <p className="mt-1 text-sm font-semibold text-white/90">
                    {formatMoneyDisplay(order.netRevenueMinor, order.currencyCode, order.minorUnitExponent)}
                  </p>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="text-sm font-semibold text-white/85">Line items</p>
              {order.lineItems.length === 0 ? (
                <p className="mt-2 text-xs text-white/50">No line items recorded for this order.</p>
              ) : (
                <div className="mt-3 space-y-2">
                  {order.lineItems.map((item) => (
                    <div
                      key={item.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 p-3"
                    >
                      <div>
                        <p className="text-sm text-white/80">{item.title ?? "Untitled item"}</p>
                        <p className="mt-1 text-xs text-white/45">
                          {item.sku ? `SKU ${item.sku}` : "No SKU"} — Qty {item.quantity}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="text-sm text-white/80">{formatMoneyDisplay(item.unitPriceMinor, order.currencyCode, order.minorUnitExponent)} each</p>
                        <p className="mt-1 text-xs text-white/50">{formatMoneyDisplay(item.totalMinor, order.currencyCode, order.minorUnitExponent)} total</p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <Button asChild variant="outline" className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10">
              <Link href="/dashboard/brand/commerce/orders">Back to order operations</Link>
            </Button>
          </div>
        )}
      </PageCard>
    </BrandPageShell>
  );
}
