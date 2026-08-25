/**
 * src/lib/commerce/providers/commerce7-order-normalizer.ts
 *
 * PHASE 16 BIG ROUND / SUBPHASE 4 — pure normalization of a raw Commerce7
 * Order object (from `GET /order/{id}` or an authenticated order webhook's
 * `payload`) into the provider-neutral `NormalizedOrderInput` contract
 * (`../order-ingestion.ts`). No I/O, no side effects, fully unit-testable.
 *
 * FIELD REFERENCE (verified against developer.commerce7.com/docs/orders.md
 * — every field below is quoted from that documentation, not guessed):
 *   Identifiers/dates: id, orderNumber, createdAt, updatedAt.
 *   Financial (all `number`, integer CENTS — Commerce7's documented
 *   convention, the SAME one `../providers/commerce7-products.ts` already
 *   relies on for variant prices): subTotal, shipTotal, taxTotal, total,
 *   totalAfterTip.
 *   Status: paymentStatus ("Paid" | "Authorized" | "Cancelled"),
 *   fulfillmentStatus ("Fulfilled" | "Not Fulfilled" | "Partially Fulfilled"
 *   | "No Fulfillment Required").
 *   Line items (`items[]`): id, productId, productVariantId, productTitle,
 *   sku, quantity, price (per-unit, cents), tax (per-line, cents).
 *
 * DOCUMENTED ABSENCES — deliberately NOT invented:
 *   - NO currency/currencyCode field anywhere on the Order object. Currency
 *     comes exclusively from the CALLER-supplied connection currency (see
 *     `Commerce7OrderNormalizationContext.currencyCode`, sourced from
 *     `CommerceConnectionSummary.currencyCode` — the same merchant-confirmed
 *     value Subphase 1 introduced). When it is unknown, every money field
 *     normalizes to `null` rather than assuming a currency.
 *   - NO cancellation timestamp/reason field (no `cancelled`, `isCancelled`,
 *     or `cancelReason`). `cancelledAt`/`cancelReason` are therefore ALWAYS
 *     `null` here — the only cancellation signal Commerce7 exposes is
 *     `paymentStatus: "Cancelled"`, which this file maps to
 *     `CommerceOrderFinancialStatus.VOIDED` (the closest existing semantic:
 *     a payment that was never captured/settled — there is no dedicated
 *     "Cancelled" value in the canonical enum).
 *   - NO aggregate order-level discount total field. `discountsMinor` is
 *     therefore always `null` — summing `coupons`/`promotions` array
 *     entries would require guessing their shape, which this phase
 *     explicitly refuses to do.
 *   - NO per-line discount field. `discountMinor` is therefore always
 *     `null` per line item — `originalPrice`/`isPriceOverride` describe a
 *     price OVERRIDE, not a promotional discount, and conflating the two
 *     would misrepresent what actually happened to the price.
 *   - NO per-line total field. `totalMinor` is derived by PURE ARITHMETIC
 *     from two directly-documented fields (`price * quantity`) — this is
 *     not a guess about undocumented provider semantics, just multiplying
 *     numbers Commerce7 already gave us.
 *   - `previousOrderId` / `previousOrderNumber` / `linkedOrders` exist on
 *     the Order object but Commerce7's documentation gives NO semantic
 *     explanation of what creates them or what relationship they encode
 *     (re-verified directly against developer.commerce7.com/docs/orders.md
 *     during the PHASE 16/17 REPAIR round — confirmed undocumented, not
 *     merely unread). This file therefore NEVER reads them and NEVER
 *     merges/links separate Commerce7 order ids into one canonical order —
 *     each Commerce7 order id maps to exactly one independent `CommerceOrder`
 *     row, preserving provider order identity per this round's explicit
 *     instruction. `purchaseType` (with values including "Refund"/
 *     "Exchange") was re-verified to exist on Commerce7's CART object, NOT
 *     the Order object — it is not read here for the same reason.
 *
 * REFUND EVIDENCE — PHASE 16/17 REPAIR (was incorrectly documented as
 * absent in the original Big Round; corrected here after an independent
 * review re-checked `orders.md`'s `tenders[]` sub-object fields directly):
 *   The Order object's `tenders[]` array documents `chargeType` (enum:
 *   `Sale`, `PreAuth`, `Cancel`, `Refund`) and `chargeStatus` (enum:
 *   `Pending`, `Failed`, `Success`, `Waiting`, `Cancelled`) per tender, plus
 *   `amountTendered`. `totalRefundedMinor` is derived by summing
 *   `amountTendered` across every tender with `chargeType === "Refund" AND
 *   chargeStatus === "Success"` — see `computeCommerce7RefundedMinor`
 *   below. Failed/Cancelled/Pending/Waiting refund tenders are deliberately
 *   EXCLUDED (never counted as completed money movement). PHASE 18 REPAIR
 *   (P2-4C): deduplicated on `tender.id` (a repeated identical tender
 *   object is counted once), deliberately NOT on `refundId` — Commerce7 can
 *   split one logical refund across multiple tenders sharing a `refundId`
 *   but each carrying their own `id` and `amountTendered`, so collapsing by
 *   `refundId` would silently drop real refunded money.
 *
 *   SIGN OF `amountTendered` IS NOT DOCUMENTED. developer.commerce7.com
 *   gives no example Refund tender and no statement of whether the value is
 *   positive or negative for a refund. Rather than guess, this file sums
 *   the ABSOLUTE VALUE of each qualifying tender's `amountTendered` — this
 *   derives the tender's own reported MAGNITUDE (never a fabricated
 *   number), which is correct regardless of which sign convention Commerce7
 *   actually uses.
 *
 *   `tenders` MISSING or not an array -> `totalRefundedMinor: null`
 *   ("this event says nothing about refunds", per `NormalizedOrderInput`'s
 *   own contract — any previously stored value is preserved). `tenders`
 *   present as an array (including EMPTY) -> a real, non-null total is
 *   computed (0 when no qualifying Refund/Success tender exists) — an empty
 *   or refund-free tender list IS complete, authoritative evidence that
 *   nothing has been refunded, not an absence of information.
 *
 *   `financialStatus` is refined using this same refund evidence: a
 *   `paymentStatus: "Paid"` order with `totalRefundedMinor > 0` becomes
 *   `REFUNDED` (refunded >= total) or `PARTIALLY_REFUNDED` (partial),
 *   matching the canonical `CommerceOrderFinancialStatus` enum's existing
 *   values — no new enum value invented. `Authorized`/`Cancelled` orders
 *   are NOT refund-refined (no documented, well-understood refund-on-
 *   authorized-order path exists to reason about safely).
 */

