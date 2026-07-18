import { cookies } from "next/headers";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import type { CustomSession } from "@/lib/auth-session";
import prisma from "@/lib/prisma";

export const ACTIVE_BRAND_COOKIE = "sqratch_active_brand_id";
export type BrandAccessRole = "ADMIN" | "MANAGER" | "VIEWER";

const BRAND_SELECT = {
  id: true,
  name: true,
  slug: true,
  isActive: true,
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
} as const;

const ROLE_RANK: Record<BrandAccessRole, number> = {
  VIEWER: 1,
  MANAGER: 2,
  ADMIN: 3,
};

export type ActiveBrandContext = {
  userId: string;
  globalRole: string;
  membership: {
    id: string;
    role: BrandAccessRole;
    brand: {
      id: string;
      name: string;
      slug: string;
      isActive: boolean;
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
  brands: Array<{ id: string; name: string; slug: string; membershipRole: BrandAccessRole }>;
  selectionRequired: boolean;
};

async function trySetCookie(brandId: string) {
  try {
    const store = await cookies();
    store.set(ACTIVE_BRAND_COOKIE, brandId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
    });
  } catch {
    // Server components cannot always mutate cookies; API switch routes do.
  }
}

export async function setActiveBrandCookie(brandId: string) {
  await trySetCookie(brandId);
}

export async function clearActiveBrandCookie() {
  try {
    const store = await cookies();
    store.set(ACTIVE_BRAND_COOKIE, "", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 0,
    });
  } catch {
    // Best effort outside route handlers.
  }
}

export async function listAuthorizedBrandMemberships(userId: string) {
  return prisma.brandMember.findMany({
    where: { userId, brand: { isActive: true } },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      role: true,
      brand: { select: { id: true, name: true, slug: true } },
    },
  });
}

export async function validateBrandSelection(userId: string, brandId: string) {
  const membership = await prisma.brandMember.findFirst({
    where: { userId, brandId, brand: { isActive: true } },
    select: { id: true, role: true, brand: { select: BRAND_SELECT } },
  });

  if (membership) return membership;

  const session = await getServerSession(authOptions);
  if (session?.user?.id !== userId || session.user.role !== "ADMIN") {
    return null;
  }

  const brand = await prisma.brand.findUnique({
    where: { id: brandId },
    select: BRAND_SELECT,
  });
  return brand && brand.isActive
    ? { id: brand.id, role: "ADMIN" as const, brand }
    : null;
}

export async function resolveActiveBrandContext(options?: {
  userId?: string;
  minimumRole?: BrandAccessRole;
  session?: CustomSession | null;
}): Promise<ActiveBrandContext | null> {
  const session = options?.session ?? (await getServerSession(authOptions));
  const userId = options?.userId || session?.user?.id;
  if (!userId) return null;

  const globalRole = session?.user?.role || "USER";
  const minimumRole = options?.minimumRole || "VIEWER";
  let memberships = await prisma.brandMember.findMany({
    where: { userId, brand: { isActive: true } },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true, brand: { select: BRAND_SELECT } },
  });

  // Global ADMIN is intentionally not limited by BrandMember rows, but still
  // needs an explicit active-brand selection before a brand-scoped operation.
  // This preserves the admin control plane without ever choosing an arbitrary
  // brand on the administrator's behalf.
  if (globalRole === "ADMIN") {
    const adminBrands = await prisma.brand.findMany({
      where: { isActive: true },
      orderBy: { createdAt: "asc" },
      select: BRAND_SELECT,
    });
    memberships = adminBrands.map((brand) => ({
      id: brand.id,
      role: "ADMIN" as const,
      brand,
    }));
  }
  const eligible = memberships.filter(
    (membership) => ROLE_RANK[membership.role] >= ROLE_RANK[minimumRole],
  );
  const summaries = eligible.map((membership) => ({
    id: membership.brand.id,
    name: membership.brand.name,
    slug: membership.brand.slug,
    membershipRole: membership.role,
  }));

  if (eligible.length === 0) {
    return { userId, globalRole, membership: null, brands: summaries, selectionRequired: false };
  }

  let activeId: string | null = null;
  try {
    activeId = (await cookies()).get(ACTIVE_BRAND_COOKIE)?.value || null;
  } catch {
    activeId = null;
  }

  let selected = activeId
    ? eligible.find((membership) => membership.brand.id === activeId) || null
    : null;
  if (!selected && eligible.length === 1) {
    selected = eligible[0];
    await trySetCookie(selected.brand.id);
  }

  if (!selected) {
    await clearActiveBrandCookie();
  }

  return {
    userId,
    globalRole,
    membership: selected,
    brands: summaries,
    selectionRequired: eligible.length > 1 && !selected,
  };
}

export async function requireActiveBrandContext(options?: {
  minimumRole?: BrandAccessRole;
}) {
  return resolveActiveBrandContext(options);
}

export { BRAND_SELECT };
