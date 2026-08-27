/**
 * src/lib/commerce/providers/commerce7-order-refund-reconciliation.ts
 *
 * PHASE 25 — Commerce7 REFUND reconciliation. The provider-specific resolver
 * that teaches the ingestion pipeline what a Commerce7 refund actually looks
 * like, mirroring the ARCHITECTURE of
 * `./shopify-order-financial-reconciliation.ts` (classify -> reconcile ->
 * overlay authoritative settlement fields onto a normalized order) without
 * copying Shopify's API semantics: Commerce7 has no GraphQL transaction
 * ledger, and its refund evidence lives in an entirely different shape.
 *
 * ===========================================================================
 * THE COMMERCE7 REFUND MODEL, AS OBSERVED — NOT FROM OFFICIAL DOCUMENTATION
 * ===========================================================================
 * developer.commerce7.com/docs/orders.md documents `previousOrderId` /
 * `previousOrderNumber` / `linkedOrders` / `purchaseType` NOWHERE (a prior
 * round's re-verification went further and stated `purchaseType` lives only
 * on Commerce7's CART object — that claim is now known to be WRONG for the
 * refund case). Everything below is derived from one verified real refund
 * observed against Commerce7 sandbox tenant `sqratch-inc`, order #1002 /
 * #1003, on 2026-08-26 — stated honestly as OBSERVED SANDBOX BEHAVIOR, not a
 * documented contract:
 *
 *   - Creating a partial or full refund in Commerce7 for order N does NOT
 *     mutate order N's own `tenders[]`. It creates a SEPARATE, independent
 *     Commerce7 order M with:
 *       - `purchaseType: "Refund"`
 *       - `previousOrderId` (and `previousOrderNumber`) pointing at N
 *       - negative `total` / `subTotal` / `taxTotal`
 *       - its own `tenders[]`, carrying a settled tender with
 *         `chargeType: "Refund"`, `chargeStatus: "Success"`, and a negative
 *         `amountTendered`
 *       - one line item per refunded unit, with a negative `quantity`
 *   - Order N is subsequently updated to carry
 *     `linkedOrders: [{ orderId: M, orderNumber, purchaseType: "Refund" }]`
 *     — PERMANENTLY, not as a one-time notification. Order N's own
 *     `tenders[]` NEVER gains a Refund entry and its own reported `total`
 *     NEVER changes.
 *
 * This directly disproves the assumption `commerce7-order-normalizer.ts`
 * previously documented (every Commerce7 order id maps to one independent
 * canonical order, with no cross-order relationship worth reading). It also
 * means a refund order's own `tenders[]`-based normalization (see
 * `computeCommerce7RefundedMinor` in that file) is fundamentally the WRONG
 * object to persist as an independent `CommerceOrder`: its own `totalMinor`
 * is negative, and `totalRefundedMinor` computed from ITS OWN tenders would
 * exceed that negative total — which is exactly why the generic financial
 * invariant guard in `../order-ingestion.ts` correctly rejects it today. The
 * guard is not the bug; feeding it the refund order as if it were an
 * ordinary sale is.
 *
 * ===========================================================================
 * ARCHITECTURE
 * ===========================================================================
 *   RAW COMMERCE7 ORDER
 *           |
 *           v
 *   classifyCommerce7Order()
 *           |
 *           +--- REGULAR ---------------> normalizeCommerce7Order() as today
 *           |
 *           +--- REFUND_CHILD ----------> resolve previousOrderId, fetch the
 *           |    (this delivery IS a       ROOT order fresh, then reconcile
 *           |     refund order)            exactly like ROOT_WITH_LINKED_
 *           |                              REFUNDS below
 *           |
 *           +--- ROOT_WITH_LINKED_       > reconcileCommerce7OrderRefunds()
 *                REFUNDS                   against the root's OWN
 *                (this delivery IS the     linkedOrders, then overlay the
 *                 original order, already  cumulative refund onto the
 *                 carrying refund          root's normalized snapshot
 *                 evidence)
 *
 * A refund order (`REFUND_CHILD`) is NEVER normalized into its own
 * `CommerceOrder` row — `prepareCommerce7OrderForIngestion` below always
 * resolves identity to the ROOT order's `externalOrderId` before handing
 * anything to the generic, provider-neutral `ingestNormalizedOrder`. This
 * preserves `../order-ingestion.ts`'s existing invariant exactly as
 * documented there: "A refund is NEVER a new order row" and
 * `totalRefundedMinor` is CUMULATIVE, not incremental — reconciliation here
 * RECOMPUTES the cumulative total from scratch on every call (summing every
 * linked refund order's settled tenders), it never adds a delta to a stored
 * value, which is what makes it safe under duplicate delivery, out-of-order
 * delivery, and repeated backfill runs (see the per-function docs below).
 *
 * ===========================================================================
 * OUTCOME CONTRACT — DELIBERATELY PARALLEL TO SHOPIFY'S
 * ===========================================================================
 *   RECONCILED       — a trustworthy cumulative refund figure. Safe to
 *                       overlay onto the root order's normalized snapshot.
 *   NOT_ELIGIBLE      — a DETERMINISTIC reason reconciliation cannot happen
 *                       right now (root/linked order not found, no usable
 *                       credential, too many linked refund orders to prove
 *                       completeness, or a linked order's own shape is
 *                       unusable). Retrying the SAME delivery would not
 *                       change this. The caller must defer (null) rather
 *                       than fabricate a value.
 *   TRANSIENT_FAILURE — a network/HTTP condition that plausibly resolves on
 *                       retry. The caller must not persist anything for this
 *                       delivery at all.
 * Never throws.
 */

