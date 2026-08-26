/**
 * src/lib/commerce/order-operations-summary.ts
 *
 * PHASE 18 — PART 6: the provider-neutral, per-connection data behind the
 * Commerce order operations dashboard (`/dashboard/brand/commerce/orders`).
 *
 * Provider-neutral by design, mirroring the rest of this round's Phase 18
 * additions (`./order-list.ts`, `./providers/commerce7-diagnostics.ts`):
 * `CommerceConnection` and `CommerceOrder`/`CommerceOrderEvent` are already
 * canonical across both SHOPIFY and COMMERCE7, so a dashboard keyed only on
 * "the brand's connections" costs nothing extra to make provider-neutral and
 * avoids hard-coding a second, Commerce7-only aggregation path.
 *
 * NO customer PII: only counts and status/timestamp fields are read — see
 * `./order-list.ts`'s header for why `CommerceOrder` has no PII to begin
 * with.
 *
 * COMPLETENESS: `getAllCommerceConnectionsForBrand` (P2-4B) already
 * distinguishes "this brand truly has zero connections" from "a provider's
 * read failed" via its own `complete` flag — that flag is passed straight
 * through here as `BrandOrderOperationsSummary.complete` rather than being
 * silently absorbed, so the dashboard can render an honest "list may be
 * incomplete" state instead of a false "all connections shown."
 */

import { CommerceProvider, type CommerceOrderFinancialStatus } from "@prisma/client";
import {
  getAllCommerceConnectionsForBrand,
  type CommerceConnectionServiceDeps,
} from "./connection-service";
import { getCommerce7OrderWebhookConfig } from "./providers/commerce7";
import type { CommerceConnectionSummary } from "./types";

export type CommerceConnectionOrderOperationsSummary = {
  connectionId: string;
  provider: CommerceProvider;
  displayName: string;
  externalAccountId: string;
  status: CommerceConnectionSummary["status"];
  latestOrderIngestedAt: string | null;
  latestWebhookProcessedAt: string | null;
  orderCountsByFinancialStatus: Partial<Record<CommerceOrderFinancialStatus, number>>;
  /** Orders whose `financialStatus` is `null` — reported explicitly, never folded into a guessed bucket. */
  unknownFinancialStatusCount: number;
  attributedOrderCount: number;
  unattributedOrderCount: number;
  /**
   * PHASE 18 — PART 11: whether SQRATCH's OWN Commerce7 order webhook
   * receiver is configured (env credentials present) — `null` for a
   * non-COMMERCE7 connection, where this field does not apply. This is
   * NEVER a claim that Commerce7's own webhook subscription is active;
   * that fact lives in Commerce7's App Dev Center and is not observable
   * from here. See `./providers/commerce7-diagnostics.ts`'s file header
   * for the same distinction.
   */
  orderReceiverConfigured: boolean | null;
};

export type BrandOrderOperationsSummary = {
  connections: CommerceConnectionOrderOperationsSummary[];
  /** `false` whenever the underlying connection list may be incomplete (see file header). */
  complete: boolean;
};

export type OrderOperationsSummaryDeps = {
  getConnections(
    brandId: string,
  ): Promise<{ connections: CommerceConnectionSummary[]; complete: boolean }>;
  countOrdersByFinancialStatus(
    connectionId: string,
  ): Promise<Array<{ financialStatus: CommerceOrderFinancialStatus | null; count: number }>>;
  countAttributedOrders(connectionId: string): Promise<number>;
  countUnattributedOrders(connectionId: string): Promise<number>;
  findLatestOrderIngestedAt(connectionId: string): Promise<Date | null>;
  findLatestWebhookProcessedAt(connectionId: string, provider: CommerceProvider): Promise<Date | null>;
};

/**
 * PHASE 23 — PART 2: the closed, explicit set of `CommerceOrderEvent.topic`
 * values that represent a GENUINE provider order webhook delivery, per
 * provider. This is deliberately an allow-list, not "anything except
 * backfill" — a future non-webhook producer (another reconciliation mode, a
 * migration/import tool, etc.) must never silently start counting as
 * "webhook processed" just because it isn't named "backfill."
 *
 * Commerce7: written only by `commerce7-order-webhook.ts`, which authenticates
 * every request via Basic Auth (`commerce7-order-webhook-auth.ts`) before
 * ingestion — see that file for the live 401 investigation. Reconciliation/
 * catch-up/custom-range all funnel through `backfillCommerce7Orders`, which
 * writes the distinct `commerce7:order:backfill` topic and must NEVER be
 * mistaken for a webhook delivery.
 *
 * Shopify: written only by the four HMAC-verified routes under
 * `src/app/api/shopify/webhooks/{orders/create,orders/updated,
 * order_transactions/create,refunds/create}` (topic bound to the route path,
 * never the spoofable `x-shopify-topic` header — see
 * `shopify-order-webhook.ts`'s header comment). Shopify has no
 * reconciliation/backfill producer of `CommerceOrderEvent` today, so this
 * list does not change Shopify's current observed behavior — it only makes
 * the definition explicit and future-proof.
 */
const COMMERCE7_ORDER_WEBHOOK_TOPICS: readonly string[] = [
  "commerce7:order:Create",
  "commerce7:order:Update",
];

const SHOPIFY_ORDER_WEBHOOK_TOPICS: readonly string[] = [
  "orders/create",
  "orders/updated",
  "order_transactions/create",
  "refunds/create",
];

