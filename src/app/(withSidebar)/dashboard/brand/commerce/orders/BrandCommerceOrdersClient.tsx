"use client";

import { useEffect, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { formatMoneyDisplay } from "@/lib/commerce/money";

type CommerceProvider = "SHOPIFY" | "COMMERCE7";
type CommerceConnectionStatus =
  | "PENDING"
  | "CONNECTED"
  | "REQUIRES_RECONNECT"
  | "DISCONNECTED"
  | "UNINSTALLED"
  | "ERROR";
type CommerceOrderFinancialStatus =
  | "PENDING"
  | "AUTHORIZED"
  | "PARTIALLY_PAID"
  | "PAID"
  | "PARTIALLY_REFUNDED"
  | "REFUNDED"
  | "VOIDED";

type ConnectionOrderOperationsSummary = {
  connectionId: string;
  provider: CommerceProvider;
  displayName: string;
  externalAccountId: string;
  status: CommerceConnectionStatus;
  latestOrderIngestedAt: string | null;
  latestWebhookProcessedAt: string | null;
  orderCountsByFinancialStatus: Partial<Record<CommerceOrderFinancialStatus, number>>;
  unknownFinancialStatusCount: number;
  attributedOrderCount: number;
  unattributedOrderCount: number;
  orderReceiverConfigured: boolean | null;
};

type BrandOrderOperationsSummary = {
  connections: ConnectionOrderOperationsSummary[];
  complete: boolean;
};

type ReconcileResult = {
  status: "SUCCEEDED" | "PARTIAL";
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  failedCount: number;
  truncated: boolean;
};

const PROVIDER_LABELS: Record<CommerceProvider, string> = {
  SHOPIFY: "Shopify",
  COMMERCE7: "Commerce7",
};

const FINANCIAL_STATUS_LABELS: Record<CommerceOrderFinancialStatus, string> = {
  PENDING: "Pending",
  AUTHORIZED: "Authorized",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Refunded",
  VOIDED: "Voided",
};

const FINANCIAL_STATUS_ORDER: CommerceOrderFinancialStatus[] = [
  "PAID",
  "PARTIALLY_PAID",
  "AUTHORIZED",
  "PENDING",
  "PARTIALLY_REFUNDED",
  "REFUNDED",
  "VOIDED",
];

function statusLabel(status: CommerceConnectionStatus): string {
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
      return "Disconnected";
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
 * PHASE 18 — PART 9 UI entry point: a bounded, explicit, one-click
 * reconciliation of the last 24 hours only. Deliberately not configurable
 * from this card (a wider window is available directly against the API for
 * an operator who needs it) — this keeps the common "did today's orders
 * come through" action a single click without exposing the raw
 * `from`/`to` bounds this route enforces server-side.
 */
function ReconcileButton({
  connectionId,
  disabled,
  onSuccess,
}: {
  connectionId: string;
  disabled: boolean;
  onSuccess: () => void;
}) {
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ReconcileResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleReconcile() {
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const to = new Date();
      const from = new Date(to.getTime() - 24 * 60 * 60 * 1000);
      const data = await fetchJson<{ data: ReconcileResult }>(
        `/api/brand/commerce/connections/${connectionId}/orders/reconcile`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from: from.toISOString(), to: to.toISOString() }),
        },
      );
      setResult(data.data);
      // PHASE 19 — PART 16: refresh the summary/order list on success so a
      // just-reconciled order is immediately visible, not only after a
      // manual page reload.
      onSuccess();
    } catch (reconcileError) {
      setError(getErrorMessage(reconcileError, "Failed to reconcile orders."));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-2">
      <Button
        onClick={handleReconcile}
        disabled={disabled || running}
        variant="outline"
        className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
      >
        {running ? "Reconciling..." : "Reconcile last 24 hours"}
      </Button>
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      {result ? (
        <p className="text-xs text-white/60">
          Fetched {result.fetchedCount}, created {result.createdCount}, updated {result.updatedCount},
          unchanged {result.unchangedCount}
          {result.failedCount > 0 ? `, failed ${result.failedCount}` : ""}
          {result.truncated ? " — truncated: not all matching orders could be fetched." : "."}
        </p>
      ) : null}
    </div>
  );
}

