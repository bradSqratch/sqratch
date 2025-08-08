// src/app/api/qr/bulk-generate/route.ts
import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import QRCode from "qrcode";
import { v2 as cloudinary } from "cloudinary";
import { nanoid } from "nanoid";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (request.method !== "POST") {
    return NextResponse.json({ error: "Only POST allowed" }, { status: 405 });
  }

  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  let body: { campaignId: string; quantity: number };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { campaignId, quantity } = body;
  if (!campaignId || !quantity || quantity < 1) {
    return NextResponse.json(
      { error: "campaignId and valid quantity are required" },
      { status: 400 }
    );
  }

  const createdQRs = [];

  for (let i = 0; i < quantity; i++) {
    const qrCodeData = nanoid();
    const redeemUrl = `${process.env.DOMAIN}/redeemQR/${campaignId}/${qrCodeData}`;

    const buffer = await QRCode.toBuffer(redeemUrl, {
      type: "png",
      width: 500,
      color: {
        dark: "#000000",
        light: "#0000",
      },
    });

    const dataUri = "data:image/png;base64," + buffer.toString("base64");

    let uploadResult;
    try {
      uploadResult = await cloudinary.uploader.upload(dataUri, {
        folder: "qrCodes",
        public_id: `qr_${qrCodeData}`,
        overwrite: false,
        resource_type: "image",
      });
    } catch (err: any) {
      console.error("Cloudinary upload error:", err);
      continue;
    }

    try {
      const record = await prisma.qRCode.create({
        data: {
          qrCodeData,
          qrCodeUrl: uploadResult.secure_url,
          status: "NEW",
          campaignId,
          createdById: session.user.id,
        },
      });
      createdQRs.push(record);
    } catch (err) {
      console.error("Prisma DB error:", err);
      continue;
    }
  }

  return NextResponse.json({ count: createdQRs.length, data: createdQRs });
}
