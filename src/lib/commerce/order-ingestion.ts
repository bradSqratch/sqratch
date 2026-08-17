/**
 * src/lib/commerce/order-ingestion.ts
 *
 * Provider-neutral ORDER PERSISTENCE service. Takes an already-normalized,
 * provider-shaped-payload-free `NormalizedOrderInput` (produced by a pure
 * per-provider normalizer such as
 * `./providers/shopify-order-normalizer.ts`) plus the identity of the
 * delivery that carried it, and idempotently lands it in `CommerceOrder` /
 * `CommerceOrderLineItem`, recording exactly one `CommerceOrderEvent` row per
 * delivery.
 *
 * Same dependency-injection idiom as `./product-sync.ts` /
 * `./connection-sync.ts`: every exported entry point takes a
 * `Partial<OrderIngestionDeps>`, and the default DB-backed implementations
 * lazily `import("@/lib/prisma")` inside the function body, so importing this
 * module never requires `DATABASE_URL`.
 *
 * ===========================================================================
 * LIVE ROLLOUT BOUNDARY
 * ===========================================================================
 * Phase 12 declares Shopify order/refund topics and `read_orders`. Delivery
 * begins only after deploying the config and merchant reauthorization; the
 * Theme App Extension must also be enabled for click-token transport. The
 * service itself remains provider-neutral and can only persist a normalized,
 * HMAC-verified provider delivery.
 *
 * ===========================================================================
 * NO PII, NO POINTS, NO COMMISSION
 * ===========================================================================
 * Nothing here reads, writes, logs, or returns a customer email, name, phone,
 * or address — those fields do not exist on the input type, on the models, or
 * on the returned outcome. Nothing here touches `PointTransaction`,
 * `UserPointAccount`, `BrandRewardOffer`, or `ShopifyRewardRedemption`: this
 * phase normalizes orders, it does not award points and does not compute
 * commissions. The returned `OrderIngestionOutcome` deliberately carries only
 * ids, counts, and short classified tags — never a payload excerpt, an error
 * object, or a provider response body.
 *
 * ===========================================================================
 * IDEMPOTENCY: THE EVENT CLAIM IS ITS OWN STATEMENT, AND WHY
 * ===========================================================================
 * The deduplication gate is an INSERT into `CommerceOrderEvent` keyed on the
 * unique `(provider, providerEventId)`. Winning that INSERT is the claim on the
 * delivery. Losing it (Prisma P2002) is NOT automatically a successful no-op:
 * what the loser may conclude depends entirely on what the winning row's state
 * PROVES, so the claim resolves to exactly one of four outcomes (see
 * `OrderEventClaim`):
 *
 *   CLAIMED             — the INSERT won. Nothing has processed this delivery.
 *   RECLAIMED           — a prior row exists but is provably not being worked
 *                         on: either `FAILED` (a previous attempt recorded its
 *                         own failure) or `RECEIVED` with an EXPIRED lease
 *                         (`EVENT_CLAIM_LEASE_MS`). Reclaimed through a
 *                         compare-and-set, so exactly one retry can win it.
 *   COMPLETED_DUPLICATE — a prior row is in a TERMINAL state (`PROCESSED`,
 *                         `SKIPPED_STALE`, `SKIPPED_DISCONNECTED`). This
 *                         delivery was already fully handled — acknowledging it
 *                         without reprocessing is correct (`ALREADY_PROCESSED`).
 *   IN_FLIGHT           — a prior row is `RECEIVED` with a LIVE lease. Another
 *                         request holds this delivery and we can prove NEITHER
 *                         success NOR failure yet.
 *
 * IN_FLIGHT is the outcome that must never be acknowledged as success, and the
 * reason this four-state model exists at all. When every lost INSERT was
 * reported `ALREADY_PROCESSED`, a process that died between winning the claim
 * and committing the order transaction turned the provider's own retry into
 * PERMANENT DATA LOSS: the retry was answered 200, the provider stopped
 * retrying, and that order was never written by anyone. A caller must therefore
 * translate IN_FLIGHT into a RETRYABLE failure (HTTP 500 for a webhook) — by
 * the time the provider retries, the lease has either been finalized
 * (-> COMPLETED_DUPLICATE -> 200) or expired (-> RECLAIMED -> reprocessed for
 * real). `isRetryableOrderIngestionOutcome` is that translation, and it is the
 * single source of truth for it.
 *
 * That claim is executed as its OWN statement/transaction, before the
 * order-writing transaction — deliberately NOT inside it. In PostgreSQL a
 * failed statement aborts the entire enclosing transaction: if the claim
 * INSERT raised a unique violation inside the order transaction, every
 * subsequent statement in that transaction would fail with
 * `25P02 current transaction is aborted`, so "catch P2002 and carry on" is not
 * expressible there. A single INSERT is already atomic and is itself the lock,
 * so nothing is lost by hoisting it: exactly one caller can ever win it.
 *
 * A process that dies between winning the claim and committing the order
 * transaction leaves a `RECEIVED` event row with no order.
 * `CommerceOrderEvent.status = RECEIVED` with a null `processedAt` and a null
 * `orderId` is still precisely the query that finds these, but they are no
 * longer an operator's re-drive task: while the lease is live the delivery is
 * reported IN_FLIGHT (retryable, never acknowledged), and once the lease expires
 * the next provider retry RECLAIMS and reprocesses it. Reprocessing is safe
 * because it lands through the same idempotent upsert — a redelivery carrying
 * the same `providerUpdatedAt` as the stored row is `SKIPPED_STALE`, never a
 * second order row.
 *
 * ===========================================================================
 * REFUND SEMANTICS: CUMULATIVE, NOT INCREMENTAL
 * ===========================================================================
 * A refund is NEVER a new order row. It is an UPDATE to the existing order's
 * `totalRefundedMinor` / `financialStatus` / `netRevenueMinor`.
 *
 * `NormalizedOrderInput.totalRefundedMinor` is interpreted as the CUMULATIVE
 * amount refunded against the order as of this event — the running total, not
 * the delta for this one refund. This is a deliberate design choice, and it is
 * the safer of the two:
 *
 *   - Cumulative is idempotent BY CONSTRUCTION. Replaying the same refund
 *     event (or applying a later refund event twice) writes the same value,
 *     because assignment is idempotent where addition is not. Given that
 *     webhook transports guarantee at-least-once and never exactly-once
 *     delivery, an incremental design would double-count a refund on any
 *     redelivery that slipped past the dedup gate (for instance a provider
 *     that re-sent the same logical refund under a NEW delivery id).
 *   - Cumulative is also self-healing under a missed event: if refund #2's
 *     delivery is lost and refund #3's arrives, the cumulative total in #3 is
 *     still correct, whereas an incremental design would silently understate
 *     the refunded amount forever.
 *
 * Shopify's own refund payloads are the reason this is stated explicitly
 * rather than assumed: a `refunds/create` body describes ONE refund (its own
 * `transactions[]` and `refund_line_items[]`), so a normalizer that naively
 * read that single refund's amount would be producing an INCREMENT, not a
 * cumulative total. The Shopify normalizer in this repo therefore derives the
 * cumulative figure ONLY from a full ORDER payload — either the order's own
 * `total_refunded`/`total_refunded_set` field, or the sum over the order's
 * complete `refunds[]` array (an order carries ALL of its refunds, so that sum
 * is cumulative by construction) — and yields `null` from a bare
 * `refunds/create` fragment, which can only ever describe an increment. See
 * `./providers/shopify-order-normalizer.ts`. `null` means "this event says
 * nothing about refunds", and this module then PRESERVES the stored value
 * rather than zeroing it.
 *
 * Anything that later wants incremental semantics must convert to cumulative
 * in the normalizer, not here.
 *
 * ===========================================================================
 * CONCURRENT DELIVERIES FOR THE SAME ORDER
 * ===========================================================================
 * The event claim above deduplicates ONE delivery. It says nothing about two
 * DIFFERENT deliveries that describe the same order and arrive together —
 * which providers routinely do (Shopify emits `refunds/create` and
 * `orders/updated` for one refund back to back). Those run as two independent
 * transactions, and under READ COMMITTED each one's staleness decision is made
 * against a snapshot that the other can invalidate before either writes.
 *
 * The order UPDATE is therefore a COMPARE-AND-SET that restates the stored
 * `providerUpdatedAt` the decision was made against. The loser raises, rolls
 * back, and is reported as the retryable `WRITE_FAILED`; the provider's
 * redelivery re-reads committed state and decides again. Without that
 * predicate the losing transaction would write its full field set — including
 * the values it coalesced from its own stale read — over the newer committed
 * state, reverting a financial status or zeroing a cumulative refund total
 * with no later delivery to repair it. The `create` branch needs no equivalent
 * because `@@unique([connectionId, externalOrderId])` already elects one
 * winner and turns the loser into the same retryable failure.
 *
 * ===========================================================================
 * MONEY
 * ===========================================================================
 * All amounts arrive already converted to minor units as `bigint`. Conversion
 * itself is the normalizer's job and uses `getCurrencyExponent` /
 * `decimalStringToBigIntMinorUnits` from `./money.ts` — the SIGN-AWARE converter,
 * never `providerPriceStringToMinorUnits`, which rejects negatives by design
 * and would wrongly reject a refund, discount, or adjustment amount.
 *
 * `totalMinor` is the provider's own reported total, persisted verbatim. It is
 * never derived by summing converted line items: the decimal converter
 * truncates rather than rounds, so a sum of per-line conversions can
 * legitimately disagree with the provider's total by a few minor units, and
 * asserting equality would reject perfectly valid orders.
 *
 * `netRevenueMinor` is the one derived column: `totalMinor -
 * totalRefundedMinor`, computed at write time, and null whenever `totalMinor`
 * is null (an unknown total cannot produce a known net).
 *
 * Order normalization uses the BigInt-bounded converter. Catalog prices still
 * use the deliberately narrower int4 converter because their columns are Int.
 *
 * ===========================================================================
 * CROSS-BRAND INTEGRITY
 * ===========================================================================
 * There is no composite `(connectionId, brandId) -> CommerceConnection(id,
 * brandId)` foreign key, because no `CommerceConnection_id_brandId_key` unique
 * exists and Phase 7's migration refuses to add a unique index to a
 * pre-existing table. Integrity is enforced here instead: the `brandId`
 * actually written is ALWAYS the one read from the resolved
 * `CommerceConnection` row, never the one supplied by the caller or implied by
 * a webhook payload. A caller-supplied mismatch is reported as
 * `brandIdOverriddenFromConnection` on the outcome and is never persisted.
 */

