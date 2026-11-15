import { PageCard } from "@/components/experience/experience-shell";
import {
  CONVERSION_LIMITATIONS_NOTE,
  FINANCIAL_STATUS_LABELS,
} from "@/lib/commerce/analytics-labels";
import type { FinancialStatusCountRow } from "@/lib/commerce/conversion-analytics-client";

/**
 * What the order-value figures above actually contain: how many attributed
 * orders sit in each payment status. An order-value total includes pending,
 * authorized and voided orders, so a reader needs this to interpret it.
 */
export function FinancialStatusBreakdown({
  rows,
  cancelledOrders,
}: {
  rows: readonly FinancialStatusCountRow[];
  cancelledOrders: number;
}) {
  return (
    <PageCard>
      <h3 className="text-lg font-semibold">Orders by payment status</h3>
      <p className="mt-1 text-xs text-copy-45">
        These are the orders behind the order-value figures above.
      </p>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm text-copy-65">No attributed orders.</p>
      ) : (
        <ul className="mt-3 space-y-1 text-sm">
          {rows.map((row) => (
            <li key={row.status} className="flex justify-between gap-4 tabular-nums text-copy-85">
              <span>{FINANCIAL_STATUS_LABELS[row.status] ?? row.status}</span>
              <span>{row.orders}</span>
            </li>
          ))}
        </ul>
      )}
      {cancelledOrders > 0 && (
        <p className="mt-3 text-xs text-copy-55">
          {cancelledOrders} of these {cancelledOrders === 1 ? "order was" : "orders were"} cancelled.
          Cancelled orders still count above under their payment status.
        </p>
      )}
      <p className="mt-3 text-xs text-copy-45">{CONVERSION_LIMITATIONS_NOTE}</p>
    </PageCard>
  );
}
