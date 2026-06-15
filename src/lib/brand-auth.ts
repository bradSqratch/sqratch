import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

export type BrandAdminContext = {
  userId: string;
  membership: {
    id: string;
    role: "ADMIN" | "MANAGER" | "VIEWER";
      brand: {
        id: string;
        name: string;
        slug: string;
        bio: string | null;
        websiteUrl: string | null;
        logoUrl: string | null;
        coverImageUrl: string | null;
        shopifyShopDomain: string | null;
        shopifyAdminAccessTokenEncrypted: string | null;
        shopifyInstalledAt: Date | null;
        shopifyDisconnectedAt: Date | null;
        shopifyUninstalledAt: Date | null;
        shopifyConnectionStatus: "DISCONNECTED" | "CONNECTED" | "UNINSTALLED" | "REQUIRES_RECONNECT";
        shopifyLastProductSyncAt: Date | null;
        shopifyCurrencyCode: string | null;
      };
  } | null;
};

export async function getBrandAdminContext(options?: {
  allowWithoutBrand?: boolean;
}): Promise<BrandAdminContext | null> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;
  const role = session?.user?.role || null;

  if (!userId || role !== "BRAND_ADMIN") {
    return null;
  }

  const membership = await prisma.brandMember.findFirst({
    where: {
      userId,
      role: {
        in: ["ADMIN", "MANAGER"],
      },
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      role: true,
      brand: {
        select: {
          id: true,
          name: true,
          slug: true,
          bio: true,
          websiteUrl: true,
          logoUrl: true,
          coverImageUrl: true,
          shopifyShopDomain: true,
          shopifyAdminAccessTokenEncrypted: true,
          shopifyInstalledAt: true,
          shopifyDisconnectedAt: true,
          shopifyUninstalledAt: true,
          shopifyConnectionStatus: true,
          shopifyLastProductSyncAt: true,
          shopifyCurrencyCode: true,
        },
      },
    },
  });

  if (!membership && !options?.allowWithoutBrand) {
    return null;
  }

  return {
    userId,
    membership,
  };
}

export async function getBrandManagementContext(options?: {
  allowWithoutBrand?: boolean;
}): Promise<BrandAdminContext | null> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;

  if (!userId) {
    return null;
  }

  const membership = await prisma.brandMember.findFirst({
    where: {
      userId,
      role: {
        in: ["ADMIN", "MANAGER"],
      },
    },
    orderBy: {
      createdAt: "asc",
    },
    select: {
      id: true,
      role: true,
      brand: {
        select: {
          id: true,
          name: true,
          slug: true,
          bio: true,
          websiteUrl: true,
          logoUrl: true,
          coverImageUrl: true,
          shopifyShopDomain: true,
          shopifyAdminAccessTokenEncrypted: true,
          shopifyInstalledAt: true,
          shopifyDisconnectedAt: true,
          shopifyUninstalledAt: true,
          shopifyConnectionStatus: true,
          shopifyLastProductSyncAt: true,
          shopifyCurrencyCode: true,
        },
      },
    },
  });

  if (!membership && !options?.allowWithoutBrand) {
    return null;
  }

  return {
    userId,
    membership,
  };
}

export async function getOwnedBrandCampaign(
  campaignId: string,
  brandId: string,
) {
  return prisma.campaign.findFirst({
    where: {
      id: campaignId,
      brandId,
    },
    select: {
      id: true,
      name: true,
      slug: true,
      description: true,
      isActive: true,
      brandId: true,
    },
  });
}

export function slugifyValue(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}