import { Prisma, type CommerceProvider } from "@prisma/client";
import type {
  CommerceConnectionStatus,
  CommerceOrderEventStatus,
  CommerceOrderFinancialStatus,
  CommerceOrderFulfillmentStatus,
} from "@prisma/client";
import { hashClickToken } from "./click-token";

type TxClient = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Public input types
// ---------------------------------------------------------------------------

/**
 * One normalized order line. Every money field is already in minor units at
 * the parent order's `minorUnitExponent`, and every one of them may be
 * negative: a discount, credit, or adjustment line legitimately is.
 */
export type NormalizedOrderLineItemInput = {
  externalLineItemId: string | null;
  externalProductId: string | null;
  externalVariantId: string | null;
  title: string | null;
  sku: string | null;
  /** Provider-reported quantity. Normalizers clamp to a finite integer. */
  quantity: number;
  unitPriceMinor: bigint | null;
  discountMinor: bigint | null;
  taxMinor: bigint | null;
  totalMinor: bigint | null;
};

/**
 * The provider-neutral shape every order normalizer must produce. It contains
 * NO customer fields by construction — there is nowhere to put an email, name,
 * phone, or address.
 */
export type NormalizedOrderInput = {
  connectionId: string;
  brandId: string;
  provider: CommerceProvider;

  /**
   * Whether this input is an authoritative complete snapshot of the order.
   *
   *   FULL    — every field is authoritative, INCLUDING its nulls. A null
   *             `cancelledAt` genuinely means "not cancelled" and clears a
   *             previously stored cancellation. Produced by a payload that
   *             carries the whole order (Shopify `orders/create`,
   *             `orders/updated`).
   *   PARTIAL — a fragment. Only NON-NULL fields are applied; every null
   *             preserves whatever is already stored. Produced by a payload
   *             that describes something ABOUT an order rather than the order
   *             itself (Shopify `refunds/create`). Without this distinction a
   *             refund fragment would blank the order's currency, totals, and
   *             statuses.
   *
   * On a first-seen order there is nothing to preserve, so both behave
   * identically.
   */
  completeness: "FULL" | "PARTIAL";

  externalOrderId: string | null;
  orderNumber: string | null;

  currencyCode: string | null;
  minorUnitExponent: number | null;

  subtotalMinor: bigint | null;
  discountsMinor: bigint | null;
  shippingMinor: bigint | null;
  taxMinor: bigint | null;
  /** The provider's own reported total. Never a sum of `lineItems`. */
  totalMinor: bigint | null;
  /**
   * CUMULATIVE refunded amount as of this event — see the REFUND SEMANTICS
   * block in this file's header. `null` means "this event says nothing about
   * refunds", and the stored value is preserved rather than zeroed.
   */
  totalRefundedMinor: bigint | null;

  financialStatus: CommerceOrderFinancialStatus | null;
  fulfillmentStatus: CommerceOrderFulfillmentStatus | null;
  cancelledAt: Date | null;
  cancelReason: string | null;

  providerCreatedAt: Date | null;
  providerUpdatedAt: Date | null;

  lineItems: NormalizedOrderLineItemInput[];

  /**
   * Raw click token found in the payload, if any. NEVER trusted as-is: it is
   * hashed and looked up here, and produces an attribution link only on an
   * exact, unexpired, unconsumed `CommerceClickAttribution.tokenHash` match.
   */
  attributionToken: string | null;
};

/** Identity of the delivery that carried this order. */
export type OrderIngestionEventInput = {
  /** Provider delivery id (`X-Shopify-Webhook-Id`) or a `digest:<sha256>` fallback. */
  providerEventId: string;
  /** Bound to the receiving ROUTE PATH, never to a spoofable topic header. */
  topic: string;
  /** SHA-256 hex digest of the raw, HMAC-verified body. The body is never stored. */
  payloadDigest: string;
  connectionId: string;
  brandId: string;
  provider: CommerceProvider;
};

// ---------------------------------------------------------------------------
// Public outcome types
// ---------------------------------------------------------------------------

export type OrderIngestionStatus =
  | "CREATED"
  | "UPDATED"
  | "ALREADY_PROCESSED"
  | "SKIPPED_STALE"
  | "SKIPPED_DISCONNECTED"
  /**
   * Another request holds this delivery's live claim lease. NOT a duplicate and
   * NOT a failure of this delivery — nothing is known yet about whether the
   * holder succeeded. Callers must retry (see
   * `isRetryableOrderIngestionOutcome`), never acknowledge.
   */
  | "IN_FLIGHT"
  | "FAILED";

