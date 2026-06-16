import { NextRequest, NextResponse } from "next/server";
import { getBrandAdminContext } from "@/lib/brand-auth";
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

function buildBatchName(baseName: string) {
  return `${baseName} ${new Date().toISOString().slice(0, 10)}`;
}

export async function GET(request: NextRequest) {
  try {
    const brand = await getBrandAdminContext();

    if (!brand?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

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
            brandId: brand.membership.brand.id,
          },
        },
        orderBy: { createdAt: "desc" },
        take: 500,
        select: {
          id: true,
          name: true,
          createdAt: true,
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
          brandId: brand.membership.brand.id,
        },
        orderBy: { name: "asc" },
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
            brandId: brand.membership.brand.id,
          },
        },
        orderBy: { createdAt: "desc" },
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
      prisma.qRCode.count({ where: { campaign: { brandId: brand.membership.brand.id } } }),
    ]);

    return NextResponse.json({
      data: {
        batches: batches.map((batch) => ({
          id: batch.id,
          name: batch.name,
          createdAt: batch.createdAt,
          quantity: batch._count.qrCodes,
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
    const brand = await getBrandAdminContext();

    if (!brand?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
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

    const campaign = await prisma.campaign.findFirst({
      where: {
        id: campaignId,
        brandId: brand.membership.brand.id,
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
          brandId: brand.membership.brand.id,
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

    const batch = await prisma.qRCodeBatch.create({
      data: {
        campaignId: campaign.id,
        name: resolvedBatchName,
      },
      select: {
        id: true,
        name: true,
      },
    });

    const campaignFolder = `qrCodes/${campaign.name.replace(/[\\/]/g, "-")}/${batch.id}`;
    try {
      await cloudinary.api.create_folder(campaignFolder);
    } catch (error: unknown) {
      const cloudinaryError = error as { http_code?: number; message?: string };
      if (
        !(
          cloudinaryError?.http_code === 409 ||
          /already exists/i.test(cloudinaryError?.message || "")
        )
      ) {
        console.warn(
          "[brand/qr-batches][POST] Cloudinary create_folder warning:",
          cloudinaryError?.message || error,
        );
      }
    }

    const createdRecords: Array<{
      qrCodeData: string;
      qrCodeUrl: string;
      status: "NEW";
      campaignId: string;
      batchId: string;
      createdById: string;
    }> = [];
    const batchSize = 50;

    for (let index = 0; index < quantity; index += batchSize) {
      const items = Array.from({
        length: Math.min(batchSize, quantity - index),
      }).map(async () => {
        const qrCodeData = nanoid();
        const scanUrl = `${domain}/q/${qrCodeData}`;

        try {
          const buffer = await QRCode.toBuffer(scanUrl, {
            type: "png",
            width: 500,
            color: {
              dark: "#000000",
              light: "#ffffff",
            },
          });

          const uploadResult = await cloudinary.uploader.upload(
            `data:image/png;base64,${buffer.toString("base64")}`,
            {
              folder: campaignFolder,
              public_id: `qr_${qrCodeData}`,
              overwrite: false,
              resource_type: "image",
            },
          );

          return {
            qrCodeData,
            qrCodeUrl: uploadResult.secure_url,
            status: "NEW" as const,
            campaignId: campaign.id,
            batchId: batch.id,
            createdById: brand.userId,
          };
        } catch (error) {
          console.error("[brand/qr-batches][POST] QR generation failed:", error);
          return null;
        }
      });

      const results = await Promise.allSettled(items);
      const validRecords = results
        .filter(
          (
            result,
          ): result is PromiseFulfilledResult<
            NonNullable<(typeof createdRecords)[number]>
          > => result.status === "fulfilled" && result.value !== null,
        )
        .map((result) => result.value);

      if (validRecords.length > 0) {
        await prisma.qRCode.createMany({
          data: validRecords,
          skipDuplicates: true,
        });
        createdRecords.push(...validRecords);
      }
    }

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
