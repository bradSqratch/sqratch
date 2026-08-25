/**
 * src/lib/commerce/product-sync.ts
 *
 * Provider-neutral PRODUCT PERSISTENCE service. Fetches a brand's commerce
 * catalog through the registered `CommerceAdapter` (never a hard-coded
 * Shopify import) and upserts it into `ConnectedCommerceProduct`, recording
 * one `CommerceProductSyncRun` row per attempt.
 *
 * Same dependency-injection idiom as `./connection-sync.ts` /
 * `./connection-reconciliation.ts`: every exported entry point takes a
 * `Partial<ProductSyncDeps>`, the default DB-backed implementations lazily
 * `import("@/lib/prisma")` inside the function body, so importing this
 * module never requires `DATABASE_URL`.
 *
 * ---------------------------------------------------------------------------
 * MISSING CONNECTIONS NEVER GET A SILENT EMPTY SUCCESS
 * ---------------------------------------------------------------------------
 * `CommerceProductSyncRun.connectionId` is a required FK to a real
 * `CommerceConnection` row. A missing connection therefore returns an
 * explicit skipped outcome, never a false successful zero-product sync.
 *
 * ---------------------------------------------------------------------------
 * FULL vs PARTIAL vs FAILED, AND THE MARK-UNAVAILABLE GUARD
 * ---------------------------------------------------------------------------
 * The soft-unavailability step (marking every previously-seen,
 * currently-available product that was NOT returned by this run as
 * `isAvailable: false`) is the most dangerous write this module makes: get it
 * wrong and a transient provider hiccup erases a brand's entire catalog. It
 * therefore runs ONLY when the fetch fully and successfully exhausted the
 * catalog:
 *
 *   - A provider-page failure before any usable result -> run status FAILED.
 *   - A page failure, malformed cursor, guard, timeout, or write failure
 *     after usable products -> run status PARTIAL. Returned products may be
 *     persisted, but absence reconciliation is skipped.
 *   - Only a page sequence that explicitly terminates with `isComplete:true`
 *     and has no write failures -> run status SUCCEEDED. Only then does
 *     absence reconciliation run, scoped to `connectionId` and excluding
 *     every external key seen in the complete catalog.
 *
 * The guard itself lives in `runProductSync` below, directly on the branch
 * that decides `finalStatus`: `markUnavailableExcept` is called from exactly
 * one place, inside `if (finalStatus === "SUCCEEDED")`.
 *
 * `hasPublicStorefrontUrl` (Phase 8) is held to the SAME discipline, and is
 * deliberately narrower: it is only ever written from a page that actually
 * returned that specific product, i.e. through `decideProductWrite`'s
 * CREATE/UPDATE data for a fetched row. The absence sweep
 * (`markUnavailableExcept`) must never touch it — a truncated fetch would
 * otherwise mass-clear every unfetched product's public destination. It is
 * also never derived from `isAvailable` (or vice versa): one is provider
 * inventory/lifecycle status, the other is whether the provider gave us a
 * provider-confirmed Online Store publication, and a public click destination
 * needs both. Shopify's password-protected development stores can return
 * `onlineStoreUrl: null` for every published product, so the adapter's fact
 * comes from its complete publication scan, never URL presence alone.
 *
 * ---------------------------------------------------------------------------
 * MONEY / CURRENCY
 * ---------------------------------------------------------------------------
 * `CommerceProduct.currency` (from `./types.ts`) is NEVER read here — for
 * Shopify it is a hardcoded `"USD"` default unless a caller explicitly
 * supplies `options.currency` to `fetchNormalizedShopifyProducts`, which
 * nothing in this codebase does (see that file's own warning comment).
 * Instead, currency comes from the ALREADY-RESOLVED
 * `CommerceConnectionSummary.currencyCode` (`summary.currencyCode`,
 * sourced from `CommerceConnection.providerMetadata.currencyCode` — the
 * single canonical currency representation, see `./types.ts`) —
 * `syncBrandCommerceProducts` already resolves `summary` before this sync
 * even starts, so this is a pure pass-through, not a second read. This
 * module deliberately does NOT attempt a live self-heal fetch when it is
 * `null`: doing so would require importing Shopify-specific token/currency
 * resolution into a module whose entire contract is provider-neutral (see
 * the file header above — adapter access only, never a hard-coded Shopify
 * import). The self-heal that DOES exist (`getValidAccessToken` +
 * `getShopifyShopCurrencyWithAccessToken` + `recordCommerceConnectionCurrencyCode`,
 * see `src/app/api/brand/rewards/offers/route.ts`) lives at the Shopify-aware
 * routes that actually need it, and its write lands in the same canonical
 * field this module reads — so a gap closed there is visible here on the
 * very next sync with no duplicated logic. Fetched once per sync (not once
 * per product). When `summary.currencyCode` is `null`/unknown, EVERY
 * product for this brand gets
 * `currencyCode: null`, `priceMinMinor: null`, `priceMaxMinor: null`,
 * `priceMinorUnitExponent: null` — never a guessed "USD", and never an
 * amount stored without a currency to name its unit. When the brand currency
 * IS known, `priceRangeRaw.min` / `.max` (raw decimal strings) are converted
 * independently via `providerPriceStringToMinorUnits` from `./money.ts`; a
 * parse failure on one bound (`ok: false` — including a value that parses
 * fine but overflows Postgres `INTEGER`'s 32-bit range, reason
 * `OUT_OF_RANGE`; see that module's header) nulls only that bound, not the
 * whole product — `priceMinorUnitExponent` is resolved directly from the
 * currency code via `getCurrencyExponent` so it is never left `null` merely
 * because a price string failed to parse.
 *
 * ---------------------------------------------------------------------------
 * CHANGE DETECTION AND IDEMPOTENCY
 * ---------------------------------------------------------------------------
 * `decideProductWrite` is a PURE function (no I/O) that compares a fetched
 * product's computed fields against the existing row (if any) and returns
 * one of three decisions: CREATE (no existing row), UPDATE (an existing row
 * whose title/handle/productUrl/imageUrl/images/externalVariantIds/
 * descriptionText/sku/currencyCode/price fields/status changed, OR whose
 * availability needs to flip), or TOUCH (existing row, nothing meaningful
 * changed). Only CREATE/UPDATE write the full field set; TOUCH writes ONLY
 * `lastSeenAt` + `lastSyncRunId` — this is what makes a second, identical
 * sync report 100% UNCHANGED while performing no other field writes.
 *
 * ---------------------------------------------------------------------------
 * SANITIZED providerMetadata
 * ---------------------------------------------------------------------------
 * `buildProviderMetadata` whitelists exactly five benign, non-credential
 * fields from the neutral `CommerceProduct` — `status`, `priceText`,
 * `providerCreatedAt` (ISO string), `providerUpdatedAt` (ISO string), and a
 * boolean URL-provenance marker — and
 * NEVER spreads the provider payload or stores a raw provider node, URL with
 * embedded credentials, header, or token. `failureSummary` (on
 * `CommerceProductSyncRun`) is built by `classifySyncFailure` below, which
 * emits a short classified tag plus a bounded (300-char), message-only
 * string — never a full error object, response body, or URL.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO
 * ---------------------------------------------------------------------------
 * It never hard-deletes a `ConnectedCommerceProduct` row (soft-unavailable
 * only, per the schema's design). It never touches
 * `CommerceConnection.lastProductSyncAt` directly — the optional adapter
 * completion hook owns that provider-connection write after this service has
 * confirmed a complete persisted catalog. This file only directly touches
 * `ConnectedCommerceProduct` / `CommerceProductSyncRun`.
 */

import { CommerceProvider, type Prisma } from "@prisma/client";
import type { CommerceAdapter } from "./adapter";
import {
  CommerceConnectionMismatchError,
  CommerceConnectionNotFoundError,
  CommerceConnectionNotReadyError,
  CommerceProviderApiError,
  UnsupportedCapabilityError,
} from "./errors";
import { getCurrencyExponent, providerPriceStringToMinorUnits } from "./money";
import type { CommerceConnectionSummary, CommerceProduct } from "./types";
import {
  getActiveCommerceConnection,
  getAdapterForConnection,
  getCommerceConnectionById,
} from "./connection-service";
import {
  deriveCurrencyCodeForFingerprint,
  deriveProductConfigurationFingerprint,
} from "./product-config-fingerprint";
import { lockCommerceConnectionForTransaction } from "./connection-row-lock";

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

export type ProductSyncStats = {
  fetchedCount: number;
  createdCount: number;
  updatedCount: number;
  unchangedCount: number;
  markedUnavailableCount: number;
  failedCount: number;
};

function zeroStats(): ProductSyncStats {
  return {
    fetchedCount: 0,
    createdCount: 0,
    updatedCount: 0,
    unchangedCount: 0,
    markedUnavailableCount: 0,
    failedCount: 0,
  };
}