import type { CommerceOrderFinancialStatus } from "@prisma/client";
import { CommerceProviderApiError } from "../errors";
import {
  centsToBigIntMinorUnits,
  emptyOrder,
  normalizeCommerce7Order,
  refineFinancialStatusForRefunds,
  type Commerce7OrderNormalizationContext,
} from "./commerce7-order-normalizer";
import { fetchCommerce7Order } from "./commerce7-orders";
import type { NormalizedOrderInput } from "../order-ingestion";

function readTrimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Parses a PROVIDER-REPORTED timestamp string. Returns `null` for anything
 * unparseable — this module never substitutes `Date.now()`, a receipt time,
 * or any other fabricated value for a missing provider timestamp.
 */
function readProviderDate(value: unknown): Date | null {
  const raw = readTrimmed(value);
  if (!raw) {
    return null;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// ---------------------------------------------------------------------------
// Classification (pure)
// ---------------------------------------------------------------------------

export type Commerce7OrderClassification =
  | { kind: "REGULAR" }
  | {
      kind: "REFUND_CHILD";
      previousOrderId: string;
      /**
       * PHASE 26 — this refund order's OWN id, when it reports one. Carried
       * so reconciliation can UNION it into the root's `linkedOrders` set:
       * a refund child payload is itself direct provider evidence linking
       * this refund to the root (`purchaseType` + `previousOrderId`), so it
       * must still be counted when Commerce7 has not yet updated the root's
       * `linkedOrders` — see `prepareCommerce7OrderForIngestion`'s
       * child-before-parent race handling.
       */
      childOrderId: string | null;
    }
  /** `purchaseType === "Refund"` but `previousOrderId` is missing/blank — cannot resolve a root. */
  | { kind: "REFUND_CHILD_UNRESOLVABLE" }
  | { kind: "ROOT_WITH_LINKED_REFUNDS"; linkedRefundOrderIds: string[] };

/**
 * PURE. Extracts every distinct linked-order id whose OWN `purchaseType` is
 * `"Refund"` from a raw `linkedOrders` array. Non-"Refund" linked orders
 * (e.g. a hypothetical "Exchange") are deliberately NOT treated as refund
 * evidence — no observed or documented behavior justifies broadening this,
 * and guessing is exactly what this module refuses to do (unknown types
 * fail closed, i.e. are simply not counted, rather than being assumed to
 * behave like a refund).
 */
function readLinkedRefundOrderIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (readTrimmed(record.purchaseType) !== "Refund") {
      continue;
    }
    const orderId = readTrimmed(record.orderId);
    if (orderId) {
      ids.add(orderId);
    }
  }
  return [...ids];
}

/**
 * PURE. Classifies a raw Commerce7 order for refund-aware ingestion — see
 * the file header's architecture diagram. `purchaseType === "Refund"` is
 * checked FIRST and takes priority over any `linkedOrders` the same payload
 * might also carry (no observed case of a refund order itself carrying
 * further links, but ordering the checks this way is the safer default:
 * this delivery's own identity as a refund is authoritative over anything
 * else in its body).
 */
export function classifyCommerce7Order(raw: unknown): Commerce7OrderClassification {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { kind: "REGULAR" };
  }
  const record = raw as Record<string, unknown>;

  if (readTrimmed(record.purchaseType) === "Refund") {
    const previousOrderId = readTrimmed(record.previousOrderId);
    return previousOrderId
      ? { kind: "REFUND_CHILD", previousOrderId, childOrderId: readTrimmed(record.id) }
      : { kind: "REFUND_CHILD_UNRESOLVABLE" };
  }

  const linkedRefundOrderIds = readLinkedRefundOrderIds(record.linkedOrders);
  return linkedRefundOrderIds.length > 0
    ? { kind: "ROOT_WITH_LINKED_REFUNDS", linkedRefundOrderIds }
    : { kind: "REGULAR" };
}

// ---------------------------------------------------------------------------
// Reconciliation (I/O)
// ---------------------------------------------------------------------------

