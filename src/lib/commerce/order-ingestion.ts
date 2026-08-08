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
 * NOT REACHABLE IN PRODUCTION TODAY
 * ===========================================================================
 * Nothing in production calls this module. SQRATCH's Shopify app holds
 * `read_products`, `read_discounts` and `write_discounts` — NOT `read_orders`
 * — and neither `shopify.app.toml` nor `shopify.app.custom.toml` subscribes to
 * any `orders/*` or `refunds/*` topic, so Shopify never sends an order
 * payload. The three route handlers that call this
 * (`src/app/api/shopify/webhooks/orders/create`, `.../orders/updated`,
 * `.../refunds/create`) are real, correct, and fixture-testable, but they can
 * only be exercised by a fixture. Turning them on is a separate, deliberately
 * reviewed rollout with scope-change and privacy-policy prerequisites,
 * documented in `docs/commerce/phase-7-order-normalization-summary.md`.
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
 * unique `(provider, providerEventId)`. Winning that INSERT is the claim on
 * the delivery; losing it (Prisma P2002) means another delivery of the same
 * provider event already claimed it, which is a successful no-op
 * (`ALREADY_PROCESSED`), never an error and never a second write to the order
 * table.
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
 * The consequence, stated plainly rather than hidden: a process that dies
 * between winning the claim and committing the order transaction leaves a
 * `RECEIVED` event row with no order, and a redelivery of that same provider
 * event id will be reported `ALREADY_PROCESSED` and will NOT retry the order
 * write. `CommerceOrderEvent.status = RECEIVED` with a null `processedAt` and
 * a null `orderId` is precisely the query that finds these, and re-driving
 * them is an operational task, not something this module should paper over by
 * weakening the dedup guarantee.
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
 * MONEY
 * ===========================================================================
 * All amounts arrive already converted to minor units as `bigint`. Conversion
 * itself is the normalizer's job and uses `getCurrencyExponent` /
 * `decimalStringToMinorUnits` from `./money.ts` — the SIGN-AWARE converter,
 * never `providerPriceStringToMinorUnits`, which rejects negatives by design
 * and would wrongly reject a refund, discount, or adjustment amount.
 *
 * `totalMinor` is the provider's own reported total, persisted verbatim. It is
 * never derived by summing converted line items: `decimalStringToMinorUnits`
 * truncates rather than rounds, so a sum of per-line conversions can
 * legitimately disagree with the provider's total by a few minor units, and
 * asserting equality would reject perfectly valid orders.
 *
 * `netRevenueMinor` is the one derived column: `totalMinor -
 * totalRefundedMinor`, computed at write time, and null whenever `totalMinor`
 * is null (an unknown total cannot produce a known net).
 *
 * KNOWN LIMITATION (see the schema comment too): the columns are `BigInt`, but
 * `decimalStringToMinorUnits` still enforces the int4 range because it was
 * written for the `Int` catalog columns. Today a single amount above roughly
 * $21.4M-equivalent is rejected by the converter with `OUT_OF_RANGE`, which
 * nulls that one field and never fails the order.
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
  | "WRITE_FAILED";

/**
 * Everything a caller may log. Contains ids, counts, enum-like tags and
 * booleans only — no payload content, no provider error body, no PII.
 */