import type { CommerceProvider } from "@prisma/client";
import type {
  CommerceOrderFinancialStatus,
  CommerceOrderFulfillmentStatus,
} from "@prisma/client";
import type {
  NormalizedOrderInput,
  NormalizedOrderLineItemInput,
} from "../order-ingestion";

/** Commerce7's documented, fixed minor-unit exponent — see the file header. */
const COMMERCE7_MINOR_UNIT_EXPONENT = 2;

function readTrimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Converts a Commerce7 integer-cents `number` to `bigint` minor units.
 * `Number.isSafeInteger`, not merely `Number.isInteger` — see the identical
 * reasoning in `commerce7-products.ts`'s price handling. Sign is preserved
 * (never special-cased), matching the order-domain's sign-aware BigInt
 * convention (`decimalStringToBigIntMinorUnits` in `../money.ts`) — a
 * legitimate negative line (e.g. a price override reducing revenue) must
 * not be coerced to zero or rejected outright.
 */
function centsToBigIntMinorUnits(value: unknown): bigint | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return null;
  }
  return BigInt(value);
}

const PAYMENT_STATUS_MAP: Record<string, CommerceOrderFinancialStatus> = {
  Paid: "PAID",
  Authorized: "AUTHORIZED",
  // No dedicated "Cancelled" value exists in the canonical enum — VOIDED is
  // the closest fit: a payment that was never captured/settled. See file header.
  Cancelled: "VOIDED",
};

const FULFILLMENT_STATUS_MAP: Record<string, CommerceOrderFulfillmentStatus | null> = {
  Fulfilled: "FULFILLED",
  "Not Fulfilled": "UNFULFILLED",
  "Partially Fulfilled": "PARTIALLY_FULFILLED",
  // "No Fulfillment Required" has no direct match. Mapping it to FULFILLED
  // would misrepresent "nothing to fulfill" as "physically fulfilled", so it
  // maps to null (unknown/not-applicable) instead — see file header.
  "No Fulfillment Required": null,
};

function mapFinancialStatus(raw: unknown): CommerceOrderFinancialStatus | null {
  const value = readTrimmed(raw);
  return value ? (PAYMENT_STATUS_MAP[value] ?? null) : null;
}

function mapFulfillmentStatus(raw: unknown): CommerceOrderFulfillmentStatus | null {
  const value = readTrimmed(raw);
  if (value === null) {
    return null;
  }
  return value in FULFILLMENT_STATUS_MAP ? FULFILLMENT_STATUS_MAP[value] : null;
}

