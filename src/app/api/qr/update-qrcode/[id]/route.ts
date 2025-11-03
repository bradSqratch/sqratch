import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import QRCode from "qrcode";
import { v2 as cloudinary } from "cloudinary";

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export async function PATCH(
  req: Request,
  context: { params: Promise<{ id: string }> }
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { id } = await context.params;

  const { campaignId, status, usedBy, usedAt } = await req.json();

  let user = null;
  if (usedBy) {
    user = await prisma.user.findUnique({ where: { email: usedBy } });
    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 400 });
    }
  }

  const existingQRCode = await prisma.qRCode.findUnique({
    where: { id },
  });

  if (!existingQRCode) {
    return NextResponse.json({ error: "QR code not found" }, { status: 404 });
  }

  let newImageUrl = existingQRCode.qrCodeUrl;
  const campaignChanged = campaignId !== existingQRCode.campaignId;

  if (campaignChanged) {
    // Step 1: Delete old QR image from Cloudinary
    if (existingQRCode.qrCodeUrl) {
      try {
        const urlObj = new URL(existingQRCode.qrCodeUrl);
        // Extract public_id by finding the "upload" segment and taking the path after cloud name
        // URL pattern: https://res.cloudinary.com/<cloud>/image/upload/v<ver>/qrCodes/.../<public_id>.<ext>
        const path = urlObj.pathname; // /<cloud>/image/upload/v123/qrCodes/.../qr_xxx.png
        const uploadIdx = path.indexOf("/upload/");
        if (uploadIdx !== -1) {
          const afterUpload = path.substring(uploadIdx + "/upload/".length);
          // remove leading version if present (e.g., v123/)
          const afterVersion = afterUpload.replace(/^v\d+\//, "");
          // remove extension
          const publicId = afterVersion.replace(/\.[^.]+$/, "");
          await cloudinary.uploader.destroy(publicId, {
            resource_type: "image",
          });
        }
      } catch (err) {
        console.error("Cloudinary deletion failed:", err);
      }
    }

    // Step 2: Generate new QR image using same qrCodeData
    const qrData = existingQRCode.qrCodeData;
    const redeemUrl = `https://sqratch-qrcode.vercel.app/redeemQR/${campaignId}/${qrData}`;
    const buffer = await QRCode.toBuffer(redeemUrl, {
      type: "png",
      width: 500,
      color: {
        dark: "#000000",
        light: "#0000",
      },
    });
    const dataUri = "data:image/png;base64," + buffer.toString("base64");

    // Ensure folder for target campaign exists
    const targetCampaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { name: true },
    });
    const targetFolder = `qrCodes/${(
      targetCampaign?.name ?? "_unknown"
    ).replace(/[\\/]/g, "-")}`;
    try {
      await cloudinary.api.create_folder(targetFolder);
    } catch (e: any) {
      if (!(e?.http_code === 409 || /already exists/i.test(e?.message || ""))) {
        console.warn("Cloudinary create_folder warning:", e?.message || e);
      }
    }

    const cloudinaryPublicId = `qr_${qrData}`;

    const uploadResult = await cloudinary.uploader.upload(dataUri, {
      folder: targetFolder,
      public_id: cloudinaryPublicId,
      overwrite: true,
      resource_type: "image",
    });

    newImageUrl = uploadResult.secure_url;
  }

  await prisma.qRCode.update({
    where: { id },
    data: {
      campaignId,
      status,
      usedAt: usedAt ? new Date(usedAt) : null,
      redeemedById: user?.id || null,
      email: usedBy || null,
      qrCodeUrl: newImageUrl,
    },
  });

  return NextResponse.json({ success: true });
}
