"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoneyDisplay } from "@/lib/commerce/money";
import {
  parseCatchUpStepResult,
  parseCustomRangeStepResult,
  parseOrderListEnvelope,
  parseOrderOperationsSummary,
  parseReconciliationState,
  type BrandOrderOperationsSummary,
  type CatchUpStepResult,
  type CommerceConnectionStatus,
  type CommerceOrderFinancialStatus,
  type CommerceOrderFulfillmentStatus,
  type CommerceProvider,
  type ConnectionOrderOperationsSummary,
  type CustomRangeStepResult,
  type OrderListRow,
  type ReconciliationStateView,
} from "../commerce-response-validation";

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

/** PHASE 22, Part 5 — the canonical fulfillment statuses this codebase currently produces (`CommerceOrderFulfillmentStatus`). */
const FULFILLMENT_STATUS_LABELS: Record<CommerceOrderFulfillmentStatus, string> = {
  UNFULFILLED: "Unfulfilled",
  PARTIALLY_FULFILLED: "Partially fulfilled",
  FULFILLED: "Fulfilled",
  RESTOCKED: "Restocked",
};

function fulfillmentToneClass(status: CommerceOrderFulfillmentStatus | null): string {
  if (status === "FULFILLED") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200/90";
  if (status === "PARTIALLY_FULFILLED") return "border-amber-400/25 bg-amber-400/10 text-amber-200/90";
  if (status === "RESTOCKED") return "border-white/15 bg-white/5 text-white/50";
  return "border-white/10 bg-white/5 text-white/55";
}

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
 * PHASE 22 — replaces the fixed "reconcile last 24 hours" button with a
 * durable-checkpoint-driven "Catch up orders" control. See
 * `@/lib/commerce/providers/commerce7-order-reconciliation` for the full
 * checkpoint/resumability/concurrency design this thin UI drives.
 *
 * Each click (or each automatic continuation, see below) calls the
 * `catch-up` endpoint ONCE — the server processes ONE bounded chunk and
 * returns immediately, never one long-lived request. While the returned
 * `reachedTarget` is `false`, this component automatically calls again
 * (bounded — a large backlog completes across several fast round trips
 * without extra clicks) for as long as it stays mounted; navigating away
 * simply stops the loop, and the durable checkpoint already committed by
 * every completed chunk is untouched — clicking "Catch up orders" again
 * later resumes exactly where it left off. Failure stops the loop and
 * surfaces a sanitized error rather than retrying blindly.
 */
