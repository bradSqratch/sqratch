import { CommerceProvider, type Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { recordShopifyConnectionLoss } from "@/lib/shopify-connection-transitions";
import { invalidateShopifyCredential } from "@/lib/commerce/providers/shopify-credential-store";
import { normalizeExternalAccountId } from "@/lib/commerce/connection-sync";
import { extractCurrencyCodeFromProviderMetadata } from "@/lib/commerce/connection-resolver";

export type EmbeddedConnectedBrand = {
  id: string;
  name: string;
  shopifyConnectionStatus: "CONNECTED";
  currencyCode: string | null;
};

/**
 * PHASE 14C-A: CANONICAL-ONLY embedded link resolution — no legacy
 * `Brand.shopify*` fallback. Every live Shopify install already has a
 * canonical `CommerceConnection` (operator-verified). Resolves
 * (shopDomain, clientId) — both taken from Shopify's own signed embedded
 * session context, never client-suppliable independent of that
 * verification — directly through `CommerceConnection`'s
 * `[provider, externalAccountId]` unique key, exactly mirroring how
 * `app/scopes_update` resolves identity (see
 * `shopify-token-manager.ts`'s `applyGrantedScopesUpdate`).
 *
 * Returns `null` when no canonical connection exists at all, OR when one
 * exists but doesn't match (wrong client id, not CONNECTED, or not
 * EXPIRING_OFFLINE auth) — the canonical row is authoritative about its own
 * state either way.
 */
export async function findEmbeddedConnectedBrand(
  shopDomain: string,
  clientId: string,
): Promise<EmbeddedConnectedBrand | null> {
  const connection = await prisma.commerceConnection.findUnique({
    where: {
      provider_externalAccountId: {
        provider: CommerceProvider.SHOPIFY,
        externalAccountId: normalizeExternalAccountId(shopDomain),
      },
    },
    select: { brandId: true, status: true, providerClientId: true, providerMetadata: true },
  });

  if (!connection) {
    return null;
  }

  const authMode = (connection.providerMetadata as { authMode?: unknown } | null)?.authMode;
  const matches =
    connection.status === "CONNECTED" &&
    connection.providerClientId === clientId &&
    authMode === "EXPIRING_OFFLINE";

  if (!matches) {
    return null;
  }

  const brand = await prisma.brand.findUnique({
    where: { id: connection.brandId },
    select: { id: true, name: true },
  });

  return brand
    ? {
        id: brand.id,
        name: brand.name,
        shopifyConnectionStatus: "CONNECTED",
        currencyCode: extractCurrencyCodeFromProviderMetadata(connection.providerMetadata),
      }
    : null;
}

export async function disconnectEmbeddedConnectedBrand(input: {
  brandId: string;
  shopDomain: string;
  clientId: string;
}): Promise<{ count: number }> {
  // PHASE 14C-A: CANONICAL-ONLY eligibility + invalidation — no legacy
  // `Brand` read or write. Re-verifies eligibility through the SAME
  // canonical-first path `findEmbeddedConnectedBrand` uses for linking, so a
  // request can never disconnect a brand/shop/clientId combination it
  // wasn't actually linked to.
  const linked = await findEmbeddedConnectedBrand(input.shopDomain, input.clientId);
  const eligible = linked?.id === input.brandId ? linked : null;

  if (!eligible) {
    return { count: 0 };
  }

  const canonicalInvalidation = await invalidateShopifyCredential({
    brandId: input.brandId,
    status: "DISCONNECTED" as const,
    onInvalidated: async (tx) => {
      await recordShopifyConnectionLoss(tx as Prisma.TransactionClient, {
        brandId: input.brandId,
        eventType: "DISCONNECTED",
        snapshot: {
          shopDomain: input.shopDomain,
          currencyCode: eligible.currencyCode,
          shopifyClientId: input.clientId,
        },
      });
    },
  });

  return { count: canonicalInvalidation.outcome === "INVALIDATED" ? 1 : 0 };
}
