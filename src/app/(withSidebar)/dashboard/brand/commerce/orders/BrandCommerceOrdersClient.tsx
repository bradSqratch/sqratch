"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatMoneyDisplay } from "@/lib/commerce/money";
// The SERVER owns this bound. Imported rather than re-typed so the input
// control and the URL seeder can never silently drift from the 400 the API
// actually returns. `order-list.ts` is safe to pull into a client bundle: its
// only import is `import type`, so it carries no Prisma/server runtime.
import { MAX_ORDER_NUMBER_SEARCH_LENGTH } from "@/lib/commerce/order-list";
import {
  parseCatchUpStepResult,
  parseCustomRangeStepResult,
  parseOrderListEnvelope,
  formatDateTimeLocalMax,
  parseOrderActivityPage,
  parseOrderOperationsSummary,
  parseReconciliationState,
  validateCustomRangeSelection,
  type BrandOrderOperationsSummary,
  type OrderActivityCategory,
  type OrderActivityPage,
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

      {/* PHASE C4 — the rest of the durable checkpoint, previously only
          visible via SQL. `targetThrough` is what Catch Up is working toward,
          so "reconciled through" being behind it is normal progress rather
          than a fault. */}
      {!loadingState && state ? (
        <div className="grid gap-1 text-[11px] leading-4 text-white/45 sm:grid-cols-2">
          {state.targetThrough ? (
            <p>Catching up toward: {formatDateTime(state.targetThrough)}</p>
          ) : null}
          {state.lastAttemptedAt ? (
            <p>Last attempted: {formatDateTime(state.lastAttemptedAt)}</p>
          ) : null}
          {state.lastRunOutcome ? <p>Last outcome: {state.lastRunOutcome}</p> : null}
          {/* Already a short classified tag server-side, never a raw error. */}
          {state.lastRunError ? (
            <p className="text-amber-200/80 sm:col-span-2">Last error: {state.lastRunError}</p>
          ) : null}
        </div>
      ) : null}

      {/* PHASE C4 — Custom Range progress is shown SEPARATELY and is never
          presented as the Catch Up watermark. Custom Range deliberately does
          NOT advance `reconciledThrough`; conflating the two would make an
          operator believe a targeted historical repair had moved the
          contiguous checkpoint forward, silently skipping everything in
          between. */}
      {!loadingState && state?.customRangeFrom && state?.customRangeTo ? (
        <div className="rounded-lg border border-white/10 bg-black/20 p-2 text-[11px] leading-4 text-white/45">
          <p className="text-white/60">Last custom range (separate from the checkpoint above)</p>
          <p>
            {formatDateTime(state.customRangeFrom)} → {formatDateTime(state.customRangeTo)}
          </p>
          {state.customRangeCursor ? (
            <p>Progress: {formatDateTime(state.customRangeCursor)}</p>
          ) : null}
          <p className="mt-1 text-white/35">
            A custom range repairs a specific historical window only. It does not move the
            contiguous Catch Up checkpoint.
          </p>
        </div>
      ) : null}

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

  /**
   * PHASE 26 — the latest LOCAL date/time the pickers may offer.
   *
   * The server rejects any range extending past its own clock, so a picker
   * that happily accepts "tomorrow" lets the operator build a request that
   * can only ever 400 — which is exactly what happened in production. This
   * caps both controls at "now".
   *
   * Recomputed when the panel OPENS and every 30s while it stays open, so a
   * long-lived panel never freezes the ceiling at an obsolete minute and
   * starts refusing the genuine current time. The interval is created only
   * while `expanded` is true and is cleared by the effect's own cleanup on
   * collapse AND on unmount, so no timer can outlive the component.
   */
  const [maxDateTimeLocal, setMaxDateTimeLocal] = useState(() =>
    formatDateTimeLocalMax(new Date()),
  );
  useEffect(() => {
    if (!expanded) return;
    setMaxDateTimeLocal(formatDateTimeLocalMax(new Date()));
    const handle = setInterval(() => {
      setMaxDateTimeLocal(formatDateTimeLocalMax(new Date()));
    }, 30_000);
    return () => clearInterval(handle);
  }, [expanded]);

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
    // PHASE 26 — pure, shared pre-flight validation (see
    // `validateCustomRangeSelection`). Rejects a future range BEFORE any
    // POST, so the operator gets the specific message rather than a generic
    // failure after a round trip. The server re-validates all of this
    // against its OWN clock regardless — this never replaces that.
    const selection = validateCustomRangeSelection({
      fromValue,
      toValue,
      now: new Date(),
    });
    if (!selection.ok) {
      setError(selection.message);
      return;
    }

    setRunning(true);
    setError(null);
    setLastChunk(null);

    const { fromIso, toIso } = selection;
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
            max={maxDateTimeLocal}
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
            max={maxDateTimeLocal}
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
  activityRefreshToken,
}: {
  summary: ConnectionOrderOperationsSummary;
  onReconciled: () => void;
  /** Bumped after a reconciliation run so the activity feed picks up the new events. */
  activityRefreshToken: number;
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

      {/* PHASE C — provider-neutral, so it sits OUTSIDE the Commerce7-only
          reconciliation block above: a Shopify connection has ingestion
          events worth inspecting too. */}
      <div className="mt-3">
        <OrderActivityPanel connectionId={summary.connectionId} refreshToken={activityRefreshToken} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PHASE C — INGESTION / RECONCILIATION ACTIVITY
// ---------------------------------------------------------------------------

const ACTIVITY_CATEGORY_LABELS: Record<OrderActivityCategory, string> = {
  WEBHOOK: "Webhook",
  RECONCILIATION: "Reconciliation",
  // Fail-closed bucket: an unrecognized topic is never optimistically
  // described as a webhook.
  OTHER: "Other",
};

function activityCategoryToneClass(category: OrderActivityCategory): string {
  if (category === "WEBHOOK") return "border-sky-400/25 bg-sky-400/10 text-sky-200/90";
  if (category === "RECONCILIATION") return "border-violet-400/25 bg-violet-400/10 text-violet-200/90";
  return "border-white/15 bg-white/5 text-white/60";
}

function activityStatusToneClass(status: string): string {
  if (status === "PROCESSED") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200/90";
  if (status === "FAILED") return "border-red-400/25 bg-red-400/10 text-red-200/90";
  if (status === "RECEIVED") return "border-amber-400/25 bg-amber-400/10 text-amber-200/90";
  return "border-white/15 bg-white/5 text-white/60";
}

const ACTIVITY_STATUS_LABELS: Record<string, string> = {
  RECEIVED: "In flight",
  PROCESSED: "Processed",
  FAILED: "Failed",
  SKIPPED_STALE: "Skipped (not newer)",
  SKIPPED_DISCONNECTED: "Skipped (disconnected)",
};

/**
 * PHASE C — recent order-ingestion activity for one connection.
 *
 * THE CENTRAL SEMANTIC: this panel shows EVENT HISTORY, not current order
 * state. A historical FAILED event (for example the Commerce7 refund child
 * #1003 that failed under an older interpretation) stays visible forever as
 * genuine audit evidence, and must NOT be read as "this order is currently
 * broken" — a later reconciliation may already have repaired the canonical
 * order. The header says exactly that, and each row links to the canonical
 * order so an operator can check its CURRENT state directly rather than
 * inferring it from an old event.
 */
function OrderActivityPanel({
  connectionId,
  refreshToken,
}: {
  connectionId: string;
  refreshToken: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [page, setPage] = useState<OrderActivityPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const requestSeq = useRef(0);

  const load = useCallback(
    async (afterCursor: string | null) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ limit: "25" });
        if (afterCursor) params.set("cursor", afterCursor);
        const data = await fetchJson<unknown>(
          `/api/brand/commerce/connections/${connectionId}/orders/activity?${params.toString()}`,
        );
        if (seq !== requestSeq.current) return;
        const parsed = parseOrderActivityPage(data);
        if (!parsed) {
          setPage(null);
          setError("Activity came back in an unexpected format.");
          return;
        }
        setPage(parsed);
      } catch (loadError) {
        if (seq !== requestSeq.current) return;
        setPage(null);
        setError(getErrorMessage(loadError, "Failed to load order activity."));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [connectionId],
  );

  // Only fetched once the operator opens the panel — this is a diagnostic
  // surface, not something every page load should pay for.
  useEffect(() => {
    if (!expanded) return;
    setCursor(null);
    void load(null);
  }, [expanded, refreshToken, load]);

  if (!expanded) {
    return (
      <Button
        onClick={() => setExpanded(true)}
        variant="outline"
        className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
      >
        View ingestion activity
      </Button>
    );
  }

  return (
    <div className="space-y-3 rounded-xl border border-white/10 bg-black/20 p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-white/50">Recent ingestion activity</p>
        <Button
          onClick={() => setExpanded(false)}
          variant="outline"
          className="h-7 rounded-full border-white/20 bg-transparent px-3 text-[11px] text-white hover:bg-white/10"
        >
          Hide
        </Button>
      </div>

      {/* THE HISTORY-vs-CURRENT-STATE DISCLAIMER. Load-bearing, not filler. */}
      <p className="text-[11px] leading-4 text-white/40">
        This is a history of ingestion events, not the current state of your orders. An older failed
        or skipped event can be followed by a successful reconciliation that already repaired the
        order — open the order itself to see its current state.
      </p>

      {loading ? (
        <p className="text-sm text-white/65">Loading activity...</p>
      ) : error ? (
        <p className="text-sm text-red-300">{error}</p>
      ) : !page || page.entries.length === 0 ? (
        <p className="text-sm text-white/65">No ingestion activity recorded yet.</p>
      ) : (
        <>
          <div className="space-y-2">
            {page.entries.map((entry) => (
              <div key={entry.id} className="rounded-lg border border-white/10 bg-black/20 p-2.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] ${activityCategoryToneClass(entry.category)}`}
                  >
                    {ACTIVITY_CATEGORY_LABELS[entry.category]}
                  </span>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-[11px] ${activityStatusToneClass(entry.status)}`}
                  >
                    {ACTIVITY_STATUS_LABELS[entry.status] ?? entry.status}
                  </span>
                  <span className="text-[11px] text-white/45">{formatDateTime(entry.receivedAt)}</span>
                </div>
                <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-white/45">
                  {entry.order ? (
                    <a
                      href={`/dashboard/brand/commerce/orders/${entry.order.id}`}
                      className="text-white/70 underline underline-offset-2 hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                    >
                      Order {entry.order.orderNumber ?? entry.order.id.slice(0, 8)}
                    </a>
                  ) : (
                    // Genuinely meaningful: a Commerce7 refund child never
                    // becomes a canonical order, so "no canonical order" is
                    // correct behavior rather than a gap.
                    <span>No canonical order</span>
                  )}
                  {entry.externalOrderRef ? (
                    <span className="font-mono text-white/35">
                      provider ref {entry.externalOrderRef.slice(0, 12)}
                    </span>
                  ) : null}
                  {entry.providerUpdatedAt ? (
                    <span>provider updated {formatDateTime(entry.providerUpdatedAt)}</span>
                  ) : null}
                </div>
                {entry.failureSummary ? (
                  <p className="mt-1.5 text-[11px] text-amber-200/80">{entry.failureSummary}</p>
                ) : null}
              </div>
            ))}
          </div>
          {page.hasNextPage && page.nextCursor ? (
            <Button
              onClick={() => {
                setCursor(page.nextCursor);
                void load(page.nextCursor);
              }}
              disabled={loading}
              variant="outline"
              className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
            >
              Load older activity
            </Button>
          ) : null}
          {cursor ? (
            <Button
              onClick={() => {
                setCursor(null);
                void load(null);
              }}
              disabled={loading}
              variant="outline"
              className="ml-2 rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
            >
              Back to newest
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// PHASE B — ORDER EXPLORER
// ---------------------------------------------------------------------------

/** The closed set of filters this explorer can express. All optional. */
type OrderExplorerFilters = {
  connectionId: string;
  provider: string;
  orderNumber: string;
  financialStatus: string;
  fulfillmentStatus: string;
  attributed: string;
  dateFrom: string;
  dateTo: string;
};

const EMPTY_FILTERS: OrderExplorerFilters = {
  connectionId: "",
  provider: "",
  orderNumber: "",
  financialStatus: "",
  fulfillmentStatus: "",
  attributed: "",
  dateFrom: "",
  dateTo: "",
};

const FINANCIAL_STATUS_OPTIONS: Array<{ value: CommerceOrderFinancialStatus; label: string }> = [
  { value: "PENDING", label: "Pending" },
  { value: "AUTHORIZED", label: "Authorized" },
  { value: "PARTIALLY_PAID", label: "Partially paid" },
  { value: "PAID", label: "Paid" },
  { value: "PARTIALLY_REFUNDED", label: "Partially refunded" },
  { value: "REFUNDED", label: "Refunded" },
  { value: "VOIDED", label: "Voided" },
];

const FULFILLMENT_STATUS_OPTIONS: Array<{ value: CommerceOrderFulfillmentStatus; label: string }> = [
  { value: "UNFULFILLED", label: "Unfulfilled" },
  { value: "PARTIALLY_FULFILLED", label: "Partially fulfilled" },
  { value: "FULFILLED", label: "Fulfilled" },
  { value: "RESTOCKED", label: "Restocked" },
];

/** Every filter the server understands, serialized. Empty values are omitted entirely. */
function buildOrderQuery(filters: OrderExplorerFilters, cursor: string | null, limit: number): string {
  const params = new URLSearchParams({ limit: String(limit) });
  if (filters.connectionId) params.set("connectionId", filters.connectionId);
  if (filters.provider) params.set("provider", filters.provider);
  if (filters.orderNumber.trim()) params.set("orderNumber", filters.orderNumber.trim());
  if (filters.financialStatus) params.set("financialStatus", filters.financialStatus);
  if (filters.fulfillmentStatus) params.set("fulfillmentStatus", filters.fulfillmentStatus);
  if (filters.attributed) params.set("attributed", filters.attributed);
  // `datetime-local` emits LOCAL wall-clock time with no zone designator;
  // `new Date(...)` parses that as local and `toISOString()` converts it to
  // the correct UTC instant. A literal "Z" must never be appended — that
  // would reinterpret the operator's local time as UTC and shift the window
  // by their whole offset.
  if (filters.dateFrom) params.set("dateFrom", new Date(filters.dateFrom).toISOString());
  if (filters.dateTo) params.set("dateTo", new Date(filters.dateTo).toISOString());
  if (cursor) params.set("cursor", cursor);
  return params.toString();
}

const ORDER_EXPLORER_PAGE_SIZE = 20;

/** Only these filters may be seeded from the URL, and only with values the server accepts. */
const URL_SEEDABLE_ATTRIBUTION = new Set(["attributed", "unattributed"]);

/**
 * Reads the filters another page deep-linked with (e.g. Brand Analytics'
 * "View attributed orders").
 *
 * Every value is validated against the SAME closed sets the toolbar offers,
 * so a hand-edited URL can only ever produce a filter the UI could have
 * produced itself. The server re-validates independently regardless — this
 * is a UX affordance, never a trust boundary.
 *
 * Deliberately reads `window.location` inside an effect rather than during
 * render: this component is server-rendered for the initial HTML, so
 * touching `window` at render time would either crash or cause a hydration
 * mismatch.
 */
function readFiltersFromUrl(search: string): Partial<OrderExplorerFilters> {
  const params = new URLSearchParams(search);
  const seeded: Partial<OrderExplorerFilters> = {};

  const attributed = params.get("attributed");
  if (attributed && URL_SEEDABLE_ATTRIBUTION.has(attributed)) {
    seeded.attributed = attributed;
  }

  const financialStatus = params.get("financialStatus");
  if (financialStatus && FINANCIAL_STATUS_OPTIONS.some((o) => o.value === financialStatus)) {
    seeded.financialStatus = financialStatus;
  }

  const fulfillmentStatus = params.get("fulfillmentStatus");
  if (fulfillmentStatus && FULFILLMENT_STATUS_OPTIONS.some((o) => o.value === fulfillmentStatus)) {
    seeded.fulfillmentStatus = fulfillmentStatus;
  }

  const orderNumber = params.get("orderNumber");
  // Bounded exactly like the input control and the server.
  if (
    orderNumber &&
    orderNumber.trim() &&
    orderNumber.trim().length <= MAX_ORDER_NUMBER_SEARCH_LENGTH
  ) {
    seeded.orderNumber = orderNumber.trim();
  }

  return seeded;
}

/**
 * PHASE B — the order explorer: a filterable, cursor-paginated view over the
 * canonical, provider-neutral `GET /api/brand/commerce/orders`.
 *
 * Replaces the previous fixed "Recent orders" list (PHASE 19 PART 12), which
 * could only ever show the newest 20 rows with no way to find a specific
 * order. Each row still links to the EXISTING detail page
 * (`/dashboard/brand/commerce/orders/[id]`) — no second detail architecture
 * was introduced.
 *
 * PAGINATION is keyset/seek, unchanged: the server returns an opaque
 * `nextCursor` and this component keeps a client-side STACK of the cursors
 * it has visited so "Previous" is just a pop. That deliberately avoids
 * inventing reverse-offset queries, which would be both fragile and O(n) on
 * the database.
 *
 * SORT ORDER is by SQRATCH ingestion time (`createdAt`), which is what the
 * server's keyset is built on — see `order-list.ts`'s CURSOR FIELD CHOICE
 * note for why the nullable provider timestamp cannot be the keyset. The
 * column header says so explicitly rather than implying the list is sorted
 * by business order date, which for backfilled history it is not.
 */
function OrderExplorer({
  refreshToken,
  connections,
}: {
  refreshToken: number;
  connections: ConnectionOrderOperationsSummary[];
}) {
  // `draft` is what the operator is typing; `applied` is what the last
  // request actually used. Keeping them separate is what makes "changing a
  // filter resets pagination" correct — the cursor stack is cleared exactly
  // when `applied` changes, never on an unrelated keystroke.
  const [draft, setDraft] = useState<OrderExplorerFilters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<OrderExplorerFilters>(EMPTY_FILTERS);
  const [rows, setRows] = useState<OrderListRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasNextPage, setHasNextPage] = useState(false);
  /** The cursor that produced the page currently on screen. `null` = page 1. */
  const [currentCursor, setCurrentCursor] = useState<string | null>(null);
  /**
   * Cursors of the pages BEHIND the current one, oldest first. Its length is
   * therefore the current zero-based page index, and "Previous" is a pop.
   * A `null` entry is meaningful — it is page 1's cursor.
   */
  const [cursorStack, setCursorStack] = useState<Array<string | null>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Guards against a slow, superseded request landing after a newer one.
  const requestSeq = useRef(0);

  const load = useCallback(
    async (filters: OrderExplorerFilters, cursor: string | null) => {
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        // This endpoint genuinely needs BOTH `data` and `meta`, so it
        // deliberately does not use the unwrapping `fetchJson` helper (which
        // discards `meta`). Raw fetch + explicit envelope validation instead.
        const response = await fetch(
          `/api/brand/commerce/orders?${buildOrderQuery(filters, cursor, ORDER_EXPLORER_PAGE_SIZE)}`,
          { credentials: "include" },
        );
        const json = await response.json().catch(() => null);
        if (seq !== requestSeq.current) return; // superseded
        if (!response.ok) {
          // The server's own message is surfaced for the validated 400s
          // (bad date, inverted range, over-long search) so the operator
          // learns what to correct instead of a generic failure.
          setRows([]);
          setHasNextPage(false);
          setError(json?.error || "Failed to load orders.");
          return;
        }
        const parsed = parseOrderListEnvelope(json);
        if (!parsed) {
          setRows([]);
          setHasNextPage(false);
          setError("Orders response came back in an unexpected format.");
          return;
        }
        setRows(parsed.data);
        setHasNextPage(parsed.meta.hasNextPage);
        setNextCursor(parsed.meta.nextCursor);
      } catch (loadError) {
        if (seq !== requestSeq.current) return;
        setRows([]);
        setHasNextPage(false);
        setError(getErrorMessage(loadError, "Failed to load orders."));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [],
  );

  // Seeds filters another page deep-linked with, ONCE on mount. Runs in an
  // effect (not during render) because this component is server-rendered for
  // the initial HTML — see `readFiltersFromUrl`. When the URL carries nothing
  // seedable this sets no state at all, so the normal page-1 effect below
  // fires exactly once.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const seeded = readFiltersFromUrl(window.location.search);
    if (Object.keys(seeded).length === 0) return;
    setDraft((current) => ({ ...current, ...seeded }));
    setApplied((current) => ({ ...current, ...seeded }));
  }, []);

  // Page 1 for the currently-applied filters. Re-runs when filters are
  // applied/reset or an external refresh (e.g. a finished reconciliation)
  // bumps the token.
  useEffect(() => {
    setCursorStack([]);
    setCurrentCursor(null);
    void load(applied, null);
  }, [applied, refreshToken, load]);

  function applyFilters() {
    // Resets pagination by construction: `applied` changing re-runs the
    // effect above, which clears the cursor stack and requests page 1.
    setApplied(draft);
  }

  function resetFilters() {
    setDraft(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
  }

  function goNext() {
    if (!hasNextPage || !nextCursor) return;
    // Push the cursor that produced the CURRENT page, so Previous can return
    // to exactly this page. `null` is a legitimate entry — it is page 1.
    setCursorStack((stack) => [...stack, currentCursor]);
    setCurrentCursor(nextCursor);
    void load(applied, nextCursor);
  }

  const canGoPrevious = cursorStack.length > 0;

  function goPrevious() {
    if (!canGoPrevious) return;
    const stack = [...cursorStack];
    // `pop()` on a stack whose entries may legitimately BE `null` — the
    // `?? null` normalizes the `undefined` an empty pop would give, it is
    // not papering over a missing value (guarded by `canGoPrevious`).
    const previousCursor = stack.pop() ?? null;
    setCursorStack(stack);
    setCurrentCursor(previousCursor);
    void load(applied, previousCursor);
  }

  const filtersAreActive = Object.values(applied).some((value) => value !== "");

  return (
    <PageCard>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-white/85">Orders</p>
        <p className="text-[11px] text-white/40">Newest first, by the time SQRATCH ingested the order</p>
      </div>

      {/* ---------------- Filter toolbar ---------------- */}
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {connections.length > 1 ? (
          <label className="space-y-1 text-xs text-white/55">
            <span>Store</span>
            <select
              value={draft.connectionId}
              onChange={(e) => setDraft((d) => ({ ...d, connectionId: e.target.value }))}
              className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
            >
              <option value="">All stores</option>
              {connections.map((connection) => (
                <option key={connection.connectionId} value={connection.connectionId}>
                  {PROVIDER_LABELS[connection.provider]} — {connection.displayName || connection.externalAccountId}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        <label className="space-y-1 text-xs text-white/55">
          <span>Order number</span>
          <Input
            value={draft.orderNumber}
            onChange={(e) => setDraft((d) => ({ ...d, orderNumber: e.target.value }))}
            // Bounded here as well as server-side; the server is authoritative.
            maxLength={MAX_ORDER_NUMBER_SEARCH_LENGTH}
            placeholder="e.g. 1002"
            className="border-white/10 bg-black/20 text-white"
          />
        </label>

        <label className="space-y-1 text-xs text-white/55">
          <span>Payment status</span>
          <select
            value={draft.financialStatus}
            onChange={(e) => setDraft((d) => ({ ...d, financialStatus: e.target.value }))}
            className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          >
            <option value="">Any payment status</option>
            {FINANCIAL_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-xs text-white/55">
          <span>Fulfillment status</span>
          <select
            value={draft.fulfillmentStatus}
            onChange={(e) => setDraft((d) => ({ ...d, fulfillmentStatus: e.target.value }))}
            className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          >
            <option value="">Any fulfillment status</option>
            {FULFILLMENT_STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="space-y-1 text-xs text-white/55">
          <span>Attribution</span>
          <select
            value={draft.attributed}
            onChange={(e) => setDraft((d) => ({ ...d, attributed: e.target.value }))}
            className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
          >
            <option value="">All orders</option>
            <option value="attributed">Attributed</option>
            <option value="unattributed">Unattributed</option>
          </select>
        </label>

        <label className="space-y-1 text-xs text-white/55">
          <span>Order date from</span>
          <Input
            type="datetime-local"
            value={draft.dateFrom}
            onChange={(e) => setDraft((d) => ({ ...d, dateFrom: e.target.value }))}
            className="border-white/10 bg-black/20 text-white"
          />
        </label>

        <label className="space-y-1 text-xs text-white/55">
          <span>Order date to</span>
          <Input
            type="datetime-local"
            value={draft.dateTo}
            onChange={(e) => setDraft((d) => ({ ...d, dateTo: e.target.value }))}
            className="border-white/10 bg-black/20 text-white"
          />
        </label>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button
          onClick={applyFilters}
          disabled={loading}
          className="rounded-full border border-white bg-white text-black hover:bg-white/90"
        >
          Apply filters
        </Button>
        {filtersAreActive ? (
          <Button
            onClick={resetFilters}
            disabled={loading}
            variant="outline"
            className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
          >
            Clear filters
          </Button>
        ) : null}
      </div>

      {/* ---------------- Results ---------------- */}
      {loading ? (
        <p className="mt-4 text-sm text-white/65">Loading orders...</p>
      ) : error ? (
        <p className="mt-4 text-sm text-red-300">{error}</p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-white/65">
          {filtersAreActive
            ? "No orders match these filters."
            : "No orders yet."}
        </p>
      ) : (
        <div className="mt-4 space-y-2">
          {rows.map((row) => (
            <OrderExplorerRow key={row.id} row={row} />
          ))}
        </div>
      )}

      {!loading && !error && (rows.length > 0 || canGoPrevious) ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          {/* Both are disabled while a page is in flight. Without that, a
              fast double-click on Next pushes TWO entries onto the cursor
              stack while only one page actually advances (the stale response
              is discarded by `requestSeq`), leaving the page counter wrong
              and requiring two Previous clicks to get back one page. */}
          <Button
            onClick={goPrevious}
            disabled={!canGoPrevious || loading}
            variant="outline"
            className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
          >
            Previous
          </Button>
          <Button
            onClick={goNext}
            disabled={!hasNextPage || loading}
            variant="outline"
            className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
          >
            Next
          </Button>
          <span className="text-[11px] text-white/40">Page {cursorStack.length + 1}</span>
        </div>
      ) : null}
    </PageCard>
  );
}

/**
 * One order row. A real `<a>` (not a click handler on a div) so keyboard
 * focus, Enter activation, middle-click and "open in new tab" all work
 * without any custom key handling.
 *
 * MONEY is always rendered through `formatMoneyDisplay`, which uses the
 * row's OWN persisted `minorUnitExponent` — never a hardcoded `/100`, so
 * JPY (exponent 0) and 3-decimal currencies render correctly, and an
 * unknown amount/currency/exponent renders as an em dash rather than a
 * fabricated "$0.00".
 */
function OrderExplorerRow({ row }: { row: OrderListRow }) {
  const refunded = row.totalRefundedMinor;
  const hasRefund = refunded !== null && refunded !== "0" && !refunded.startsWith("-");

  return (
    <a
      href={`/dashboard/brand/commerce/orders/${row.id}`}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/20 p-3 hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
    >
      <div className="min-w-0">
        <p className="text-sm text-white/80">
          {row.orderNumber ?? `#${row.id.slice(0, 8)}`} — {PROVIDER_LABELS[row.provider] ?? row.provider}
        </p>
        <p className="mt-1 text-xs text-white/45">
          {formatDateTime(row.orderDate)} — {row.financialStatus ?? "Unknown"} —{" "}
          {row.attributed ? "Attributed" : "Unattributed"}
        </p>
      </div>
      <div className="flex flex-col items-end gap-1">
        <p className="text-sm text-white/80 tabular-nums">
          {formatMoneyDisplay(row.totalMinor, row.currencyCode, row.minorUnitExponent)}
        </p>
        {/* Refunded/net are shown ONLY when money has actually been refunded
            — a zero-refund order would otherwise carry two redundant lines
            (net always equals gross there). */}
        {hasRefund ? (
          <>
            <p className="text-[11px] text-amber-200/80 tabular-nums">
              Refunded {formatMoneyDisplay(refunded, row.currencyCode, row.minorUnitExponent)}
            </p>
            <p className="text-[11px] text-white/55 tabular-nums">
              Net {formatMoneyDisplay(row.netRevenueMinor, row.currencyCode, row.minorUnitExponent)}
            </p>
          </>
        ) : null}
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
                activityRefreshToken={refreshToken}
              />
            ))}
            <Button asChild variant="outline" className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10">
              <a href="/dashboard/brand/commerce">Back to Store</a>
            </Button>
          </div>
        )}
      </PageCard>
      <OrderExplorer
        refreshToken={refreshToken}
        connections={summary?.connections ?? []}
      />
    </BrandPageShell>
  );
}