/**
 * Reasonable ceiling on how many linked refund orders one reconciliation
 * will fetch. Commerce7 documents no pagination or truncation behavior for
 * `linkedOrders` (a genuine, confirmed gap — same posture as
 * `fetchCommerce7OrdersByDateRange`'s documented absence of list-endpoint
 * pagination in `./commerce7-orders.ts`), so there is no signal this module
 * could detect a truncated response with. This ceiling exists purely as
 * defense-in-depth against a pathological order, bounding the N+1 fetch
 * fan-out rather than allowing it to grow unbounded.
 */
const MAX_LINKED_REFUND_ORDERS = 25;

export type Commerce7RefundReconciliationSnapshot = {
  /** Cumulative, non-negative sum of every settled linked refund tender's magnitude. */
  totalRefundedMinor: bigint;
  /**
   * PHASE 26 — the NEWEST provider-reported `updatedAt` among the refund
   * orders that ACTUALLY CONTRIBUTED to `totalRefundedMinor` (passed
   * validation and carried at least one settled Refund tender). `null` when
   * nothing contributed.
   *
   * Exists to fix a real staleness hole: the canonical order's
   * `providerUpdatedAt` is normalized from the ROOT order, but a refund
   * child can legitimately be NEWER than the root — Commerce7 may not have
   * bumped the root's own `updatedAt` yet when the refund webhook arrives.
   * Generic ingestion's out-of-order guard would then classify a genuinely
   * newer financial snapshot as STALE and drop the refund entirely. The
   * caller therefore advances the canonical `providerUpdatedAt` to
   * `max(root.updatedAt, latestEvidenceUpdatedAt)`.
   *
   * ONLY provider-reported timestamps ever reach this field — never
   * `Date.now()`, never webhook receipt time, never a fabricated value. If
   * a contributing refund order reports no parseable `updatedAt`, it simply
   * contributes nothing here (its money still counts).
   */
  latestEvidenceUpdatedAt: Date | null;
};

export type ReconcileCommerce7OrderRefundsResult =
  | { outcome: "RECONCILED"; snapshot: Commerce7RefundReconciliationSnapshot }
  | {
      outcome: "NOT_ELIGIBLE";
      reason:
        | "NO_CREDENTIAL"
        | "LINKED_ORDER_NOT_FOUND"
        | "LINKED_REFUND_ORDER_LIMIT_EXCEEDED";
    }
  | { outcome: "TRANSIENT_FAILURE" };

export type ReconcileCommerce7OrderRefundsDeps = {
  fetchOrder: typeof fetchCommerce7Order;
};

function classifyFetchFailure(error: unknown): "NOT_FOUND" | "NO_CREDENTIAL" | "TRANSIENT" {
  if (error instanceof CommerceProviderApiError) {
    if (error.httpStatus === 404) {
      return "NOT_FOUND";
    }
    if (error.httpStatus === 401 || error.httpStatus === 403) {
      return "NO_CREDENTIAL";
    }
  }
  // Any other shape (network failure, 5xx, malformed body) is treated as
  // plausibly transient — the same conservative default
  // `reconcileShopifyOrderFinancials` uses for an unclassified failure.
  return "TRANSIENT";
}

/**
 * Sums the settled refund tenders across every genuinely-linked refund
 * order. RECOMPUTES the cumulative total from scratch on every call (never
 * increments a stored value) — see the file header's REFUND SEMANTICS note
 * for why this is what makes the result safe under duplicate/out-of-order
 * delivery and repeated backfill runs: replaying the exact same linked-order
 * set always yields the exact same sum.
 *
 * Per-linked-order validation (PART 7.5 of the originating round): a linked
 * order is only counted when its OWN `purchaseType === "Refund"` AND its OWN
 * `previousOrderId` matches `params.rootExternalOrderId`. A linked order
 * that fails this check is IGNORED (not counted, and does not abort the
 * whole reconciliation) — the documented, safer of the two policy options
 * named in the originating brief, since one inconsistent linked entry should
 * not block reconciling the others that are genuinely consistent.
 *
 * Deduplication is by STABLE ids only: linked order ids (a `Set`, so a
 * repeated id in `linkedRefundOrderIds` is only ever fetched/counted once)
 * and, within one linked order, `tender.id` (mirrors
 * `computeCommerce7RefundedMinor`'s own tender-id dedup in the normalizer,
 * scoped per-order since two different orders could theoretically reuse a
 * tender id). Never deduplicated by amount or any other mutable property.
 */
