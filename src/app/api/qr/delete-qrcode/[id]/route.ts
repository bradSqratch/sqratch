import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { v2 as cloudinary } from "cloudinary";
import { getBrandAdminContext, BrandAdminContext } from "@/lib/brand-auth";

// Configure Cloudinary (from env)
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

interface CustomSession {
  user: {
    id: string;
    role: string;
    email?: string | null;
  };
}

export async function DELETE(
  req: Request,
  context: { params: Promise<{ id: string }> } // ← params is a Promise
) {
  const g = globalThis as Record<string, unknown>;
  const mockSession = g.__mockGetServerSession as
    | ((options: unknown) => Promise<CustomSession | null>)
    | undefined;
  const session = mockSession
    ? await mockSession(authOptions)
    : ((await getServerSession(authOptions)) as CustomSession | null);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let brandId: string | null = null;
  if (session.user.role === "BRAND_ADMIN") {
    const mockBrandCtx = g.__mockGetBrandAdminContext as (() => Promise<BrandAdminContext | null>) | undefined;
    const brand = mockBrandCtx
      ? await mockBrandCtx()
      : await getBrandAdminContext();
    if (!brand?.membership?.brand) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    brandId = brand.membership.brand.id;
  } else if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Await the params promise to get { id }
  const { id: qrId } = await context.params;

  const record = await prisma.qRCode.findFirst({
    where: {
      id: qrId,
      ...(brandId ? { campaign: { brandId } } : {}),
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