function CatchUpOrdersControl({
  connectionId,
  disabled,
  onSuccess,
}: {
  connectionId: string;
  disabled: boolean;
  onSuccess: () => void;
}) {
  const [state, setState] = useState<ReconciliationStateView | null>(null);
  const [loadingState, setLoadingState] = useState(true);
  const [running, setRunning] = useState(false);
  const [lastChunk, setLastChunk] = useState<CatchUpStepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Guards the auto-continuation loop below against setting state (or
  // firing another chunk request) after this component has unmounted —
  // e.g. the admin navigates away from the page mid-Catch-Up. Every chunk
  // already committed by the time that happens stays exactly as committed;
  // this ref only stops the CLIENT from continuing to drive further chunks.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const loadState = useCallback(async () => {
    setLoadingState(true);
    try {
      const data = await fetchJson<unknown>(
        `/api/brand/commerce/connections/${connectionId}/orders/reconciliation-state`,
      );
      const parsed = parseReconciliationState(data);
      if (parsed) setState(parsed);
    } catch {
      // Non-fatal — the checkpoint line just stays blank; the Catch Up
      // button itself still works independently of this read.
    } finally {
      setLoadingState(false);
    }
  }, [connectionId]);

  useEffect(() => {
    void loadState();
  }, [loadState]);

  async function runOneChunk(): Promise<CatchUpStepResult | null> {
    try {
      const data = await fetchJson<unknown>(
        `/api/brand/commerce/connections/${connectionId}/orders/catch-up`,
        { method: "POST" },
      );
      const parsed = parseCatchUpStepResult(data);
      if (!parsed) {
        setError("Catch up result came back in an unexpected format.");
        return null;
      }
      return parsed;
    } catch (catchUpError) {
      setError(getErrorMessage(catchUpError, "Failed to run order catch-up."));
      return null;
    }
  }

  async function handleCatchUp() {
    setRunning(true);
    setError(null);
    setLastChunk(null);

    // Bounded auto-continuation: each iteration is one real chunk request.
    // A chunk failure or a parse error stops the loop immediately (never
    // retries blindly); reaching the target stops it too; an unmount
    // (`mountedRef`) stops it without touching state on a gone component —
    // whatever chunks already committed server-side stay committed either way.
    let reachedTarget = false;
    while (!reachedTarget && mountedRef.current) {
      const chunk = await runOneChunk();
      if (!mountedRef.current) return;
      if (!chunk) break;
      setLastChunk(chunk);
      reachedTarget = chunk.reachedTarget;
      if (chunk.status === "FAILED") break;
    }

    await loadState();
    if (!mountedRef.current) return;
    setRunning(false);
    onSuccess();
  }

  const reconciledThroughLabel = state?.reconciledThrough
    ? formatDateTime(state.reconciledThrough)
    : "Never reconciled yet";

  return (
    <div className="space-y-2">
      <p className="text-xs text-white/50">Order reconciliation</p>
      <p className="text-sm text-white/80">
        Last successfully reconciled through:{" "}
        <span className="text-white/60">{loadingState ? "Loading..." : reconciledThroughLabel}</span>
      </p>
      <Button
        onClick={() => void handleCatchUp()}
        disabled={disabled || running}
        variant="outline"
        className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
      >
        {running ? "Catching up..." : "Catch up orders"}
      </Button>
      {running ? (
        <p className="text-[11px] leading-4 text-white/40">
          Reconciliation in progress. You can leave this page safely; progress already completed will
          be preserved and Catch Up can resume later.
        </p>
      ) : null}
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      {lastChunk ? (
        <p className="text-xs text-white/60">
          {lastChunk.status === "FAILED"
            ? `Stopped: ${lastChunk.error ?? "an error occurred"}`
            : lastChunk.reachedTarget
              ? `Caught up. Fetched ${lastChunk.ordersFetched}, processed ${lastChunk.ordersProcessed}.`
              : `In progress — fetched ${lastChunk.ordersFetched}, processed ${lastChunk.ordersProcessed} so far.`}
        </p>
      ) : null}
    </div>
  );
}

/**
 * PHASE 22, Part 4 — "Reconcile custom range." Uses the SAME canonical
 * chunk processor as Catch Up (`runCustomRangeStep`) but for an EXPLICIT,
 * admin-chosen historical window that never advances the primary
 * contiguous checkpoint — see that service's own header for why.
 */