export type ProductSyncSkippedReason =
  /** The brand has no commerce connection at all for this provider. */
  | "NO_CONNECTION"
  /**
   * A connection exists for this provider but its `status` is not
   * `CONNECTED` (e.g. `UNINSTALLED`, `DISCONNECTED`, `REQUIRES_RECONNECT`).
   * PHASE 16C2: the canonical product-sync lifecycle invariant — provider
   * I/O never runs against a non-CONNECTED connection. Never silently swaps
   * in a different connection or auto-reconnects.
   */
  | "NOT_CONNECTED";

export type ProductSyncOutcome =
  | {
      status: "SKIPPED";
      reason: ProductSyncSkippedReason;
      brandId: string;
      provider: CommerceProvider;
    }
  | {
      /**
       * PHASE 19 REPAIR (P1-2): the atomic claim (see `claimProductSyncRun`)
       * found an existing, still-fresh `RUNNING` run for this EXACT
       * connection and refused to start a second one. Distinct from
       * `SKIPPED` (which means "there is nothing to do") — this means
       * "there IS work, but another run already owns it right now."
       */
      status: "ALREADY_RUNNING";
      brandId: string;
      provider: CommerceProvider;
      connectionId: string;
      runningRun: { id: string; startedAt: Date };
    }
  | {
      status: "SUCCEEDED" | "PARTIAL" | "FAILED";
      brandId: string;
      provider: CommerceProvider;
      connectionId: string;
      runId: string;
      stats: ProductSyncStats;
      hasNextPage: boolean;
      /** Classified, sanitized failure detail. `null` for a SUCCEEDED run. */
      failureSummary: string | null;
    };

// ---------------------------------------------------------------------------
// DB row shapes (select-shaped, never the full Prisma model)
// ---------------------------------------------------------------------------

export type ExistingConnectedProductRow = {
  id: string;
  externalKey: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  externalVariantIds: string[];
  descriptionText: string | null;
  sku: string | null;
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
  isAvailable: boolean;
  hasPublicStorefrontUrl: boolean;
  unavailableSince: Date | null;
  providerMetadata: Prisma.JsonValue | null;
};

export type ConnectedProductWriteData = {
  externalId: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  externalVariantIds: string[];
  descriptionText: string | null;
  sku: string | null;
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
  isAvailable: boolean;
  hasPublicStorefrontUrl: boolean;
  unavailableSince: Date | null;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  providerMetadata: Prisma.JsonObject;
  lastSeenAt: Date;
  lastSyncRunId: string;
};

export type ProductWriteDecision =
  | { kind: "CREATE"; data: ConnectedProductWriteData }
  | { kind: "UPDATE"; existingId: string; data: ConnectedProductWriteData }
  | {
      kind: "TOUCH";
      existingId: string;
      lastSeenAt: Date;
      lastSyncRunId: string;
    };

export type CreateSyncRunInput = {
  connectionId: string;
  brandId: string;
  provider: CommerceProvider;
  triggeredBy: string | null;
};

/**
 * PHASE 19 REPAIR (P1-2): the outcome of `claimProductSyncRun` — a
 * discriminated union so a caller can never mistake "I claimed a NEW run"
 * for "someone else already owns one." See that dep's own doc comment for
 * the atomicity guarantee.
 */
export type ClaimSyncRunResult =
  | { status: "CLAIMED"; run: { id: string } }
  | { status: "ALREADY_RUNNING"; runningRun: { id: string; startedAt: Date } };

export type FinalizeSyncRunInput = {
  status: "SUCCEEDED" | "PARTIAL" | "FAILED";
  finishedAt: Date;
  stats: ProductSyncStats;
  hasNextPage: boolean;
  requestedLimit: number | null;
  failureSummary: string | null;
};

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

export type ProductSyncDeps = {
  /** Resolves the brand's active connection summary for `provider`. Defaults to `getActiveCommerceConnection`. */
  getActiveConnection(
    brandId: string,
    provider: CommerceProvider,
  ): Promise<CommerceConnectionSummary | null>;
  /** Resolves the adapter for `provider`. Throws `UnsupportedProviderError` for an unregistered provider (no live example today: SHOPIFY and COMMERCE7 are both registered as of Phase 16C1). Never itself makes a network call. */
  getAdapter(summary: CommerceConnectionSummary): CommerceAdapter;
  /** Loads every existing `ConnectedCommerceProduct` row for this connection, keyed for change detection. */
  findExistingProducts(
    connectionId: string,
  ): Promise<ExistingConnectedProductRow[]>;
  /**
   * PHASE 19 REPAIR (P1-2): atomically checks for an existing `RUNNING`
   * run for this EXACT connection and, if none exists, creates one — as
   * ONE database transaction that also serializes on the exact
   * `CommerceConnection` row (see the default implementation's doc
   * comment for the locking mechanism). This REPLACES the prior
   * `createSyncRun` (always-create) + a separate, non-atomic
   * `findRunningRun` pre-check that used to live in the route layer: two
   * near-simultaneous requests for the SAME connection could both observe
   * "no RUNNING row" before either had written its own. Folding the check
   * and the create into one transaction closes that window. The claimed
   * row becomes THE run `runProductSync` uses for the rest of this call —
   * nothing else ever creates a second `CommerceProductSyncRun` row for
   * this invocation.
   *
   * PHASE 20 REPAIR (stale-run lease repair, P1): there is deliberately NO
   * age-based staleness window here anymore — ANY existing `RUNNING` row
   * for this connection, regardless of how old, yields `ALREADY_RUNNING`.
   * See `runProductSync`'s doc comment (above its call site) for why: this
   * codebase has no field that safely proves a `RUNNING` row is abandoned
   * rather than merely long-running, so an age cutoff could — and, before
   * this repair, did — reclaim a connection out from under a genuinely
   * live sync, producing two concurrent writers for the same connection.
   * A `RUNNING` row is authoritative until `finalizeSyncRun` closes it.
   */
  claimProductSyncRun(input: CreateSyncRunInput): Promise<ClaimSyncRunResult>;
  /** Finalizes a run with its terminal status + counts. */
  finalizeSyncRun(runId: string, input: FinalizeSyncRunInput): Promise<void>;
  /**
   * PHASE 19 REPAIR (P1-1): applies one product's create/update/touch
   * decision — and, when `expectedFingerprint` is non-null, does so
   * ATOMICALLY with a live config-freshness recheck, inside ONE database
   * transaction that also serializes on the exact `CommerceConnection`
   * row (see the default implementation's doc comment). This is what
   * makes stale-data safety a property the write itself GUARANTEES before
   * it commits, rather than something a separate cleanup step restores
   * afterward: if the live fingerprint no longer matches
   * `expectedFingerprint` (or cannot be read at all) at the moment this
   * transaction actually persists the row, the implementation must
   * silently substitute a SANITIZED decision (money/public-destination
   * fields forced to their safe fail-closed values) instead of `decision`
   * — never write `decision` as given. `expectedFingerprint: null` means
   * the caller already knows the baseline itself was untrustworthy (the
   * PRE-fetch read failed) — in that case `decision` is assumed to
   * already be pre-sanitized by the caller, and no live recheck is
   * meaningful (there is nothing trustworthy to compare against), so the
   * implementation writes it as given without opening a locking
   * transaction for it.
   *
   * Returns whether the write that actually committed was the trusted,
   * as-given `decision` (`true`) or a sanitized substitute (`false`) —
   * informational only; `runProductSync` does not need this to enforce
   * correctness (the final safety net still runs regardless), but it is
   * useful for logging/telemetry.
   */
  applyProductWrite(
    connectionId: string,
    brandId: string,
    provider: CommerceProvider,
    externalKey: string,
    decision: ProductWriteDecision,
    expectedFingerprint: string | null,
  ): Promise<{ trustworthy: boolean }>;
  /**
   * Marks every currently-available product for `connectionId` whose
   * `externalKey` is NOT in `seenExternalKeys` as unavailable (setting
   * `unavailableSince` to `now` and `lastSyncRunId` to `runId`). MUST only
   * ever be called after a full, successful fetch — see the file header.
   * MUST NOT re-stamp a row that is already `isAvailable: false` (the
   * default implementation's `where` clause enforces this by filtering on
   * `isAvailable: true`).
   */
  markUnavailableExcept(
    connectionId: string,
    seenExternalKeys: string[],
    now: Date,
    runId: string,
  ): Promise<{ count: number }>;
  /**
   * PHASE 16-18 REPAIR (config-vs-sync race, P1-1): a cheap, CONFIG-ONLY
   * fingerprint of the connection — see `./product-config-fingerprint.ts`
   * for the exact field list and, critically, WHY `updatedAt` /
   * `lastProductSyncAt` must never be part of it (a normal successful sync
   * writes `lastProductSyncAt` to itself via `completeProductSync`, which
   * bumps Prisma's `@updatedAt` — using that as the fingerprint made every
   * successful sync self-invalidate). `runProductSync` reads this THREE
   * times: once per product write (a live recheck against the baseline
   * captured by `getConnectionConfigSnapshot`, narrowing the race window
   * from "the whole sync" down to "this one product's write"), and once
   * more after every write the sync will ever make (the final safety net)
   * — see `runProductSync` for the full fail-CLOSED state machine. Returns
   * `null` if the connection is gone (a real, meaningful value — never
   * conflated with a read FAILURE, which the caller wraps separately; see
   * `readConnectionFingerprint`).
   */
  getConnectionFingerprint(connectionId: string): Promise<string | null>;
  /**
   * PHASE 16-18 REPAIR (P1-1): a ONE-TIME baseline read, taken as the very
   * first action of a sync run, before any catalog fetch or write. Returns
   * BOTH the config-only fingerprint AND the currency code extracted from
   * the SAME row read — deliberately not two separate reads, and
   * deliberately not the `currencyCode` a caller might have resolved
   * earlier (e.g. via `getActiveCommerceConnection`, which can run a full
   * DB round-trip — `createSyncRun` — before this read happens): if a
   * configuration change landed in that gap, an earlier-resolved
   * `currencyCode` could already be stale relative to a fingerprint
   * captured moments later, and every live per-write recheck against that
   * stale-but-matching fingerprint would then wrongly authorize it. Reading
   * both from one row eliminates that gap by construction. Returns `null`
   * only if the connection row is gone.
   */
  getConnectionConfigSnapshot(
    connectionId: string,
  ): Promise<{ fingerprint: string; currencyCode: string | null } | null>;
  /**
   * PHASE 16-18 REPAIR (P1-1/P1-2/4A): scoped to the EXACT connection only.
   * Called from `runProductSync`'s final safety net when the configuration
   * fingerprint could not be proven unchanged across the whole sync.
   * Nulls `currencyCode`/`priceMinMinor`/`priceMaxMinor`/
   * `priceMinorUnitExponent` AND sets `hasPublicStorefrontUrl: false` in
   * ONE atomic write (never two independent calls that could leave a
   * partial cleanup if one succeeds and the other fails — see 4A) —
   * mirrors the fail-closed state `configureCommerce7Storefront`'s own
   * invalidation applies on a genuine config save (see
   * `./providers/commerce7-storefront-configuration.ts`), duplicated here
   * (not imported) so this file stays provider-neutral. MUST throw on
   * failure rather than swallow it — `runProductSync` depends on that to
   * enforce P1-2 (a required safety write that failed must never let the
   * run report SUCCEEDED).
   */
  invalidateStaleConfigDerivedFields(connectionId: string): Promise<void>;
};

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