export async function reconcileCommerce7OrderRefunds(
  params: {
    tenant: string;
    rootExternalOrderId: string;
    linkedRefundOrderIds: readonly string[];
    /**
     * PHASE 26 — raw refund-order payloads ALREADY IN HAND (the webhook
     * delivery that triggered this reconciliation), keyed into by their own
     * `id`. Used instead of re-fetching an order Commerce7 just delivered
     * to us. NOT a trust shortcut: a preloaded payload goes through the
     * byte-for-byte SAME validation as a fetched one (`purchaseType`,
     * `previousOrderId` match, settled-tender gate) — it only skips the
     * redundant network round-trip.
     */
    preloadedRefundOrders?: readonly Record<string, unknown>[];
  },
  deps: Partial<ReconcileCommerce7OrderRefundsDeps> = {},
): Promise<ReconcileCommerce7OrderRefundsResult> {
  const fetchOrder = deps.fetchOrder ?? fetchCommerce7Order;
  const distinctLinkedIds = [...new Set(params.linkedRefundOrderIds)];

  if (distinctLinkedIds.length > MAX_LINKED_REFUND_ORDERS) {
    return { outcome: "NOT_ELIGIBLE", reason: "LINKED_REFUND_ORDER_LIMIT_EXCEEDED" };
  }

  const preloadedById = new Map<string, Record<string, unknown>>();
  for (const entry of params.preloadedRefundOrders ?? []) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const id = readTrimmed((entry as Record<string, unknown>).id);
    if (id) {
      preloadedById.set(id, entry as Record<string, unknown>);
    }
  }

  let totalRefundedMinor = BigInt(0);
  let latestEvidenceUpdatedAt: Date | null = null;

  for (const linkedOrderId of distinctLinkedIds) {
    let linkedRaw: Record<string, unknown>;
    const preloaded = preloadedById.get(linkedOrderId);
    if (preloaded) {
      linkedRaw = preloaded;
    } else {
      try {
        linkedRaw = await fetchOrder({ tenant: params.tenant, externalOrderId: linkedOrderId });
      } catch (error) {
        const classification = classifyFetchFailure(error);
        if (classification === "TRANSIENT") {
          return { outcome: "TRANSIENT_FAILURE" };
        }
        // NOT_FOUND or NO_CREDENTIAL for one linked order means completeness
        // of the sum cannot be proven — fail the WHOLE reconciliation closed
        // rather than silently under-count by skipping just this one.
        return {
          outcome: "NOT_ELIGIBLE",
          reason: classification === "NOT_FOUND" ? "LINKED_ORDER_NOT_FOUND" : "NO_CREDENTIAL",
        };
      }
    }

    // Per-linked-order validation — see this function's own doc comment.
    // Applied IDENTICALLY to preloaded and freshly-fetched payloads.
    if (
      readTrimmed(linkedRaw.purchaseType) !== "Refund" ||
      readTrimmed(linkedRaw.previousOrderId) !== params.rootExternalOrderId
    ) {
      continue;
    }

    const tenders = linkedRaw.tenders;
    if (!Array.isArray(tenders)) {
      continue;
    }

    const seenTenderIds = new Set<string>();
    let contributedFromThisOrder = false;
    for (const entry of tenders) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const tender = entry as Record<string, unknown>;
      if (readTrimmed(tender.chargeType) !== "Refund") {
        continue;
      }
      if (readTrimmed(tender.chargeStatus) !== "Success") {
        continue;
      }
      const tenderId = readTrimmed(tender.id);
      if (tenderId !== null) {
        if (seenTenderIds.has(tenderId)) {
          continue;
        }
        seenTenderIds.add(tenderId);
      }
      const amount = centsToBigIntMinorUnits(tender.amountTendered);
      if (amount === null) {
        continue;
      }
      totalRefundedMinor += amount < BigInt(0) ? -amount : amount;
      contributedFromThisOrder = true;
    }

    // Freshness is only ever taken from an order that ACTUALLY contributed
    // money — a validated-but-zero-tender linked order must not advance the
    // canonical staleness key on its own.
    if (contributedFromThisOrder) {
      const updatedAt = readProviderDate(linkedRaw.updatedAt);
      if (updatedAt && (!latestEvidenceUpdatedAt || updatedAt > latestEvidenceUpdatedAt)) {
        latestEvidenceUpdatedAt = updatedAt;
      }
    }
  }

  return { outcome: "RECONCILED", snapshot: { totalRefundedMinor, latestEvidenceUpdatedAt } };
}

// ---------------------------------------------------------------------------
// Preparation — the single entry point both the webhook and backfill use
// ---------------------------------------------------------------------------

export type PrepareCommerce7OrderForIngestionResult =
  | {
      outcome: "READY";
      order: NormalizedOrderInput;
      warnings: string[];
      /** Classified diagnostic ONLY — never a payload excerpt, id, or monetary value beyond what the caller already logs for a normal order. */
      refundReconciliationOutcome:
        | "NOT_APPLICABLE"
        | "RECONCILED"
        | "DEFERRED"
        | "UNRESOLVABLE_REFUND_CHILD"
        /** PHASE 26 — the P1 durability guard fired: a refund-blind payload was prevented from un-learning established refund state. */
        | "REFUND_STATE_PRESERVED";
      refundReconciliationReason: string | null;
    }
  | { outcome: "TRANSIENT_FAILURE" };

/**
 * PHASE 26 — the canonical financial state ALREADY STORED for this exact
 * `(connectionId, externalOrderId)`, read before a refund-blind snapshot is
 * allowed to overwrite it. See `applyRefundDurabilityGuard`.
 */
