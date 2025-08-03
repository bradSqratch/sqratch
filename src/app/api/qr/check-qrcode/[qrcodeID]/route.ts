// /src/app/api/qr/check-qrcode/[qrcodeID]/route.ts

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ qrcodeID: string }> }
) {
  // ⬇️ Must await context.params!
  const { qrcodeID } = await context.params;
  const campaignId = request.nextUrl.searchParams.get("campaignId");

  if (!qrcodeID || !campaignId) {
    return NextResponse.json(
      { error: "Missing QR code ID or campaign ID." },
      { status: 400 }
    );
  }

  try {
    // qrCodeData is the qrcodeID
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
  } catch (error) {
    return NextResponse.json(
      { status: "INVALID", error: "Server error." },
      { status: 500 }
    );
  }
}