const EXISTING_PRODUCT_SELECT = {
  id: true,
  externalKey: true,
  title: true,
  handle: true,
  productUrl: true,
  imageUrl: true,
  images: true,
  externalVariantIds: true,
  descriptionText: true,
  sku: true,
  currencyCode: true,
  priceMinMinor: true,
  priceMaxMinor: true,
  priceMinorUnitExponent: true,
  isAvailable: true,
  hasPublicStorefrontUrl: true,
  unavailableSince: true,
  providerMetadata: true,
} as const;

async function defaultGetActiveConnection(
  brandId: string,
  provider: CommerceProvider,
): Promise<CommerceConnectionSummary | null> {
  return getActiveCommerceConnection(brandId, provider);
}

const CONFIG_FINGERPRINT_SELECT = {
  provider: true,
  storefrontUrl: true,
  providerMetadata: true,
} as const;

async function readConnectionConfigRow(connectionId: string) {
  const prisma = await getPrisma();
  return prisma.commerceConnection.findUnique({
    where: { id: connectionId },
    select: CONFIG_FINGERPRINT_SELECT,
  });
}

async function defaultGetConnectionFingerprint(
  connectionId: string,
): Promise<string | null> {
  const row = await readConnectionConfigRow(connectionId);
  return row ? deriveProductConfigurationFingerprint(row) : null;
}

async function defaultGetConnectionConfigSnapshot(
  connectionId: string,
): Promise<{ fingerprint: string; currencyCode: string | null } | null> {
  const row = await readConnectionConfigRow(connectionId);
  if (!row) {
    return null;
  }
  return {
    fingerprint: deriveProductConfigurationFingerprint(row),
    currencyCode: deriveCurrencyCodeForFingerprint(row.providerMetadata),
  };
}

async function defaultInvalidateStaleConfigDerivedFields(
  connectionId: string,
): Promise<void> {
  const prisma = await getPrisma();
  // ONE UPDATE statement — atomic by construction, never a partial
  // cleanup where currency is nulled but the public destination isn't (or
  // vice versa). See the P1-2/4A doc comment on this dep's type.
  await prisma.connectedCommerceProduct.updateMany({
    where: { connectionId },
    data: {
      currencyCode: null,
      priceMinMinor: null,
      priceMaxMinor: null,
      priceMinorUnitExponent: null,
      hasPublicStorefrontUrl: false,
    },
  });
}

function defaultGetAdapter(
  summary: CommerceConnectionSummary,
): CommerceAdapter {
  return getAdapterForConnection(summary);
}

async function defaultFindExistingProducts(
  connectionId: string,
): Promise<ExistingConnectedProductRow[]> {
  const prisma = await getPrisma();
  return prisma.connectedCommerceProduct.findMany({
    where: { connectionId },
    select: EXISTING_PRODUCT_SELECT,
  });
}

/**
 * PHASE 19 REPAIR (P1-2, real-lock round): serializes on the exact
 * `CommerceConnection` row via `lockCommerceConnectionForTransaction` (see
 * `./connection-row-lock.ts` for the full justification and empirical
 * proof that this — unlike the prior round's `data: {}` — is a REAL
 * PostgreSQL row lock), then performs the RUNNING-run check and the create
 * through the SAME transaction client (`tx`) — so a second, concurrent call
 * for the SAME `connectionId` genuinely blocks at the row lock until the
 * first commits, rather than racing a plain SELECT against a plain INSERT
 * the way the original best-effort guard did.
 *
 * The row lock is held only for the duration of THIS transaction (check +
 * possible create) — never across provider HTTP, which has not started yet
 * at the point this is called (see `runProductSync`). A connectionId that
 * no longer exists makes the locking `update()` itself throw (Prisma's
 * standard "record not found" behavior for `update`, unlike `findUnique`) —
 * an acceptable, safe failure mode for this already-extremely-narrow race
 * (the connection was resolved successfully by the caller only moments
 * earlier): it surfaces as a request-level error, never as a claim
 * silently succeeding against a nonexistent connection.
 */
async function defaultClaimProductSyncRun(
  input: CreateSyncRunInput,
): Promise<ClaimSyncRunResult> {
  const prisma = await getPrisma();
  return prisma.$transaction(async (tx) => {
    // Real row lock — see ./connection-row-lock.ts. A concurrent claim
    // attempt for the SAME connectionId blocks here until this transaction
    // commits or rolls back — this is what turns "check for RUNNING, then
    // create" into one atomic critical section.
    await lockCommerceConnectionForTransaction(tx, input.connectionId);

    // PHASE 20 REPAIR: no `startedAt` age filter — see this function's
    // interface doc comment (`claimProductSyncRun`) for why an age cutoff
    // is unsafe here. ANY RUNNING row for this connection blocks a new
    // claim, no matter how long it has been running.
    const existing = await tx.commerceProductSyncRun.findFirst({
      where: {
        connectionId: input.connectionId,
        status: "RUNNING",
      },
      orderBy: [{ startedAt: "desc" }],
      select: { id: true, startedAt: true },
    });
    if (existing) {
      return { status: "ALREADY_RUNNING" as const, runningRun: existing };
    }

    const run = await tx.commerceProductSyncRun.create({
      data: {
        connectionId: input.connectionId,
        brandId: input.brandId,
        provider: input.provider,
        status: "RUNNING",
        triggeredBy: input.triggeredBy ?? undefined,
      },
      select: { id: true },
    });
    return { status: "CLAIMED" as const, run };
  });
}

async function defaultFinalizeSyncRun(
  runId: string,
  input: FinalizeSyncRunInput,
): Promise<void> {
  const prisma = await getPrisma();
  await prisma.commerceProductSyncRun.update({
    where: { id: runId },
    data: {
      status: input.status,
      finishedAt: input.finishedAt,
      fetchedCount: input.stats.fetchedCount,
      createdCount: input.stats.createdCount,
      updatedCount: input.stats.updatedCount,
      unchangedCount: input.stats.unchangedCount,
      markedUnavailableCount: input.stats.markedUnavailableCount,
      failedCount: input.stats.failedCount,
      hasNextPage: input.hasNextPage,
      requestedLimit: input.requestedLimit ?? undefined,
      failureSummary: input.failureSummary ?? undefined,
    },
  });
}

