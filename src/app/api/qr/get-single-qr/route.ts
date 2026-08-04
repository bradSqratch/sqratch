import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";
import { getBrandContextFailure } from "@/lib/brand-auth";

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

  const brand = await deps.resolveBrandAdminContext();
  if (!brand?.membership?.brand) {
    const failure = getBrandContextFailure(brand);
    return NextResponse.json(
      { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
      { status: failure.status },
    );
  }
  const brandId = brand.membership.brand.id;

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
        campaign: { brandId },
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
