/**
 * src/lib/commerce/providers/shopify-order-normalizer.ts
 *
 * PURE Shopify order-payload normalizer. No I/O, no Prisma, no network, no
 * clock. It takes a parsed Shopify webhook body (typed `unknown` and narrowed
 * defensively) plus `{connectionId, brandId}` and produces the
 * provider-neutral `NormalizedOrderInput` consumed by
 * `../order-ingestion.ts`.
 *
 * ===========================================================================
 * NOT REACHABLE IN PRODUCTION TODAY
 * ===========================================================================
 * SQRATCH's Shopify app does not hold `read_orders`, and neither
 * `shopify.app.toml` nor `shopify.app.custom.toml` subscribes to an `orders/*`
 * or `refunds/*` topic, so no real Shopify order payload ever reaches this
 * module. It is written against Shopify Admin API `2026-04`
 * (`SHOPIFY_API_VERSION` in `src/lib/shopify.ts` is the single source of truth)
 * and is exercised only by fixtures. Rollout steps live in
 * `docs/commerce/phase-7-order-normalization-summary.md`.
 *
 * ===========================================================================
 * NO CUSTOMER PII — ACTIVELY SKIPPED, NOT MERELY OMITTED
 * ===========================================================================
 * The output type has no field that could hold one, and this module never
 * reads `customer`, `billing_address`, `shipping_address`, `email`,
 * `contact_email`, `phone`, `customer_locale`, `browser_ip`, or
 * `client_details` — see `SHOPIFY_ORDER_PII_KEYS` below, which exists so a
 * test can assert the exclusion rather than trusting a reviewer's eye. Order
 * numbers and provider ids are retained: they are merchant-facing commerce
 * identifiers, not personal data.
 *
 * ===========================================================================
 * TOTALITY
 * ===========================================================================
 * Nothing here throws for bad input. Every field access is guarded, every
 * parse degrades to `null`, and a malformed line item is skipped rather than
 * failing the order. Warnings are returned as a short, closed set of tags —
 * never payload excerpts.
 *
 * ===========================================================================
 * MONEY: TWO SHOPIFY SHAPES, BOTH HANDLED
 * ===========================================================================
 * Shopify represents money either as a bare decimal STRING (`"19.99"` — the
 * long-standing REST shape for `total_price`, `subtotal_price`, `total_tax`,
 * `total_discounts`, line-item `price`), or as a MoneyBag object
 * (`{ shop_money: { amount, currency_code }, presentment_money: {...} }` — the
 * `*_set` fields such as `total_shipping_price_set`, and increasingly the
 * primary shape in newer versions). Because there is no live payload to verify
 * against, `readMoneyAmount` handles BOTH, plus a bare JSON number, and
 * returns `null` for anything else.
 *
 * When a MoneyBag is present, `shop_money` is preferred over
 * `presentment_money`: `shop_money` is denominated in the shop's own currency,
 * which is what `order.currency` names and therefore what
 * `minorUnitExponent` is resolved from. Mixing a presentment amount with a
 * shop currency code would produce a number that is wrong by an exchange rate,
 * silently.
 *
 * Every conversion uses `decimalStringToMinorUnits` (SIGN-AWARE) from
 * `../money.ts` — never `providerPriceStringToMinorUnits`, which rejects
 * negatives by design and would wrongly reject a refund, discount, or
 * adjustment. A conversion failure nulls that ONE field and never fails the
 * order.
 *
 * ===========================================================================
 * FULL vs PARTIAL SNAPSHOTS
 * ===========================================================================
 * `orders/create` and `orders/updated` carry a COMPLETE order object, so their
 * normalized output is `completeness: "FULL"` and every field is authoritative
 * — including nulls (a `cancelled_at` of null genuinely means "not
 * cancelled").
 *
 * `refunds/create` carries a single Refund resource, NOT the order, so its
 * output is `completeness: "PARTIAL"`: only non-null fields are applied by the
 * ingestion service and everything else on the stored order is preserved. See
 * the refund note on `normalizeShopifyRefundPayload` for why a partial refund
 * payload deliberately does NOT try to synthesize a cumulative refund total.
 */