/** Structural subset of the Prisma client (or a live transaction handle) `persistDecision` needs — satisfied by both `prisma` and a `tx` callback argument. */
type ProductWriteClient = {
  connectedCommerceProduct: {
    create(args: { data: Record<string, unknown> }): Promise<unknown>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
};

async function persistDecision(
  client: ProductWriteClient,
  connectionId: string,
  brandId: string,
  provider: CommerceProvider,
  externalKey: string,
  decision: ProductWriteDecision,
): Promise<void> {
  if (decision.kind === "CREATE") {
    await client.connectedCommerceProduct.create({
      data: { connectionId, brandId, provider, externalKey, ...decision.data },
    });
    return;
  }
  if (decision.kind === "UPDATE") {
    await client.connectedCommerceProduct.update({
      where: { id: decision.existingId },
      data: decision.data,
    });
    return;
  }
  await client.connectedCommerceProduct.update({
    where: { id: decision.existingId },
    data: {
      lastSeenAt: decision.lastSeenAt,
      lastSyncRunId: decision.lastSyncRunId,
    },
  });
}

/**
 * PHASE 19 REPAIR (P1-1): when `expectedFingerprint` is non-null, the live
 * config-freshness recheck and the actual product write happen INSIDE ONE
 * transaction that ALSO row-locks the exact `CommerceConnection` (the same
 * real lock (`lockCommerceConnectionForTransaction` — see
 * `./connection-row-lock.ts`) as `defaultClaimProductSyncRun`. This is the
 * structural fix for P1-1: stale-data safety is now guaranteed BEFORE an
 * authoritative write can commit, not restored by a separate cleanup step
 * afterward. A concurrent config-save transaction
 * (`configureCommerce7Storefront`) naturally participates in the SAME lock
 * — its own `CommerceConnection` UPDATE takes an equivalent Postgres
 * row-level lock for the duration of ITS transaction, so the two either
 * fully serialize with the stale write committing first (safe: the
 * subsequent config-save's own invalidation still cleans it up) or the
 * config-save commits first (safe: this transaction's live re-read then
 * observes the NEW fingerprint and sanitizes before ever persisting).
 *
 * `expectedFingerprint === null` means the caller's baseline was already
 * untrustworthy (see `applyProductWrite`'s doc comment on `ProductSyncDeps`
 * for why no locking transaction is opened in that case). A connectionId
 * that no longer exists makes the locking `update()` throw — caught by
 * `runProductSync`'s existing per-product try/catch (a write failure for
 * ONE product already increments `stats.failedCount` and continues, never
 * strands the run), so a deleted connection safely results in "this
 * product was not written this run," never a stale write.
 */
async function defaultApplyProductWrite(
  connectionId: string,
  brandId: string,
  provider: CommerceProvider,
  externalKey: string,
  decision: ProductWriteDecision,
  expectedFingerprint: string | null,
): Promise<{ trustworthy: boolean }> {
  const prisma = await getPrisma();

  if (expectedFingerprint === null) {
    await persistDecision(prisma, connectionId, brandId, provider, externalKey, decision);
    return { trustworthy: false };
  }

  return prisma.$transaction(async (tx) => {
    // Real row lock FIRST — see ./connection-row-lock.ts. Held until this
    // transaction commits, so a concurrent config-save (or another
    // per-write lock attempt for the SAME connection) genuinely waits here.
    await lockCommerceConnectionForTransaction(tx, connectionId);

    // Read the live config AFTER acquiring the lock, inside the SAME
    // transaction — this sees either (a) the pre-existing config, if no
    // concurrent config-save is contending for the lock, or (b) whatever a
    // concurrent config-save committed before releasing the lock this
    // transaction just waited on.
    const row = await tx.commerceConnection.findUnique({
      where: { id: connectionId },
      select: { provider: true, storefrontUrl: true, providerMetadata: true },
    });
    const liveFingerprint = row ? deriveProductConfigurationFingerprint(row) : null;
    const trustworthy = liveFingerprint !== null && liveFingerprint === expectedFingerprint;
    const finalDecision = trustworthy ? decision : sanitizeDecisionForUntrustedConfig(decision);

    await persistDecision(tx, connectionId, brandId, provider, externalKey, finalDecision);
    return { trustworthy };
  });
}

async function defaultMarkUnavailableExcept(
  connectionId: string,
  seenExternalKeys: string[],
  now: Date,
  runId: string,
): Promise<{ count: number }> {
  const prisma = await getPrisma();
  const result = await prisma.connectedCommerceProduct.updateMany({
    where: {
      connectionId,
      isAvailable: true,
      externalKey: { notIn: seenExternalKeys },
    },
    data: {
      isAvailable: false,
      unavailableSince: now,
      lastSyncRunId: runId,
    },
  });
  return { count: result.count };
}

const DEFAULT_PRODUCT_SYNC_DEPS: ProductSyncDeps = {
  getActiveConnection: defaultGetActiveConnection,
  getAdapter: defaultGetAdapter,
  findExistingProducts: defaultFindExistingProducts,
  claimProductSyncRun: defaultClaimProductSyncRun,
  finalizeSyncRun: defaultFinalizeSyncRun,
  applyProductWrite: defaultApplyProductWrite,
  markUnavailableExcept: defaultMarkUnavailableExcept,
  getConnectionFingerprint: defaultGetConnectionFingerprint,
  getConnectionConfigSnapshot: defaultGetConnectionConfigSnapshot,
  invalidateStaleConfigDerivedFields: defaultInvalidateStaleConfigDerivedFields,
};

function resolveDeps(deps: Partial<ProductSyncDeps>): ProductSyncDeps {
  return { ...DEFAULT_PRODUCT_SYNC_DEPS, ...deps };
}

// ---------------------------------------------------------------------------
// Pure helpers: money / currency
// ---------------------------------------------------------------------------

/** Provider-neutral "is this product currently sellable" predicate. Unset/missing status defaults to available; anything other than "ACTIVE" (case-insensitive) is treated as unavailable. */
function isStatusActive(status: string | null | undefined): boolean {
  if (status === null || status === undefined) {
    return true;
  }
  return status.trim().toUpperCase() === "ACTIVE";
}

type ComputedPrice = {
  currencyCode: string | null;
  priceMinMinor: number | null;
  priceMaxMinor: number | null;
  priceMinorUnitExponent: number | null;
};

/**
 * Resolves currency + minor-unit prices from the canonical
 * `CommerceConnectionSummary.currencyCode`, NEVER from
 * `CommerceProduct.currency`. Returns every field `null` when
 * `brandCurrencyCode` is unknown — see the file header's MONEY / CURRENCY
 * section for why.
 */
function computePrice(
  product: CommerceProduct,
  brandCurrencyCode: string | null,
): ComputedPrice {
  const trimmed = brandCurrencyCode?.trim().toUpperCase();
  if (!trimmed) {
    return {
      currencyCode: null,
      priceMinMinor: null,
      priceMaxMinor: null,
      priceMinorUnitExponent: null,
    };
  }

  const exponent = getCurrencyExponent(trimmed).exponent;
  const rawMin = product.priceRangeRaw?.min ?? null;
  const rawMax = product.priceRangeRaw?.max ?? null;
  const minResult = providerPriceStringToMinorUnits(rawMin, trimmed);
  const maxResult = providerPriceStringToMinorUnits(rawMax, trimmed);

  return {
    currencyCode: trimmed,
    priceMinMinor: minResult.ok ? minResult.minorUnits : null,
    priceMaxMinor: maxResult.ok ? maxResult.minorUnits : null,
    priceMinorUnitExponent: exponent,
  };
}

/**
 * Whitelisted, sanitized `providerMetadata`. Only these five fields are ever
 * copied out of the neutral `CommerceProduct` — never the raw provider node,
 * never a token/header/URL. See the file header's providerMetadata section.
 */
function buildProviderMetadata(product: CommerceProduct): Prisma.JsonObject {
  const metadata: Prisma.JsonObject = {};
  if (product.status) {
    metadata.status = product.status;
  }
  if (product.priceText) {
    metadata.priceText = product.priceText;
  }
  if (product.providerCreatedAt) {
    metadata.providerCreatedAt = product.providerCreatedAt.toISOString();
  }
  if (product.providerUpdatedAt) {
    metadata.providerUpdatedAt = product.providerUpdatedAt.toISOString();
  }
  if (typeof product.hasProviderSuppliedStorefrontUrl === "boolean") {
    metadata.storefrontUrlSource = product.hasProviderSuppliedStorefrontUrl
      ? "PROVIDER"
      : "FALLBACK";
  }
  return metadata;
}

function jsonStringField(
  value: Prisma.JsonValue | null | undefined,
  key: string,
): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, Prisma.JsonValue>)[key];
  return typeof field === "string" ? field : null;
}

// ---------------------------------------------------------------------------
// Pure change detection / write decision
// ---------------------------------------------------------------------------

type ComputedProductFields = {
  externalKey: string;
  externalId: string;
  title: string;
  handle: string | null;
  productUrl: string;
  imageUrl: string | null;
  images: string[];
  externalVariantIds: string[];
  descriptionText: string | null;
  sku: string | null;
  isAvailable: boolean;
  hasPublicStorefrontUrl: boolean;
  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;
  providerMetadata: Prisma.JsonObject;
} & ComputedPrice;