function ConnectionOrderOperationsCard({
  summary,
  onReconciled,
}: {
  summary: ConnectionOrderOperationsSummary;
  onReconciled: () => void;
}) {
  const totalOrders =
    Object.values(summary.orderCountsByFinancialStatus).reduce((sum, count) => sum + (count ?? 0), 0) +
    summary.unknownFinancialStatusCount;

  return (
    <div className="rounded-2xl border border-white/10 bg-black/20 p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-white/85">
            {PROVIDER_LABELS[summary.provider]} — {summary.displayName}
          </p>
          <p className="mt-1 text-xs text-white/50">{summary.externalAccountId}</p>
        </div>
        <span className="rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/70">
          {statusLabel(summary.status)}
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <p className="text-xs text-white/50">Latest order ingested</p>
          <p className="mt-1 text-sm text-white/80">{formatDateTime(summary.latestOrderIngestedAt)}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <p className="text-xs text-white/50">Latest webhook processed</p>
          <p className="mt-1 text-sm text-white/80">{formatDateTime(summary.latestWebhookProcessedAt)}</p>
        </div>
      </div>

      <div>
        <p className="text-xs text-white/50">Orders by status ({totalOrders} total)</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {FINANCIAL_STATUS_ORDER.filter(
            (status) => (summary.orderCountsByFinancialStatus[status] ?? 0) > 0,
          ).map((status) => (
            <span
              key={status}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-white/70"
            >
              {FINANCIAL_STATUS_LABELS[status]}: {summary.orderCountsByFinancialStatus[status]}
            </span>
          ))}
          {summary.unknownFinancialStatusCount > 0 ? (
            <span className="rounded-full border border-amber-400/25 bg-amber-400/10 px-3 py-1 text-xs text-amber-200/90">
              Unknown: {summary.unknownFinancialStatusCount}
            </span>
          ) : null}
          {totalOrders === 0 ? <span className="text-xs text-white/40">No orders yet.</span> : null}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <p className="text-xs text-white/50">Attributed to a SQRATCH click</p>
          <p className="mt-1 text-lg font-semibold text-white/85">{summary.attributedOrderCount}</p>
        </div>
        <div className="rounded-xl border border-white/10 bg-black/20 p-3">
          <p className="text-xs text-white/50">Unattributed</p>
          <p className="mt-1 text-lg font-semibold text-white/85">{summary.unattributedOrderCount}</p>
        </div>
      </div>

      {summary.provider === "COMMERCE7" ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-white/10 bg-black/20 p-3">
            <p className="text-xs text-white/50">SQRATCH order webhook receiver</p>
            <p className="mt-1 text-sm text-white/80">
              {summary.orderReceiverConfigured ? "Ready" : "Not configured"}
            </p>
            <p className="mt-1 text-[11px] leading-4 text-white/40">
              This only reflects SQRATCH&apos;s own receiver readiness — Commerce7&apos;s webhook
              subscription state is not observable from here.
            </p>
          </div>
          <ReconcileButton
            connectionId={summary.connectionId}
            disabled={summary.status !== "CONNECTED"}
            onSuccess={onReconciled}
          />
        </div>
      ) : null}
    </div>
  );
}

type OrderListRow = {
  id: string;
  connectionId: string;
  provider: CommerceProvider;
  orderNumber: string | null;
  orderDate: string;
  financialStatus: CommerceOrderFinancialStatus | null;
  currencyCode: string | null;
  /**
   * PHASE 19 REPAIR (P1-3): the EXACT persisted exponent — the UI must
   * use this, never assume 2 decimal places or derive one from
   * `currencyCode`. See `formatMoneyDisplay` in `@/lib/commerce/money`.
   */
  minorUnitExponent: number | null;
  totalMinor: string | null;
  netRevenueMinor: string | null;
  attributed: boolean;
};

/**
 * PHASE 19 — PART 12: a compact, paginated recent-orders list backing the
 * "make an order navigable to detail" requirement — reads the existing
 * Part 7 API (`GET /api/brand/commerce/orders`), previously built with no
 * UI consumer. Each row links to `/dashboard/brand/commerce/orders/[id]`.
 */
