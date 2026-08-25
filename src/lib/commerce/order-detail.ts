/**
 * src/lib/commerce/order-detail.ts
 *
 * PHASE 19 — PART 11: the canonical, provider-neutral Brand-owned single
 * order detail. `brandId` is ALWAYS the authenticated context's own brand —
 * the query's `where` filters on both `id` AND `brandId` together, so a
 * foreign order id is indistinguishable from a nonexistent one (both
 * resolve to `null`).
 *
 * NO customer PII: `CommerceOrder`/`CommerceOrderLineItem` carry no
 * customer name/email/address/payment field to begin with (see
 * `./order-list.ts`'s header) — this module selects a few more columns
 * from the SAME two models plus a connection display projection, never a
 * new source of customer data. Never the raw provider payload — this
 * reads only already-normalized canonical columns, never
 * `CommerceOrderEvent.payloadDigest` or any webhook body.
 *
 * "Unknown must display as unknown, never as zero": every money field that
 * is `null` in the database is returned as `null` in the JSON response.
 */

import type {
  CommerceOrderFinancialStatus,
  CommerceOrderFulfillmentStatus,
  CommerceProvider,
} from "@prisma/client";
import { resolveDisplayOrderDate } from "./order-list";

export type BrandCommerceOrderDetailLineItem = {
  id: string;
  title: string | null;
  sku: string | null;
  quantity: number;
  unitPriceMinor: string | null;
  totalMinor: string | null;
  externalProductId: string | null;
  externalVariantId: string | null;
  connectedProductId: string | null;
};

export type BrandCommerceOrderDetail = {
  id: string;
  connectionId: string;
  provider: CommerceProvider;
  connectionDisplayName: string;
  connectionExternalAccountId: string;
  orderNumber: string | null;
  orderDate: string;
  financialStatus: CommerceOrderFinancialStatus | null;
  fulfillmentStatus: CommerceOrderFulfillmentStatus | null;
  currencyCode: string | null;
  /**
   * PHASE 19 REPAIR (P1-3): the EXACT minor-unit exponent this order's
   * amounts were persisted at (`getCurrencyExponent`'s resolved value at
   * ingestion time) — a UI MUST use this, never derive/guess an exponent
   * from `currencyCode` itself (a client-side currency table can drift
   * from what was actually used at write time). `null` only when the
   * order's amounts are themselves entirely unresolved.
   */
  minorUnitExponent: number | null;
  subtotalMinor: string | null;
  shippingMinor: string | null;
  taxMinor: string | null;
  totalMinor: string | null;
  totalRefundedMinor: string | null;
  netRevenueMinor: string | null;
  attributed: boolean;
  createdAt: string;
  updatedAt: string;
  lineItems: BrandCommerceOrderDetailLineItem[];
};

export type OrderDetailRow = {
  id: string;
  connectionId: string;
  provider: CommerceProvider;
  orderNumber: string | null;
  providerCreatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  financialStatus: CommerceOrderFinancialStatus | null;
  fulfillmentStatus: CommerceOrderFulfillmentStatus | null;
  currencyCode: string | null;
  minorUnitExponent: number | null;
  subtotalMinor: bigint | null;
  shippingMinor: bigint | null;
  taxMinor: bigint | null;
  totalMinor: bigint | null;
  totalRefundedMinor: bigint;
  netRevenueMinor: bigint | null;
  attributionId: string | null;
  connection: { displayName: string; externalAccountId: string };
  lineItems: Array<{
    id: string;
    title: string | null;
    sku: string | null;
    quantity: number;
    unitPriceMinor: bigint | null;
    totalMinor: bigint | null;
    externalProductId: string | null;
    externalVariantId: string | null;
    connectedProductId: string | null;
  }>;
};

export type BrandCommerceOrderDetailDeps = {
  findOrder(orderId: string, brandId: string): Promise<OrderDetailRow | null>;
};

const ORDER_DETAIL_SELECT = {
  id: true,
  connectionId: true,
  provider: true,
  orderNumber: true,
  providerCreatedAt: true,
  createdAt: true,
  updatedAt: true,
  financialStatus: true,
  fulfillmentStatus: true,
  currencyCode: true,
  minorUnitExponent: true,
  subtotalMinor: true,
  shippingMinor: true,
  taxMinor: true,
  totalMinor: true,
  totalRefundedMinor: true,
  netRevenueMinor: true,
  attributionId: true,
  connection: { select: { displayName: true, externalAccountId: true } },
  lineItems: {
    select: {
      id: true,
      title: true,
      sku: true,
      quantity: true,
      unitPriceMinor: true,
      totalMinor: true,
      externalProductId: true,
      externalVariantId: true,
      connectedProductId: true,
    },
  },
} as const;

async function defaultFindOrder(
  orderId: string,
  brandId: string,
): Promise<OrderDetailRow | null> {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma.commerceOrder.findFirst({
    where: { id: orderId, brandId },
    select: ORDER_DETAIL_SELECT,
  });
}

const DEFAULT_DEPS: BrandCommerceOrderDetailDeps = {
  findOrder: defaultFindOrder,
};

function minorToString(value: bigint | null): string | null {
  return value === null ? null : value.toString();
}

export async function getBrandCommerceOrderDetail(
  orderId: string,
  brandId: string,
  deps: Partial<BrandCommerceOrderDetailDeps> = {},
): Promise<BrandCommerceOrderDetail | null> {
  const resolved: BrandCommerceOrderDetailDeps = { ...DEFAULT_DEPS, ...deps };
  const row = await resolved.findOrder(orderId, brandId);
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    connectionId: row.connectionId,
    provider: row.provider,
    connectionDisplayName: row.connection.displayName,
    connectionExternalAccountId: row.connection.externalAccountId,
    orderNumber: row.orderNumber,
    orderDate: resolveDisplayOrderDate(row.providerCreatedAt, row.createdAt).toISOString(),
    financialStatus: row.financialStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    currencyCode: row.currencyCode,
    minorUnitExponent: row.minorUnitExponent,
    subtotalMinor: minorToString(row.subtotalMinor),
    shippingMinor: minorToString(row.shippingMinor),
    taxMinor: minorToString(row.taxMinor),
    totalMinor: minorToString(row.totalMinor),
    totalRefundedMinor: minorToString(row.totalRefundedMinor),
    netRevenueMinor: minorToString(row.netRevenueMinor),
    attributed: row.attributionId !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lineItems: row.lineItems.map((item) => ({
      id: item.id,
      title: item.title,
      sku: item.sku,
      quantity: item.quantity,
      unitPriceMinor: minorToString(item.unitPriceMinor),
      totalMinor: minorToString(item.totalMinor),
      externalProductId: item.externalProductId,
      externalVariantId: item.externalVariantId,
      connectedProductId: item.connectedProductId,
    })),
  };
}
