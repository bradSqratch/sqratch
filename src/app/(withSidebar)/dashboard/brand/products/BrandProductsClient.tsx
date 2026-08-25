"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Package, RefreshCw } from "lucide-react";
import { BrandPageShell } from "@/components/brand/page-shell";
import { fetchJson, getErrorMessage } from "@/components/experience/client-utils";
import { PageCard } from "@/components/experience/experience-shell";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  buildProductQueryString,
  DISPLAY_ORDER_MAX,
  DISPLAY_ORDER_MIN,
  describeSyncOutcome,
  formatPriceDisplay,
  SHORT_DESCRIPTION_OVERRIDE_MAX_LENGTH,
  TITLE_OVERRIDE_MAX_LENGTH,
  validateDisplayOrder,
  validateShortDescriptionOverride,
  validateTitleOverride,
  type SyncOutcomeNotice,
} from "./product-catalog-helpers";

// ---------------------------------------------------------------------------
// Wire types (mirrors GET/PATCH /api/brand/products response shapes)
// ---------------------------------------------------------------------------

type ProductSelection = {
  isVisibleInShop: boolean;
  isCampaignEligible: boolean;
  displayOrder: number;
  titleOverride: string | null;
  shortDescriptionOverride: string | null;
};

type ProductRow = {
  id: string;
  externalId: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  sku: string | null;
  status: string | null;
  isAvailable: boolean;
  lastSeenAt: string;
  unavailableSince: string | null;
  price: {
    minMinor: number | null;
    maxMinor: number | null;
    currencyCode: string | null;
    minorUnitExponent: number | null;
  };
  selection: ProductSelection;
};

type LastSyncRunSummary = {
  id: string;
  status: string;
  finishedAt: string | null;
} | null;

type ProductsListMeta = {
  nextCursor: string | null;
  hasNextPage: boolean;
  limit: number;
  lastSyncRun: LastSyncRunSummary;
};

type LiveConnection = {
  connectionId: string;
  provider: string;
  status: string;
  displayName: string;
  externalAccountId: string;
  isConnected: boolean;
  lastProductSyncAt: string | null;
};

type BrandCommerceConnectionsResponse = {
  connections: LiveConnection[];
  complete: boolean;
  autoSelectConnectionId: string | null;
} | null;

/**
 * PHASE 18 REPAIR (P2-4A): tracks the connections-LIST fetch as its own
 * state machine, separate from the (possibly stale, single-preferred)
 * `/api/brand/commerce/status` read. `"ready"` is the ONLY state in which
 * an operational action (sync) may be enabled — `"loading"`/`"error"`/
 * `"incomplete"` (the server itself could not verify every provider) all
 * mean "we do not yet definitively know the brand's connection list," and
 * must never be silently treated as "proceed with whatever status said."
 */
type ConnectionsListStatus = "loading" | "ready" | "incomplete" | "error";

type BrandCommerceStatus = {
  connection: LiveConnection | null;
} | null;

type AvailabilityFilter = "available" | "unavailable" | "all";

type OverrideDraft = {
  displayOrder: string;
  titleOverride: string;
  shortDescriptionOverride: string;
};

type OverrideRowState = {
  saving: boolean;
  error: string | null;
  success: boolean;
};

function draftFromSelection(selection: ProductSelection): OverrideDraft {
  return {
    displayOrder: String(selection.displayOrder),
    titleOverride: selection.titleOverride ?? "",
    shortDescriptionOverride: selection.shortDescriptionOverride ?? "",
  };
}

