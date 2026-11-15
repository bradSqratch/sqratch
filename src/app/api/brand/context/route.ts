import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { assertExpectedBrand } from "@/lib/brand-auth";
import {
  ACTIVE_BRAND_COOKIE,
  listAuthorizedBrandMemberships,
  resolveActiveBrandContext,
  validateBrandSelection,
} from "@/lib/brand-context";

export async function GET() {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const context = await resolveActiveBrandContext({
    userId,
    minimumRole: "MANAGER",
  });
  return NextResponse.json({
    data: {
      activeBrandId: context?.membership?.brand.id || null,
      selectionRequired: context?.selectionRequired || false,
      brands: context?.brands || (await listAuthorizedBrandMemberships(userId)).map((membership) => ({
        id: membership.brand.id,
        name: membership.brand.name,
        slug: membership.brand.slug,
        membershipRole: membership.role,
      })),
    },
  });
}

export async function POST(request: NextRequest) {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id;
  if (!userId) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const current = await resolveActiveBrandContext({ userId, minimumRole: "MANAGER" });
  if (current?.membership) {
    const mismatch = assertExpectedBrand(request, current);
    if (mismatch) return NextResponse.json(mismatch, { status: mismatch.status });
  }

  const body = await request.json().catch(() => null);
  const brandId = String(body?.brandId || "").trim();
  const membership = brandId ? await validateBrandSelection(userId, brandId) : null;
  if (!membership || membership.role === "VIEWER") {
    return NextResponse.json({ error: "You are not authorized for this brand." }, { status: 403 });
  }

  const response = NextResponse.json({
    data: {
      activeBrandId: membership.brand.id,
      brand: {
        id: membership.brand.id,
        name: membership.brand.name,
        slug: membership.brand.slug,
        membershipRole: membership.role,
      },
    },
  });
  response.cookies.set(ACTIVE_BRAND_COOKIE, membership.brand.id, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return response;
}