export type OrderIngestionOutcome = {
  status: OrderIngestionStatus;
  reason: OrderIngestionReason | null;
  /** `CommerceOrderEvent.id`, or null when the claim was lost to a duplicate. */
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

export type OrderEventClaim =
  | { claimed: true; eventId: string }
  | { claimed: false };

export type OrderIngestionDeps = {
  /**
   * Atomically claims the delivery by inserting the `CommerceOrderEvent` row.
   * Returns `{claimed:false}` on a P2002 against
   * `(provider, providerEventId)` — a duplicate delivery, which is a
   * successful no-op. Any other error propagates.
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
    return { claimed: true, eventId: created.id };
  } catch (error) {
    if (isUniqueViolation(error)) {
      // A previous process may have died after claiming the delivery but before
      // committing the order transaction. The event body is intentionally not
      // stored, so a provider retry is the only safe re-drive source. Reclaim
      // terminal failed events and stale RECEIVED leases; never reclaim a
      // processed/skipped delivery.
      const { default: prisma } = await import("@/lib/prisma");
      const existing = await prisma.commerceOrderEvent.findUnique({
        where: { provider_providerEventId: { provider: input.provider, providerEventId: input.providerEventId } },
        select: { id: true, status: true, receivedAt: true },
      });
      const staleLease = existing?.status === "RECEIVED" &&
        Date.now() - existing.receivedAt.getTime() > 60_000;
      if (existing && (existing.status === "FAILED" || staleLease)) {
        const reclaimed = await prisma.commerceOrderEvent.updateMany({
          where: { id: existing.id, status: existing.status },
          data: { status: "RECEIVED", processedAt: null, failureSummary: null },
        });
        if (reclaimed.count === 1) return { claimed: true, eventId: existing.id };
      }
      return { claimed: false };
    }
    throw error;
  }
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
  runTransaction: defaultRunTransaction,
  hashAttributionToken: hashClickToken,
  now: () => new Date(),
};

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
 * here would turn a successful ingestion into a caller-visible error (and, for
 * a webhook caller, a provider retry of work that is already done). The row
 * simply stays `RECEIVED`, which is the same recoverable state described in
 * the IDEMPOTENCY section of this file's header.
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
 * IN PRODUCTION TODAY THIS PATH NEVER FIRES. Phase 6's transport audit found
 * that no Shopify storefront-to-order path carries the `ref` query parameter
 * into an order payload: the token is appended to the merchant product URL,
 * and nothing in Shopify's cart/checkout/order pipeline captures a storefront
 * query parameter into `note_attributes` or any other order field without a
 * theme or checkout extension SQRATCH does not ship. This logic exists so that
 * it is CORRECT when fixture-tested and when a real transport is eventually
 * built — NOT because live traffic reaches it.
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
      brandId: true,
      commerceConnectionId: true,
      expiresAt: true,
      consumedAt: true,
      consumedByOrderRef: true,
    },
  });

  if (!attribution) {
    return null;
  }

  // A bearer token is evidence only for the brand that minted the click. A
  // non-null connection narrows that proof to one merchant connection too.
  // Never let a token observed in a different shop's payload cross that
  // boundary, even if a future transport accidentally propagates it.
  if (
    attribution.brandId !== params.brandId ||
    (attribution.commerceConnectionId !== null &&
      attribution.commerceConnectionId !== params.connectionId)
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
        .flatMap((item) => providerProductKeyCandidates(item.externalProductId))
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
    for (const candidate of providerProductKeyCandidates(externalProductId)) {
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
 * PURE. `ConnectedCommerceProduct.externalKey` stores whatever id form the
 * provider's CATALOG adapter emitted (for Shopify, a GraphQL global id such as
 * `gid://shopify/Product/123`), whereas an order WEBHOOK payload reports the
 * same product as a bare numeric REST id (`123`). Matching therefore tries
 * both forms rather than assuming either. A non-numeric, non-gid value is
 * returned as-is so other providers still match.
 */
export function providerProductKeyCandidates(
  externalProductId: string | null,
): string[] {
  const raw = externalProductId?.trim();
  if (!raw) {
    return [];
  }
  if (/^\d+$/.test(raw)) {
    return [raw, `gid://shopify/Product/${raw}`];
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
 *   1. Claim the delivery (`CommerceOrderEvent` insert). Lost claim ->
 *      `ALREADY_PROCESSED`, order table untouched.
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
 * Never throws for an expected condition (duplicate, disconnected, stale,
 * missing id) — each is a typed outcome. A genuine DB failure inside the
 * transaction is caught, recorded on the event as `FAILED`/`WRITE_FAILED`, and
 * returned as a `FAILED` outcome rather than propagated, so a webhook caller
 * can still answer 200 and avoid a provider retry storm; the event row is the
 * durable record that the delivery arrived and did not apply.
 */
export async function ingestNormalizedOrder(
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

  if (!claim.claimed) {
    return { ...base, status: "ALREADY_PROCESSED", reason: "DUPLICATE_DELIVERY" };
  }

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
        await tx.commerceOrder.update({
          where: { id: existing.id },
          data: moneyAndStatus,
        });
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
          ? await writeLineItems(tx, orderId, connection.id, order.lineItems)
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