function computeProductFields(
  product: CommerceProduct,
  brandCurrencyCode: string | null,
): ComputedProductFields {
  return {
    externalKey: product.externalId,
    externalId: product.externalId,
    title: product.title,
    handle: product.handle,
    productUrl: product.productUrl,
    imageUrl: product.imageUrl,
    images: product.images,
    externalVariantIds: product.externalVariantIds,
    descriptionText: product.descriptionText ?? null,
    sku: product.sku ?? null,
    isAvailable: isStatusActive(product.status),
    // Fail-closed: an adapter that does not report complete storefront
    // publication evidence is treated as "not publicly usable". Never
    // derived from `status` / `isAvailable`, or a possibly fabricated URL.
    hasPublicStorefrontUrl: product.hasProviderStorefrontPublication === true,
    providerCreatedAt: product.providerCreatedAt ?? null,
    providerUpdatedAt: product.providerUpdatedAt ?? null,
    providerMetadata: buildProviderMetadata(product),
    ...computePrice(product, brandCurrencyCode),
  };
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  return a.every((value, index) => value === b[index]);
}

/** True when any field that counts as "changed" per the module's contract differs. Does NOT include availability — see `decideProductWrite`. */
function contentChanged(
  existing: ExistingConnectedProductRow,
  computed: ComputedProductFields,
): boolean {
  return (
    existing.title !== computed.title ||
    existing.handle !== computed.handle ||
    existing.productUrl !== computed.productUrl ||
    existing.imageUrl !== computed.imageUrl ||
    !arraysEqual(existing.images, computed.images) ||
    !arraysEqual(existing.externalVariantIds, computed.externalVariantIds) ||
    existing.descriptionText !== computed.descriptionText ||
    existing.sku !== computed.sku ||
    existing.currencyCode !== computed.currencyCode ||
    existing.priceMinMinor !== computed.priceMinMinor ||
    existing.priceMaxMinor !== computed.priceMaxMinor ||
    existing.priceMinorUnitExponent !== computed.priceMinorUnitExponent ||
    existing.hasPublicStorefrontUrl !== computed.hasPublicStorefrontUrl ||
    jsonStringField(existing.providerMetadata, "status") !==
      jsonStringField(computed.providerMetadata, "status") ||
    jsonStringField(existing.providerMetadata, "storefrontUrlSource") !==
      jsonStringField(computed.providerMetadata, "storefrontUrlSource")
  );
}

function toWriteData(
  computed: ComputedProductFields,
  now: Date,
  runId: string,
  previousUnavailableSince: Date | null,
): ConnectedProductWriteData {
  const unavailableSince = computed.isAvailable
    ? null
    : (previousUnavailableSince ?? now);

  return {
    externalId: computed.externalId,
    title: computed.title,
    handle: computed.handle,
    productUrl: computed.productUrl,
    imageUrl: computed.imageUrl,
    images: computed.images,
    externalVariantIds: computed.externalVariantIds,
    descriptionText: computed.descriptionText,
    sku: computed.sku,
    currencyCode: computed.currencyCode,
    priceMinMinor: computed.priceMinMinor,
    priceMaxMinor: computed.priceMaxMinor,
    priceMinorUnitExponent: computed.priceMinorUnitExponent,
    isAvailable: computed.isAvailable,
    hasPublicStorefrontUrl: computed.hasPublicStorefrontUrl,
    unavailableSince,
    providerCreatedAt: computed.providerCreatedAt,
    providerUpdatedAt: computed.providerUpdatedAt,
    providerMetadata: computed.providerMetadata,
    lastSeenAt: now,
    lastSyncRunId: runId,
  };
}

/**
 * Pure decision function — no I/O. Compares a fetched product's computed
 * fields against the existing row (if any). Availability is handled
 * separately from `contentChanged`: a product whose content is byte-identical
 * but that is transitioning available<->unavailable (e.g. reappearing after
 * a prior absence, or newly reporting a non-ACTIVE status) still counts as a
 * write (UPDATE), never silently absorbed into TOUCH.
 */
export function decideProductWrite(
  existing: ExistingConnectedProductRow | null,
  computed: ComputedProductFields,
  now: Date,
  runId: string,
): ProductWriteDecision {
  if (!existing) {
    return { kind: "CREATE", data: toWriteData(computed, now, runId, null) };
  }

  const fieldsChanged = contentChanged(existing, computed);
  const availabilityChanged = existing.isAvailable !== computed.isAvailable;

  if (!fieldsChanged && !availabilityChanged) {
    return {
      kind: "TOUCH",
      existingId: existing.id,
      lastSeenAt: now,
      lastSyncRunId: runId,
    };
  }

  return {
    kind: "UPDATE",
    existingId: existing.id,
    data: toWriteData(computed, now, runId, existing.unavailableSince),
  };
}

/**
 * PHASE 19 REPAIR (P1-1): pure — given a decision computed OPTIMISTICALLY
 * (assuming the config baseline is still trustworthy), returns an
 * equivalent decision with every config-derived field forced to its safe
 * fail-closed value. `TOUCH` is returned unchanged: it never carries
 * money/public-destination fields to begin with (see `decideProductWrite`
 * — a TOUCH only ever writes `lastSeenAt`/`lastSyncRunId`), so there is
 * nothing to sanitize.
 */
