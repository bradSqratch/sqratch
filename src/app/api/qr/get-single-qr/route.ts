import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { getBrandAdminContext, BrandAdminContext } from "@/lib/brand-auth";

export const dynamic = "force-dynamic";

interface CustomSession {
  user: {
    id: string;
    role: string;
    email?: string | null;
  };
}

export async function GET(request: NextRequest) {
  const g = globalThis as Record<string, unknown>;
  const mockSession = g.__mockGetServerSession as
    | ((options: unknown) => Promise<CustomSession | null>)
    | undefined;
  const session = mockSession
    ? await mockSession(authOptions)
    : ((await getServerSession(authOptions)) as CustomSession | null);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let brandId: string | null = null;
  if (session.user.role === "BRAND_ADMIN") {
    const mockBrandCtx = g.__mockGetBrandAdminContext as (() => Promise<BrandAdminContext | null>) | undefined;
    const brand = mockBrandCtx
      ? await mockBrandCtx()
      : await getBrandAdminContext();
    if (!brand?.membership?.brand) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    brandId = brand.membership.brand.id;
  } else if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const qrCodeId = searchParams.get("qrId");

  if (!qrCodeId) {
    return NextResponse.json(
      { error: "QR code id is required" },
      { status: 400 }
    );
  }

  try {
    const qrCode = await prisma.qRCode.findFirst({
      where: {
        id: qrCodeId,
        ...(brandId ? { campaign: { brandId } } : {}),
      },
      select: {
        id: true,
        qrCodeData: true,
        status: true,
        qrCodeUrl: true,
        email: true,
        usedAt: true,
        createdAt: true,
        campaignId: true,
        redeemedBy: {
          select: {
            id: true,
            email: true,
            name: true,
          },
        },
      },
    });

    if (!qrCode) {
      return NextResponse.json({ error: "QR code not found" }, { status: 404 });
    }

    return NextResponse.json(qrCode);
  } catch (error: unknown) {
    console.error("Error fetching single QR code:", error);
    return NextResponse.json({ error: "Failed to fetch QR code." }, { status: 500 });
  }
}
