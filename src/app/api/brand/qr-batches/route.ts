import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { resolveSession, resolveBrandAdminContext } from "@/lib/auth-session";
import { assertExpectedBrand } from "@/lib/brand-auth";
import { getBrandContextFailure } from "@/lib/brand-auth";

import prisma from "@/lib/prisma";
import { unusedQrWhere } from "@/lib/qr-lifecycle";
import QRCode from "qrcode";
import { v2 as cloudinary } from "cloudinary";
import { nanoid } from "nanoid";

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

function buildBatchName(baseName: string) {
  return `${baseName} ${new Date().toISOString().slice(0, 10)}`;
}

export async function GET(request: NextRequest) {
  try {
    const session = await resolveSession();

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const brand = await resolveBrandAdminContext();
    if (!brand?.membership?.brand) {
      const failure = getBrandContextFailure(brand);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }
    const brandId = brand.membership.brand.id;

    const PAGE_SIZE = 100;
    const MAX_PAGE_SIZE = 200;
    const page = Math.max(1, parseInt(request.nextUrl.searchParams.get("page") ?? "1", 10) || 1);
    const take = Math.min(
      Math.max(1, parseInt(request.nextUrl.searchParams.get("pageSize") ?? String(PAGE_SIZE), 10) || PAGE_SIZE),
      MAX_PAGE_SIZE,
    );
    const skip = (page - 1) * take;

    const [batches, campaigns, qrCodes, qrCodeTotal] = await Promise.all([
      prisma.qRCodeBatch.findMany({
        where: {
          campaign: {
            brandId,
          },
        },
        orderBy: [
          { createdAt: "desc" },
          { id: "asc" },
        ],
        take: 500,
        select: {
          id: true,
          name: true,
          createdAt: true,
          csvExportedAt: true,
          printedAt: true,
          qrCodes: { where: { NOT: { ...unusedQrWhere, campaign: { brandId } } }, select: { id: true }, take: 1 },
          campaign: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
          _count: {
            select: {
              qrCodes: true,
            },
          },
        },
      }),
      prisma.campaign.findMany({
        where: {
          brandId,
        },
        orderBy: [
          { name: "asc" },
          { id: "asc" },
        ],
        take: 500,
        select: {
          id: true,
          name: true,
          slug: true,
        },
      }),
      prisma.qRCode.findMany({
        where: {
          campaign: {
            brandId,
          },
        },
        orderBy: [
          { createdAt: "desc" },
          { id: "asc" },
        ],
        take,
        skip,
        select: {
          id: true,
          qrCodeData: true,
          status: true,
          qrCodeUrl: true,
          email: true,
          usedAt: true,
          createdAt: true,
          batch: {
            select: {
              id: true,
              name: true,
            },
          },
          campaign: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
          redeemedBy: {
            select: {
              id: true,
              email: true,
              name: true,
            },
          },
        },
      }),
      prisma.qRCode.count({ where: { campaign: { brandId } } }),
    ]);

    return NextResponse.json({
      data: {
        batches: batches.map((batch) => ({
          id: batch.id,
          name: batch.name,
          createdAt: batch.createdAt,
          quantity: batch._count.qrCodes,
          canDelete: !batch.csvExportedAt && !batch.printedAt && batch.qrCodes.length === 0,
          campaign: batch.campaign,
        })),
        campaigns,
        qrCodes: qrCodes.map((qrCode) => ({
          id: qrCode.id,
          code: qrCode.qrCodeData,
          status: qrCode.status === "USED" ? "REDEEMED" : "NEW",
          imageUrl: qrCode.qrCodeUrl,
          usedAt: qrCode.usedAt,
          createdAt: qrCode.createdAt,
          batch: qrCode.batch,
          campaign: qrCode.campaign,
          usedBy:
            qrCode.redeemedBy?.name ||
            qrCode.redeemedBy?.email ||
            null,
          usedByEmail: qrCode.redeemedBy?.email || qrCode.email || null,
        })),
        pagination: {
          page,
          pageSize: take,
          total: qrCodeTotal,
          totalPages: Math.ceil(qrCodeTotal / take),
        },
      },
    });
  } catch (error) {
    console.error("[brand/qr-batches][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load QR batches." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const session = await resolveSession();

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const campaignId = String(body?.campaignId || "").trim();
    const quantity = Number(body?.quantity || 0);
    const batchName = String(body?.batchName || "").trim();
    const domain = (
      process.env.DOMAIN ||
      process.env.NEXT_PUBLIC_APP_URL ||
      process.env.NEXTAUTH_URL ||
      request.nextUrl.origin
    ).replace(/\/$/, "");

    if (!campaignId || !Number.isInteger(quantity) || quantity <= 0) {
      return NextResponse.json(
        { error: "campaignId and a positive integer quantity are required." },
        { status: 400 },
      );
    }

    if (quantity > 5000) {
      return NextResponse.json(
        { error: "Quantity too large. Maximum supported batch is 5000." },
        { status: 400 },
      );
    }

    const brand = await resolveBrandAdminContext();
    if (!brand?.membership?.brand) {
      const failure = getBrandContextFailure(brand);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }
    const mismatch = assertExpectedBrand(request, brand);
    if (mismatch) return NextResponse.json(mismatch, { status: mismatch.status });
    const brandId = brand.membership.brand.id;
    const userId = session.user.id;

    const campaign = await prisma.campaign.findFirst({
      where: {
        id: campaignId,
        brandId,
      },
      select: {
        id: true,
        name: true,
      },
    });

    if (!campaign) {
      return NextResponse.json(
        { error: "Campaign not found." },
        { status: 404 },
      );
    }

    const resolvedBatchName = batchName || buildBatchName(campaign.name);

    const existingBatch = await prisma.qRCodeBatch.findFirst({
      where: {
        name: resolvedBatchName,
        campaign: {
          brandId,
        },
      },
      select: {
        id: true,
      },
    });

    if (existingBatch) {
      return NextResponse.json(
        { error: "Batch name already exists. Please choose a different name." },
        { status: 409 },
      );
    }

    // The batch remains invisible until every image is ready and its rows
    // commit together. Export and deletion cannot observe a partial batch.
    const batch = { id: randomUUID(), name: resolvedBatchName };
    const campaignFolder = `qrCodes/${campaign.name.replace(/[\\/]/g, "-")}/${batch.id}`;
    const createdRecords: Array<{
      qrCodeData: string;
      qrCodeUrl: string;
      status: "NEW";
      campaignId: string;
      batchId: string;
      createdById: string;
    }> = [];
    let generationFailed = false;
    for (let index = 0; index < quantity; index += 50) {
      const items = Array.from({ length: Math.min(50, quantity - index) }, async () => {
        const qrCodeData = nanoid();
        const buffer = await QRCode.toBuffer(`${domain}/q/${qrCodeData}`, {
          type: "png", width: 500, color: { dark: "#000000", light: "#ffffff" },
        });
        const result = await cloudinary.uploader.upload(`data:image/png;base64,${buffer.toString("base64")}`, {
          folder: campaignFolder, public_id: `qr_${qrCodeData}`, overwrite: false, resource_type: "image",
        });
        return { qrCodeData, qrCodeUrl: result.secure_url, status: "NEW" as const, campaignId: campaign.id, batchId: batch.id, createdById: userId };
      });
      const results = await Promise.allSettled(items);
      for (const result of results) {
        if (result.status === "fulfilled") createdRecords.push(result.value);
        else { generationFailed = true; console.error("[brand/qr-batches][POST] QR generation failed:", result.reason); }
      }
      if (generationFailed) break;
    }
    if (generationFailed) {
      // These confirmed uploads were never submitted to the database. A failed
      // upload with an unknown provider outcome is intentionally retained.
      await Promise.all(createdRecords.map(async qr => {
        try { await cloudinary.uploader.destroy(`${campaignFolder}/qr_${qr.qrCodeData}`, { resource_type: "image" }); }
        catch (error) { console.error("[brand/qr-batches][POST] Cleanup failed:", error); }
      }));
      return NextResponse.json({ error: "Failed to generate QR batch." }, { status: 500 });
    }
    // Once submitted, a lost database response may hide a successful commit;
    // retain uploaded assets on any transaction error.
    await prisma.$transaction(async tx => {
      await tx.qRCodeBatch.create({ data: { id: batch.id, campaignId: campaign.id, name: batch.name } });
      await tx.qRCode.createMany({ data: createdRecords });
    }, { timeout: 30000 });

    return NextResponse.json(
      {
        data: {
          batch: {
            id: batch.id,
            name: batch.name,
            campaignId: campaign.id,
            quantity: createdRecords.length,
          },
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[brand/qr-batches][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to generate QR batch." },
      { status: 500 },
    );
  }
}