export type Commerce7StoredOrderFinancialState = {
  totalRefundedMinor: bigint;
  financialStatus: CommerceOrderFinancialStatus | null;
};

export type PrepareCommerce7OrderForIngestionDeps = {
  fetchOrder: typeof fetchCommerce7Order;
  reconcileRefunds: typeof reconcileCommerce7OrderRefunds;
  /**
   * Reads the stored canonical financial state for one order, or `null` when
   * the order has never been seen. Injected (rather than importing Prisma
   * here) so this whole module stays unit-testable with no database, matching
   * the DI discipline every other module in this directory already uses.
   */
  loadStoredFinancialState(input: {
    connectionId: string;
    externalOrderId: string;
  }): Promise<Commerce7StoredOrderFinancialState | null>;
};

async function defaultLoadStoredFinancialState(input: {
  connectionId: string;
  externalOrderId: string;
}): Promise<Commerce7StoredOrderFinancialState | null> {
  const { default: prisma } = await import("@/lib/prisma");
  const row = await prisma.commerceOrder.findUnique({
    where: {
      connectionId_externalOrderId: {
        connectionId: input.connectionId,
        externalOrderId: input.externalOrderId,
      },
    },
    // Financial state ONLY — no customer field exists on this model at all
    // (see order-ingestion.ts's NO PII header), and nothing else is read.
    select: { totalRefundedMinor: true, financialStatus: true },
  });
  return row
    ? { totalRefundedMinor: row.totalRefundedMinor, financialStatus: row.financialStatus }
    : null;
}

const DEFAULT_PREPARE_DEPS: PrepareCommerce7OrderForIngestionDeps = {
  fetchOrder: fetchCommerce7Order,
  reconcileRefunds: reconcileCommerce7OrderRefunds,
  loadStoredFinancialState: defaultLoadStoredFinancialState,
};

/**
 * PURE. Whether `applyRefundDurabilityGuard` could possibly fire for this
 * order — i.e. whether reading stored state is worth a database round-trip
 * at all.
 *
 * Only a payload that asserts a REFUND-BLIND ZERO can un-learn refund state.
 * A `null` `totalRefundedMinor` (Commerce7 sent no `tenders` array) already
 * preserves stored state through generic ingestion's own null-preservation,
 * and a positive figure is affirmative evidence. Both skip the read
 * entirely, so the overwhelmingly common case costs nothing extra.
 */
export function refundDurabilityGuardNeedsStoredState(order: NormalizedOrderInput): boolean {
  return Boolean(order.externalOrderId) && order.totalRefundedMinor === BigInt(0);
}

/**
 * PURE. Whether stored canonical state already establishes that money was
 * refunded against this order.
 *
 * Both signals are checked, not just the amount: a stored
 * `PARTIALLY_REFUNDED`/`REFUNDED` status is itself an assertion that a refund
 * exists, and an implementation that only compared amounts would let a
 * status-only row be silently downgraded to `PAID`.
 */
export function storedStateEstablishesRefund(
  stored: Commerce7StoredOrderFinancialState | null,
): boolean {
  if (!stored) {
    return false;
  }
  return (
    stored.totalRefundedMinor > BigInt(0) ||
    stored.financialStatus === "PARTIALLY_REFUNDED" ||
    stored.financialStatus === "REFUNDED"
  );
}

/**
 * PHASE 26 — THE P1 DURABILITY GUARD. Commerce7 refund state must never be
 * UN-LEARNED by a payload that simply does not mention the refund.
 *
 * WHY THIS IS NEEDED. A Commerce7 refund lives on a SEPARATE order document
 * (see this file's header). The original order's own `tenders[]` therefore
 * never gains a Refund tender and its own `total` never changes — so a later
 * root payload that omits `linkedOrders` normalizes to a perfectly ordinary
 * "PAID, nothing refunded" snapshot. `computeCommerce7RefundedMinor` returns
 * a REAL `0n` (not `null`) for it, because a present-but-refund-free tender
 * array genuinely is complete evidence of no refund *on that document* —
 * and generic ingestion's null-preservation contract, correctly, does not
 * treat `0n` as "no information". The established refund would be silently
 * reverted (3277 -> 0, PARTIALLY_REFUNDED -> PAID) with no later signal to
 * repair it.
 *
 * WHY THE FIX LIVES HERE AND NOT IN GENERIC INGESTION. "A zero refund figure
 * may be untrustworthy" is a COMMERCE7-SPECIFIC fact about how that provider
 * represents refunds. Shopify's `0` is genuinely authoritative (its refunds
 * live on the order itself), so teaching the provider-neutral layer to
 * distrust zero would be wrong for Shopify and would leak provider semantics
 * across the boundary. The guard is therefore applied at the Commerce7
 * adapter boundary, and hands generic ingestion the value its EXISTING
 * contract already understands: `null` = "this event says nothing about
 * refunds, preserve what is stored."
 *
 * FAIL-CLOSED, AND WHY THAT IS THE RIGHT DIRECTION. Commerce7 documents no
 * "undo refund" semantic, so the absence of refund metadata in one payload is
 * NOT affirmative evidence that a settled refund ceased to exist. Preserving
 * a stale-but-real refund is recoverable (the next payload carrying real
 * evidence corrects it); silently zeroing a real refund overstates revenue
 * and self-heals never.
 *
 * NOTE THE ASYMMETRY THIS DELIBERATELY PRESERVES: a genuinely NEW,
 * never-refunded Commerce7 order still establishes `PAID` / refunded `0`
 * normally, because nothing is stored for it yet. Only an order whose stored
 * state ALREADY establishes a refund is protected.
 */
