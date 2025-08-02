import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma"; // Ensure prisma is correctly configured

export const dynamic = "force-dynamic"; // Forces the route to be dynamic and prevents caching

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const qrCodeId = searchParams.get("qrId");

  if (!qrCodeId) {
    return NextResponse.json(
      { error: "QR code id is required" },
      { status: 400 }
    );
  }

  try {
    const qrCode = await prisma.qRCode.findUnique({
      where: { id: qrCodeId },
    });

    if (!qrCode) {
      return NextResponse.json({ error: "QR code not found" }, { status: 404 });
    }

    return NextResponse.json(qrCode);
  } catch (error: any) {
    console.error("Error fetching single QR code:", error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