/**
 * PHASE 16/17 REPAIR — sums the ABSOLUTE VALUE of `amountTendered` across
 * every tender with `chargeType === "Refund" AND chargeStatus === "Success"`.
 * See the file header's REFUND EVIDENCE section for why magnitude (not the
 * raw signed value) is used, and why Failed/Cancelled/Pending/Waiting
 * tenders are excluded.
 *
 * Returns `null` when `tenders` is missing/malformed (no information —
 * preserve any stored value) or currency is unknown (never attach an
 * amount to an unknown currency). Returns a real number — including `0` —
 * whenever `tenders` is present as an array, since an empty or
 * refund-free list is itself complete evidence that nothing was refunded.
 */
function computeCommerce7RefundedMinor(
  rawTenders: unknown,
  hasCurrency: boolean,
): bigint | null {
  if (!hasCurrency || !Array.isArray(rawTenders)) {
    return null;
  }

  // PHASE 18 REPAIR (P2-4C): `tender.id` is the documented, stable identity
  // of one tender — deduplicated on it so a payload that (legitimately or
  // due to a provider/transport quirk) repeats the SAME tender object twice
  // is never double-counted. Deliberately NOT deduplicated by `refundId`:
  // Commerce7 can split one logical refund across multiple tenders that
  // share a `refundId` but each have their OWN `id` and their OWN
  // `amountTendered` — collapsing by `refundId` would silently drop real
  // money from a split refund. A tender with no `id` at all is NOT
  // fabricated an identity (never guess a key from mutable fields like
  // `amountTendered`) — it is simply never deduplicated against anything,
  // so it always contributes its own amount once.
  const seenTenderIds = new Set<string>();
  let total = BigInt(0);
  for (const entry of rawTenders) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (readTrimmed(record.chargeType) !== "Refund") {
      continue;
    }
    if (readTrimmed(record.chargeStatus) !== "Success") {
      continue;
    }
    const tenderId = readTrimmed(record.id);
    if (tenderId !== null) {
      if (seenTenderIds.has(tenderId)) {
        continue;
      }
      seenTenderIds.add(tenderId);
    }
    const amount = centsToBigIntMinorUnits(record.amountTendered);
    if (amount === null) {
      continue;
    }
    total += amount < BigInt(0) ? -amount : amount;
  }

  return total;
}

/**
 * Refines a `paymentStatus`-derived financial status using refund evidence.
 * Only ever moves `PAID` -> `PARTIALLY_REFUNDED`/`REFUNDED` — every other
 * base status (AUTHORIZED, VOIDED, or an unrecognized/null status) passes
 * through unchanged, since no documented, well-understood refund-on-that-
 * state path exists to reason about safely (see file header).
 */
function refineFinancialStatusForRefunds(
  baseStatus: CommerceOrderFinancialStatus | null,
  totalMinor: bigint | null,
  totalRefundedMinor: bigint | null,
): CommerceOrderFinancialStatus | null {
  if (baseStatus !== "PAID") {
    return baseStatus;
  }
  if (totalMinor === null || totalRefundedMinor === null || totalRefundedMinor <= BigInt(0)) {
    return baseStatus;
  }
  return totalRefundedMinor >= totalMinor ? "REFUNDED" : "PARTIALLY_REFUNDED";
}

function readLineItems(
  raw: unknown,
  hasCurrency: boolean,
): NormalizedOrderLineItemInput[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter(
      (entry): entry is Record<string, unknown> =>
        Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
    )
    .map((item) => {
      const rawQuantity = item.quantity;
      const quantity =
        typeof rawQuantity === "number" && Number.isFinite(rawQuantity)
          ? Math.trunc(rawQuantity)
          : 0;

      // Money is deferred to null exactly like the order-level fields when
      // the connection's currency is unknown — see `hasCurrency` in the
      // caller. Never attach a minor-unit amount to an unknown currency.
      const unitPriceMinor = hasCurrency ? centsToBigIntMinorUnits(item.price) : null;
      const taxMinor = hasCurrency ? centsToBigIntMinorUnits(item.tax) : null;
      // Pure arithmetic on two already-documented fields — see file header.
      const totalMinor =
        unitPriceMinor !== null ? unitPriceMinor * BigInt(quantity) : null;

      return {
        externalLineItemId: readTrimmed(item.id),
        externalProductId: readTrimmed(item.productId),
        externalVariantId: readTrimmed(item.productVariantId),
        title: readTrimmed(item.productTitle),
        sku: readTrimmed(item.sku),
        quantity,
        unitPriceMinor,
        // No documented per-line discount field — see file header.
        discountMinor: null,
        taxMinor,
        totalMinor,
      };
    });
}