export function applyRefundDurabilityGuard(
  order: NormalizedOrderInput,
  stored: Commerce7StoredOrderFinancialState | null,
): { order: NormalizedOrderInput; preserved: boolean } {
  // This payload asserts nothing about refunds already — nothing to guard.
  if (order.totalRefundedMinor === null) {
    return { order, preserved: false };
  }
  // This payload asserts a REAL refund amount. That is affirmative evidence,
  // not a refund-blind zero, so it is allowed through (the monotonicity
  // check in the reconciled path handles a decrease separately).
  if (order.totalRefundedMinor > BigInt(0)) {
    return { order, preserved: false };
  }
  if (!storedStateEstablishesRefund(stored)) {
    return { order, preserved: false };
  }
  // Refund-blind zero vs. established refund state -> defer BOTH settlement
  // fields together, exactly as the NOT_ELIGIBLE path does. They must travel
  // as a pair: a snapshot that knows one but not the other is precisely the
  // contradictory state the generic invariant guard rejects.
  return {
    order: { ...order, totalRefundedMinor: null, financialStatus: null },
    preserved: true,
  };
}

/**
 * Turns one raw Commerce7 order into a `NormalizedOrderInput` that is always
 * safe to hand to the generic, provider-neutral `ingestNormalizedOrder` —
 * the single shared preparation step both `./commerce7-order-webhook.ts` and
 * `./commerce7-order-backfill.ts` call, so live-webhook and manual
 * Catch-Up/Custom-Range repair can never drift onto different refund
 * semantics (a missed refund webhook must be repairable through backfill —
 * see this round's brief, Part 11).
 *
 * `TRANSIENT_FAILURE` is the ONLY outcome that does not carry an order: the
 * caller must not persist anything for this delivery (see
 * `handleCommerce7OrderWebhook`, which — mirroring
 * `handleShopifyOrderWebhook` exactly — never calls `ingest` in this case,
 * so no `CommerceOrderEvent` claim is taken and a webhook redelivery starts
 * completely fresh; `backfillCommerce7Orders` simply skips this one order
 * for this pass, leaving it for a later Catch-Up/Custom-Range run).
 */
