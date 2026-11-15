import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { v2 as cloudinary } from "cloudinary";
import prisma from "@/lib/prisma";
import { type AuthResolvers, realAuthResolvers } from "@/lib/auth-session";
import { assertExpectedBrand, getBrandContextFailure } from "@/lib/brand-auth";
import { cloudinaryPublicId, deleteUnusedQrCodes, describeQrDeletionBlockers, lockQrBatch, lockQrCodes, QrDeletionBlocked, unusedQrWhere } from "@/lib/qr-lifecycle";

cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET, secure: true });

async function destroyImage(url: string | null) {
  if (!url) return;
  try { const id = cloudinaryPublicId(url); if (id) await cloudinary.uploader.destroy(id, { resource_type: "image" }); }
  catch (error) { console.error("[brand/qr-codes] Cloudinary deletion failed:", error); }
}

async function authorize(request: NextRequest, deps: AuthResolvers) {
  if (!await deps.resolveSession()) return { response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  const brand = await deps.resolveBrandAdminContext();
  if (!brand?.membership?.brand) {
    const failure = getBrandContextFailure(brand);
    return { response: NextResponse.json({ error: failure.error, ...(failure.code ? { code: failure.code } : {}) }, { status: failure.status }) };
  }
  const mismatch = assertExpectedBrand(request, brand);
  if (mismatch) return { response: NextResponse.json(mismatch, { status: mismatch.status }) };
  return { brandId: brand.membership.brand.id };
}

async function blocked(id: string) {
  return NextResponse.json({ error: "QR codes with history or distribution cannot be changed or deleted.", code: "QR_HAS_HISTORY", blockers: await describeQrDeletionBlockers(prisma, [id]) }, { status: 409 });
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return patchQrCodeImpl(request, context, realAuthResolvers);
}

export async function patchQrCodeImpl(request: NextRequest, { params }: { params: Promise<{ id: string }> }, deps: AuthResolvers, runTransaction: (fn: (tx: Prisma.TransactionClient) => Promise<boolean>) => Promise<boolean> = fn => prisma.$transaction(fn)) {
  try {
    const auth = await authorize(request, deps); if (auth.response) return auth.response;
    const { id } = await params;
    const body = await request.json().catch(() => null);
    const campaignId = typeof body?.campaignId === "string" ? body.campaignId.trim() : "";
    if (!campaignId) return NextResponse.json({ error: "campaignId is required." }, { status: 400 });
    const existing = await prisma.qRCode.findFirst({ where: { id, campaign: { brandId: auth.brandId } }, select: { id: true, qrCodeData: true, qrCodeUrl: true, campaignId: true, status: true, batchId: true } });
    if (!existing) return NextResponse.json({ error: "QR code not found." }, { status: 404 });
    if (body.status !== undefined && body.status !== existing.status) return NextResponse.json({ error: "QR status cannot be changed.", code: "QR_STATUS_IMMUTABLE" }, { status: 409 });
    if (body.usedBy !== undefined || body.usedAt !== undefined) return NextResponse.json({ error: "Redemption details cannot be changed." }, { status: 400 });
    const target = await prisma.campaign.findFirst({ where: { id: campaignId, brandId: auth.brandId }, select: { id: true, name: true } });
    if (!target) return NextResponse.json({ error: "Target campaign not found." }, { status: 404 });
    if (campaignId === existing.campaignId) return NextResponse.json({ data: { success: true } });
    const scanUrl = `${(process.env.DOMAIN || process.env.NEXT_PUBLIC_APP_URL || process.env.NEXTAUTH_URL || request.nextUrl.origin).replace(/\/$/, "")}/q/${existing.qrCodeData}`;
    const buffer = await QRCode.toBuffer(scanUrl, { type: "png", width: 500, color: { dark: "#000000", light: "#ffffff" } });
    const upload = await cloudinary.uploader.upload(`data:image/png;base64,${buffer.toString("base64")}`, { folder: `qrCodes/${target.name.replace(/[\\/]/g, "-")}`, public_id: `qr_${existing.qrCodeData}_${randomUUID()}`, overwrite: false, resource_type: "image" });
    // Only a confirmed rejected update is safe to clean up. A failed transaction
    // may have committed despite a lost response, so retain the new asset then.
    const updated = await runTransaction(async tx => {
      if (existing.batchId) await lockQrBatch(tx, existing.batchId);
      await lockQrCodes(tx, [id]);
      const result = await tx.qRCode.updateMany({ where: { id, campaignId: existing.campaignId, qrCodeUrl: existing.qrCodeUrl, batchId: existing.batchId, campaign: { brandId: auth.brandId }, ...unusedQrWhere, OR: [{ batchId: null }, { batch: { is: { csvExportedAt: null, printedAt: null } } }] }, data: { campaignId, qrCodeUrl: upload.secure_url } });
      return result.count === 1;
    });
    if (!updated) { await destroyImage(upload.secure_url); return blocked(id); }
    await destroyImage(existing.qrCodeUrl);
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    console.error("[brand/qr-codes][PATCH] Error:", error);
    return NextResponse.json({ error: "Failed to update QR code." }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return deleteQrCodeImpl(request, context, realAuthResolvers);
}

export async function deleteQrCodeImpl(request: NextRequest, { params }: { params: Promise<{ id: string }> }, deps: AuthResolvers) {
  let id = "";
  try {
    const auth = await authorize(request, deps); if (auth.response) return auth.response;
    ({ id } = await params);
    const record = await prisma.qRCode.findFirst({ where: { id, campaign: { brandId: auth.brandId } }, select: { id: true, batchId: true } });
    if (!record) return NextResponse.json({ error: "QR code not found." }, { status: 404 });
    const imageUrl = await prisma.$transaction(async tx => {
      if (record.batchId) await lockQrBatch(tx, record.batchId);
      await lockQrCodes(tx, [id]);
      const current = await tx.qRCode.findFirst({ where: { id, batchId: record.batchId, campaign: { brandId: auth.brandId } }, select: { qrCodeUrl: true } });
      if (!current) throw new QrDeletionBlocked();
      await deleteUnusedQrCodes(tx, { codeIds: [id], brandId: auth.brandId! });
      return current.qrCodeUrl;
    });
    await destroyImage(imageUrl);
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    if (error instanceof QrDeletionBlocked) return blocked(id);
    console.error("[brand/qr-codes][DELETE] Error:", error);
    return NextResponse.json({ error: "Failed to delete QR code." }, { status: 500 });
  }
}
