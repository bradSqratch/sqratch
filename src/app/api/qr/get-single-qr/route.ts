import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return getSingleQrImpl(request, realAuthResolvers);
}

export async function getSingleQrImpl(
  request: NextRequest,
  deps: AuthResolvers,
) {
  const session = await deps.resolveSession();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let brandId: string | null = null;
  if (session.user.role === "BRAND_ADMIN") {
    const brand = await deps.resolveBrandAdminContext();
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