export function sanitizeDecisionForUntrustedConfig(
  decision: ProductWriteDecision,
): ProductWriteDecision {
  if (decision.kind === "TOUCH") {
    return decision;
  }
  return {
    ...decision,
    data: {
      ...decision.data,
      currencyCode: null,
      priceMinMinor: null,
      priceMaxMinor: null,
      priceMinorUnitExponent: null,
      hasPublicStorefrontUrl: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Failure classification (bounded, sanitized — never an error object/body/URL)
// ---------------------------------------------------------------------------

const MAX_FAILURE_MESSAGE_LENGTH = 300;

function classifySyncFailure(error: unknown): { tag: string; message: string } {
  if (error instanceof CommerceProviderApiError) {
    return {
      tag: "PROVIDER_API_ERROR",
      message: error.message.slice(0, MAX_FAILURE_MESSAGE_LENGTH),
    };
  }
  if (error instanceof Error) {
    return {
      tag: "UNKNOWN_ERROR",
      message: error.message.slice(0, MAX_FAILURE_MESSAGE_LENGTH),
    };
  }
  return {
    tag: "UNKNOWN_ERROR",
    message: "Non-Error value thrown during product sync.",
  };
}

function formatFailureSummary(tag: string, message: string): string {
  return `${tag}: ${message}`;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export type SyncBrandCommerceProductsOptions = {
  /** Free-text provenance tag stored on `CommerceProductSyncRun.triggeredBy` (e.g. "cron", "manual", "webhook"). */
  triggeredBy?: string;
  /** Provider-neutral page size. Defaults to Shopify's established 100-item page size. */
  pageSize?: number;
  /** Bounded safety guard for a synchronous catalog request. */
  maxPages?: number;
  /** Bounded safety guard for total provider rows observed, before deduplication. */
  maxProducts?: number;
  /** Bounded elapsed-time guard for the complete logical sync. */
  maxDurationMs?: number;
  /** Injectable clock for deterministic unit tests. */
  now?: () => number;
};

const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_MAX_PRODUCTS = 10_000;
const DEFAULT_MAX_DURATION_MS = 45_000;

type CollectedCatalog = {
  products: CommerceProduct[];
  hasNextPage: boolean;
  requestedLimit: number | null;
  failureSummary: string | null;
  providerFailed: boolean;
};

function positiveBound(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || !value || value < 1) {
    return fallback;
  }
  return Math.min(Math.floor(value), maximum);
}

function pageFailureSummary(tag: string, message: string): string {
  return formatFailureSummary(
    tag,
    message.slice(0, MAX_FAILURE_MESSAGE_LENGTH),
  );
}

/**
 * Fetches the whole logical catalog through the optional neutral page method.
 * Older adapters retain their established single-call behavior; they simply
 * report `hasNextPage` and are therefore never mistaken for a complete sync.
 */
async function collectCatalog(
  adapter: CommerceAdapter,
  connectionId: string,
  options: SyncBrandCommerceProductsOptions,
): Promise<CollectedCatalog> {
  if (!adapter.fetchProductPage) {
    const result = await adapter.syncProducts(connectionId);
    return {
      products: result.products,
      hasNextPage: result.hasNextPage,
      requestedLimit: result.limit,
      failureSummary: result.hasNextPage
        ? pageFailureSummary(
            "TRUNCATED_PAGINATION",
            "Adapter returned an incomplete catalog.",
          )
        : null,
      providerFailed: false,
    };
  }

  const pageSize = positiveBound(
    options.pageSize,
    DEFAULT_PAGE_SIZE,
    DEFAULT_PAGE_SIZE,
  );
  const maxPages = positiveBound(options.maxPages, DEFAULT_MAX_PAGES, 10_000);
  const maxProducts = positiveBound(
    options.maxProducts,
    DEFAULT_MAX_PRODUCTS,
    1_000_000,
  );
  const maxDurationMs = positiveBound(
    options.maxDurationMs,
    DEFAULT_MAX_DURATION_MS,
    10 * 60_000,
  );
  const now = options.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), maxDurationMs);
  const observed: CommerceProduct[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let pagesFetched = 0;

  try {
    // Some providers must obtain one complete, catalog-wide fact before the
    // first row can be safely persisted (for example, Shopify's Online Store
    // publication set). Keep that state opaque and provider-owned. If it is
    // incomplete or fails, do not write a catalog page with false/unknown
    // evidence over previously trusted facts.
    let syncContext: unknown;
    try {
      syncContext = await adapter.prepareProductSync?.(connectionId, {
        limit: pageSize,
        maxPages,
        maxProducts,
        signal: controller.signal,
      });
    } catch (error) {
      const timedOut =
        controller.signal.aborted || now() - startedAt >= maxDurationMs;
      const classified = classifySyncFailure(error);
      return {
        products: [],
        hasNextPage: true,
        requestedLimit: pageSize,
        failureSummary: timedOut
          ? pageFailureSummary(
              "PAGINATION_TIMEOUT",
              "Elapsed-time guard reached before publication preparation completed.",
            )
          : pageFailureSummary(
              "PROVIDER_PREPARATION_FAILURE",
              classified.message,
            ),
        providerFailed: !timedOut,
      };
    }

    while (true) {
      if (now() - startedAt >= maxDurationMs) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "PAGINATION_TIMEOUT",
            "Elapsed-time guard reached before catalog completion.",
          ),
          providerFailed: false,
        };
      }

      let page;
      try {
        page = await adapter.fetchProductPage(connectionId, {
          cursor,
          limit: pageSize,
          signal: controller.signal,
          syncContext,
        });
      } catch (error) {
        const timedOut =
          controller.signal.aborted || now() - startedAt >= maxDurationMs;
        const classified = classifySyncFailure(error);
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: timedOut
            ? pageFailureSummary(
                "PAGINATION_TIMEOUT",
                "Elapsed-time guard reached before catalog completion.",
              )
            : pageFailureSummary("PROVIDER_PAGE_FAILURE", classified.message),
          providerFailed: !timedOut,
        };
      }

      pagesFetched += 1;
      if (
        !Array.isArray(page.products) ||
        typeof page.isComplete !== "boolean"
      ) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "INVALID_PAGE",
            "Provider returned an invalid product page.",
          ),
          providerFailed: false,
        };
      }

      for (const product of page.products) {
        if (
          !product ||
          typeof product.externalId !== "string" ||
          !product.externalId.trim()
        ) {
          return {
            products: deduplicateCatalogProducts(observed),
            hasNextPage: true,
            requestedLimit: pageSize,
            failureSummary: pageFailureSummary(
              "INVALID_PAGE",
              "Provider returned a product without an external key.",
            ),
            providerFailed: false,
          };
        }
        observed.push(product);
      }

      if (observed.length > maxProducts) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "MAX_PRODUCTS_REACHED",
            "Maximum product guard reached before catalog completion.",
          ),
          providerFailed: false,
        };
      }

      const nextCursor = page.nextCursor;
      if (page.isComplete) {
        if (nextCursor !== null) {
          return {
            products: deduplicateCatalogProducts(observed),
            hasNextPage: true,
            requestedLimit: pageSize,
            failureSummary: pageFailureSummary(
              "INVALID_PAGE",
              "Complete page returned a next cursor.",
            ),
            providerFailed: false,
          };
        }
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: false,
          requestedLimit: page.limit,
          failureSummary: null,
          providerFailed: false,
        };
      }

      if (typeof nextCursor !== "string" || !nextCursor.trim()) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "MISSING_CURSOR",
            "Incomplete page did not return a usable next cursor.",
          ),
          providerFailed: false,
        };
      }

      if (seenCursors.has(nextCursor)) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "CURSOR_LOOP",
            "Provider returned a repeated catalog cursor.",
          ),
          providerFailed: false,
        };
      }

      if (pagesFetched >= maxPages) {
        return {
          products: deduplicateCatalogProducts(observed),
          hasNextPage: true,
          requestedLimit: pageSize,
          failureSummary: pageFailureSummary(
            "MAX_PAGES_REACHED",
            "Maximum page guard reached before catalog completion.",
          ),
          providerFailed: false,
        };
      }

      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } finally {
    clearTimeout(timeout);
  }
}

/** Later pages win for an overlapping external key; first-seen key order remains stable. */
function deduplicateCatalogProducts(
  products: CommerceProduct[],
): CommerceProduct[] {
  const byExternalKey = new Map<string, CommerceProduct>();
  for (const product of products) {
    byExternalKey.set(product.externalId, product);
  }
  return [...byExternalKey.values()];
}

/**
 * Syncs `brandId`'s catalog for `provider` (default SHOPIFY) into
 * `ConnectedCommerceProduct`. See the file header for the full behavior
 * contract (skip semantics, full/partial/failed determination, money rules,
 * providerMetadata whitelist).
 *
 * Throws `UnsupportedProviderError` (from `deps.getAdapter`) for a provider
 * with no registered adapter, and `UnsupportedCapabilityError` for a
 * registered adapter that does not support product sync — both BEFORE any
 * `CommerceProductSyncRun` row is created and before any network call, so a
 * caller's error handling for "provider not supported" never has to
 * distinguish "did this write a run row" from "did it not".
 */
export async function syncBrandCommerceProducts(
  brandId: string,
  provider: CommerceProvider = CommerceProvider.SHOPIFY,
  options: SyncBrandCommerceProductsOptions = {},
  deps: Partial<ProductSyncDeps> = {},
): Promise<ProductSyncOutcome> {
  const resolvedDeps = resolveDeps(deps);

  const summary = await resolvedDeps.getActiveConnection(brandId, provider);

  if (!summary) {
    return { status: "SKIPPED", reason: "NO_CONNECTION", brandId, provider };
  }

  // PHASE 16C2: the canonical product-sync lifecycle invariant applies here
  // too, not only to the exact-connection-id entry point below. The
  // "preferred" resolver does not itself filter by status, so this boundary
  // must — never silently select a different connection, never auto-heal.
  // A non-CONNECTED preferred row is reported as an ordinary SKIPPED outcome
  // (not a thrown error) so the legacy no-body caller keeps its existing
  // SKIPPED-outcome contract unchanged.
  if (summary.status !== "CONNECTED") {
    return { status: "SKIPPED", reason: "NOT_CONNECTED", brandId, provider };
  }

  const connectionId = summary.id;

  // Resolved BEFORE creating a run row and before any network call — throws
  // UnsupportedProviderError / UnsupportedCapabilityError propagate straight
  // to the caller with nothing written.
  const adapter = resolvedDeps.getAdapter(summary);
  const capabilities = adapter.getCapabilities();
  if (!capabilities.products.sync) {
    throw new UnsupportedCapabilityError(provider, "products.sync");
  }

  return runProductSync(brandId, provider, connectionId, adapter, options, resolvedDeps);
}

export type SyncCommerceConnectionByIdInput = {
  brandId: string;
  provider: CommerceProvider;
  connectionId: string;
};

/**
 * PHASE 16C2: syncs an EXACT `CommerceConnection.id` rather than the brand's
 * "preferred" connection for a provider. Exists so a provider-neutral UI that
 * lets a Brand Admin pick a specific connection (relevant once a brand can
 * hold more than one connection for the same provider) can never have that
 * selection silently resolve to a different account.
 *
 * Verifies, BEFORE any adapter/provider I/O and BEFORE any
 * `CommerceProductSyncRun` row is created:
 *   1. the connection exists;
 *   2. it belongs to `input.brandId` — a mismatch throws the SAME
 *      `CommerceConnectionNotFoundError` as a genuinely missing id, so a
 *      caller can never learn that a connectionId exists under a different
 *      brand;
 *   3. its provider matches `input.provider` exactly — a mismatch throws
 *      `CommerceConnectionMismatchError` (a caller/UI bug, safe to name);
 *   4. its `status` is `CONNECTED` — a mismatch throws
 *      `CommerceConnectionNotReadyError`. This is the canonical product-sync
 *      lifecycle invariant: `UNINSTALLED` / `DISCONNECTED` /
 *      `REQUIRES_RECONNECT` must never reach account-specific provider
 *      transport, even though the connection is genuinely this brand's own
 *      and genuinely the right provider. Never silently falls back to a
 *      different connection or auto-reconnects — the caller must fix the
 *      connection first.
 *   5. the resolved adapter actually supports `products.sync`.
 *
 * Reuses `runProductSync` — the exact same persistence engine
 * `syncBrandCommerceProducts` uses — so there is no second, divergent catalog
 * write path.
 */
