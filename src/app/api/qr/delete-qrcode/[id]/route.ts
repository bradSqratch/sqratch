import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { v2 as cloudinary } from "cloudinary";
import { resolveSession, resolveBrandAdminContext } from "@/lib/auth-session";

// Configure Cloudinary (from env)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> } // ← params is a Promise
) {
  const session = await resolveSession();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const brand = await resolveBrandAdminContext();
  const brandId = brand?.membership?.brand?.id || null;
  if (!brandId) {
    return NextResponse.json({ error: "Select an active brand.", code: "ACTIVE_BRAND_REQUIRED" }, { status: 409 });
  }

  // Await the params promise to get { id }
  const { id: qrId } = await context.params;

  const record = await prisma.qRCode.findFirst({
    where: {
      id: qrId,
      campaign: { brandId },
    },
    select: { qrCodeUrl: true },
  });
  if (!record) {
    return NextResponse.json({ error: "QR code not found" }, { status: 404 });
  }

  if (record.qrCodeUrl) {
    try {
      const urlObj = new URL(record.qrCodeUrl);
      const path = urlObj.pathname; // /<cloud>/image/upload/v123/qrCodes/.../qr_xxx.png
      const uploadIdx = path.indexOf("/upload/");
      if (uploadIdx !== -1) {
        const afterUpload = path.substring(uploadIdx + "/upload/".length);
        const afterVersion = afterUpload.replace(/^v\d+\//, "");
        const publicId = afterVersion.replace(/\.[^.]+$/, "");
        await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
      }
    } catch (err) {
      console.error("Cloudinary deletion error:", err);
      // proceed to delete DB row anyway
    }
  }

  await prisma.qRCode.delete({ where: { id: qrId } });
  return NextResponse.json({ success: true });
}
