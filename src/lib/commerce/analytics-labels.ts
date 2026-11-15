/**
 * Plain-language names and one-line definitions for the order figures on the
 * conversion panels. SQRATCH records an order's total, its cumulative refunds
 * and a payment status. It does NOT record how much money was actually
 * captured, so none of these figures may be called revenue or sales collected.
 */
export const ORDER_VALUE_LABELS = {
  attributedOrderValue: {
    title: "Attributed order value",
    definition:
      "Sum of order totals for every attributed order, whatever its payment status (pending, authorized and voided orders included). This is order value, not money collected.",
  },
  refunded: {
    title: "Refunded",
    definition: "Refunds the store has reported against those orders so far.",
  },
  currentNet: {
    title: "Current net attributed order value",
    definition:
      "Order total minus refunds for paid, partially paid and partially refunded orders only. A partially paid order counts at its full order total. This is not a payment total.",
  },
} as const;

export const CONVERSION_SECTION_TITLE = "Attributed conversions & order value";

/** The date every conversion figure is filtered and bucketed on, until provider order dates are used. */
export const CONVERSION_DATE_BASIS_NOTE =
  "Orders are placed in a period by the date SQRATCH received them (UTC), which can be later than the date the customer ordered.";

export const CONVERSION_LIMITATIONS_NOTE =
  "Attribution shows an order followed a tracked SQRATCH link. It does not show that SQRATCH caused the sale. SQRATCH does not record the amount actually paid, so these figures are order values, not collected payments.";

export const FINANCIAL_STATUS_LABELS: Readonly<Record<string, string>> = {
  PENDING: "Pending",
  AUTHORIZED: "Authorized",
  PARTIALLY_PAID: "Partially paid",
  PAID: "Paid",
  PARTIALLY_REFUNDED: "Partially refunded",
  REFUNDED: "Refunded",
  VOIDED: "Voided",
  UNKNOWN: "Status not reported",
};

/** Label for the trend table's per-currency order-value columns. */
export const TREND_COLUMN_LABELS = {
  orderValue: "Attributed order value",
  refunded: "Refunded",
  currentNet: "Current net value",
} as const;
