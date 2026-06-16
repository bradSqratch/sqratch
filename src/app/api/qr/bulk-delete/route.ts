import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { v2 as cloudinary } from "cloudinary";
import { getBrandAdminContext, BrandAdminContext } from "@/lib/brand-auth";

// configure cloudinary same as other route
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

export async function POST(req: Request) {
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

  let body: { ids?: string[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const ids = body.ids ?? [];
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "No ids provided" }, { status: 400 });
  }

  // get all qrcodes so we can delete from cloudinary
  const qrCodes = await prisma.qRCode.findMany({
    where: {
      id: { in: ids },
      ...(brandId ? { campaign: { brandId } } : {}),
    },
    select: { id: true, qrCodeUrl: true },
  });

  // delete images one by one (network I/O, fine to loop)
  for (const qr of qrCodes) {
    if (!qr.qrCodeUrl) continue;
    try {
      const urlObj = new URL(qr.qrCodeUrl);
      const path = urlObj.pathname;
      const uploadIdx = path.indexOf("/upload/");
      if (uploadIdx !== -1) {
        const afterUpload = path.substring(uploadIdx + "/upload/".length);
        const afterVersion = afterUpload.replace(/^v\d+\//, "");
        const publicId = afterVersion.replace(/\.[^.]+$/, "");
        await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
      }
    } catch (err) {
      console.error("Cloudinary deletion error (bulk):", err);
      // continue anyway
    }
  }

  const qrCodeIdsToDelete = qrCodes.map((q) => q.id);

  // now delete from DB in ONE query
  await prisma.qRCode.deleteMany({
    where: { id: { in: qrCodeIdsToDelete } },
  });

  return NextResponse.json({
    success: true,
    deletedCount: qrCodeIdsToDelete.length,
  });
}
