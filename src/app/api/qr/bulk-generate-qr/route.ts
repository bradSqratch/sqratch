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
  const userId = session.user.id;
  if (!userId) {
    return NextResponse.json({ error: "Invalid session" }, { status: 401 });
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

  // Get campaign to derive folder path
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, name: true },
  });
  if (!campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  // Create a Cloudinary-safe folder path
  const campaignFolder = `qrCodes/${campaign.name.replace(/[\\/]/g, "-")}`;
  try {
    await cloudinary.api.create_folder(campaignFolder);
  } catch (error: unknown) {
    const cloudinaryError = error as { http_code?: number; message?: string };
    if (
      !(
        cloudinaryError.http_code === 409 ||
        /already exists/i.test(cloudinaryError.message || "")
      )
    ) {
      console.warn(
        "Cloudinary create_folder warning:",
        cloudinaryError.message || error,
      );
    }
  }

  type CreatedQr = {
    qrCodeData: string;
    qrCodeUrl: string;
    status: "NEW";
    campaignId: string;
    createdById: string;
  };
  const createdQRs: CreatedQr[] = [];
  const batchSize = 50; // adjust for speed vs Cloudinary limits

  for (let i = 0; i < quantity; i += batchSize) {
    const batch = Array.from({ length: Math.min(batchSize, quantity - i) }).map(
      async () => {
        const qrCodeData = nanoid();
        const redeemUrl = `${process.env.DOMAIN}/redeemQR/${campaignId}/${qrCodeData}`;

        try {
          const buffer = await QRCode.toBuffer(redeemUrl, {
            type: "png",
            width: 500,
            color: {
              dark: "#000000",
              light: "#0000",
            },
          });

          const dataUri = "data:image/png;base64," + buffer.toString("base64");

          const uploadResult = await cloudinary.uploader.upload(dataUri, {
            folder: campaignFolder,
            public_id: `qr_${qrCodeData}`,
            overwrite: false,
            resource_type: "image",
          });

          return {
            qrCodeData,
            qrCodeUrl: uploadResult.secure_url,
            status: "NEW" as const,
            campaignId,
            createdById: userId,
          };
        } catch (err) {
          console.error("QR/Cloudinary error:", err);
          return null;
        }
      }
    );

    const results = await Promise.allSettled(batch);

    const validRecords = results
      .filter(
        (result): result is PromiseFulfilledResult<CreatedQr> =>
          result.status === "fulfilled" && result.value !== null,
      )
      .map((result) => result.value);

    if (validRecords.length > 0) {
      try {
        await prisma.qRCode.createMany({ data: validRecords });
        createdQRs.push(...validRecords);
      } catch (err) {
        console.error("Prisma createMany error:", err);
      }
    }
  }

  return NextResponse.json({ count: createdQRs.length, data: createdQRs });
}
