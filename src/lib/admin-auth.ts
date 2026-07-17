import { Role } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { slugifyValue } from "@/lib/brand-auth";

export type AdminContext = {
  userId: string;
  role: "ADMIN";
};

export async function getAdminContext(): Promise<AdminContext | null> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;
  const role = session?.user?.role || null;

  if (!userId || role !== "ADMIN") {
    return null;
  }

  return {
    userId,
    role: "ADMIN",
  };
}

export function normalizeUserRole(value: unknown): Role | null {
  const normalized = String(value || "")
    .trim()
    .toUpperCase();

  switch (normalized) {
    case "USER":
    case "CREATOR":
    case "BRAND_ADMIN":
    case "ADMIN":
      return normalized;
    default:
      return null;
  }
}

export async function createUniqueSlug(
  value: string,
  exists: (candidate: string) => Promise<boolean>,
  fallback = "item",
) {
  const baseSlug = slugifyValue(value) || fallback;
  let candidate = baseSlug;
  let suffix = 2;

  while (await exists(candidate)) {
    candidate = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return candidate;
}