function ReconcileCustomRangeControl({
  connectionId,
  disabled,
  onSuccess,
}: {
  connectionId: string;
  disabled: boolean;
  onSuccess: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [fromValue, setFromValue] = useState("");
  const [toValue, setToValue] = useState("");
  const [running, setRunning] = useState(false);
  const [lastChunk, setLastChunk] = useState<CustomRangeStepResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  async function runOneChunk(from: string, to: string): Promise<CustomRangeStepResult | null> {
    try {
      const data = await fetchJson<unknown>(
        `/api/brand/commerce/connections/${connectionId}/orders/reconcile-range`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ from, to }),
        },
      );
      const parsed = parseCustomRangeStepResult(data);
      if (!parsed) {
        setError("Reconcile result came back in an unexpected format.");
        return null;
      }
      return parsed;
    } catch (rangeError) {
      setError(getErrorMessage(rangeError, "Failed to reconcile the custom range."));
      return null;
    }
  }

  async function handleReconcileRange() {
    const fromDate = new Date(fromValue);
    const toDate = new Date(toValue);
    if (!fromValue || !toValue || Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      setError("Choose a valid From and To date/time.");
      return;
    }
    if (fromDate.getTime() >= toDate.getTime()) {
      setError('"From" must be strictly before "To".');
      return;
    }

    setRunning(true);
    setError(null);
    setLastChunk(null);

    const fromIso = fromDate.toISOString();
    const toIso = toDate.toISOString();
    let reachedTarget = false;
    while (!reachedTarget && mountedRef.current) {
      const chunk = await runOneChunk(fromIso, toIso);
      if (!mountedRef.current) return;
      if (!chunk) break;
      setLastChunk(chunk);
      reachedTarget = chunk.reachedTarget;
      if (chunk.status === "FAILED") break;
    }

    setRunning(false);
    onSuccess();
  }

  if (!expanded) {
    return (
      <Button
        onClick={() => setExpanded(true)}
        disabled={disabled}
        variant="outline"
        className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
      >
        Reconcile custom range
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
      <p className="text-xs text-white/50">Reconcile a specific historical date/time range</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-white/55">
          <span>From</span>
          <Input
            type="datetime-local"
            value={fromValue}
            onChange={(e) => setFromValue(e.target.value)}
            disabled={disabled || running}
            className="border-white/10 bg-black/20 text-white"
          />
        </label>
        <label className="space-y-1 text-xs text-white/55">
          <span>To</span>
          <Input
            type="datetime-local"
            value={toValue}
            onChange={(e) => setToValue(e.target.value)}
            disabled={disabled || running}
            className="border-white/10 bg-black/20 text-white"
          />
        </label>
      </div>
      <p className="text-[11px] leading-4 text-white/40">
        This repairs a specific historical window and does not change the main reconciliation checkpoint
        above.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <Button
          onClick={() => void handleReconcileRange()}
          disabled={disabled || running}
          className="rounded-full border border-white bg-white text-black hover:bg-white/90"
        >
          {running ? "Reconciling..." : "Reconcile selected range"}
        </Button>
        <Button
          onClick={() => {
            setExpanded(false);
            setError(null);
            setLastChunk(null);
          }}
          disabled={running}
          variant="outline"
          className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
        >
          Cancel
        </Button>
      </div>
      {error ? <p className="text-xs text-red-300">{error}</p> : null}
      {lastChunk ? (
        <p className="text-xs text-white/60">
          {lastChunk.status === "FAILED"
            ? `Stopped: ${lastChunk.error ?? "an error occurred"}`
            : lastChunk.reachedTarget
              ? `Done. Fetched ${lastChunk.ordersFetched}, processed ${lastChunk.ordersProcessed}.`
              : `In progress — fetched ${lastChunk.ordersFetched}, processed ${lastChunk.ordersProcessed} so far.`}
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
          <CatchUpOrdersControl
            connectionId={summary.connectionId}
            disabled={summary.status !== "CONNECTED"}
            onSuccess={onReconciled}
          />
          <ReconcileCustomRangeControl
            connectionId={summary.connectionId}
            disabled={summary.status !== "CONNECTED"}
            onSuccess={onReconciled}
          />
        </div>
      ) : null}
    </div>
  );
}

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

  /**
   * This endpoint's response is genuinely needed in full — both `data` AND
   * `meta.hasNextPage`/`meta.nextCursor` — so it deliberately does NOT use
   * the unwrapping `fetchJson` helper (which would silently discard
   * `meta`). Raw `fetch()` + explicit envelope validation instead: a
   * malformed/missing `data` or `meta` throws a normal `Error` (caught by
   * every caller below), never a raw `TypeError` from reading a property
   * off `undefined`.
   */
  async function loadPage(afterCursor: string | null) {
    const params = new URLSearchParams({ limit: "20" });
    if (afterCursor) params.set("cursor", afterCursor);
    const response = await fetch(`/api/brand/commerce/orders?${params.toString()}`, {
      credentials: "include",
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(json?.error || "Failed to load orders.");
    }
    const parsed = parseOrderListEnvelope(json);
    if (!parsed) {
      throw new Error("Orders response came back in an unexpected format.");
    }
    return parsed;
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
              <div className="flex flex-col items-end gap-1">
                <p className="text-sm text-white/80">
                  {formatMoneyDisplay(row.totalMinor, row.currencyCode, row.minorUnitExponent)}
                </p>
                {/* PHASE 22, Part 5 — fulfillment is a SEPARATE badge, never
                    merged into the financial-status text above: a PAID order
                    can be UNFULFILLED and vice versa. */}
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-[11px] ${fulfillmentToneClass(row.fulfillmentStatus)}`}
                >
                  {row.fulfillmentStatus ? FULFILLMENT_STATUS_LABELS[row.fulfillmentStatus] : "Unknown"}
                </span>
              </div>
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
        // `fetchJson` already unwraps this route's `{ data }` envelope (no
        // `meta`) — the resolved value IS the summary object. A malformed
        // shape must surface as a controlled error, never as an empty
        // `connections: []` — that would read as "no commerce connections
        // yet" and could mask a real, existing connection.
        const data = await fetchJson<unknown>(
          "/api/brand/commerce/orders/summary",
        );
        if (!cancelled) {
          const parsed = parseOrderOperationsSummary(data);
          if (!parsed) {
            setError("Order operations summary came back in an unexpected format.");
            return;
          }
          setSummary(parsed);
        }
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