function RecentOrdersList({ refreshToken }: { refreshToken: number }) {
  const [rows, setRows] = useState<OrderListRow[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPage(afterCursor: string | null) {
    const params = new URLSearchParams({ limit: "20" });
    if (afterCursor) params.set("cursor", afterCursor);
    const data = await fetchJson<{
      data: OrderListRow[];
      meta: { hasNextPage: boolean; nextCursor: string | null };
    }>(`/api/brand/commerce/orders?${params.toString()}`);
    return data;
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const data = await loadPage(null);
        if (!cancelled) {
          setRows(data.data);
          setHasNextPage(data.meta.hasNextPage);
          setCursor(data.meta.nextCursor);
        }
      } catch (loadError) {
        if (!cancelled) setError(getErrorMessage(loadError, "Failed to load recent orders."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  async function handleLoadMore() {
    setLoadingMore(true);
    try {
      const data = await loadPage(cursor);
      setRows((prev) => [...prev, ...data.data]);
      setHasNextPage(data.meta.hasNextPage);
      setCursor(data.meta.nextCursor);
    } catch (loadError) {
      setError(getErrorMessage(loadError, "Failed to load more orders."));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <PageCard>
      <p className="text-sm font-semibold text-white/85">Recent orders</p>
      {loading ? (
        <p className="mt-3 text-sm text-white/65">Loading orders...</p>
      ) : error ? (
        <p className="mt-3 text-sm text-red-300">{error}</p>
      ) : rows.length === 0 ? (
        <p className="mt-3 text-sm text-white/65">No orders yet.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {rows.map((row) => (
            <a
              key={row.id}
              href={`/dashboard/brand/commerce/orders/${row.id}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-white/10 bg-black/20 p-3 hover:bg-white/5"
            >
              <div>
                <p className="text-sm text-white/80">
                  {row.orderNumber ?? `#${row.id.slice(0, 8)}`} — {PROVIDER_LABELS[row.provider]}
                </p>
                <p className="mt-1 text-xs text-white/45">
                  {formatDateTime(row.orderDate)} — {row.financialStatus ?? "Unknown"} —{" "}
                  {row.attributed ? "Attributed" : "Unattributed"}
                </p>
              </div>
              <p className="text-sm text-white/80">
                {formatMoneyDisplay(row.totalMinor, row.currencyCode, row.minorUnitExponent)}
              </p>
            </a>
          ))}
          {hasNextPage ? (
            <Button
              onClick={() => void handleLoadMore()}
              disabled={loadingMore}
              variant="outline"
              className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
            >
              {loadingMore ? "Loading..." : "Load more"}
            </Button>
          ) : null}
        </div>
      )}
    </PageCard>
  );
}

/**
 * PHASE 18 — PART 6: the Commerce order operations dashboard. Reads
 * `/api/brand/commerce/orders/summary`, which is provider-neutral (see that
 * route's own doc comment) — every connected provider for this brand gets
 * its own card, not just Commerce7. No customer PII is requested or
 * rendered anywhere on this page.
 */
export function BrandCommerceOrdersClient() {
  const [summary, setSummary] = useState<BrandOrderOperationsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // PHASE 19 — PART 16: bumped after a successful reconciliation to force
  // both the summary card and the recent-orders list to refetch, so a
  // just-reconciled order is visible without a manual page reload.
  const [refreshToken, setRefreshToken] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const data = await fetchJson<{ data: BrandOrderOperationsSummary }>(
          "/api/brand/commerce/orders/summary",
        );
        if (!cancelled) setSummary(data.data);
      } catch (loadError) {
        if (!cancelled) {
          setError(getErrorMessage(loadError, "Failed to load order operations."));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [refreshToken]);

  return (
    <BrandPageShell
      title="Order operations"
      description="Per-connection order ingestion, webhook health, and attribution status."
    >
      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading order operations...</p>
        ) : error ? (
          <p className="text-sm text-red-300">{error}</p>
        ) : !summary || summary.connections.length === 0 ? (
          <p className="text-sm text-white/65">
            No commerce connections yet.{" "}
            <a href="/dashboard/brand/commerce" className="underline hover:text-white/80">
              Set one up from the Store page.
            </a>
          </p>
        ) : (
          <div className="space-y-4">
            {!summary.complete ? (
              <p className="rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-xs text-amber-200/90">
                Some connection data could not be loaded — this list may be incomplete. Reload to try
                again.
              </p>
            ) : null}
            {summary.connections.map((connectionSummary) => (
              <ConnectionOrderOperationsCard
                key={connectionSummary.connectionId}
                summary={connectionSummary}
                onReconciled={() => setRefreshToken((token) => token + 1)}
              />
            ))}
            <Button asChild variant="outline" className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10">
              <a href="/dashboard/brand/commerce">Back to Store</a>
            </Button>
          </div>
        )}
      </PageCard>
      <RecentOrdersList refreshToken={refreshToken} />
    </BrandPageShell>
  );
}
