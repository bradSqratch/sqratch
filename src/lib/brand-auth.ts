import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { resolveActiveBrandContext } from "@/lib/brand-context";

export type BrandAdminContext = {
  userId: string;
  selectionRequired: boolean;
  brands: Array<{
    id: string;
    name: string;
    slug: string;
    membershipRole: "ADMIN" | "MANAGER" | "VIEWER";
  }>;
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

/**
 * Single source of truth for Brand-management / Shopify-management eligibility.
 *
 * Policy (see docs/agent-context.md "Brand-management authorization policy"):
 *  - global role must be BRAND_ADMIN or ADMIN — USER and CREATOR are always
 *    denied, even if a stray BrandMember row exists for that user.
 *  - BRAND_ADMIN must additionally hold an ADMIN or MANAGER BrandMember row on
 *    an active Brand (VIEWER-only membership does not qualify).
 *  - ADMIN may act on any active Brand but must explicitly select one — no
 *    Brand is ever silently defaulted on the administrator's behalf when more
 *    than one is available.
 *
 * Both `getBrandAdminContext` and `getBrandManagementContext` delegate to this
 * one implementation so the page-layer gate and every API-layer gate apply
 * identical eligibility criteria.
 */
async function resolveBrandManagementContext(options?: {
  allowWithoutBrand?: boolean;
}): Promise<BrandAdminContext | null> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;
  const role = session?.user?.role || null;

  if (!userId || (role !== "BRAND_ADMIN" && role !== "ADMIN")) {
    return null;
  }

  const active = await resolveActiveBrandContext({
    userId,
    minimumRole: "MANAGER",
  });
  const membership = active?.membership || null;

  if (!membership && !options?.allowWithoutBrand && !active?.selectionRequired) {
    return null;
  }

  return {
    userId,
    membership,
    brands: active?.brands || [],
    selectionRequired: Boolean(active?.selectionRequired),
  };
}

export async function getBrandAdminContext(options?: {
  allowWithoutBrand?: boolean;
}): Promise<BrandAdminContext | null> {
  return resolveBrandManagementContext(options);
}

export async function getBrandManagementContext(options?: {
  allowWithoutBrand?: boolean;
}): Promise<BrandAdminContext | null> {
  return resolveBrandManagementContext(options);
}

export function getBrandContextFailure(context: BrandAdminContext | null) {
  if (context?.selectionRequired) {
    return {
      code: "ACTIVE_BRAND_REQUIRED" as const,
      error: "Select an active brand before continuing.",
      status: 409 as const,
    };
  }

  return {
    error: "Brand admin access required.",
    status: 403 as const,
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