export type Commerce7OrderNormalizationContext = {
  connectionId: string;
  brandId: string;
  provider: CommerceProvider;
  /**
   * The connection's merchant-confirmed currency
   * (`CommerceConnectionSummary.currencyCode`), or `null` when not yet
   * configured. Every money field normalizes to `null` when this is `null`
   * — currency is NEVER inferred from the order payload, which documents no
   * currency field of its own.
   */
   currencyCode: string | null;
};

export type Commerce7OrderNormalizationResult = {
  order: NormalizedOrderInput;
  warnings: string[];
};

/**
 * Normalizes one raw Commerce7 Order object. `GET /order/{id}` (and, per
 * the generic webhook payload shape, an order webhook's `payload` field)
 * both return a COMPLETE order snapshot, never a fragment — so
 * `completeness` is always `"FULL"`, unlike Shopify's `refunds/create`
 * fragment topic.
 */
export function normalizeCommerce7Order(
  raw: unknown,
  context: Commerce7OrderNormalizationContext,
): Commerce7OrderNormalizationResult {
  const warnings: string[] = [];

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    warnings.push("MALFORMED_PAYLOAD");
    return {
      order: emptyOrder(context),
      warnings,
    };
  }

  const record = raw as Record<string, unknown>;
  const externalOrderId = readTrimmed(record.id);
  if (!externalOrderId) {
    warnings.push("MISSING_EXTERNAL_ORDER_ID");
  }

  const hasCurrency = Boolean(context.currencyCode);
  if (!hasCurrency) {
    warnings.push("UNKNOWN_CONNECTION_CURRENCY");
  }

  const orderNumberRaw = record.orderNumber;
  const orderNumber =
    typeof orderNumberRaw === "number" && Number.isFinite(orderNumberRaw)
      ? String(Math.trunc(orderNumberRaw))
      : readTrimmed(orderNumberRaw);

  const totalMinor = hasCurrency ? centsToBigIntMinorUnits(record.total) : null;
  const totalRefundedMinor = computeCommerce7RefundedMinor(record.tenders, hasCurrency);
  const baseFinancialStatus = mapFinancialStatus(record.paymentStatus);
  const financialStatus = refineFinancialStatusForRefunds(
    baseFinancialStatus,
    totalMinor,
    totalRefundedMinor,
  );

  const order: NormalizedOrderInput = {
    connectionId: context.connectionId,
    brandId: context.brandId,
    provider: context.provider,
    completeness: "FULL",

    externalOrderId,
    orderNumber,

    currencyCode: context.currencyCode,
    minorUnitExponent: hasCurrency ? COMMERCE7_MINOR_UNIT_EXPONENT : null,

    subtotalMinor: hasCurrency ? centsToBigIntMinorUnits(record.subTotal) : null,
    // No documented aggregate order-level discount field — see file header.
    discountsMinor: null,
    shippingMinor: hasCurrency ? centsToBigIntMinorUnits(record.shipTotal) : null,
    taxMinor: hasCurrency ? centsToBigIntMinorUnits(record.taxTotal) : null,
    totalMinor,
    totalRefundedMinor,

    financialStatus,
    fulfillmentStatus: mapFulfillmentStatus(record.fulfillmentStatus),
    // No documented cancellation field — see file header.
    cancelledAt: null,
    cancelReason: null,

    providerCreatedAt: readDate(record.createdAt),
    providerUpdatedAt: readDate(record.updatedAt),

    lineItems: readLineItems(record.items, hasCurrency),

    // Commerce7's Order object documents no click-token-carrying field.
    // Attribution is explicitly fail-closed for this round regardless (see
    // the order-webhook route) — this stays null unconditionally.
    attributionToken: null,
  };

  return { order, warnings };
}

function emptyOrder(context: Commerce7OrderNormalizationContext): NormalizedOrderInput {
  return {
    connectionId: context.connectionId,
    brandId: context.brandId,
    provider: context.provider,
    completeness: "FULL",
    externalOrderId: null,
    orderNumber: null,
    currencyCode: null,
    minorUnitExponent: null,
    subtotalMinor: null,
    discountsMinor: null,
    shippingMinor: null,
    taxMinor: null,
    totalMinor: null,
    totalRefundedMinor: null,
    financialStatus: null,
    fulfillmentStatus: null,
    cancelledAt: null,
    cancelReason: null,
    providerCreatedAt: null,
    providerUpdatedAt: null,
    lineItems: [],
    attributionToken: null,
  };
}