/**
 * Short, closed set of classified reasons. Deliberately an enum-like union of
 * constants rather than free text so nothing derived from a payload can ever
 * reach a log line through this field.
 */
export type OrderIngestionReason =
  | "DUPLICATE_DELIVERY"
  | "CONNECTION_NOT_FOUND"
  | "CONNECTION_NOT_INGESTIBLE"
  | "MISSING_EXTERNAL_ORDER_ID"
  | "OLDER_THAN_STORED_STATE"
  | "UNORDERABLE_MISSING_TIMESTAMP"
  /** Pairs with `IN_FLIGHT`: a live lease on this exact delivery. Retryable. */
  | "DELIVERY_IN_FLIGHT"
  /** The order transaction itself failed. Retryable. */
  | "WRITE_FAILED"
  /**
   * An unexpected throw anywhere in the pipeline (claim, connection load, order
   * write). Retryable, and deliberately classified rather than propagated —
   * see `ingestNormalizedOrder`.
   */
  | "UNEXPECTED_FAILURE";

/**
 * Everything a caller may log. Contains ids, counts, enum-like tags and
 * booleans only — no payload content, no provider error body, no PII.
 */
export type OrderIngestionOutcome = {
  status: OrderIngestionStatus;
  reason: OrderIngestionReason | null;
  /**
   * `CommerceOrderEvent.id`. When this delivery's claim was lost (duplicate or
   * in-flight) it is the EXISTING row's id when that row could be read, so an
   * operator can correlate the two deliveries; null when no row is known at all
   * (an unexpected failure, or a row that vanished under us).
   */
  eventId: string | null;
  orderId: string | null;
  lineItemCount: number;
  /** True only when a real, hash-matched click was exclusively claimed. */
  attributionLinked: boolean;
  /**
   * True when the caller-supplied `brandId` disagreed with the connection's
   * own `brandId`. The connection always wins; this flags the disagreement.
   */
  brandIdOverriddenFromConnection: boolean;
};

/**
 * PURE. Whether the caller must ask the provider to REDELIVER this event.
 *
 * This is the single source of truth for that decision, kept here beside the
 * outcome union rather than in each transport so a new outcome cannot be
 * introduced without deciding its retry semantics in one place. Exactly three
 * outcomes are retryable, and all three share one property: SQRATCH cannot
 * prove the order was landed, and a later attempt plausibly can.
 *
 *   IN_FLIGHT / DELIVERY_IN_FLIGHT — someone else's live claim; unproven.
 *   FAILED / WRITE_FAILED          — the order transaction failed; transient.
 *   FAILED / UNEXPECTED_FAILURE    — an unexpected throw; treated as transient.
 *
 * Everything else is either a success or a DETERMINISTIC rejection (missing
 * external order id, disconnected shop, stale event, genuine duplicate) that a
 * retry would reach the identical conclusion about, so retrying it would only
 * produce a retry storm.
 */
export function isRetryableOrderIngestionOutcome(
  outcome: Pick<OrderIngestionOutcome, "status" | "reason">,
): boolean {
  if (outcome.status === "IN_FLIGHT") {
    return true;
  }
  return (
    outcome.status === "FAILED" &&
    (outcome.reason === "WRITE_FAILED" || outcome.reason === "UNEXPECTED_FAILURE")
  );
}

// ---------------------------------------------------------------------------
// Connection gating
// ---------------------------------------------------------------------------

/** The minimal connection projection this service gates on. */
export type OrderIngestionConnection = {
  id: string;
  brandId: string;
  provider: CommerceProvider;
  status: CommerceConnectionStatus;
};

/**
 * Whether a connection in this state may have order data applied to it.
 * ALL SIX `CommerceConnectionStatus` members are handled explicitly — this is
 * a total switch, so adding a seventh member becomes a compile error rather
 * than a silent default.
 *
 *   PENDING            -> yes. An install in flight is still a real shop, and
 *                         an order that arrives during it is real data.
 *   CONNECTED          -> yes. The normal case.
 *   REQUIRES_RECONNECT -> yes. This status is about an unusable ACCESS TOKEN.
 *                         A webhook is pushed TO us and needs no token at all,
 *                         so discarding genuine, HMAC-verified order data
 *                         because our outbound credential expired would lose
 *                         revenue history for a shop that is still ours.
 *   DISCONNECTED       -> no. The merchant severed the link.
 *   UNINSTALLED        -> no. The app is gone from the shop.
 *   ERROR              -> no. The connection is in an unknown, untrusted state;
 *                         recording the event without applying it is the
 *                         conservative choice.
 *
 * A non-ingestible connection still gets its event row written (as
 * `SKIPPED_DISCONNECTED`) so the caller can answer 200 and the provider never
 * enters a retry storm over a shop we deliberately declined to write for.
 */
