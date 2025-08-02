import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { v2 as cloudinary } from "cloudinary";

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
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  // Await the params promise to get { id }
  const { id: qrId } = await context.params; // ← await here :contentReference[oaicite:0]{index=0}

  const record = await prisma.qRCode.findUnique({
    where: { id: qrId },
    select: { qrCodeUrl: true },
  });
  if (!record) {
    return NextResponse.json({ error: "QR code not found" }, { status: 404 });
  }

  if (record.qrCodeUrl) {
    try {
      const urlObj = new URL(record.qrCodeUrl);
      const segments = urlObj.pathname.split("/");
      const idx = segments.findIndex((s) => s === "qrCodes");
      if (idx !== -1 && segments.length > idx + 1) {
        const filename = segments[idx + 1];
        const publicId = `qrCodes/${filename.replace(/\.[^.]+$/, "")}`;
        await cloudinary.uploader.destroy(publicId, {
          resource_type: "image",
        });
      }
    } catch (err) {
      console.error("Cloudinary deletion error:", err);
      // proceed to delete DB row anyway
    }
  }

  await prisma.qRCode.delete({ where: { id: qrId } });
  return NextResponse.json({ success: true });
}