export async function syncCommerceConnectionById(
  input: SyncCommerceConnectionByIdInput,
  options: SyncBrandCommerceProductsOptions = {},
  deps: Partial<ProductSyncDeps> & {
    getConnectionById?(connectionId: string): Promise<CommerceConnectionSummary | null>;
  } = {},
): Promise<ProductSyncOutcome> {
  const { getConnectionById = defaultGetConnectionById, ...persistenceOverrides } = deps;
  const resolvedDeps = resolveDeps(persistenceOverrides);

  const summary = await getConnectionById(input.connectionId);

  if (!summary || summary.brandId !== input.brandId) {
    throw new CommerceConnectionNotFoundError(input.connectionId);
  }

  if (summary.provider !== input.provider) {
    throw new CommerceConnectionMismatchError(
      input.connectionId,
      input.provider,
      summary.provider,
    );
  }

  if (summary.status !== "CONNECTED") {
    throw new CommerceConnectionNotReadyError(
      summary.id,
      summary.provider,
      summary.status,
    );
  }

  // Same ordering guarantee as syncBrandCommerceProducts: resolved BEFORE any
  // run row or network call.
  const adapter = resolvedDeps.getAdapter(summary);
  const capabilities = adapter.getCapabilities();
  if (!capabilities.products.sync) {
    throw new UnsupportedCapabilityError(input.provider, "products.sync");
  }

  return runProductSync(input.brandId, input.provider, summary.id, adapter, options, resolvedDeps);
}

async function defaultGetConnectionById(
  connectionId: string,
): Promise<CommerceConnectionSummary | null> {
  return getCommerceConnectionById(connectionId);
}

/**
 * PHASE 18 REPAIR (P1-1): a dedicated sentinel for "the fingerprint read
 * itself failed," distinct from BOTH a real fingerprint string and `null`
 * ("the connection row is genuinely gone" — itself a meaningful, valid
 * result). The prior repair's defect was collapsing a read FAILURE into the
 * same `null` a genuinely-missing connection produces, which then compared
 * as "unchanged" and let stale data through. This type makes that collapse
 * a compile error: `FINGERPRINT_UNKNOWN` can never equal a fingerprint
 * string or `null` in the comparisons below.
 */
const FINGERPRINT_UNKNOWN = Symbol("commerce-product-sync-fingerprint-unknown");
type FingerprintReadResult = string | null | typeof FINGERPRINT_UNKNOWN;
type ConfigSnapshotReadResult =
  | { fingerprint: string; currencyCode: string | null }
  | null
  | typeof FINGERPRINT_UNKNOWN;

async function readConnectionFingerprint(
  deps: ProductSyncDeps,
  connectionId: string,
): Promise<FingerprintReadResult> {
  try {
    return await deps.getConnectionFingerprint(connectionId);
  } catch {
    return FINGERPRINT_UNKNOWN;
  }
}

async function readConnectionConfigSnapshot(
  deps: ProductSyncDeps,
  connectionId: string,
): Promise<ConfigSnapshotReadResult> {
  try {
    return await deps.getConnectionConfigSnapshot(connectionId);
  } catch {
    return FINGERPRINT_UNKNOWN;
  }
}

/**
 * PHASE 20 REPAIR (stale-run lease repair, P1): PHASE 19 introduced a
 * 5-minute `RUNNING_RUN_STALE_AFTER_MS` age cutoff so a `RUNNING` row from
 * a crashed process would not permanently block new syncs. That cutoff was
 * UNSAFE and has been removed. The trace that proves why:
 *
 *   - `maxDurationMs` (see `collectCatalog`, default 45s, caller-clampable
 *     up to 10 minutes) bounds ONLY the provider fetch/pagination phase.
 *     It is enforced by an `AbortController` local to `collectCatalog` and
 *     is never checked, propagated, or re-armed anywhere else.
 *   - Everything after `collectCatalog` returns — the per-product
 *     create/update/touch write loop (up to `maxProducts`, default 10,000,
 *     caller-clampable to 1,000,000), `markUnavailableExcept` absence
 *     reconciliation, `adapter.completeProductSync`, and
 *     `finalizeSyncRun` — has ZERO time bound. A grep of this function's
 *     entire body (claim through finalize) turns up exactly one
 *     time-related statement: the (now-removed) `notBefore` computation.
 *   - Therefore `maxDurationMs` is NOT a hard wall-clock bound on total
 *     run execution, and a legitimate run (large catalog, slow DB/network)
 *     can genuinely still be doing real work well past the old 5-minute
 *     mark.
 *
 * `CommerceProductSyncRun` (see prisma/schema.prisma) has no renewable
 * heartbeat/lease field (`startedAt` is set once at creation, `finishedAt`
 * only at completion — neither can be safely repurposed as a heartbeat
 * without corrupting its own meaning), so there is no schema-change-free
 * way to distinguish "still legitimately running" from "abandoned" by age
 * alone. Adding such a field is a schema change and is explicitly out of
 * scope for this round.
 *
 * The chosen design is therefore: a `RUNNING` row is authoritative and
 * unconditionally blocks a new claim for its connection until
 * `finalizeSyncRun` closes it — no automatic age-based reclaim at all (see
 * `claimProductSyncRun`'s doc comment). This trades away automatic
 * crash recovery (a crashed process can leave a stuck `RUNNING` row,
 * requiring explicit operator intervention — e.g. a manual finalize
 * action, or a future schema addition for a real heartbeat/lease) in
 * exchange for making concurrent-writer catalog corruption structurally
 * impossible. Correctness over unattended recovery.
 */