export function isIngestibleConnectionStatus(
  status: CommerceConnectionStatus,
): boolean {
  switch (status) {
    case "PENDING":
    case "CONNECTED":
    case "REQUIRES_RECONNECT":
      return true;
    case "DISCONNECTED":
    case "UNINSTALLED":
    case "ERROR":
      return false;
    default: {
      // Exhaustiveness guard: `never` here means every member above is
      // handled. A new enum member fails to compile instead of defaulting to
      // "ingestible", which would be the dangerous direction to guess in.
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

export type StalenessDecision = "FIRST_SEEN" | "APPLY" | "STALE" | "UNORDERABLE";

/**
 * PURE out-of-order protection. `providerUpdatedAt` is the ordering key.
 *
 *   - No stored row at all      -> FIRST_SEEN. A brand-new external order id is
 *                                  NEVER stale, whatever its timestamp says.
 *   - Stored row, no stored key  -> APPLY. Anything is better than unknown.
 *   - Stored row, no incoming key-> UNORDERABLE. We cannot prove this delivery
 *                                  is newer, so we refuse to overwrite. Treated
 *                                  as a skip, not a failure.
 *   - incoming <= stored         -> STALE. Note `<=`, not `<`: an equal
 *                                  timestamp carries no evidence of being
 *                                  newer, and rewriting on equality would let
 *                                  two same-timestamp deliveries flap the row.
 *   - incoming >  stored         -> APPLY.
 */
export function decideOrderStaleness(
  storedProviderUpdatedAt: Date | null | undefined,
  incomingProviderUpdatedAt: Date | null,
  hasStoredRow: boolean,
): StalenessDecision {
  if (!hasStoredRow) {
    return "FIRST_SEEN";
  }
  if (!storedProviderUpdatedAt) {
    return "APPLY";
  }
  if (!incomingProviderUpdatedAt) {
    return "UNORDERABLE";
  }
  return incomingProviderUpdatedAt.getTime() > storedProviderUpdatedAt.getTime()
    ? "APPLY"
    : "STALE";
}

// ---------------------------------------------------------------------------
// Derived money
// ---------------------------------------------------------------------------

/**
 * PURE. `netRevenueMinor = totalMinor - totalRefundedMinor`, nullable-safe.
 * A null total yields a null net: an unknown gross cannot produce a known net,
 * and returning 0 there would read as "this order earned nothing", which is a
 * different and false claim.
 */
export function computeNetRevenueMinor(
  totalMinor: bigint | null,
  totalRefundedMinor: bigint,
): bigint | null {
  if (totalMinor === null) {
    return null;
  }
  return totalMinor - totalRefundedMinor;
}

// ---------------------------------------------------------------------------
// Dependency injection
// ---------------------------------------------------------------------------

/**
 * The four distinguishable results of trying to claim one delivery. See the
 * IDEMPOTENCY block in this file's header for why all four must exist.
 *
 * `eventId` is non-null for the two outcomes that authorize processing, because
 * the caller must finalize that exact row. For the two that do not authorize
 * processing it is the EXISTING row's id when it could be read, and null only
 * when no row could be identified at all.
 */
export type OrderEventClaim =
  /** The INSERT won. Process it. */
  | { status: "CLAIMED"; eventId: string }
  /** A dead/abandoned prior claim was atomically taken over. Process it. */
  | { status: "RECLAIMED"; eventId: string }
  /** Already fully handled (terminal status). Acknowledge, do not reprocess. */
  | { status: "COMPLETED_DUPLICATE"; eventId: string | null }
  /** Someone else's live lease. Neither acknowledge nor process — retry later. */
  | { status: "IN_FLIGHT"; eventId: string | null };

export type OrderIngestionDeps = {
  /**
   * Atomically claims the delivery by inserting the `CommerceOrderEvent` row,
   * resolving a P2002 against `(provider, providerEventId)` into one of the
   * three non-CLAIMED `OrderEventClaim` outcomes. Any other error propagates
   * and is classified as `UNEXPECTED_FAILURE` by `ingestNormalizedOrder`.
   */
  claimEvent(input: {
    providerEventId: string;
    topic: string;
    payloadDigest: string;
    connectionId: string;
    brandId: string;
    provider: CommerceProvider;
    externalOrderRef: string | null;
    providerUpdatedAt: Date | null;
  }): Promise<OrderEventClaim>;

  /** Loads the gating projection of the connection, or null if it is gone. */
  loadConnection(connectionId: string): Promise<OrderIngestionConnection | null>;

  /**
   * PROVIDER-SPECIFIC id expansion, injected so this generic layer holds no
   * provider's id format. Given one raw `externalProductId` from a normalized
   * line item, returns every id form that provider's CATALOG adapter might have
   * stored in `ConnectedCommerceProduct.externalKey`.
   *
   * Defaults to `providerProductKeyCandidates`, which is provider-neutral. The
   * Shopify wiring supplies `shopifyProductKeyCandidates` (see
   * `./providers/shopify-order-webhook.ts`), because only Shopify knows that
   * its catalog stores `gid://shopify/Product/<id>` while its order webhooks
   * report the same product as a bare numeric REST id.
   */
  expandProductKeyCandidates(externalProductId: string | null): string[];

  /** Runs `fn` inside a DB transaction and returns its result. */
  runTransaction<T>(fn: (tx: TxClient) => Promise<T>): Promise<T>;

  /**
   * Hashes a raw click token for `CommerceClickAttribution.tokenHash` lookup.
   * Defaults to `hashClickToken`, which THROWS on a malformed token or an
   * unconfigured `COMMERCE_CLICK_TOKEN_PEPPER`; both are caught here and
   * degrade to "no attribution", never to a failed ingestion.
   */
  hashAttributionToken(token: string): string;

  /** Injectable clock, so expiry behavior is testable without waiting. */
  now(): Date;
};

/**
 * How long a `RECEIVED` `CommerceOrderEvent` row is treated as a LIVE lease held
 * by the request that claimed it.
 *
 * 60s is deliberately unchanged from the original implementation. It only has
 * to comfortably exceed the wall-clock cost of one order transaction (a handful
 * of statements), and neither direction of error is a correctness bug now that
 * IN_FLIGHT is answered with a retry rather than an acknowledgement:
 *
 *   - too SHORT lets two workers both judge a row stale near the boundary, which
 *     the compare-and-set in `reclaim` resolves by electing exactly one winner;
 *     the loser is reported IN_FLIGHT and retries.
 *   - too LONG only delays the self-heal of a genuinely abandoned claim by more
 *     provider-retry round trips.
 *
 * Both are operational costs. The correctness comes from never reporting an
 * unfinished claim as completed.
 */
export const EVENT_CLAIM_LEASE_MS = 60_000;

/** What an EXISTING event row proves about whether this delivery may proceed. */
export type OrderEventClaimDecision =
  | "RECLAIMABLE"
  | "COMPLETED_DUPLICATE"
  | "IN_FLIGHT";

/** The projection of an existing event row the claim decision needs. */
export type ExistingOrderEventRow = {
  id: string;
  status: CommerceOrderEventStatus;
  receivedAt: Date;
};

/**
 * PURE. Classifies an existing `CommerceOrderEvent` row for a redelivery of the
 * same `(provider, providerEventId)`.
 *
 * ALL FIVE `CommerceOrderEventStatus` members are handled explicitly — a total
 * switch, so a sixth member becomes a compile error rather than silently
 * defaulting. The dangerous direction to guess in is COMPLETED_DUPLICATE (which
 * would acknowledge unfinished work), so the default is not reachable and no
 * status is grouped by accident:
 *
 *   FAILED               -> RECLAIMABLE. A previous attempt explicitly recorded
 *                          its own failure, so nothing holds this delivery. Safe
 *                          immediately, with no lease wait.
 *   RECEIVED, expired    -> RECLAIMABLE. The holder is gone (crashed, or its
 *                          finalize write failed). Take it over.
 *   RECEIVED, live       -> IN_FLIGHT. Someone is (or just was) working on it.
 *                          Nothing is proven; this must not be acknowledged.
 *   PROCESSED,
 *   SKIPPED_STALE,
 *   SKIPPED_DISCONNECTED -> COMPLETED_DUPLICATE. Terminal and deliberate: the
 *                          delivery was applied, or superseded by newer state,
 *                          or declined because the shop was disconnected.
 */
export function decideOrderEventClaim(
  existingStatus: CommerceOrderEventStatus,
  existingReceivedAt: Date,
  now: Date,
  leaseMs: number = EVENT_CLAIM_LEASE_MS,
): OrderEventClaimDecision {
  switch (existingStatus) {
    case "FAILED":
      return "RECLAIMABLE";
    case "RECEIVED":
      return now.getTime() - existingReceivedAt.getTime() > leaseMs
        ? "RECLAIMABLE"
        : "IN_FLIGHT";
    case "PROCESSED":
    case "SKIPPED_STALE":
    case "SKIPPED_DISCONNECTED":
      return "COMPLETED_DUPLICATE";
    default: {
      const exhaustive: never = existingStatus;
      return exhaustive;
    }
  }
}

/**
 * The three row operations the claim state machine needs, isolated from Prisma
 * so the state machine itself is the SAME code in production and under test —
 * a fake that re-implemented the machine would prove nothing about it.
 */
export type OrderEventClaimStore = {
  /**
   * Inserts the `RECEIVED` row. Resolves to `"DUPLICATE"` on a unique violation
   * against `(provider, providerEventId)`; any other error must throw.
   */
  insertClaim(): Promise<{ id: string } | "DUPLICATE">;
  /** Reads the existing row for this `(provider, providerEventId)`, or null. */
  findExistingClaim(): Promise<ExistingOrderEventRow | null>;
  /**
   * COMPARE-AND-SET takeover: flips the row to a FRESH `RECEIVED` lease if and
   * only if `(id, status, receivedAt)` still match `row`. Resolves true for the
   * single winner and false for anyone whose read is already outdated.
   *
   * `receivedAt` is part of the predicate, not just `status`: a stale
   * `RECEIVED` row is reclaimed BACK to `RECEIVED`, so status alone cannot tell
   * two concurrent reclaimers apart and both would believe they won.
   */
  reclaim(row: ExistingOrderEventRow, now: Date): Promise<boolean>;
};

/**
 * The claim state machine. Transport-free and DB-free by construction.
 */
export async function resolveOrderEventClaim(
  store: OrderEventClaimStore,
  now: Date,
  leaseMs: number = EVENT_CLAIM_LEASE_MS,
): Promise<OrderEventClaim> {
  const inserted = await store.insertClaim();
  if (inserted !== "DUPLICATE") {
    return { status: "CLAIMED", eventId: inserted.id };
  }

  const existing = await store.findExistingClaim();
  if (!existing) {
    // Lost the INSERT, then found no row: the winner's transaction has not
    // become visible, or the row was redacted between the two statements.
    // Nothing is proven, so fail closed to RETRYABLE rather than acknowledge.
    return { status: "IN_FLIGHT", eventId: null };
  }

  const decision = decideOrderEventClaim(
    existing.status,
    existing.receivedAt,
    now,
    leaseMs,
  );
  if (decision !== "RECLAIMABLE") {
    return { status: decision, eventId: existing.id };
  }

  const won = await store.reclaim(existing, now);
  // Losing the CAS means a concurrent reclaimer now holds a fresh lease on this
  // exact delivery — which is IN_FLIGHT, not a completed duplicate.
  return won
    ? { status: "RECLAIMED", eventId: existing.id }
    : { status: "IN_FLIGHT", eventId: existing.id };
}

async function defaultClaimEvent(input: {
  providerEventId: string;
  topic: string;
  payloadDigest: string;
  connectionId: string;
  brandId: string;
  provider: CommerceProvider;
  externalOrderRef: string | null;
  providerUpdatedAt: Date | null;
}): Promise<OrderEventClaim> {
  const { default: prisma } = await import("@/lib/prisma");
  const identity = {
    provider_providerEventId: {
      provider: input.provider,
      providerEventId: input.providerEventId,
    },
  };

  return resolveOrderEventClaim(
    {
      async insertClaim() {
        try {
          const created = await prisma.commerceOrderEvent.create({
            data: {
              providerEventId: input.providerEventId,
              topic: input.topic,
              payloadDigest: input.payloadDigest,
              connectionId: input.connectionId,
              brandId: input.brandId,
              provider: input.provider,
              externalOrderRef: input.externalOrderRef,
              providerUpdatedAt: input.providerUpdatedAt,
              status: "RECEIVED",
            },
            select: { id: true },
          });
          return { id: created.id };
        } catch (error) {
          if (isUniqueViolation(error)) {
            return "DUPLICATE";
          }
          throw error;
        }
      },
      async findExistingClaim() {
        return prisma.commerceOrderEvent.findUnique({
          where: identity,
          select: { id: true, status: true, receivedAt: true },
        });
      },
      async reclaim(row, now) {
        const reclaimed = await prisma.commerceOrderEvent.updateMany({
          where: { id: row.id, status: row.status, receivedAt: row.receivedAt },
          data: {
            status: "RECEIVED",
            // Restart the lease for THIS attempt. Without it, a row that was
            // ever reclaimed keeps its original `receivedAt` forever, so every
            // later retry immediately reads as stale and the lease stops
            // protecting that row at all.
            receivedAt: now,
            processedAt: null,
            failureSummary: null,
          },
        });
        return reclaimed.count === 1;
      },
    },
    // Real wall clock, deliberately not the injected `now`: the lease measures
    // elapsed real time between two processes, and a frozen test clock would
    // make every lease look either eternally live or eternally stale.
    new Date(),
  );
}

async function defaultLoadConnection(
  connectionId: string,
): Promise<OrderIngestionConnection | null> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.commerceConnection.findUnique({
    where: { id: connectionId },
    select: { id: true, brandId: true, provider: true, status: true },
  });
}

async function defaultRunTransaction<T>(
  fn: (tx: TxClient) => Promise<T>,
): Promise<T> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.$transaction(fn);
}

const DEFAULT_ORDER_INGESTION_DEPS: OrderIngestionDeps = {
  claimEvent: defaultClaimEvent,
  loadConnection: defaultLoadConnection,
  expandProductKeyCandidates: providerProductKeyCandidates,
  runTransaction: defaultRunTransaction,
  hashAttributionToken: hashClickToken,
  now: () => new Date(),
};

/**
 * Raised when the optimistic-concurrency guard on the order UPDATE loses: the
 * stored row's ordering key moved between this transaction's read and its
 * write, so a concurrent delivery for the SAME order committed underneath us
 * and this delivery's staleness decision is based on a snapshot that no longer
 * exists.
 *
 * Deliberately carries a CONSTANT tag rather than any state: it is classified
 * as the retryable `WRITE_FAILED` by the order-transaction catch below, and
 * nothing derived from a payload may ever ride an error message into a log.
 */
class ConcurrentOrderWriteError extends Error {
  constructor() {
    super("CONCURRENT_ORDER_WRITE");
    this.name = "ConcurrentOrderWriteError";
  }
}

/** True for a Prisma P2002 unique-constraint violation. */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  );
}

