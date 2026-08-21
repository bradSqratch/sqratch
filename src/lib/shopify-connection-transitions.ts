import { CommerceProvider, type CommerceConnectionEventType, type Prisma } from "@prisma/client";
import { isSameShopDomain, normalizeShopDomain } from "@/lib/shopify";
import {
  recordCommerceConnectionEvent,
  resolveLastKnownExternalAccountId,
} from "@/lib/commerce/connection-lifecycle";

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
 * provider-neutral CommerceConnectionEvent describing a Shopify connection loss (manual/embedded
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
      CommerceConnectionEventType,
      "DISCONNECTED" | "UNINSTALLED" | "REQUIRES_RECONNECT"
    >;
    snapshot: PreTransitionShopifySnapshot;
  },
) {
  await deactivateAllBrandRewardOffers(tx, input.brandId);
  await recordCommerceConnectionEvent(tx, {
    brandId: input.brandId,
    provider: CommerceProvider.SHOPIFY,
    eventType: input.eventType,
    snapshot: {
      externalAccountId: input.snapshot.shopDomain,
      currencyCode: input.snapshot.currencyCode,
      providerClientId: input.snapshot.shopifyClientId,
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
  CommerceConnectionEventType,
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
 * CONNECTED/RECONNECTED/RELINKED CommerceConnectionEvent, atomically inside
 * the given transaction. Offers are never automatically reactivated here —
 * activation always requires a separate, explicit Brand Admin action.
 */
export async function recordShopifyConnectionInstall(
  tx: TxClient,
  input: {
    brandId: string;
    eventType: Extract<
      CommerceConnectionEventType,
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
  await recordCommerceConnectionEvent(tx, {
    brandId: input.brandId,
    provider: CommerceProvider.SHOPIFY,
    eventType: input.eventType,
    snapshot: {
      externalAccountId: normalizeShopDomain(input.shopDomain) ?? input.shopDomain,
      currencyCode: input.currencyCode,
      providerClientId: input.shopifyClientId,
    },
    previousSnapshot: {
      externalAccountId: input.previousShopDomain,
      currencyCode: input.previousCurrencyCode,
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
  const externalAccountId = await resolveLastKnownExternalAccountId(
    tx,
    brandId,
    CommerceProvider.SHOPIFY,
  );
  return normalizeShopDomain(externalAccountId);
}
