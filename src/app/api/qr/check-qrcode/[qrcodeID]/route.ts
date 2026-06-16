import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ qrcodeID: string }> }
) {
  return checkQrCodeImpl(request, context, realAuthResolvers);
}

export async function checkQrCodeImpl(
  request: NextRequest,
  context: { params: Promise<{ qrcodeID: string }> },
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

  const { qrcodeID } = await context.params;
  const campaignId = request.nextUrl.searchParams.get("campaignId");

  if (!qrcodeID || !campaignId) {
    return NextResponse.json(
      { error: "Missing QR code ID or campaign ID." },
      { status: 400 }
    );
  }

  // If BRAND_ADMIN, verify the requested campaign belongs to their brand
  if (brandId) {
    const campaignObj = await prisma.campaign.findFirst({
      where: {
        id: campaignId,
        brandId,
      },
      select: { id: true },
    });

    if (!campaignObj) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  try {
    const qr = await prisma.qRCode.findFirst({
      where: {
        qrCodeData: qrcodeID,
        campaignId: campaignId,
      },
      select: { status: true },
    });

    if (!qr) {
      return NextResponse.json(
        {
          status: "INVALID",
          message: "QR code not found or does not belong to this campaign.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({ status: qr.status }, { status: 200 });
  } catch {
    return NextResponse.json(
      { status: "INVALID", error: "Server error." },
      { status: 500 }
    );
  }
}