// ---------------------------------------------------------------------------
// Event finalization
// ---------------------------------------------------------------------------

/**
 * Best-effort terminal write on the event row. Deliberately swallowing its own
 * failure: the order write has already committed at this point, and throwing
 * here would turn a successful ingestion into a caller-visible error. The row
 * simply stays `RECEIVED`, holding a live lease.
 *
 * Under the four-state claim model that outcome is now strictly SAFER than it
 * used to be. A redelivery arriving while the lease is live is classified
 * IN_FLIGHT and answered with a retry, so nothing is acknowledged on the
 * strength of a write we cannot see; once the lease expires the next retry
 * RECLAIMS the row and reprocesses it, which is idempotent (the redelivery
 * carries the same `providerUpdatedAt` as the stored order, so it lands as
 * `SKIPPED_STALE`). Previously the same swallowed failure meant the next
 * redelivery was answered `ALREADY_PROCESSED`, permanently hiding an order that
 * may never have been written.
 */
async function finalizeEvent(
  eventId: string,
  data: {
    status: CommerceOrderEventStatus;
    orderId?: string | null;
    failureSummary?: string | null;
  },
  now: Date,
): Promise<void> {
  try {
    const { default: prisma } = await import("@/lib/prisma");
    await prisma.commerceOrderEvent.update({
      where: { id: eventId },
      data: {
        status: data.status,
        processedAt: now,
        orderId: data.orderId ?? null,
        failureSummary: data.failureSummary ?? null,
      },
    });
  } catch {
    // Intentionally ignored — see the doc comment above.
  }
}

// ---------------------------------------------------------------------------
// Attribution association
// ---------------------------------------------------------------------------

