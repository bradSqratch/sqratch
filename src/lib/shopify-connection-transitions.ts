import type { Prisma, ShopifyConnectionEventType } from "@prisma/client";
import { isSameShopDomain, normalizeShopDomain } from "@/lib/shopify";

type TxClient = Prisma.TransactionClient;

export type PreTransitionShopifySnapshot = {
  shopDomain: string | null;
  currencyCode: string | null;
  shopifyClientId: string | null;
};

/**
 * Deactivates every reward offer for a Brand. Idempotent — safe to call even
 * when offers are already inactive. Must be called inside the same
 * transaction as the connection-state write it accompanies.
 */
export async function deactivateAllBrandRewardOffers(
  tx: TxClient,
  brandId: string,
) {
  await tx.brandRewardOffer.updateMany({
    where: { brandId },
    data: { isActive: false },
  });
}

/**
 * Deactivates every reward offer for the brand and records a
 * ShopifyConnectionEvent describing a connection loss (manual/embedded
 * disconnect, app uninstall, or a permanent token failure), atomically
 * inside the given transaction.
 *
 * `snapshot` must be read from the Brand row BEFORE any credential-clearing
 * write happens in the same transaction. For a loss event there is no
 * meaningful "previous, different" domain/currency to report (that concept
 * only applies to install-time CONNECTED/RECONNECTED/RELINKED transitions),
 * so shopDomain/currencyCode are populated with the pre-loss values and
 * previousShopDomain/previousCurrencyCode are left null.
 */
export async function recordShopifyConnectionLoss(
  tx: TxClient,
  input: {
    brandId: string;
    eventType: Extract<
      ShopifyConnectionEventType,
      "DISCONNECTED" | "UNINSTALLED" | "REQUIRES_RECONNECT"
    >;
    snapshot: PreTransitionShopifySnapshot;
  },
) {
  await deactivateAllBrandRewardOffers(tx, input.brandId);
  await tx.shopifyConnectionEvent.create({
    data: {
      brandId: input.brandId,
      eventType: input.eventType,
      shopDomain: input.snapshot.shopDomain,
      previousShopDomain: null,
      currencyCode: input.snapshot.currencyCode,
      previousCurrencyCode: null,
      shopifyClientId: input.snapshot.shopifyClientId,
    },
  });
}

/**
 * Determines the connection-event type for an install/reconnect/relink
 * transition by comparing the normalized previous vs. new shop domain.
 */
export function resolveInstallConnectionEventType(
  previousShopDomain: string | null,
  newShopDomain: string,
): Extract<
  ShopifyConnectionEventType,
  "CONNECTED" | "RECONNECTED" | "RELINKED"
> {
  if (!previousShopDomain) {
    return "CONNECTED";
  }

  return isSameShopDomain(previousShopDomain, newShopDomain)
    ? "RECONNECTED"
    : "RELINKED";
}

/**
 * Deactivates every reward offer for the brand and records a
 * CONNECTED/RECONNECTED/RELINKED ShopifyConnectionEvent, atomically inside
 * the given transaction. Offers are never automatically reactivated here —
 * activation always requires a separate, explicit Brand Admin action.
 */
export async function recordShopifyConnectionInstall(
  tx: TxClient,
  input: {
    brandId: string;
    eventType: Extract<
      ShopifyConnectionEventType,
      "CONNECTED" | "RECONNECTED" | "RELINKED"
    >;
    shopDomain: string;
    previousShopDomain: string | null;
    currencyCode: string | null;
    previousCurrencyCode: string | null;
    shopifyClientId: string | null;
  },
) {
  await deactivateAllBrandRewardOffers(tx, input.brandId);
  await tx.shopifyConnectionEvent.create({
    data: {
      brandId: input.brandId,
      eventType: input.eventType,
      shopDomain: normalizeShopDomain(input.shopDomain) ?? input.shopDomain,
      previousShopDomain: input.previousShopDomain,
      currencyCode: input.currencyCode,
      previousCurrencyCode: input.previousCurrencyCode,
      shopifyClientId: input.shopifyClientId,
    },
  });
}

/**
 * Resolves the last known Shopify domain for a Brand that currently has none
 * on record (e.g. after a redaction nulled it), by looking at its most
 * recent connection-history event that has a shopDomain. Returns null when
 * there is no such history — a genuinely first-time connection.
 */
export async function resolveLastKnownShopDomain(
  tx: TxClient,
  brandId: string,
): Promise<string | null> {
  const lastEvent = await tx.shopifyConnectionEvent.findFirst({
    where: { brandId, shopDomain: { not: null } },
    orderBy: { createdAt: "desc" },
    select: { shopDomain: true },
  });

  return normalizeShopDomain(lastEvent?.shopDomain ?? null);
}