import crypto from "node:crypto";
import { CommerceProvider } from "@prisma/client";
import type {
  CommerceOrderFinancialStatus,
  CommerceOrderFulfillmentStatus,
} from "@prisma/client";
import { decimalStringToMinorUnits, getCurrencyExponent } from "../money";
import { CLICK_TOKEN_QUERY_PARAM, isValidClickToken } from "../click-token";
import type {
  NormalizedOrderInput,
  NormalizedOrderLineItemInput,
} from "../order-ingestion";

/**
 * Payload keys this module must NEVER read. Exported so a test can assert the
 * exclusion mechanically instead of relying on code review.
 */
export const SHOPIFY_ORDER_PII_KEYS: readonly string[] = [
  "customer",
  "billing_address",
  "shipping_address",
  "email",
  "contact_email",
  "phone",
  "customer_locale",
  "browser_ip",
  "client_details",
] as const;

/** Closed set of normalization warnings. Never contains payload content. */
export type ShopifyOrderNormalizationWarning =
  | "PAYLOAD_NOT_AN_OBJECT"
  | "MISSING_ORDER_ID"
  | "MISSING_CURRENCY"
  | "UNRECOGNIZED_FINANCIAL_STATUS"
  | "UNRECOGNIZED_FULFILLMENT_STATUS"
  | "UNPARSEABLE_MONEY_FIELD"
  | "SKIPPED_MALFORMED_LINE_ITEM"
  | "REFUND_CUMULATIVE_UNAVAILABLE";

export type ShopifyOrderNormalizationResult = {
  order: NormalizedOrderInput;
  warnings: ShopifyOrderNormalizationWarning[];
};

export type ShopifyOrderNormalizationContext = {
  connectionId: string;
  brandId: string;
};

