"use client";

import { useId } from "react";
import { conversionDateBasisNote, fallbackOrdersNote } from "@/lib/commerce/analytics-labels";
import type { OrderDateBasis } from "@/lib/commerce/order-date-basis";

/** Chooses which date places an order in the reporting period. */
export function DateBasisSelect({
  value,
  onChange,
}: {
  value: OrderDateBasis;
  onChange: (next: OrderDateBasis) => void;
}) {
  const id = useId();
  return (
    <label htmlFor={id} className="mt-3 flex flex-wrap items-center gap-3 text-sm text-copy-70">
      <span>Order date</span>
      <select
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value as OrderDateBasis)}
        className="h-10 min-w-[260px] rounded-xl border border-edge/10 bg-inset/20 px-3 text-sm text-ink"
      >
        <option value="provider">Date the store recorded (recommended)</option>
        <option value="ingested">Date SQRATCH received the order</option>
      </select>
    </label>
  );
}

/** States the basis in effect, and how many orders could not use the store's date. */
export function DateBasisNotes({ basis, fallbackOrderCount }: { basis: OrderDateBasis; fallbackOrderCount: number }) {
  return (
    <>
      <p className="mt-2 text-xs text-copy-45">{conversionDateBasisNote(basis)}</p>
      {basis === "provider" && fallbackOrderCount > 0 ? (
        <p role="status" className="mt-1 text-xs text-amber-700 dark:text-amber-200">
          {fallbackOrdersNote(fallbackOrderCount)}
        </p>
      ) : null}
    </>
  );
}