async function runProductSync(
  brandId: string,
  provider: CommerceProvider,
  connectionId: string,
  adapter: CommerceAdapter,
  options: SyncBrandCommerceProductsOptions,
  deps: ProductSyncDeps,
): Promise<ProductSyncOutcome> {
  // PHASE 19 REPAIR (P1-2): ONE atomic transaction decides "is there
  // already a fresh RUNNING run for this exact connection" AND, if not,
  // creates the new RUNNING row — see `claimProductSyncRun`'s doc comment.
  // The connection has ALREADY been resolved to this exact `connectionId`
  // by the caller (`syncBrandCommerceProducts` / `syncCommerceConnectionById`,
  // both BEFORE calling this function) — so the legacy bodyless path gets
  // the identical per-connection atomicity as the exact-connectionId path,
  // with no separate brand-wide race for it (Part 4C).
  const claim = await deps.claimProductSyncRun({
    connectionId,
    brandId,
    provider,
    triggeredBy: options.triggeredBy ?? null,
  });
  if (claim.status === "ALREADY_RUNNING") {
    // No run was created THIS call — nothing to finalize. The existing
    // RUNNING row belongs to whichever process claimed it; its own
    // eventual finalize is unaffected by this early return.
    return {
      status: "ALREADY_RUNNING",
      brandId,
      provider,
      connectionId,
      runningRun: claim.runningRun,
    };
  }
  const run = claim.run;

  // PHASE 16-18 REPAIR (P1-1): a ONE-TIME baseline captured BEFORE any
  // fetch/write work starts, from a SINGLE row read that yields BOTH the
  // config-only fingerprint AND the currency code used for this run's
  // product computations — see `ProductSyncDeps.getConnectionConfigSnapshot`'s
  // doc comment for why the currency must come from this same read rather
  // than an earlier-resolved `CommerceConnectionSummary.currencyCode`.
  // FAIL-CLOSED, not fail-open: a READ FAILURE here (`FINGERPRINT_UNKNOWN`,
  // never conflated with `null` — a genuinely-gone connection, a real,
  // meaningful, distinct result) means there is no trustworthy baseline at
  // all, so this entire run withholds config-derived authority from the
  // start (see `configTrustworthyAtStart` below).
  const configSnapshotBeforeFetch = await readConnectionConfigSnapshot(deps, connectionId);
  const configTrustworthyAtStart = configSnapshotBeforeFetch !== FINGERPRINT_UNKNOWN;
  const fingerprintBeforeFetch: string | null = configTrustworthyAtStart
    ? (configSnapshotBeforeFetch?.fingerprint ?? null)
    : null;
  const currencyCodeAtStart: string | null = configTrustworthyAtStart
    ? (configSnapshotBeforeFetch?.currencyCode ?? null)
    : null;

  let catalog: CollectedCatalog;
  try {
    catalog = await collectCatalog(adapter, connectionId, options);
  } catch (error) {
    const { tag, message } = classifySyncFailure(error);
    const stats = zeroStats();
    stats.failedCount = 1;
    const failureSummary = formatFailureSummary(tag, message);

    await deps.finalizeSyncRun(run.id, {
      status: "FAILED",
      finishedAt: new Date(),
      stats,
      hasNextPage: false,
      requestedLimit: null,
      failureSummary,
    });

    return {
      status: "FAILED",
      brandId,
      provider,
      connectionId,
      runId: run.id,
      stats,
      hasNextPage: false,
      failureSummary,
    };
  }

  const now = new Date();
  const stats = zeroStats();
  const seenExternalKeys: string[] = [];

  // Pessimistic defaults: if anything below throws before these are
  // overwritten by the normal-completion logic further down, the run still
  // finalizes as FAILED (never RUNNING) via the `finally` block — see the
  // file header's MARK-UNAVAILABLE GUARD section and M2 in the Phase 3
  // review this block closes.
  let finalStatus: "SUCCEEDED" | "PARTIAL" | "FAILED" = "FAILED";
  let failureSummary: string | null = null;
  const hasNextPage = catalog.hasNextPage;
  const requestedLimit: number | null = catalog.requestedLimit;

  try {
    const existingRows = await deps.findExistingProducts(connectionId);
    const existingByKey = new Map(
      existingRows.map((row) => [row.externalKey, row]),
    );

    for (const product of catalog.products) {
      // PHASE 19 REPAIR (P1-1): `computed`/`decision` are still built
      // OPTIMISTICALLY (assuming the baseline captured at the top of this
      // function remains trustworthy) — but unlike the prior round, this
      // is no longer the value that gets persisted unconditionally.
      // `deps.applyProductWrite` performs its OWN atomic, row-locked live
      // recheck immediately before persisting (see that dep's doc
      // comment) and silently substitutes a sanitized decision if the
      // config changed since `fingerprintBeforeFetch` was captured — the
      // structural guarantee this repair round requires: stale-data
      // safety holds BEFORE the write commits, not only after a
      // best-effort cleanup step later.
      const computed = {
        ...computeProductFields(
          product,
          configTrustworthyAtStart ? currencyCodeAtStart : null,
        ),
        ...(configTrustworthyAtStart ? {} : { hasPublicStorefrontUrl: false }),
      };
      const existing = existingByKey.get(computed.externalKey) ?? null;
      const decision = decideProductWrite(existing, computed, now, run.id);

      // A single row's write failure (e.g. M1's int4 overflow surviving
      // some other way, a unique-constraint race with a concurrent run, a
      // transient connection reset) must never abort the whole run and
      // strand it RUNNING — see M2 in the Phase 3 review. Every OTHER
      // product must still get its chance.
      try {
        await deps.applyProductWrite(
          connectionId,
          brandId,
          provider,
          computed.externalKey,
          decision,
          configTrustworthyAtStart ? fingerprintBeforeFetch : null,
        );
      } catch {
        stats.failedCount += 1;
        continue;
      }

      seenExternalKeys.push(computed.externalKey);
      stats.fetchedCount += 1;
      if (decision.kind === "CREATE") {
        stats.createdCount += 1;
      } else if (decision.kind === "UPDATE") {
        stats.updatedCount += 1;
      } else {
        stats.unchangedCount += 1;
      }
    }

    // TRUNCATED/PARTIAL: pagination did not exhaust the catalog. A run with
    // any per-product write failures is also never a clean SUCCEEDED, even
    // when pagination itself completed — see M2 in the Phase 3 review.
    // Products actually written (above) are still persisted either way; the
    // mark-unavailable step below is the ONLY thing this status gates, and
    // it is called from exactly this one place, inside
    // `if (finalStatus === "SUCCEEDED")` — see the file header.
    const isTruncated = catalog.hasNextPage;
    if (catalog.providerFailed) {
      stats.failedCount += 1;
    }
    const hadWriteFailures = stats.failedCount > 0;
    const succeededCount =
      stats.createdCount + stats.updatedCount + stats.unchangedCount;

    if ((catalog.providerFailed || isTruncated) && succeededCount === 0) {
      finalStatus = "FAILED";
    } else if (isTruncated || hadWriteFailures) {
      finalStatus = "PARTIAL";
    } else {
      finalStatus = "SUCCEEDED";
    }

    if (finalStatus === "SUCCEEDED") {
      const unavailableResult = await deps.markUnavailableExcept(
        connectionId,
        seenExternalKeys,
        now,
        run.id,
      );
      stats.markedUnavailableCount = unavailableResult.count;
      // The connection must advertise completion only after absence
      // reconciliation succeeds as well; otherwise its timestamp would
      // falsely describe a partial catalog as complete.
      await adapter.completeProductSync?.(connectionId, now);
    } else {
      const reasons: string[] = catalog.failureSummary
        ? [catalog.failureSummary]
        : [];
      if (isTruncated && reasons.length === 0) {
        reasons.push(
          "pagination did not reach the end of the catalog (hasNextPage=true)",
        );
      }
      if (hadWriteFailures) {
        reasons.push(`${stats.failedCount} product write(s) failed`);
      }
      failureSummary =
        catalog.failureSummary ??
        formatFailureSummary(
          hadWriteFailures ? "PARTIAL_WRITE_FAILURE" : "TRUNCATED_PAGINATION",
          `${reasons.join("; ")}; no product was marked unavailable this run.`,
        );
      if (hadWriteFailures && catalog.failureSummary) {
        failureSummary = formatFailureSummary(
          "PARTIAL_WRITE_FAILURE",
          `${catalog.failureSummary}; ${stats.failedCount} product write(s) or provider page(s) failed; no product was marked unavailable this run.`,
        );
      }
    }
  } catch (error) {
    // An unexpected throw anywhere above (currency lookup, existing-row
    // fetch, or the mark-unavailable step itself) must still finalize the
    // run rather than leave it RUNNING — see M2. Only sanitized,
    // classified detail is recorded; never a raw error object, response
    // body, URL, or credential (same convention as the adapter-throw catch
    // above).
    const { tag, message } = classifySyncFailure(error);
    failureSummary = formatFailureSummary(tag, message);
    const succeededCount =
      stats.createdCount + stats.updatedCount + stats.unchangedCount;
    finalStatus = succeededCount > 0 ? "PARTIAL" : "FAILED";
  } finally {
    // PHASE 19 REPAIR — DEFENSE IN DEPTH ONLY, NOT THE PRIMARY SAFETY
    // MECHANISM. Every product write above already guarantees stale-data
    // safety BEFORE it commits (see `applyProductWrite`'s doc comment on
    // `ProductSyncDeps` — the row-locked transactional recheck): an
    // authoritative A-derived (stale) write can structurally never commit
    // once a config change is visible to that write's own transaction.
    // What THIS block still exists to catch is narrower: `markUnavailableExcept`
    // and `completeProductSync` run OUTSIDE the per-product locking
    // transaction, and a config change could in principle land in the
    // small window between the last per-product write and this check.
    // Re-reads the fingerprint one more time and compares it to the
    // PRE-fetch value; if they don't both exist and match, this connection's
    // product rows are invalidated as a defense-in-depth cleanup, in ONE
    // atomic write (see 4A / `invalidateStaleConfigDerivedFields`'s doc
    // comment) scoped to this EXACT connection only.
    //
    // Its failure is never merely logged and absorbed — it still downgrades
    // `finalStatus` to FAILED before `finalizeSyncRun` is ever called (P1-2
    // of the prior round), so observability stays accurate even though (per
    // Part 2 of THIS round) that failure can no longer leave stale data
    // authoritative — the per-write transactional fence already prevented
    // that. This can still never throw INTO the outer function (a `finally`
    // throwing would replace whatever status/error was already decided
    // above) — the failure is caught, logged LOUDLY, and turned into a
    // status change instead of a propagated exception.
    const fingerprintAfterWrites = await readConnectionFingerprint(deps, connectionId);
    const configStillTrustworthy =
      configTrustworthyAtStart &&
      fingerprintAfterWrites !== FINGERPRINT_UNKNOWN &&
      fingerprintAfterWrites === fingerprintBeforeFetch;

    if (!configStillTrustworthy) {
      console.log(
        JSON.stringify({
          event: "commerce_product_sync_config_untrustworthy",
          connectionId,
          provider,
          runId: run.id,
        }),
      );
      try {
        await deps.invalidateStaleConfigDerivedFields(connectionId);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "commerce_product_sync_invalidation_failed",
            connectionId,
            provider,
            runId: run.id,
            message: classifySyncFailure(error).message,
          }),
        );
        // P1-2: a REQUIRED safety write failed — never let the run report
        // SUCCEEDED while the cleanup it depends on could not be proven to
        // have happened. FAILED (not PARTIAL): this is more severe than an
        // ordinary incomplete catalog fetch — some already-written product
        // data in THIS run may still be stale and unverifiable.
        finalStatus = "FAILED";
        failureSummary = formatFailureSummary(
          "REQUIRED_INVALIDATION_FAILED",
          "Configuration changed during this sync and the required stale-data cleanup failed; some product data written by this run may be stale. Re-run the sync.",
        );
      }
    }

    // Reached on EVERY exit path out of the try block above — normal
    // completion, a per-product write failure loop that ran to the end, or
    // an unexpected throw caught just above. A `CommerceProductSyncRun` row
    // must never be left `RUNNING`.
    await deps.finalizeSyncRun(run.id, {
      status: finalStatus,
      finishedAt: new Date(),
      stats,
      hasNextPage,
      requestedLimit,
      failureSummary,
    });
  }

  return {
    status: finalStatus,
    brandId,
    provider,
    connectionId,
    runId: run.id,
    stats,
    hasNextPage,
    failureSummary,
  };
}