/**
 * EVIDENCE-BASED ONLY. An order is linked to a click if and only if the
 * payload carried a token whose hash EXACTLY matches a stored
 * `CommerceClickAttribution.tokenHash` that is unexpired and either unclaimed
 * or already claimed by this very order. There is no fuzzy matching here and
 * there must never be: no matching by product, by timing proximity, by
 * session, by IP, or by "the only recent click for this brand". An
 * unattributed order is the correct and expected outcome.
 *
 * SHOPIFY TRANSPORT. Phase 12's Theme App Extension copies only the
 * namespaced click token into a cart attribute. The Shopify normalizer accepts
 * that durable attribute only; it never trusts landing/referrer query strings.
 * This generic claim path still requires exact hash, expiry, redirected click,
 * immutable brand, provider, and connection evidence before linking an order.
 *
 * RACE SAFETY. The claim is a CONDITIONAL update:
 * `updateMany({ where: { id, consumedAt: null }, data: {...} })`. Postgres
 * evaluates the predicate against the row it locks, so of two concurrent
 * claimants for the same click exactly one gets `count === 1` and the other
 * gets `count === 0`. Only the winner sets `attributionId`. Replay of the SAME
 * order is handled separately and idempotently: `count === 0` combined with an
 * existing `consumedByOrderRef` equal to this order's id is a re-claim by the
 * rightful owner, not a loss. `CommerceOrder.attributionId @unique` is the
 * second, database-level guard against two orders ever holding one click.
 */
async function associateAttribution(
  tx: TxClient,
  params: {
    token: string;
    orderId: string;
    brandId: string;
    connectionId: string;
    provider: CommerceProvider;
    now: Date;
    hashAttributionToken: (token: string) => string;
  },
): Promise<string | null> {
  let tokenHash: string;
  try {
    tokenHash = params.hashAttributionToken(params.token);
  } catch {
    // Malformed token, or COMMERCE_CLICK_TOKEN_PEPPER unconfigured. Both mean
    // "we cannot prove anything about this token" -> leave the order
    // unattributed. Never a failed ingestion, and the token is never logged.
    return null;
  }

  const attribution = await tx.commerceClickAttribution.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      attributedBrandId: true,
      commerceConnectionId: true,
      provider: true,
      redirectedAt: true,
      expiresAt: true,
      consumedAt: true,
      consumedByOrderRef: true,
    },
  });

  if (!attribution) {
    return null;
  }

  // A bearer token is evidence only for its immutable attributed Brand and
  // exact merchant connection. Legacy/unpinned clicks are not conversion
  // evidence; they remain historical click-only rows.
  if (
    attribution.redirectedAt === null ||
    attribution.attributedBrandId === null ||
    attribution.attributedBrandId !== params.brandId ||
    attribution.provider !== params.provider ||
    attribution.commerceConnectionId !== params.connectionId
  ) {
    return null;
  }

  if (attribution.expiresAt.getTime() <= params.now.getTime()) {
    // Expired evidence is not evidence.
    return null;
  }

  const claim = await tx.commerceClickAttribution.updateMany({
    where: { id: attribution.id, consumedAt: null },
    data: { consumedAt: params.now, consumedByOrderRef: params.orderId },
  });

  if (claim.count === 1) {
    return attribution.id;
  }

  // Lost the conditional update. That is either (a) a concurrent claim by a
  // DIFFERENT order — leave this order unattributed, never steal it — or
  // (b) a replay of THIS order, in which case re-linking is idempotent and
  // correct.
  return attribution.consumedByOrderRef === params.orderId ? attribution.id : null;
}

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

/**
 * Line items are replaced WHOLESALE on every non-stale write rather than
 * reconciled row by row. Providers report the complete line set on every order
 * event, so a merge-by-provider-id reconciliation would silently retain lines
 * the merchant has since removed from the order. Delete-then-insert inside the
 * same transaction is atomic, so no reader ever observes a partial line set.
 *
 * `connectedProductId` resolution is BEST EFFORT and never blocks the write: a
 * merchant can sell products SQRATCH never synced.
 */
async function writeLineItems(
  tx: TxClient,
  orderId: string,
  connectionId: string,
  lineItems: NormalizedOrderLineItemInput[],
  expandProductKeyCandidates: (externalProductId: string | null) => string[],
): Promise<number> {
  await tx.commerceOrderLineItem.deleteMany({ where: { orderId } });

  // Provider line ids are a stable identity when present. A malformed payload
  // must not turn one line into two persisted revenue rows; retain the first
  // occurrence deterministically while preserving distinct null-id lines.
  const seenLineIds = new Set<string>();
  const uniqueLineItems = lineItems.filter((item) => {
    if (!item.externalLineItemId) return true;
    if (seenLineIds.has(item.externalLineItemId)) return false;
    seenLineIds.add(item.externalLineItemId);
    return true;
  });

  if (uniqueLineItems.length === 0) {
    return 0;
  }

  const productKeys = Array.from(
    new Set(
      uniqueLineItems
        .flatMap((item) => expandProductKeyCandidates(item.externalProductId))
        .filter((key): key is string => key !== null),
    ),
  );

  const matches =
    productKeys.length > 0
      ? await tx.connectedCommerceProduct.findMany({
          where: { connectionId, externalKey: { in: productKeys } },
          select: { id: true, externalKey: true },
        })
      : [];

  const byExternalKey = new Map(matches.map((row) => [row.externalKey, row.id]));

  const resolveConnectedProductId = (externalProductId: string | null): string | null => {
    for (const candidate of expandProductKeyCandidates(externalProductId)) {
      const hit = byExternalKey.get(candidate);
      if (hit) {
        return hit;
      }
    }
    return null;
  };

  await tx.commerceOrderLineItem.createMany({
    data: uniqueLineItems.map((item) => ({
      orderId,
      externalLineItemId: item.externalLineItemId,
      externalProductId: item.externalProductId,
      externalVariantId: item.externalVariantId,
      connectedProductId: resolveConnectedProductId(item.externalProductId),
      title: item.title,
      sku: item.sku,
      quantity: item.quantity,
      unitPriceMinor: item.unitPriceMinor,
      discountMinor: item.discountMinor,
      taxMinor: item.taxMinor,
      totalMinor: item.totalMinor,
    })),
  });

  return uniqueLineItems.length;
}

/**
 * PURE and PROVIDER-NEUTRAL. The DEFAULT `expandProductKeyCandidates`.
 *
 * `ConnectedCommerceProduct.externalKey` stores whatever id form that
 * provider's CATALOG adapter emitted, which is not always the form its ORDER
 * payloads report. This generic layer knows only the two provider-agnostic
 * facts it can justify for ANY provider:
 *
 *   - the id may be stored verbatim, and
 *   - a namespaced/pathish id may also be stored as its trailing numeric
 *     segment (`.../123` also matches `123`).
 *
 * It deliberately contains NO provider's id format. Expanding in the other
 * direction — a bare id back into a provider's namespaced form — requires
 * knowing that namespace, so it is the provider's job and arrives through
 * `OrderIngestionDeps.expandProductKeyCandidates`. See
 * `shopifyProductKeyCandidates` in `./providers/shopify-order-webhook.ts`.
 */