/** Provider-aware, closed-list membership test — see the topic lists' doc comment above. */
export function isOrderWebhookEventTopic(provider: CommerceProvider, topic: string): boolean {
  if (provider === CommerceProvider.COMMERCE7) return COMMERCE7_ORDER_WEBHOOK_TOPICS.includes(topic);
  if (provider === CommerceProvider.SHOPIFY) return SHOPIFY_ORDER_WEBHOOK_TOPICS.includes(topic);
  return false;
}

function orderWebhookTopicsForProvider(provider: CommerceProvider): string[] {
  if (provider === CommerceProvider.COMMERCE7) return [...COMMERCE7_ORDER_WEBHOOK_TOPICS];
  if (provider === CommerceProvider.SHOPIFY) return [...SHOPIFY_ORDER_WEBHOOK_TOPICS];
  return [];
}

async function getPrisma() {
  const { default: prisma } = await import("@/lib/prisma");
  return prisma;
}

async function defaultGetConnections(
  brandId: string,
  deps?: Partial<CommerceConnectionServiceDeps>,
): Promise<{ connections: CommerceConnectionSummary[]; complete: boolean }> {
  return getAllCommerceConnectionsForBrand(brandId, deps);
}

async function defaultCountOrdersByFinancialStatus(
  connectionId: string,
): Promise<Array<{ financialStatus: CommerceOrderFinancialStatus | null; count: number }>> {
  const prisma = await getPrisma();
  const rows = await prisma.commerceOrder.groupBy({
    by: ["financialStatus"],
    where: { connectionId },
    _count: { _all: true },
  });
  return rows.map((row) => ({ financialStatus: row.financialStatus, count: row._count._all }));
}

async function defaultCountAttributedOrders(connectionId: string): Promise<number> {
  const prisma = await getPrisma();
  return prisma.commerceOrder.count({ where: { connectionId, attributionId: { not: null } } });
}

async function defaultCountUnattributedOrders(connectionId: string): Promise<number> {
  const prisma = await getPrisma();
  return prisma.commerceOrder.count({ where: { connectionId, attributionId: null } });
}

async function defaultFindLatestOrderIngestedAt(connectionId: string): Promise<Date | null> {
  const prisma = await getPrisma();
  const row = await prisma.commerceOrder.findFirst({
    where: { connectionId },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

async function defaultFindLatestWebhookProcessedAt(
  connectionId: string,
  provider: CommerceProvider,
): Promise<Date | null> {
  const topics = orderWebhookTopicsForProvider(provider);
  if (topics.length === 0) return null;
  const prisma = await getPrisma();
  const row = await prisma.commerceOrderEvent.findFirst({
    where: { connectionId, status: "PROCESSED", topic: { in: topics } },
    orderBy: { receivedAt: "desc" },
    select: { processedAt: true, receivedAt: true },
  });
  return row?.processedAt ?? row?.receivedAt ?? null;
}

const DEFAULT_DEPS: OrderOperationsSummaryDeps = {
  getConnections: defaultGetConnections,
  countOrdersByFinancialStatus: defaultCountOrdersByFinancialStatus,
  countAttributedOrders: defaultCountAttributedOrders,
  countUnattributedOrders: defaultCountUnattributedOrders,
  findLatestOrderIngestedAt: defaultFindLatestOrderIngestedAt,
  findLatestWebhookProcessedAt: defaultFindLatestWebhookProcessedAt,
};

async function summarizeConnection(
  connection: CommerceConnectionSummary,
  deps: OrderOperationsSummaryDeps,
): Promise<CommerceConnectionOrderOperationsSummary> {
  const [statusCounts, attributedOrderCount, unattributedOrderCount, latestOrderAt, latestWebhookAt] =
    await Promise.all([
      deps.countOrdersByFinancialStatus(connection.id),
      deps.countAttributedOrders(connection.id),
      deps.countUnattributedOrders(connection.id),
      deps.findLatestOrderIngestedAt(connection.id),
      deps.findLatestWebhookProcessedAt(connection.id, connection.provider),
    ]);

  const orderCountsByFinancialStatus: Partial<Record<CommerceOrderFinancialStatus, number>> = {};
  let unknownFinancialStatusCount = 0;
  for (const row of statusCounts) {
    if (row.financialStatus === null) {
      unknownFinancialStatusCount += row.count;
    } else {
      orderCountsByFinancialStatus[row.financialStatus] = row.count;
    }
  }

  return {
    connectionId: connection.id,
    provider: connection.provider,
    displayName: connection.displayName,
    externalAccountId: connection.externalAccountId,
    status: connection.status,
    latestOrderIngestedAt: latestOrderAt?.toISOString() ?? null,
    latestWebhookProcessedAt: latestWebhookAt?.toISOString() ?? null,
    orderCountsByFinancialStatus,
    unknownFinancialStatusCount,
    attributedOrderCount,
    unattributedOrderCount,
    orderReceiverConfigured:
      connection.provider === CommerceProvider.COMMERCE7
        ? getCommerce7OrderWebhookConfig() !== null
        : null,
  };
}

export async function getBrandOrderOperationsSummary(
  brandId: string,
  deps: Partial<OrderOperationsSummaryDeps> = {},
): Promise<BrandOrderOperationsSummary> {
  const resolved: OrderOperationsSummaryDeps = { ...DEFAULT_DEPS, ...deps };
  const { connections, complete } = await resolved.getConnections(brandId);

  const summaries = await Promise.all(
    connections.map((connection) => summarizeConnection(connection, resolved)),
  );

  return { connections: summaries, complete };
}
