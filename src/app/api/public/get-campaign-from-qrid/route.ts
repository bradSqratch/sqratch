// src/app/api/public/campaign-from-qr/route.ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

// GET /api/public/campaign-from-qr?qrcodeID=...
export async function GET(req: NextRequest) {
  try {
    const qrcodeID = req.nextUrl.searchParams.get("qrcodeID");
    if (!qrcodeID) {
      return NextResponse.json({ error: "Missing qrcodeID" }, { status: 400 });
    }

    const qr = await prisma.qRCode.findFirst({
      where: { qrCodeData: qrcodeID },
      select: {
        campaign: {
          select: {
            name: true,
            inviteUrl: true,
            community: { select: { name: true, type: true } },
          },
        },
      },
    });

    if (!qr?.campaign) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({ data: { name: qr.campaign.name } });
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