export async function prepareCommerce7OrderForIngestion(
  raw: unknown,
  context: Commerce7OrderNormalizationContext,
  tenant: string,
  deps: Partial<PrepareCommerce7OrderForIngestionDeps> = {},
): Promise<PrepareCommerce7OrderForIngestionResult> {
  const resolved: PrepareCommerce7OrderForIngestionDeps = { ...DEFAULT_PREPARE_DEPS, ...deps };
  const classification = classifyCommerce7Order(raw);

  if (classification.kind === "REGULAR") {
    const { order, warnings } = normalizeCommerce7Order(raw, context);
    // PHASE 26 (P1). A "regular" Commerce7 order is exactly the shape a
    // refund-blind later payload takes — see `applyRefundDurabilityGuard`.
    // The stored-state read happens ONLY when that guard could actually
    // fire, so an ordinary order costs no extra query.
    const stored =
      refundDurabilityGuardNeedsStoredState(order) && order.externalOrderId
        ? await resolved.loadStoredFinancialState({
            connectionId: context.connectionId,
            externalOrderId: order.externalOrderId,
          })
        : null;
    const guarded = applyRefundDurabilityGuard(order, stored);
    return {
      outcome: "READY",
      order: guarded.order,
      warnings,
      refundReconciliationOutcome: guarded.preserved
        ? "REFUND_STATE_PRESERVED"
        : "NOT_APPLICABLE",
      refundReconciliationReason: guarded.preserved ? "REFUND_BLIND_PAYLOAD" : null,
    };
  }

  if (classification.kind === "REFUND_CHILD_UNRESOLVABLE") {
    // No previousOrderId to resolve a root from, and this order's own id
    // must NEVER become an independent CommerceOrder (see file header) —
    // route through the EXISTING MISSING_EXTERNAL_ORDER_ID rejection path
    // by handing ingestion an order with no external id at all. FAIL
    // CLOSED, no bogus negative CommerceOrder, and the delivery is still
    // durably recorded (a real CommerceOrderEvent row, FAILED/
    // non-retryable, since retrying the identical malformed body would
    // reach the identical conclusion).
    return {
      outcome: "READY",
      order: emptyOrder(context),
      warnings: ["MISSING_PREVIOUS_ORDER_ID"],
      refundReconciliationOutcome: "UNRESOLVABLE_REFUND_CHILD",
      refundReconciliationReason: null,
    };
  }

  let rootRaw: Record<string, unknown>;
  let rootExternalOrderId: string;
  let linkedRefundOrderIds: string[];
  let preloadedRefundOrders: Record<string, unknown>[] = [];

  if (classification.kind === "REFUND_CHILD") {
    // This delivery IS a refund order. Its own fields must never be
    // normalized into the canonical order — fetch the AUTHORITATIVE root
    // fresh, since this delivery carries only the refund order's own
    // (irrelevant, negative-total) snapshot.
    rootExternalOrderId = classification.previousOrderId;
    try {
      rootRaw = await resolved.fetchOrder({
        tenant,
        externalOrderId: rootExternalOrderId,
      });
    } catch (error) {
      if (classifyFetchFailure(error) === "TRANSIENT") {
        return { outcome: "TRANSIENT_FAILURE" };
      }
      // The claimed root does not exist / credentials rejected — cannot
      // form ANY canonical order identity for this delivery. Same fail-
      // closed path as REFUND_CHILD_UNRESOLVABLE.
      return {
        outcome: "READY",
        order: emptyOrder(context),
        warnings: ["ROOT_ORDER_UNRESOLVABLE"],
        refundReconciliationOutcome: "UNRESOLVABLE_REFUND_CHILD",
        refundReconciliationReason: null,
      };
    }
    // Recomputed from the FRESHLY FETCHED root's own linkedOrders — not
    // just this one child — so a root with MULTIPLE independent partial
    // refunds is fully reconciled regardless of which single refund
    // delivery triggered this call (Case C: out-of-order/concurrent
    // delivery of several refunds converges on the same total either way).
    //
    // PHASE 26 (P2, child-before-parent race): UNIONED with THIS child's own
    // id. The child payload in hand already carries direct provider evidence
    // linking itself to the root (`purchaseType: "Refund"` +
    // `previousOrderId`), so when Commerce7 has not yet updated the root's
    // `linkedOrders`, the child must still be counted — otherwise this
    // delivery would reconcile to 0 and (before the P1 guard) actively
    // overwrite good state with it. The union is over STABLE provider ids,
    // so a child already listed by the root is not double-counted.
    linkedRefundOrderIds = [
      ...new Set([
        ...readLinkedRefundOrderIds(rootRaw.linkedOrders),
        ...(classification.childOrderId ? [classification.childOrderId] : []),
      ]),
    ];
    // The child was just delivered to us in full — reconciliation validates
    // it identically to a fetched order but skips the redundant GET.
    preloadedRefundOrders = [raw as Record<string, unknown>];
  } else {
    // ROOT_WITH_LINKED_REFUNDS: `raw` IS the authoritative root snapshot
    // already — a Commerce7 order webhook/backfill payload is always a
    // COMPLETE order snapshot (see commerce7-order-normalizer.ts's own
    // docstring), so no extra fetch is needed for the root itself, only for
    // its linked refund orders.
    rootRaw = raw as Record<string, unknown>;
    rootExternalOrderId = readTrimmed(rootRaw.id) ?? "";
    linkedRefundOrderIds = classification.linkedRefundOrderIds;
  }

  const { order: baseOrder, warnings } = normalizeCommerce7Order(rootRaw, context);

  if (!rootExternalOrderId || !baseOrder.externalOrderId) {
    return {
      outcome: "READY",
      order: emptyOrder(context),
      warnings: [...warnings, "ROOT_ORDER_UNRESOLVABLE"],
      refundReconciliationOutcome: "UNRESOLVABLE_REFUND_CHILD",
      refundReconciliationReason: null,
    };
  }

  // Stored canonical state, read once and used for BOTH refund-durability
  // decisions below (the NOT_ELIGIBLE defer already preserves by nulling;
  // this additionally powers the monotonicity check on a RECONCILED result).
  const stored = await resolved.loadStoredFinancialState({
    connectionId: context.connectionId,
    externalOrderId: baseOrder.externalOrderId,
  });

  const reconciled = await resolved.reconcileRefunds(
    { tenant, rootExternalOrderId, linkedRefundOrderIds, preloadedRefundOrders },
    // Thread the SAME injected `fetchOrder` through, so a test/caller that
    // overrides only `fetchOrder` (not `reconcileRefunds` itself) still
    // reaches the real `reconcileCommerce7OrderRefunds`'s OWN `fetchOrder`
    // seam — otherwise that default would silently fall back to the real,
    // network-calling `fetchCommerce7Order` regardless of this override.
    { fetchOrder: resolved.fetchOrder },
  );

  if (reconciled.outcome === "TRANSIENT_FAILURE") {
    return { outcome: "TRANSIENT_FAILURE" };
  }

  if (reconciled.outcome === "NOT_ELIGIBLE") {
    // DEFERRED: totalRefundedMinor/financialStatus travel together and are
    // both nulled — the generic ingestion merge (../order-ingestion.ts)
    // then PRESERVES whatever was already stored rather than persisting a
    // guess, and — critically — never resets an already-reconciled
    // PARTIALLY_REFUNDED/REFUNDED order back to its refund-blind base
    // status. Every other field (line items, fulfillment, the immutable
    // pre-refund totals) still lands normally from the authoritative root
    // snapshot.
    return {
      outcome: "READY",
      order: { ...baseOrder, totalRefundedMinor: null, financialStatus: null },
      warnings,
      refundReconciliationOutcome: "DEFERRED",
      refundReconciliationReason: reconciled.reason,
    };
  }

  // RECONCILED. Overlay the authoritative cumulative refund onto the root's
  // own normalized snapshot. `totalMinor` is the root's OWN reported total
  // (from normalizeCommerce7Order, untouched) — reconciliation never
  // rewrites it, only `totalRefundedMinor`/`financialStatus`. An over-refund
  // (reconciled total exceeding the root's own total) is NOT clamped or
  // corrected here — it is passed straight through, and
  // `../order-ingestion.ts`'s existing financial invariant guard is what
  // rejects that contradictory combination, exactly as it does today for
  // any other internally-inconsistent snapshot. This module fabricates
  // nothing and clamps nothing.
  //
  // PHASE 26 (P1, monotonicity). Commerce7 documents no "undo refund"
  // semantic, so a reconciled total that is LOWER than what is already
  // stored is evidence of INCOMPLETE input (e.g. the root's `linkedOrders`
  // momentarily missing a sibling refund), never of money being un-refunded.
  // Refuse to write it and defer instead — preserving stored state rather
  // than fabricating a corrected number. This closes the last path by which
  // an established cumulative refund could move backwards.
  if (stored && reconciled.snapshot.totalRefundedMinor < stored.totalRefundedMinor) {
    return {
      outcome: "READY",
      order: { ...baseOrder, totalRefundedMinor: null, financialStatus: null },
      warnings,
      refundReconciliationOutcome: "REFUND_STATE_PRESERVED",
      refundReconciliationReason: "REFUND_DECREASE_REFUSED",
    };
  }

  const financialStatus = refineFinancialStatusForRefunds(
    baseOrder.financialStatus,
    baseOrder.totalMinor,
    reconciled.snapshot.totalRefundedMinor,
  );

  // PHASE 26 (P2, evidence freshness). The canonical staleness key must
  // reflect the freshest PROVIDER evidence behind this financial snapshot,
  // not just the root document's own `updatedAt` — otherwise a refund child
  // that is genuinely newer than its (not-yet-rebumped) root is rejected as
  // STALE and the refund is silently dropped. Only provider-reported
  // timestamps participate; `null` on either side simply defers to the
  // other.
  const providerUpdatedAt = maxDate(
    baseOrder.providerUpdatedAt,
    reconciled.snapshot.latestEvidenceUpdatedAt,
  );

  return {
    outcome: "READY",
    order: {
      ...baseOrder,
      totalRefundedMinor: reconciled.snapshot.totalRefundedMinor,
      financialStatus,
      providerUpdatedAt,
      // PHASE 27 — authorize the generic layer's narrow EQUAL-version
      // settlement-repair exception for this delivery only.
      //
      // The real production case: Commerce7 root #1002 was stored at provider
      // version T back when SQRATCH did not understand that a Commerce7
      // refund is a SEPARATE linked order document. Re-reading that SAME
      // unchanged version now reconciles to a real cumulative refund — the
      // provider data did not change, SQRATCH's interpretation did — but it
      // still carries T, so the ordinary strictly-newer rule would reject the
      // repair permanently. Fabricating a newer timestamp is not an option
      // (`providerUpdatedAt` must remain the provider's own truth), so the
      // repair is authorized explicitly instead.
      //
      // This is set ONLY on the RECONCILED path — i.e. only when
      // reconciliation positively completed against real, validated linked
      // refund evidence. It is NEVER set for an ordinary Commerce7 order, a
      // DEFERRED/NOT_ELIGIBLE reconciliation, or a preserved refund-blind
      // payload. `decideOrderStaleness` additionally refuses to act on it
      // unless the incoming cumulative refund is strictly greater than the
      // stored one, so an idempotent replay and any attempted decrease both
      // remain STALE.
      sameVersionSettlementRepair: true,
    },
    warnings,
    refundReconciliationOutcome: "RECONCILED",
    refundReconciliationReason: null,
  };
}

/** PURE. The later of two possibly-null provider timestamps. */
export function maxDate(a: Date | null, b: Date | null): Date | null {
  if (!a) return b;
  if (!b) return a;
  return a.getTime() >= b.getTime() ? a : b;
}