// ---------------------------------------------------------------------------
// Defensive readers
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Provider ids arrive as numbers or strings depending on field and version. */
function readIdString(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function readText(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** ISO-8601 with offset, per Shopify. Anything unparseable becomes null. */
function readDate(value: unknown): Date | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  const parsed = new Date(trimmed);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Extracts a decimal money STRING from either Shopify money shape. See the
 * MONEY section of this file's header for why `shop_money` wins.
 */
export function readMoneyAmount(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : null;
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  // MoneyBag: prefer shop_money, fall back to presentment_money only when the
  // shop side is genuinely absent.
  const shopMoney = asRecord(record.shop_money);
  if (shopMoney) {
    return readMoneyAmount(shopMoney.amount);
  }
  const presentmentMoney = asRecord(record.presentment_money);
  if (presentmentMoney) {
    return readMoneyAmount(presentmentMoney.amount);
  }
  // Bare Money object: { amount, currency_code }.
  if ("amount" in record) {
    return readMoneyAmount(record.amount);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status mapping
// ---------------------------------------------------------------------------

/**
 * PURE. Maps Shopify `financial_status` onto the neutral enum. Anything
 * unrecognized — including Shopify's `expired`, which has no neutral
 * equivalent and must NOT be guessed into `VOIDED` — maps to `null`. Never
 * throws.
 */
export function mapShopifyFinancialStatus(
  value: unknown,
): CommerceOrderFinancialStatus | null {
  const raw = readText(value)?.toLowerCase();
  switch (raw) {
    case "pending":
      return "PENDING";
    case "authorized":
      return "AUTHORIZED";
    case "partially_paid":
      return "PARTIALLY_PAID";
    case "paid":
      return "PAID";
    case "partially_refunded":
      return "PARTIALLY_REFUNDED";
    case "refunded":
      return "REFUNDED";
    case "voided":
      return "VOIDED";
    default:
      // Covers `expired`, `null`, and any value a future API version adds.
      return null;
  }
}

/**
 * PURE. Maps Shopify `fulfillment_status` onto the neutral enum.
 *
 * Shopify reports an UNFULFILLED order as JSON `null`, not as the string
 * "unfulfilled". That absence is mapped to `UNFULFILLED` only when the caller
 * says the payload is a full order snapshot (`treatNullAsUnfulfilled`); on a
 * partial fragment the same `null` means "this event says nothing about
 * fulfillment" and must stay `null` so the stored value is preserved.
 */
export function mapShopifyFulfillmentStatus(
  value: unknown,
  treatNullAsUnfulfilled: boolean,
): CommerceOrderFulfillmentStatus | null {
  const text = readText(value);
  if (text === null) {
    return treatNullAsUnfulfilled ? "UNFULFILLED" : null;
  }
  switch (text.toLowerCase()) {
    case "fulfilled":
      return "FULFILLED";
    case "partial":
    case "partially_fulfilled":
      return "PARTIALLY_FULFILLED";
    case "restocked":
      return "RESTOCKED";
    case "unfulfilled":
      return "UNFULFILLED";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Attribution token extraction
// ---------------------------------------------------------------------------

/**
 * Pulls a click token out of the payload if one is present, WITHOUT treating
 * it as authoritative — validation and lookup happen in
 * `../order-ingestion.ts`, which hashes it and requires an exact stored match.
 * Only the token's FORMAT is screened here (43 base64url chars), purely to
 * avoid handing obvious junk downstream; passing that screen proves nothing.
 *
 * Sources checked, in order of how durable each would be if a transport ever
 * existed:
 *   1. `note_attributes[]` / `attributes[]` — `{name, value}` pairs. The only
 *      place a merchant-side integration could durably persist a value onto
 *      an order.
 *   2. `landing_site` — the first storefront URL of the session, as a query
 *      parameter.
 *   3. `referring_site` — the referrer, as a query parameter.
 *
 * PHASE 6'S FINDING STANDS: no Shopify storefront-to-order path populates any
 * of these from a product-URL query parameter today without a theme or
 * checkout extension SQRATCH does not ship. This extractor exists so the
 * behavior is correct under fixtures and if a transport is later built. It
 * must never be described as live attribution.
 */
export function extractShopifyAttributionToken(payload: unknown): string | null {
  const order = asRecord(payload);
  if (!order) {
    return null;
  }

  const attributePairs = [
    ...asArray(order.note_attributes),
    ...asArray(order.attributes),
    ...asArray(order.cart_attributes),
  ];

  for (const entry of attributePairs) {
    const pair = asRecord(entry);
    if (!pair) {
      continue;
    }
    const name = readText(pair.name) ?? readText(pair.key);
    if (name?.toLowerCase() !== CLICK_TOKEN_QUERY_PARAM) {
      continue;
    }
    const candidate = readText(pair.value);
    if (candidate && isValidClickToken(candidate)) {
      return candidate;
    }
  }

  for (const urlish of [order.landing_site, order.referring_site]) {
    const candidate = readTokenFromUrlish(readText(urlish));
    if (candidate) {
      return candidate;
    }
  }

  return null;
}

/**
 * `landing_site` is often a PATH with a query (`/products/x?ref=...`), not an
 * absolute URL, so it is resolved against a throwaway base rather than parsed
 * as absolute. The base is never used for anything but parsing.
 */
function readTokenFromUrlish(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value, "https://shopify-order-normalizer.invalid");
    const candidate = url.searchParams.get(CLICK_TOKEN_QUERY_PARAM);
    return candidate && isValidClickToken(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

/**
 * SHA-256 hex digest of the RAW, HMAC-verified body. The caller passes the
 * exact bytes it verified — this function never re-serializes the parsed
 * object, because `JSON.stringify(JSON.parse(x))` is not byte-identical to `x`
 * and the digest must describe what was actually authenticated.
 */
export function computeShopifyPayloadDigest(rawBody: string): string {
  return crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// Line items
// ---------------------------------------------------------------------------

function normalizeLineItems(
  rawLineItems: unknown,
  exponent: number,
  warnings: ShopifyOrderNormalizationWarning[],
): NormalizedOrderLineItemInput[] {
  const out: NormalizedOrderLineItemInput[] = [];

  for (const entry of asArray(rawLineItems)) {
    const item = asRecord(entry);
    if (!item) {
      warnings.push("SKIPPED_MALFORMED_LINE_ITEM");
      continue;
    }

    const rawQuantity = item.quantity;
    const quantity =
      typeof rawQuantity === "number" && Number.isInteger(rawQuantity)
        ? rawQuantity
        : typeof rawQuantity === "string" && /^\d+$/.test(rawQuantity.trim())
          ? Number(rawQuantity.trim())
          : null;

    // `quantity` is the one REQUIRED column on the line-item model, so an
    // item without a usable one is skipped rather than defaulted to 1 (which
    // would invent revenue that the provider never reported).
    if (quantity === null || !Number.isSafeInteger(quantity) || quantity < 0) {
      warnings.push("SKIPPED_MALFORMED_LINE_ITEM");
      continue;
    }

    const unitPriceMinor = toMinor(
      readMoneyAmount(item.price_set ?? item.price),
      exponent,
    );
    const discountMinor = toMinor(
      readMoneyAmount(item.total_discount_set ?? item.total_discount),
      exponent,
    );
    const taxMinor = sumTaxLines(item.tax_lines, exponent);

    // A LINE total is derived (unit * qty - discount) because Shopify does not
    // report one. This is explicitly NOT how the ORDER total is obtained —
    // that is always the provider's own `total_price`, never a sum of lines.
    const totalMinor =
      unitPriceMinor === null
        ? null
        : unitPriceMinor * BigInt(quantity) - (discountMinor ?? BigInt(0));

    out.push({
      externalLineItemId: readIdString(item.id),
      externalProductId: readIdString(item.product_id),
      externalVariantId: readIdString(item.variant_id),
      title: readText(item.title),
      sku: readText(item.sku),
      quantity,
      unitPriceMinor,
      discountMinor,
      taxMinor,
      totalMinor,
    });
  }

  return out;
}

function sumTaxLines(value: unknown, exponent: number): bigint | null {
  const lines = asArray(value);
  if (lines.length === 0) {
    return null;
  }
  let total: bigint | null = null;
  for (const entry of lines) {
    const line = asRecord(entry);
    if (!line) {
      continue;
    }
    const amount = toMinor(readMoneyAmount(line.price_set ?? line.price), exponent);
    if (amount !== null) {
      total = (total ?? BigInt(0)) + amount;
    }
  }
  return total;
}

/**
 * Converts one decimal money string to minor units, or `null`. Uses the
 * sign-aware converter so negative amounts (refunds, discounts, adjustments)
 * survive. Failure nulls one field only — never the order.
 */
function toMinor(raw: string | null, exponent: number): bigint | null {
  if (raw === null) {
    return null;
  }
  const parsed = decimalStringToMinorUnits(raw, exponent);
  return parsed.ok ? BigInt(parsed.minorUnits) : null;
}

function toMinorTracked(
  raw: string | null,
  exponent: number,
  warnings: ShopifyOrderNormalizationWarning[],
): bigint | null {
  if (raw === null) {
    return null;
  }
  const parsed = decimalStringToMinorUnits(raw, exponent);
  if (!parsed.ok) {
    warnings.push("UNPARSEABLE_MONEY_FIELD");
    return null;
  }
  return BigInt(parsed.minorUnits);
}

// ---------------------------------------------------------------------------
// Cumulative refunds
// ---------------------------------------------------------------------------

/**
 * PURE. Derives the CUMULATIVE refunded amount for a FULL order payload.
 *
 * Preference order:
 *   1. `total_refunded_set` / `total_refunded` when the payload carries it —
 *      already a cumulative figure by definition.
 *   2. Otherwise the sum over `refunds[]` of each refund's
 *      `transactions[].amount`. An order payload carries ALL of its refunds,
 *      so this sum is cumulative, not incremental.
 *   3. `null` when neither is present — meaning "this payload says nothing
 *      about refunds", which the ingestion service treats as "preserve the
 *      stored value", never as zero.
 */
export function deriveCumulativeRefundMinor(
  order: Record<string, unknown>,
  exponent: number,
): bigint | null {
  const direct = readMoneyAmount(order.total_refunded_set ?? order.total_refunded);
  if (direct !== null) {
    return toMinor(direct, exponent);
  }

  const refunds = asArray(order.refunds);
  if (refunds.length === 0) {
    return null;
  }

  let total: bigint | null = null;
  for (const entry of refunds) {
    const refund = asRecord(entry);
    if (!refund) {
      continue;
    }
    const amount = sumRefundTransactions(refund.transactions, exponent);
    if (amount !== null) {
      total = (total ?? BigInt(0)) + amount;
    }
  }
  return total;
}

function sumRefundTransactions(value: unknown, exponent: number): bigint | null {
  const transactions = asArray(value);
  if (transactions.length === 0) {
    return null;
  }
  let total: bigint | null = null;
  for (const entry of transactions) {
    const transaction = asRecord(entry);
    if (!transaction) {
      continue;
    }
    // Only settled money movements count toward a refunded total. A `pending`
    // or `failure` transaction has not refunded anything yet.
    const status = readText(transaction.status)?.toLowerCase();
    if (status !== null && status !== undefined && status !== "success") {
      continue;
    }
    const amount = toMinor(
      readMoneyAmount(transaction.amount_set ?? transaction.amount),
      exponent,
    );
    if (amount !== null) {
      total = (total ?? BigInt(0)) + amount;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Public normalizers
// ---------------------------------------------------------------------------

function emptyOrder(
  context: ShopifyOrderNormalizationContext,
): NormalizedOrderInput {
  return {
    connectionId: context.connectionId,
    brandId: context.brandId,
    provider: CommerceProvider.SHOPIFY,
    completeness: "PARTIAL",
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

/**
 * Normalizes a FULL Shopify order webhook body (`orders/create`,
 * `orders/updated`) into a `completeness: "FULL"` input: every field is
 * authoritative, including its nulls.
 *
 * Currency comes from `currency` (the SHOP's currency), not
 * `presentment_currency` (the buyer's), because every amount converted here is
 * a `shop_money` amount. `presentment_currency` is read only as a last-resort
 * fallback when `currency` is absent, and that case is flagged.
 */
export function normalizeShopifyOrderPayload(
  payload: unknown,
  context: ShopifyOrderNormalizationContext,
): ShopifyOrderNormalizationResult {
  const warnings: ShopifyOrderNormalizationWarning[] = [];
  const order = asRecord(payload);

  if (!order) {
    warnings.push("PAYLOAD_NOT_AN_OBJECT");
    return { order: emptyOrder(context), warnings };
  }

  const externalOrderId = readIdString(order.id);
  if (!externalOrderId) {
    warnings.push("MISSING_ORDER_ID");
  }

  const currencyCode =
    readText(order.currency) ?? readText(order.presentment_currency);
  if (!currencyCode) {
    warnings.push("MISSING_CURRENCY");
  }
  const { exponent } = getCurrencyExponent(currencyCode);

  const financialStatus = mapShopifyFinancialStatus(order.financial_status);
  if (order.financial_status != null && financialStatus === null) {
    warnings.push("UNRECOGNIZED_FINANCIAL_STATUS");
  }

  const fulfillmentStatus = mapShopifyFulfillmentStatus(
    order.fulfillment_status,
    true,
  );
  if (order.fulfillment_status != null && fulfillmentStatus === null) {
    warnings.push("UNRECOGNIZED_FULFILLMENT_STATUS");
  }

  return {
    order: {
      connectionId: context.connectionId,
      brandId: context.brandId,
      provider: CommerceProvider.SHOPIFY,
      completeness: "FULL",

      externalOrderId,
      orderNumber: readIdString(order.order_number) ?? readText(order.name),

      // Null when unknown, never a guessed "USD": an amount stored without a
      // currency to name its unit is worse than no amount.
      currencyCode: currencyCode ?? null,
      minorUnitExponent: currencyCode ? exponent : null,

      subtotalMinor: toMinorTracked(
        readMoneyAmount(order.subtotal_price_set ?? order.subtotal_price),
        exponent,
        warnings,
      ),
      discountsMinor: toMinorTracked(
        readMoneyAmount(order.total_discounts_set ?? order.total_discounts),
        exponent,
        warnings,
      ),
      shippingMinor: toMinorTracked(
        readMoneyAmount(order.total_shipping_price_set),
        exponent,
        warnings,
      ),
      taxMinor: toMinorTracked(
        readMoneyAmount(order.total_tax_set ?? order.total_tax),
        exponent,
        warnings,
      ),
      // The provider's own total, verbatim. NEVER a sum of line items.
      totalMinor: toMinorTracked(
        readMoneyAmount(order.total_price_set ?? order.total_price),
        exponent,
        warnings,
      ),
      totalRefundedMinor: deriveCumulativeRefundMinor(order, exponent),

      financialStatus,
      fulfillmentStatus,
      cancelledAt: readDate(order.cancelled_at),
      cancelReason: readText(order.cancel_reason),

      providerCreatedAt: readDate(order.created_at),
      providerUpdatedAt: readDate(order.updated_at),

      lineItems: normalizeLineItems(order.line_items, exponent, warnings),
      attributionToken: extractShopifyAttributionToken(order),
    },
    warnings,
  };
}

/**
 * Normalizes a `refunds/create` body into a `completeness: "PARTIAL"` input.
 *
 * WHY THIS DELIBERATELY DOES NOT PRODUCE A REFUND TOTAL FROM THE REFUND ALONE
 * --------------------------------------------------------------------------
 * A `refunds/create` payload is a single Refund resource: `order_id`, its own
 * `transactions[]`, its own `refund_line_items[]`. Its transaction amounts are
 * an INCREMENT for that one refund, not the cumulative total for the order —
 * and `../order-ingestion.ts` interprets `totalRefundedMinor` as CUMULATIVE
 * (see its REFUND SEMANTICS block: cumulative is idempotent under replay,
 * incremental double-counts).
 *
 * Rather than convert an increment into a cumulative figure by reading the
 * stored order and adding — which would reintroduce exactly the
 * double-counting race that cumulative semantics exist to eliminate — this
 * normalizer emits `totalRefundedMinor: null` (a `REFUND_CUMULATIVE_UNAVAILABLE`
 * warning) UNLESS the payload embeds its parent `order` object, in which case
 * the cumulative figure is derived from that order exactly as a full payload
 * would be.
 *
 * That is not a gap in coverage. Shopify emits an `orders/updated` for the
 * same order immediately after a refund, carrying the updated
 * `financial_status` and the full `refunds[]` array — that is where the
 * cumulative refund total legitimately lands. A production rollout must
 * therefore subscribe to `orders/updated` and treat `refunds/create` as a
 * timeliness signal, which is recorded in
 * `docs/commerce/phase-7-order-normalization-summary.md`.
 */
export function normalizeShopifyRefundPayload(
  payload: unknown,
  context: ShopifyOrderNormalizationContext,
): ShopifyOrderNormalizationResult {
  const warnings: ShopifyOrderNormalizationWarning[] = [];
  const refund = asRecord(payload);

  if (!refund) {
    warnings.push("PAYLOAD_NOT_AN_OBJECT");
    return { order: emptyOrder(context), warnings };
  }

  // Some payload variants embed the parent order. When they do, that object is
  // a complete, cumulative source and is used directly.
  const embeddedOrder = asRecord(refund.order);
  if (embeddedOrder) {
    const result = normalizeShopifyOrderPayload(embeddedOrder, context);
    return {
      order: { ...result.order, providerUpdatedAt: refundTimestamp(refund) ?? result.order.providerUpdatedAt },
      warnings: [...warnings, ...result.warnings],
    };
  }

  const externalOrderId = readIdString(refund.order_id);
  if (!externalOrderId) {
    warnings.push("MISSING_ORDER_ID");
  }
  warnings.push("REFUND_CUMULATIVE_UNAVAILABLE");

  return {
    order: {
      ...emptyOrder(context),
      externalOrderId,
      // PARTIAL: every other field stays null so the ingestion service
      // preserves the stored order rather than blanking it.
      providerUpdatedAt: refundTimestamp(refund),
    },
    warnings,
  };
}

function refundTimestamp(refund: Record<string, unknown>): Date | null {
  return readDate(refund.processed_at) ?? readDate(refund.created_at);
}
