import prisma from "@/lib/prisma";

export type EmbeddedConnectedBrand = {
  id: string;
  name: string;
  shopifyConnectionStatus: "CONNECTED";
};

export function buildLocalShopifyDisconnectData(disconnectedAt = new Date()) {
  return {
    shopifyShopDomain: null,
    shopifyAdminAccessTokenEncrypted: null,
    shopifyRefreshTokenEncrypted: null,
    shopifyAccessTokenExpiresAt: null,
    shopifyRefreshTokenExpiresAt: null,
    shopifyGrantedScopes: null,
    shopifyClientId: null,
    shopifyTokenRefreshLockedUntil: null,
    shopifyTokenRefreshLockId: null,
    shopifyDisconnectedAt: disconnectedAt,
    shopifyUninstalledAt: null,
    shopifyConnectionStatus: "DISCONNECTED" as const,
  };
}

export function buildEmbeddedConnectedBrandWhere(
  shopDomain: string,
  clientId: string,
) {
  return {
    shopifyShopDomain: shopDomain,
    shopifyConnectionStatus: "CONNECTED" as const,
    shopifyClientId: clientId,
    shopifyAuthMode: "EXPIRING_OFFLINE" as const,
    shopifyAdminAccessTokenEncrypted: { not: null },
    shopifyRefreshTokenEncrypted: { not: null },
    shopifyAccessTokenExpiresAt: { not: null },
    shopifyRefreshTokenExpiresAt: { not: null },
    shopifyGrantedScopes: { not: null },
  };
}

export async function findEmbeddedConnectedBrand(
  shopDomain: string,
  clientId: string,
): Promise<EmbeddedConnectedBrand | null> {
  const brand = await prisma.brand.findFirst({
    where: {
      ...buildEmbeddedConnectedBrandWhere(shopDomain, clientId),
    },
    select: {
      id: true,
      name: true,
      shopifyConnectionStatus: true,
    },
  });

  return brand
    ? {
        ...brand,
        shopifyConnectionStatus: "CONNECTED",
      }
    : null;
}

export async function disconnectEmbeddedConnectedBrand(input: {
  brandId: string;
  shopDomain: string;
  clientId: string;
}) {
  return prisma.brand.updateMany({
    where: {
      id: input.brandId,
      shopifyShopDomain: input.shopDomain,
      shopifyConnectionStatus: "CONNECTED",
      shopifyClientId: input.clientId,
    },
    data: buildLocalShopifyDisconnectData(),
  });
}
