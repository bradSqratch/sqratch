/**
 * Presentation of the closed notes ingestion records on an order event (`CommerceOrderEvent.failureSummary`).
 * Pure and client-safe. The stored note is never rewritten; only its display is.
 *
 * `OVER_REFUND_EXCESS:<minor units>` is recorded on the PROCESSED event that applied a bounded over-refund
 * (see providers/commerce7-order-refund-reconciliation.ts): the provider reported that much more refunded than the sale.
 */
import { formatMoneyDisplay } from "./money";

const OVER_REFUND_NOTE = /^OVER_REFUND_EXCESS:(\d{1,18})$/;

/** The excess in minor units for a well-formed, positive over-refund note; `null` for anything else. */
export function parseOverRefundExcess(note: string | null): bigint | null {
  const match = note ? OVER_REFUND_NOTE.exec(note) : null;
  if (!match) return null;
  const excess = BigInt(match[1]);
  return excess > BigInt(0) ? excess : null;
}

export type OrderEventNoteMoney = { currencyCode: string | null; minorUnitExponent: number | null } | null;

/**
 * Human-readable text for an activity note. An over-refund note becomes a warning with the extra amount in the order's
 * own currency and exponent; when either is unknown the amount is omitted rather than guessed. Every other note is a
 * classified failure tag and is shown as before.
 */
export function describeOrderEventNote(note: string | null, providerLabel: string, money: OrderEventNoteMoney): string | null {
  if (!note) return null;
  const excess = parseOverRefundExcess(note);
  if (excess === null) return note;
  const amount = money ? formatMoneyDisplay(excess, money.currencyCode, money.minorUnitExponent) : "—";
  const reported = amount === "—" ? "refunds above the sale total" : `${amount} refunded beyond the sale total`;
  return `Over-refund warning: ${providerLabel} reported ${reported}. SQRATCH counts refunds only up to the sale; review the extra refund in ${providerLabel}.`;
}
