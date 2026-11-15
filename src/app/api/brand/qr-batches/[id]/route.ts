import { NextRequest, NextResponse } from "next/server";
import { v2 as cloudinary } from "cloudinary";
import prisma from "@/lib/prisma";
import { resolveSession, resolveBrandAdminContext } from "@/lib/auth-session";
import { assertExpectedBrand, getBrandContextFailure } from "@/lib/brand-auth";
import { cloudinaryPublicId, deleteUnusedQrCodes, describeQrDeletionBlockers, lockQrBatch, QrDeletionBlocked } from "@/lib/qr-lifecycle";

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let codeIds: string[] = [];
  let distributed = false;
  try {
    if (!await resolveSession()) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const brand = await resolveBrandAdminContext();
    if (!brand?.membership?.brand) {
      const failure = getBrandContextFailure(brand);
      return NextResponse.json({ error: failure.error, ...(failure.code ? { code: failure.code } : {}) }, { status: failure.status });
    }
    const mismatch = assertExpectedBrand(request, brand);
    if (mismatch) return NextResponse.json(mismatch, { status: mismatch.status });
    const brandId = brand.membership.brand.id;
    const { id } = await params;
    const result = await prisma.$transaction(async tx => {
      await lockQrBatch(tx, id);
      const batch = await tx.qRCodeBatch.findFirst({ where: { id, campaign: { brandId } }, select: { id: true, csvExportedAt: true, printedAt: true, qrCodes: { select: { id: true, qrCodeUrl: true } } } });
      if (!batch) return null;
      codeIds = batch.qrCodes.map(qr => qr.id);
      if (batch.csvExportedAt || batch.printedAt) { distributed = true; throw new QrDeletionBlocked(); }
      await deleteUnusedQrCodes(tx, { codeIds, brandId });
      await tx.qRCodeBatch.delete({ where: { id } });
      return batch.qrCodes;
    });
    if (!result) return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    for (const qr of result) if (qr.qrCodeUrl) {
      try { const publicId = cloudinaryPublicId(qr.qrCodeUrl); if (publicId) await cloudinary.uploader.destroy(publicId, { resource_type: "image" }); }
      catch (error) { console.error("[brand/qr-batches][DELETE] Cloudinary deletion failed:", error); }
    }
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    if (error instanceof QrDeletionBlocked) {
      const blockers = await describeQrDeletionBlockers(prisma, codeIds);
      if (distributed && blockers.distributed === 0) blockers.distributed = 1;
      return NextResponse.json({ error: "QR codes with history or distributed batches cannot be deleted.", code: "QR_HAS_HISTORY", blockers }, { status: 409 });
    }
    console.error("[brand/qr-batches][DELETE] Error:", error);
    return NextResponse.json({ error: "Failed to delete batch." }, { status: 500 });
  }
}