export function providerProductKeyCandidates(
  externalProductId: string | null,
): string[] {
  const raw = externalProductId?.trim();
  if (!raw) {
    return [];
  }
  const numericTail = /\/(\d+)$/.exec(raw);
  return numericTail ? [raw, numericTail[1]] : [raw];
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Idempotently lands one normalized provider order.
 *
 * Sequence, exactly:
 *   1. Claim the delivery (`CommerceOrderEvent` insert), resolving to one of
 *      four outcomes. `COMPLETED_DUPLICATE` -> `ALREADY_PROCESSED`, order table
 *      untouched. `IN_FLIGHT` -> the retryable `IN_FLIGHT` outcome, order table
 *      untouched, and NOT an acknowledgement. `CLAIMED`/`RECLAIMED` proceed.
 *   2. Gate on connection status. Not ingestible (or connection gone) ->
 *      `SKIPPED_DISCONNECTED`, event recorded, order table untouched.
 *   3. Require an external order id. Absent -> `FAILED`
 *      (`MISSING_EXTERNAL_ORDER_ID`), order table untouched. A null id would
 *      otherwise create an unmatchable row, since Postgres treats NULLs as
 *      distinct in the `(connectionId, externalOrderId)` unique index.
 *   4. In one transaction: read the stored row, decide staleness, then create /
 *      update / skip. Line items are replaced wholesale on any non-stale write.
 *      Attribution is claimed conditionally, if and only if a real token
 *      matched.
 *   5. Finalize the event row with the terminal status.
 *
 * NEVER THROWS. Every expected condition (duplicate, in-flight, disconnected,
 * stale, missing id) is a typed outcome, and every UNEXPECTED throw — from the
 * claim, the connection load, or the order transaction — is caught and
 * classified rather than propagated, so a route can never turn one into an
 * unhandled exception.
 *
 * Failures are classified by whether a RETRY could plausibly succeed, which is
 * the opposite of a blanket "always answer 200":
 *
 *   - A transient write failure (`WRITE_FAILED`) or an unexpected throw
 *     (`UNEXPECTED_FAILURE`) is RETRYABLE, so the caller answers 500 and the
 *     provider redelivers. That redelivery is what eventually lands the order;
 *     answering 200 here would discard it.
 *   - A deterministic rejection (missing external order id, disconnected shop,
 *     stale event, genuine duplicate) is NOT retryable, so the caller answers
 *     200 and no retry storm forms over work that can never succeed.
 *
 * `isRetryableOrderIngestionOutcome` encodes exactly that split. Either way the
 * event row is the durable record that the delivery arrived.
 */
export async function ingestNormalizedOrder(
  event: OrderIngestionEventInput,
  order: NormalizedOrderInput,
  deps: Partial<OrderIngestionDeps> = {},
): Promise<OrderIngestionOutcome> {
  try {
    return await runOrderIngestion(event, order, deps);
  } catch {
    // FAIL CLOSED TO RETRYABLE. Reached only for an UNEXPECTED throw outside
    // the order transaction's own catch — a claim or connection-load error, or
    // a non-P2002 Prisma error. The alternative is an unhandled exception
    // escaping into the route, where an accidental 200 (or an opaque crash)
    // could drop a real order.
    //
    // The error is not swallowed silently: it becomes the classified
    // `UNEXPECTED_FAILURE` tag, which the caller logs and answers 500 to. It is
    // not bound or read, for the same no-PII reason as the write-failure catch
    // below — a Prisma error message can embed payload column values.
    return {
      status: "FAILED",
      reason: "UNEXPECTED_FAILURE",
      eventId: null,
      orderId: null,
      lineItemCount: 0,
      attributionLinked: false,
      brandIdOverriddenFromConnection: false,
    };
  }
}

async function runOrderIngestion(
  event: OrderIngestionEventInput,
  order: NormalizedOrderInput,
  deps: Partial<OrderIngestionDeps> = {},
): Promise<OrderIngestionOutcome> {
  const resolved: OrderIngestionDeps = { ...DEFAULT_ORDER_INGESTION_DEPS, ...deps };
  const now = resolved.now();

  const base: OrderIngestionOutcome = {
    status: "FAILED",
    reason: null,
    eventId: null,
    orderId: null,
    lineItemCount: 0,
    attributionLinked: false,
    brandIdOverriddenFromConnection: false,
  };

  // --- 1. Idempotency claim -------------------------------------------------
  const claim = await resolved.claimEvent({
    providerEventId: event.providerEventId,
    topic: event.topic,
    payloadDigest: event.payloadDigest,
    connectionId: event.connectionId,
    brandId: event.brandId,
    provider: event.provider,
    externalOrderRef: order.externalOrderId,
    providerUpdatedAt: order.providerUpdatedAt,
  });

  if (claim.status === "COMPLETED_DUPLICATE") {
    // The prior row is TERMINAL: this delivery was already fully handled.
    // Acknowledging it without reprocessing is correct.
    return {
      ...base,
      status: "ALREADY_PROCESSED",
      reason: "DUPLICATE_DELIVERY",
      eventId: claim.eventId,
    };
  }

  if (claim.status === "IN_FLIGHT") {
    // NOT a duplicate. Another request holds a live lease on this exact
    // delivery and we can prove neither success nor failure, so this must be
    // reported as RETRYABLE. The provider's next redelivery will find the lease
    // either finalized (-> COMPLETED_DUPLICATE -> acknowledged) or expired
    // (-> RECLAIMED -> processed for real). Answering "already processed" here
    // is what used to lose orders outright.
    return {
      ...base,
      status: "IN_FLIGHT",
      reason: "DELIVERY_IN_FLIGHT",
      eventId: claim.eventId,
    };
  }

  // CLAIMED or RECLAIMED: this request now owns the delivery.
  const eventId = claim.eventId;

  // --- 2. Connection gate ---------------------------------------------------
  const connection = await resolved.loadConnection(event.connectionId);

  if (!connection) {
    await finalizeEvent(eventId, { status: "SKIPPED_DISCONNECTED" }, now);
    return {
      ...base,
      status: "SKIPPED_DISCONNECTED",
      reason: "CONNECTION_NOT_FOUND",
      eventId,
    };
  }

  if (!isIngestibleConnectionStatus(connection.status)) {
    await finalizeEvent(eventId, { status: "SKIPPED_DISCONNECTED" }, now);
    return {
      ...base,
      status: "SKIPPED_DISCONNECTED",
      reason: "CONNECTION_NOT_INGESTIBLE",
      eventId,
    };
  }

  // The connection's own brandId is authoritative — never the caller's.
  const brandId = connection.brandId;
  const brandIdOverriddenFromConnection = brandId !== event.brandId;

  // --- 3. External order id is mandatory for identity ----------------------
  const externalOrderId = order.externalOrderId?.trim() || null;
  if (!externalOrderId) {
    await finalizeEvent(
      eventId,
      { status: "FAILED", failureSummary: "MISSING_EXTERNAL_ORDER_ID" },
      now,
    );
    return {
      ...base,
      status: "FAILED",
      reason: "MISSING_EXTERNAL_ORDER_ID",
      eventId,
      brandIdOverriddenFromConnection,
    };
  }

  // --- 4. Order write -------------------------------------------------------
  try {
    const result = await resolved.runTransaction(async (tx) => {
      const existing = await tx.commerceOrder.findUnique({
        where: {
          connectionId_externalOrderId: {
            connectionId: connection.id,
            externalOrderId,
          },
        },
        select: {
          id: true,
          providerUpdatedAt: true,
          providerCreatedAt: true,
          orderNumber: true,
          currencyCode: true,
          minorUnitExponent: true,
          subtotalMinor: true,
          discountsMinor: true,
          shippingMinor: true,
          taxMinor: true,
          totalMinor: true,
          totalRefundedMinor: true,
          financialStatus: true,
          fulfillmentStatus: true,
          cancelledAt: true,
          cancelReason: true,
          attributionId: true,
        },
      });

      const decision = decideOrderStaleness(
        existing?.providerUpdatedAt ?? null,
        order.providerUpdatedAt,
        existing !== null,
      );

      // A refund fragment is not an order snapshot. Creating an otherwise
      // empty order from it can make a subsequently delivered full
      // orders/create snapshot appear stale, permanently losing totals and
      // lines. Retain the event ledger and wait for a full provider snapshot.
      if (!existing && order.completeness === "PARTIAL") {
        return {
          status: "SKIPPED_STALE" as const,
          reason: "UNORDERABLE_MISSING_TIMESTAMP" as const,
          orderId: null,
          lineItemCount: 0,
          attributionLinked: false,
        };
      }

      if (existing && (decision === "STALE" || decision === "UNORDERABLE")) {
        return {
          status: "SKIPPED_STALE" as const,
          reason:
            decision === "STALE"
              ? ("OLDER_THAN_STORED_STATE" as const)
              : ("UNORDERABLE_MISSING_TIMESTAMP" as const),
          orderId: existing.id,
          lineItemCount: 0,
          attributionLinked: existing.attributionId !== null,
        };
      }

      // FULL inputs are authoritative including their nulls; PARTIAL inputs
      // only ever contribute non-null values. `pick` is the one place that
      // distinction is applied, so it cannot drift field by field.
      const partial = order.completeness === "PARTIAL";
      const pick = <T>(incoming: T | null, stored: T | null | undefined): T | null =>
        partial ? (incoming ?? stored ?? null) : incoming;

      // Cumulative refunds: a null incoming value ALWAYS means "this event
      // says nothing about refunds" and must PRESERVE the stored figure, not
      // zero it — this one field coalesces even on a FULL payload, because a
      // provider omitting refund data is not the same as it reporting zero
      // refunds. See the REFUND SEMANTICS block in this file's header.
      const totalRefundedMinor =
        order.totalRefundedMinor ?? existing?.totalRefundedMinor ?? BigInt(0);
      const totalMinor = pick(order.totalMinor, existing?.totalMinor);
      const netRevenueMinor = computeNetRevenueMinor(totalMinor, totalRefundedMinor);

      const moneyAndStatus = {
        currencyCode: pick(order.currencyCode, existing?.currencyCode),
        minorUnitExponent: pick(order.minorUnitExponent, existing?.minorUnitExponent),
        subtotalMinor: pick(order.subtotalMinor, existing?.subtotalMinor),
        discountsMinor: pick(order.discountsMinor, existing?.discountsMinor),
        shippingMinor: pick(order.shippingMinor, existing?.shippingMinor),
        taxMinor: pick(order.taxMinor, existing?.taxMinor),
        totalMinor,
        totalRefundedMinor,
        netRevenueMinor,
        financialStatus: pick(order.financialStatus, existing?.financialStatus),
        fulfillmentStatus: pick(order.fulfillmentStatus, existing?.fulfillmentStatus),
        // Cancellation rides the same upsert path and the same staleness
        // check — there is no separate cancellation branch. On a FULL payload
        // a null `cancelledAt` correctly clears a stored cancellation.
        cancelledAt: pick(order.cancelledAt, existing?.cancelledAt),
        cancelReason: pick(order.cancelReason, existing?.cancelReason),
        providerCreatedAt: pick(order.providerCreatedAt, existing?.providerCreatedAt),
        // Refund fragments have their own provider timestamp, not an
        // authoritative order-snapshot version. Never let one advance the
        // full-order staleness key and suppress a later orders/updated body.
        providerUpdatedAt: partial
          ? existing?.providerUpdatedAt ?? null
          : pick(order.providerUpdatedAt, existing?.providerUpdatedAt),
        orderNumber: pick(order.orderNumber, existing?.orderNumber),
      };

      let orderId: string;
      let created: boolean;

      if (existing) {
        // OPTIMISTIC CONCURRENCY ON THE ORDERING KEY — NOT A BARE UPDATE.
        //
        // `decision` above was computed from the snapshot read at the top of
        // this transaction. Under PostgreSQL's default READ COMMITTED
        // isolation that snapshot can go out of date before this statement
        // runs: a provider legitimately delivers several events for one order
        // at once (Shopify emits `refunds/create` and `orders/updated` for the
        // same refund back to back), and those land as SEPARATE deliveries in
        // SEPARATE transactions. An unconditional `update` would then write
        // this delivery's whole field set — including the values it COALESCED
        // from its own already-stale read — straight over the newer committed
        // state, silently reverting a financial status or zeroing a cumulative
        // refund total with no later delivery to repair it.
        //
        // Restating `providerUpdatedAt` in the predicate makes the write
        // conditional on the exact row version the decision was made against.
        // Postgres re-evaluates an UPDATE's predicate against the row version
        // it actually locks, so of two concurrent writers exactly one matches
        // and the other gets `count === 0` — the same compare-and-set idiom
        // the event claim and the attribution claim already use.
        //
        // Losing is NOT a silent skip: it raises, which rolls the transaction
        // back and is classified as the RETRYABLE `WRITE_FAILED`. The
        // provider's redelivery then re-reads the committed state and reaches
        // the correct decision — usually `SKIPPED_STALE`, because the winner
        // already carried the newer snapshot.
        const applied = await tx.commerceOrder.updateMany({
          where: {
            id: existing.id,
            providerUpdatedAt: existing.providerUpdatedAt,
          },
          data: moneyAndStatus,
        });
        if (applied.count !== 1) {
          throw new ConcurrentOrderWriteError();
        }
        orderId = existing.id;
        created = false;
      } else {
        const inserted = await tx.commerceOrder.create({
          data: {
            connectionId: connection.id,
            brandId,
            provider: connection.provider,
            externalOrderId,
            ...moneyAndStatus,
          },
          select: { id: true },
        });
        orderId = inserted.id;
        created = true;
      }

      // Line items are replaced wholesale ONLY from an authoritative FULL
      // snapshot. A PARTIAL fragment (a refund) carries no line set of the
      // order's own, so replacing from it would delete every stored line.
      const lineItemCount =
        order.completeness === "FULL"
          ? await writeLineItems(
              tx,
              orderId,
              connection.id,
              order.lineItems,
              resolved.expandProductKeyCandidates,
            )
          : 0;

      // Attribution is only ever attempted when a token was actually present,
      // and only when this order does not already hold one.
      let attributionLinked = existing?.attributionId != null;
      if (order.attributionToken && !attributionLinked) {
        const attributionId = await associateAttribution(tx, {
          token: order.attributionToken,
          orderId,
          brandId,
          connectionId: connection.id,
          provider: connection.provider,
          now,
          hashAttributionToken: resolved.hashAttributionToken,
        });
        if (attributionId) {
          await tx.commerceOrder.update({
            where: { id: orderId },
            data: { attributionId },
          });
          attributionLinked = true;
        }
      }

      return {
        status: created ? ("CREATED" as const) : ("UPDATED" as const),
        reason: null,
        orderId,
        lineItemCount,
        attributionLinked,
      };
    });

    const eventStatus: CommerceOrderEventStatus =
      result.status === "SKIPPED_STALE" ? "SKIPPED_STALE" : "PROCESSED";

    await finalizeEvent(eventId, { status: eventStatus, orderId: result.orderId }, now);

    return {
      status: result.status,
      reason: result.reason,
      eventId,
      orderId: result.orderId,
      lineItemCount: result.lineItemCount,
      attributionLinked: result.attributionLinked,
      brandIdOverriddenFromConnection,
    };
  } catch {
    // Deliberately does NOT include the error's message: a Prisma error can
    // embed column values from the payload, which would defeat this module's
    // no-PII guarantee. The classified tag plus the event row's
    // `payloadDigest` are enough to correlate a failure with a delivery.
    await finalizeEvent(
      eventId,
      { status: "FAILED", failureSummary: "WRITE_FAILED" },
      now,
    );
    return {
      ...base,
      status: "FAILED",
      reason: "WRITE_FAILED",
      eventId,
      brandIdOverriddenFromConnection,
    };
  }
}