function toneClass(tone: SyncOutcomeNotice["tone"]): string {
  if (tone === "success") {
    return "border-emerald-300/30 bg-emerald-300/10 text-emerald-100";
  }
  if (tone === "warning") {
    return "border-amber-300/25 bg-amber-300/10 text-amber-100";
  }
  return "border-red-300/25 bg-red-300/10 text-red-200";
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

type SyncRunRow = {
  id: string;
  connectionId: string;
  provider: string;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  markedUnavailableCount: number;
  failedCount: number;
  hasNextPage: boolean;
  failureSummary: string | null;
};

const SYNC_RUN_STATUS_LABELS: Record<string, string> = {
  SUCCEEDED: "Succeeded",
  PARTIAL: "Partial",
  FAILED: "Failed",
  RUNNING: "Running",
};

function syncRunStatusToneClass(status: string): string {
  if (status === "SUCCEEDED") return "border-emerald-400/25 bg-emerald-400/10 text-emerald-200/90";
  if (status === "PARTIAL") return "border-amber-400/25 bg-amber-400/10 text-amber-200/90";
  if (status === "FAILED") return "border-red-400/25 bg-red-400/10 text-red-200/90";
  return "border-white/15 bg-white/5 text-white/70";
}

/**
 * PHASE 19 — PART 13/14: persisted sync-run history for the connection
 * CURRENTLY BEING VIEWED (`displayConnection`) — reads the existing
 * `GET /api/brand/products/sync-runs?connectionId=...` route (already
 * connection-scoped, sanitized — never a raw exception/credential/payload,
 * see that route's own doc comment). Re-keyed by `connectionId` so
 * switching stores never shows a stale list from a previously-viewed
 * connection while the new one's data is still loading.
 */
function SyncRunHistory({ connectionId }: { connectionId: string }) {
  const [runs, setRuns] = useState<SyncRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRuns([]);

    (async () => {
      try {
        const data = await fetchJson<{ data: SyncRunRow[] }>(
          `/api/brand/products/sync-runs?connectionId=${encodeURIComponent(connectionId)}&limit=10`,
        );
        if (!cancelled) setRuns(data.data);
      } catch (loadError) {
        if (!cancelled) setError(getErrorMessage(loadError, "Failed to load sync history."));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [connectionId]);

  return (
    <PageCard>
      <p className="text-sm font-semibold text-white/85">Sync history</p>
      {loading ? (
        <p className="mt-3 text-sm text-white/65">Loading sync history...</p>
      ) : error ? (
        <p className="mt-3 text-sm text-red-300">{error}</p>
      ) : runs.length === 0 ? (
        <p className="mt-3 text-sm text-white/65">No sync runs recorded yet for this store.</p>
      ) : (
        <div className="mt-3 space-y-2">
          {runs.map((run) => (
            <div key={run.id} className="rounded-xl border border-white/10 bg-black/20 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-white/60">{formatDateTime(run.startedAt)}</p>
                <span className={`rounded-full border px-3 py-1 text-xs ${syncRunStatusToneClass(run.status)}`}>
                  {SYNC_RUN_STATUS_LABELS[run.status] ?? run.status}
                </span>
              </div>
              <p className="mt-2 text-xs text-white/50">
                Fetched {run.fetchedCount}, created {run.createdCount}, updated {run.updatedCount}, unchanged{" "}
                {run.unchangedCount}, unavailable {run.markedUnavailableCount}
                {run.failedCount > 0 ? `, failed ${run.failedCount}` : ""}
                {run.hasNextPage ? " — truncated" : ""}
              </p>
              {run.failureSummary ? (
                <p className="mt-1 text-xs text-amber-200/80">{run.failureSummary}</p>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </PageCard>
  );
}

const PAGE_LIMIT = 50;

export function BrandProductsClient() {
  const [brandStatus, setBrandStatus] = useState<BrandCommerceStatus>(null);
  const [connections, setConnections] = useState<LiveConnection[]>([]);
  const [connectionId, setConnectionId] = useState<string>("");
  const [connectionsListStatus, setConnectionsListStatus] = useState<ConnectionsListStatus>("loading");

  const [products, setProducts] = useState<ProductRow[]>([]);
  const [meta, setMeta] = useState<ProductsListMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [q, setQ] = useState("");
  const [availability, setAvailability] = useState<AvailabilityFilter>("available");

  const [syncing, setSyncing] = useState(false);
  const [syncNotice, setSyncNotice] = useState<SyncOutcomeNotice | null>(null);

  const [drafts, setDrafts] = useState<Record<string, OverrideDraft>>({});
  const [rowState, setRowState] = useState<Record<string, OverrideRowState>>({});
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Guards against a slow, superseded fetch clobbering a newer one when the
  // search box or filters change quickly.
  const requestSeq = useRef(0);

  const loadProducts = useCallback(
    async (options: { reset: boolean; cursor?: string | null }) => {
      const seq = ++requestSeq.current;

      if (options.reset) {
        setLoading(true);
      } else {
        setLoadingMore(true);
      }
      setListError(null);

      try {
        const queryString = buildProductQueryString({
          q,
          availability,
          connectionId: connectionId || null,
          cursor: options.cursor ?? null,
          limit: PAGE_LIMIT,
        });
        const response = await fetch(`/api/brand/products?${queryString}`, {
          credentials: "include",
        });
        const json = await response.json().catch(() => null);

        if (seq !== requestSeq.current) {
          // A newer request already landed — discard this stale result.
          return;
        }

        if (!response.ok) {
          setListError(json?.error || "Failed to load products.");
          if (options.reset) {
            setProducts([]);
            setMeta(null);
          }
          return;
        }

        const rows: ProductRow[] = json?.data ?? [];
        const nextMeta: ProductsListMeta = json?.meta ?? {
          nextCursor: null,
          hasNextPage: false,
          limit: PAGE_LIMIT,
          lastSyncRun: null,
        };

        setProducts((current) => (options.reset ? rows : [...current, ...rows]));
        setMeta(nextMeta);
        setDrafts((current) => {
          const next = { ...current };
          for (const row of rows) {
            next[row.id] = draftFromSelection(row.selection);
          }
          return next;
        });
      } catch (error) {
        if (seq === requestSeq.current) {
          setListError(getErrorMessage(error, "Failed to load products."));
        }
      } finally {
        if (seq === requestSeq.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [q, availability, connectionId],
  );

  /**
   * PHASE 16 BIG ROUND / SUBPHASE 3: sourced from
   * `/api/brand/commerce/connections` — the FULL live list of the brand's
   * connections across every provider, including one that has never been
   * synced (a prior version derived this list from sync-run HISTORY only,
   * so a freshly-connected, never-synced account could never appear or be
   * selected). Auto-selects the connection the moment exactly one usable
   * (CONNECTED) one exists; otherwise leaves the choice to the Brand Admin
   * via the "Store" selector below, and `runSync` refuses to fire an
   * ambiguous request.
   */
  const loadConnections = useCallback(async () => {
    setConnectionsListStatus("loading");
    try {
      const data = await fetchJson<BrandCommerceConnectionsResponse>(
        "/api/brand/commerce/connections",
      );
      const list = data?.connections ?? [];
      setConnections(list);
      setConnectionId((current) => {
        if (current && list.some((connection) => connection.connectionId === current)) {
          return current;
        }
        // PHASE 18 REPAIR (P2-4A): only auto-select when the server itself
        // confirms the read was complete — an incomplete read might be
        // hiding a second connection on a provider whose query failed.
        if (data?.complete && data?.autoSelectConnectionId) {
          return data.autoSelectConnectionId;
        }
        return "";
      });
      setConnectionsListStatus(data?.complete ? "ready" : "incomplete");
    } catch {
      setConnectionsListStatus("error");
    }
  }, []);

  const loadBrandStatus = useCallback(async () => {
    try {
      // PHASE 16C2: provider-neutral — never assumes Shopify. Whichever
      // provider the brand is actually connected to (or none) comes back
      // with the exact same field names.
      const status = await fetchJson<BrandCommerceStatus>(
        "/api/brand/commerce/status",
      );
      setBrandStatus(status);
    } catch {
      // Non-fatal — the connected-store summary just stays blank.
    }
  }, []);

  useEffect(() => {
    void loadBrandStatus();
    void loadConnections();
  }, [loadBrandStatus, loadConnections]);

  // Debounced reload on filter/search change.
  useEffect(() => {
    const handle = setTimeout(() => {
      void loadProducts({ reset: true });
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, availability, connectionId]);

  // PHASE 18 REPAIR (P2-4A): TWO distinct notions of "the active
  // connection," never conflated:
  //   `displayConnection` — for PASSIVE display only (the summary cards,
  //   provider label, empty-state copy). Falls back to
  //   `/api/brand/commerce/status`'s single "preferred" connection while
  //   the live list is still loading, so the page doesn't flash an empty
  //   state during the brief initial-load window.
  //   `syncTargetConnection` — the ONLY value `runSync` and the sync
  //   button's `disabled` condition may use. It is `null` unless
  //   `connectionsListStatus === "ready"` (the live list loaded
  //   successfully AND every provider was confirmed read) — it NEVER falls
  //   back to the status-preferred connection, so a sync can never fire
  //   against a guessed/stale target while the definitive list is still
  //   loading, failed, or came back incomplete.
  const selectedConnection =
    connections.find((connection) => connection.connectionId === connectionId) ?? null;
  const displayConnection = selectedConnection ?? brandStatus?.connection ?? null;
  const syncTargetConnection =
    connectionsListStatus === "ready" ? selectedConnection : null;
  // Explicit choice required: more than one connection exists and none is
  // selected yet. Only meaningful once the list is definitively ready.
  const selectionRequired =
    connectionsListStatus === "ready" && connections.length > 1 && !selectedConnection;
  const providerLabel =
    displayConnection?.provider === "SHOPIFY"
      ? "Shopify"
      : displayConnection?.provider === "COMMERCE7"
        ? "Commerce7"
        : displayConnection?.provider || "";
  // Passive display only — the empty-state / summary-card gate. Sync's OWN
  // gate is `syncTargetConnection?.isConnected`, computed separately below.
  const isConnected = displayConnection?.isConnected === true;
  const canSync = syncTargetConnection?.isConnected === true && !selectionRequired;

  const lastSyncLabel = useMemo(() => {
    const run = meta?.lastSyncRun;
    if (!run) return "Never synced";
    if (run.status === "SUCCEEDED" || run.status === "PARTIAL") {
      return formatDateTime(run.finishedAt);
    }
    if (run.status === "RUNNING") return "Sync in progress";
    return "Last attempt did not complete";
  }, [meta]);

  async function runSync() {
    // PHASE 16C2: the button is already disabled when this is true, but the
    // guard is repeated here so no POST can ever be emitted for a
    // non-CONNECTED (or absent) connection — belt and braces, not merely a
    // UI affordance.
    //
    // PHASE 18 REPAIR (P2-4A): `canSync` (derived from `syncTargetConnection`
    // — see its own doc comment above) is `false` whenever the connections
    // list is not definitively `"ready"`, so a sync can never fire against
    // whatever `/api/brand/commerce/status` happened to report while the
    // authoritative list was still loading, failed, or came back
    // incomplete — never a silently-defaulted or ambiguous target.
    if (!canSync || !syncTargetConnection) {
      return;
    }

    setSyncing(true);
    setSyncNotice(null);

    try {
      // PHASE 16C2: send the EXACT connection identity the brand is actually
      // using — never rely on the backend's "missing provider => Shopify"
      // default, which exists only for legacy callers.
      const response = await fetch("/api/brand/products/sync", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: syncTargetConnection.provider,
          connectionId: syncTargetConnection.connectionId,
        }),
      });
      const json = await response.json().catch(() => null);

      if (response.status === 200) {
        const syncData = json?.data;
        if (syncData?.status === "SUCCEEDED") {
          setSyncNotice(describeSyncOutcome({ status: "SUCCEEDED" }));
        } else if (syncData?.status === "PARTIAL") {
          setSyncNotice(
            describeSyncOutcome({
              status: "PARTIAL",
              failureSummary: syncData.failureSummary ?? null,
              hasNextPage: syncData.hasNextPage === true,
              fetchedCount: syncData.stats?.fetchedCount,
              failedCount: syncData.stats?.failedCount,
              runId: syncData.runId,
            }),
          );
        } else {
          setSyncNotice(describeSyncOutcome({ status: "UNKNOWN_ERROR" }));
        }
      } else if (response.status === 400) {
        const code = json?.code;
        if (code === "NO_CONNECTION") {
          setSyncNotice(describeSyncOutcome({ status: "SKIPPED", code }));
        } else {
          setSyncNotice(
            describeSyncOutcome({ status: "UNKNOWN_ERROR", message: json?.error }),
          );
        }
      } else if (response.status === 409) {
        setSyncNotice(describeSyncOutcome({ status: "SYNC_IN_PROGRESS" }));
      } else if (response.status === 502) {
        setSyncNotice(
          describeSyncOutcome({
            status: "SYNC_FAILED",
            failureSummary: json?.failureSummary ?? null,
          }),
        );
      } else {
        setSyncNotice(
          describeSyncOutcome({ status: "UNKNOWN_ERROR", message: json?.error }),
        );
      }
    } catch {
      setSyncNotice(describeSyncOutcome({ status: "UNKNOWN_ERROR" }));
    } finally {
      setSyncing(false);
      await Promise.all([loadProducts({ reset: true }), loadConnections()]);
    }
  }

  async function patchSelection(
    productId: string,
    body: Partial<{
      isVisibleInShop: boolean;
      isCampaignEligible: boolean;
      displayOrder: number;
      titleOverride: string | null;
      shortDescriptionOverride: string | null;
    }>,
  ) {
    const response = await fetch(`/api/brand/products/${productId}/selection`, {
      method: "PATCH",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(json?.error || "Failed to update product.");
    }
    return json.data as ProductSelection & { connectedProductId: string };
  }

  async function toggleVisibility(product: ProductRow) {
    setTogglingId(product.id);
    try {
      const updated = await patchSelection(product.id, {
        isVisibleInShop: !product.selection.isVisibleInShop,
      });
      setProducts((current) =>
        current.map((p) =>
          p.id === product.id ? { ...p, selection: { ...p.selection, ...updated } } : p,
        ),
      );
    } catch (error) {
      setListError(getErrorMessage(error, "Failed to update visibility."));
    } finally {
      setTogglingId(null);
    }
  }

  async function toggleEligibility(product: ProductRow) {
    setTogglingId(product.id);
    try {
      const updated = await patchSelection(product.id, {
        isCampaignEligible: !product.selection.isCampaignEligible,
      });
      setProducts((current) =>
        current.map((p) =>
          p.id === product.id ? { ...p, selection: { ...p.selection, ...updated } } : p,
        ),
      );
    } catch (error) {
      setListError(getErrorMessage(error, "Failed to update campaign eligibility."));
    } finally {
      setTogglingId(null);
    }
  }

  function updateDraft(productId: string, patch: Partial<OverrideDraft>) {
    setDrafts((current) => ({
      ...current,
      [productId]: { ...(current[productId] ?? draftFromSelection({
        isVisibleInShop: false,
        isCampaignEligible: false,
        displayOrder: 0,
        titleOverride: null,
        shortDescriptionOverride: null,
      })), ...patch },
    }));
  }

  async function saveOverrides(product: ProductRow) {
    const draft = drafts[product.id] ?? draftFromSelection(product.selection);

    const titleError = validateTitleOverride(draft.titleOverride);
    const descriptionError = validateShortDescriptionOverride(draft.shortDescriptionOverride);
    const displayOrderError = validateDisplayOrder(draft.displayOrder);
    const firstError = titleError || descriptionError || displayOrderError;

    if (firstError) {
      setRowState((current) => ({
        ...current,
        [product.id]: { saving: false, error: firstError, success: false },
      }));
      return;
    }

    setRowState((current) => ({
      ...current,
      [product.id]: { saving: true, error: null, success: false },
    }));

    try {
      const updated = await patchSelection(product.id, {
        displayOrder: Number(draft.displayOrder),
        titleOverride: draft.titleOverride.trim().length > 0 ? draft.titleOverride : null,
        shortDescriptionOverride:
          draft.shortDescriptionOverride.trim().length > 0
            ? draft.shortDescriptionOverride
            : null,
      });
      setProducts((current) =>
        current.map((p) =>
          p.id === product.id ? { ...p, selection: { ...p.selection, ...updated } } : p,
        ),
      );
      setRowState((current) => ({
        ...current,
        [product.id]: { saving: false, error: null, success: true },
      }));
    } catch (error) {
      setRowState((current) => ({
        ...current,
        [product.id]: {
          saving: false,
          error: getErrorMessage(error, "Failed to save overrides."),
          success: false,
        },
      }));
    }
  }

  return (
    <BrandPageShell
      title="Products"
      description="Review the synced commerce catalog, control what's visible in the SQRATCH Shop, and mark products eligible for campaigns."
      actions={
        <Button
          type="button"
          onClick={() => void runSync()}
          disabled={syncing || !canSync}
          title={
            connectionsListStatus === "loading"
              ? "Loading store connections…"
              : connectionsListStatus === "error"
                ? "Could not load store connections. Try refreshing the page."
                : connectionsListStatus === "incomplete"
                  ? "Could not confirm every connected store. Try refreshing the page."
                  : selectionRequired
                    ? "Select which store to sync below."
                    : !canSync
                      ? "Connect a commerce store, or reconnect the one that needs it, before syncing products."
                      : undefined
          }
          className="rounded-full border border-white bg-white text-black hover:bg-white/90"
        >
          <RefreshCw className={`h-4 w-4 ${syncing ? "animate-spin" : ""}`} />
          {syncing ? "Syncing..." : "Sync products"}
        </Button>
      }
    >
      <PageCard>
        <div className="space-y-5">
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="text-sm text-white/55">Connected store</p>
              <p className="mt-2 text-sm text-white/80">
                {displayConnection?.externalAccountId || "Not connected"}
              </p>
              {displayConnection ? (
                <span className="mt-2 inline-flex rounded-full border border-white/15 bg-white/5 px-3 py-1 text-xs text-white/70">
                  {providerLabel}
                </span>
              ) : null}
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="text-sm text-white/55">Connection status</p>
              <p className="mt-2 text-2xl font-semibold">
                {isConnected
                  ? "Connected"
                  : displayConnection?.status === "UNINSTALLED"
                    ? "Uninstalled"
                    : displayConnection?.status === "REQUIRES_RECONNECT"
                      ? "Needs reconnect"
                      : "Not connected"}
              </p>
            </div>
            <div className="rounded-2xl border border-white/10 bg-black/20 p-4">
              <p className="text-sm text-white/55">Last successful sync</p>
              <p className="mt-2 text-sm text-white/80">{lastSyncLabel}</p>
            </div>
          </div>

          {syncNotice ? (
            <div className={`rounded-2xl border p-4 text-sm ${toneClass(syncNotice.tone)}`}>
              {syncNotice.message}
            </div>
          ) : null}
          <p className="text-xs leading-5 text-white/50">
            Changes made in {providerLabel || "your store"}, including changing a product between Active and Draft,
            appear in SQRATCH after the next successful product sync.
          </p>
        </div>
      </PageCard>

      {displayConnection ? <SyncRunHistory connectionId={displayConnection.connectionId} /> : null}

      <PageCard>
        <div className="flex flex-col gap-4 md:flex-row md:flex-wrap md:items-end">
          <label className="min-w-[220px] flex-1 space-y-2 text-sm text-white/70">
            <span>Search</span>
            <Input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="Search by title or SKU"
              className="border-white/10 bg-black/20 text-white"
            />
          </label>
          <label className="space-y-2 text-sm text-white/70">
            <span>Product status</span>
            <select
              value={availability}
              onChange={(event) => setAvailability(event.target.value as AvailabilityFilter)}
              className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
            >
              <option value="available">Active</option>
              <option value="unavailable">Inactive</option>
              <option value="all">All</option>
            </select>
          </label>
          {connections.length > 1 ? (
            <label className="space-y-2 text-sm text-white/70">
              <span>Store{selectionRequired ? " (select one to sync)" : ""}</span>
              <select
                value={connectionId}
                onChange={(event) => setConnectionId(event.target.value)}
                className="h-10 w-full rounded-md border border-white/10 bg-black/20 px-3 text-sm text-white"
              >
                <option value="">All stores (browse only)</option>
                {connections.map((connection) => (
                  <option key={connection.connectionId} value={connection.connectionId}>
                    {connection.provider === "SHOPIFY"
                      ? "Shopify"
                      : connection.provider === "COMMERCE7"
                        ? "Commerce7"
                        : connection.provider}
                    {" — "}
                    {connection.displayName || connection.externalAccountId}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      </PageCard>

      {listError ? (
        <PageCard>
          <p className="text-sm text-red-300">{listError}</p>
        </PageCard>
      ) : null}

      <PageCard>
        {loading ? (
          <p className="text-sm text-white/65">Loading products...</p>
        ) : !isConnected && products.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 p-6 text-sm text-white/55">
            No commerce store is connected yet. Connect a store from the Store
            page, then come back here to sync products.
          </div>
        ) : products.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-white/10 bg-black/20 p-6 text-sm text-white/55">
            {q.trim() || availability !== "available"
              ? "No products match the current filters."
              : "No products synced yet. Use “Sync products” above to pull in the catalog."}
          </div>
        ) : (
          <div className="space-y-4">
            {products.map((product) => {
              const draft = drafts[product.id] ?? draftFromSelection(product.selection);
              const state = rowState[product.id];

              return (
                <div
                  key={product.id}
                  className="rounded-3xl border border-white/10 bg-black/20 p-5"
                >
                  <div className="flex flex-col gap-4 lg:flex-row">
                    <a
                      href={product.productUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0"
                    >
                      {product.imageUrl ? (
                        <Image
                          src={product.imageUrl}
                          alt={product.title}
                          width={128}
                          height={128}
                          className="h-28 w-28 rounded-xl border border-white/10 object-cover"
                        />
                      ) : (
                        <div className="flex h-28 w-28 items-center justify-center rounded-xl border border-white/10 bg-white/5 text-white/35">
                          <Package className="h-6 w-6" />
                        </div>
                      )}
                    </a>

                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex flex-wrap items-center gap-3">
                        <a
                          href={product.productUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-lg font-semibold text-white hover:underline"
                        >
                          {product.title}
                        </a>
                        <span
                          title="Active means this product was present and active in the latest successful product sync."
                          className={`rounded-full border px-3 py-1 text-xs ${
                            product.isAvailable
                              ? "border-emerald-300/30 bg-emerald-300/10 text-emerald-100"
                              : "border-white/10 bg-white/5 text-white/50"
                          }`}
                        >
                          {product.isAvailable ? "Active" : "Inactive"}
                        </span>
                      </div>
                      <p className="text-sm text-white/55">
                        SKU: {product.sku || "—"}
                      </p>
                      <p className="text-sm text-white/80">
                        {formatPriceDisplay(product.price)}
                      </p>

                      <div className="grid gap-3 pt-1 text-sm text-white/70">
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={product.selection.isVisibleInShop}
                            disabled={togglingId === product.id}
                            onCheckedChange={() => void toggleVisibility(product)}
                            className="border-white/30 data-[state=checked]:border-emerald-300 data-[state=checked]:bg-emerald-400"
                          />
                          Visible in SQRATCH Shop
                        </label>
                        <p className="-mt-2 pl-6 text-xs leading-5 text-white/50">
                          Shows this product in the public SQRATCH campaign storefront when the
                          campaign uses the brand catalog.
                        </p>
                        <label className="flex items-center gap-2">
                          <Checkbox
                            checked={product.selection.isCampaignEligible}
                            disabled={togglingId === product.id}
                            onCheckedChange={() => void toggleEligibility(product)}
                            className="border-white/30 data-[state=checked]:border-emerald-300 data-[state=checked]:bg-emerald-400"
                          />
                          Campaign eligible
                        </label>
                        <p className="-mt-2 pl-6 text-xs leading-5 text-white/50">
                          Marks this product as eligible for future campaign assignment.
                          Campaign-level product selection and creator filtering will be added in
                          a later phase.
                        </p>
                      </div>

                      <details className="pt-2">
                        <summary className="cursor-pointer select-none text-sm text-white/60">
                          Presentation overrides
                        </summary>
                        <div className="mt-3 grid gap-3 lg:grid-cols-2">
                          <label className="space-y-1 text-xs text-white/55">
                            <span>Display order</span>
                            <Input
                              type="number"
                              min={DISPLAY_ORDER_MIN}
                              max={DISPLAY_ORDER_MAX}
                              step={1}
                              inputMode="numeric"
                              value={draft.displayOrder}
                              onChange={(event) =>
                                updateDraft(product.id, { displayOrder: event.target.value })
                              }
                              className="border-white/10 bg-black/20 text-white"
                            />
                          </label>
                          <label className="space-y-1 text-xs text-white/55">
                            <span>
                              Title override ({draft.titleOverride.length}/
                              {TITLE_OVERRIDE_MAX_LENGTH})
                            </span>
                            <Input
                              value={draft.titleOverride}
                              onChange={(event) =>
                                updateDraft(product.id, { titleOverride: event.target.value })
                              }
                              placeholder={product.title}
                              className="border-white/10 bg-black/20 text-white"
                            />
                          </label>
                          <label className="space-y-1 text-xs text-white/55 lg:col-span-2">
                            <span>
                              Short description override ({draft.shortDescriptionOverride.length}/
                              {SHORT_DESCRIPTION_OVERRIDE_MAX_LENGTH})
                            </span>
                            <Textarea
                              value={draft.shortDescriptionOverride}
                              onChange={(event) =>
                                updateDraft(product.id, {
                                  shortDescriptionOverride: event.target.value,
                                })
                              }
                              className="min-h-20 border-white/10 bg-black/20 text-white"
                            />
                          </label>
                        </div>
                        <div className="mt-3 flex flex-wrap items-center gap-3">
                          <Button
                            type="button"
                            variant="outline"
                            onClick={() => void saveOverrides(product)}
                            disabled={state?.saving}
                            className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
                          >
                            {state?.saving ? "Saving..." : "Save overrides"}
                          </Button>
                          {state?.error ? (
                            <span className="text-xs text-red-300">{state.error}</span>
                          ) : null}
                          {state?.success ? (
                            <span className="text-xs text-emerald-300">Saved.</span>
                          ) : null}
                        </div>
                      </details>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {meta?.hasNextPage ? (
          <div className="mt-6 flex justify-center">
            <Button
              type="button"
              variant="outline"
              onClick={() => void loadProducts({ reset: false, cursor: meta.nextCursor })}
              disabled={loadingMore}
              className="rounded-full border-white/20 bg-transparent text-white hover:bg-white/10"
            >
              {loadingMore ? "Loading..." : "Load more"}
            </Button>
          </div>
        ) : null}
      </PageCard>
    </BrandPageShell>
  );
}
