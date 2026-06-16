import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import QRCode from "qrcode";
import { v2 as cloudinary } from "cloudinary";
import prisma from "@/lib/prisma";
import { getBrandAdminContext, BrandAdminContext } from "@/lib/brand-auth";

interface CustomSession {
  user: {
    id: string;
    role: string;
    email?: string | null;
  };
}

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

function extractCloudinaryPublicId(imageUrl: string) {
  const url = new URL(imageUrl);
  const uploadIndex = url.pathname.indexOf("/upload/");

  if (uploadIndex === -1) {
    return null;
  }

  const afterUpload = url.pathname.slice(uploadIndex + "/upload/".length);
  const afterVersion = afterUpload.replace(/^v\d+\//, "");
  return afterVersion.replace(/\.[^.]+$/, "");
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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

    const { id } = await params;
    const body = await request.json().catch(() => null);
    const campaignId = String(body?.campaignId || "").trim();
    const status = String(body?.status || "").trim().toUpperCase();
    const nextStatus = status === "USED" ? "USED" : status === "NEW" ? "NEW" : null;
    const usedBy = String(body?.usedBy || "").trim();
    const usedAt = String(body?.usedAt || "").trim();

    if (!campaignId || !nextStatus) {
      return NextResponse.json(
        { error: "campaignId and a valid status are required." },
        { status: 400 },
      );
    }

    const existingQRCode = await prisma.qRCode.findFirst({
      where: {
        id,
        ...(brandId ? { campaign: { brandId } } : {}),
      },
      select: {
        id: true,
        qrCodeData: true,
        qrCodeUrl: true,
        campaignId: true,
        redeemedById: true,
        email: true,
        usedAt: true,
      },
    });

    if (!existingQRCode) {
      return NextResponse.json({ error: "QR code not found." }, { status: 404 });
    }

    const targetCampaign = await prisma.campaign.findFirst({
      where: {
        id: campaignId,
        ...(brandId ? { brandId } : {}),
      },
      select: {
        id: true,
        name: true,
      },
    });

    if (!targetCampaign) {
      return NextResponse.json(
        { error: "Target campaign not found." },
        { status: 404 },
      );
    }

    let redeemedById: string | null = existingQRCode.redeemedById;
    let email: string | null = existingQRCode.email;
    let nextUsedAt: Date | null = existingQRCode.usedAt;

    if (nextStatus === "NEW") {
      redeemedById = null;
      email = null;
      nextUsedAt = null;
    } else if (usedBy) {
      const user = await prisma.user.findUnique({
        where: { email: usedBy },
        select: { id: true, email: true },
      });

      if (!user) {
        return NextResponse.json({ error: "User not found." }, { status: 400 });
      }

      redeemedById = user.id;
      email = user.email;
      nextUsedAt = usedAt ? new Date(usedAt) : existingQRCode.usedAt || new Date();
    }

    let newImageUrl = existingQRCode.qrCodeUrl;
    const campaignChanged = campaignId !== existingQRCode.campaignId;

    if (campaignChanged) {
      if (existingQRCode.qrCodeUrl) {
        try {
          const publicId = extractCloudinaryPublicId(existingQRCode.qrCodeUrl);
          if (publicId) {
            await cloudinary.uploader.destroy(publicId, {
              resource_type: "image",
            });
          }
        } catch (error) {
          console.error("[brand/qr-codes][PATCH] Cloudinary deletion failed:", error);
        }
      }

      const scanUrl = `${(
        process.env.DOMAIN ||
        process.env.NEXT_PUBLIC_APP_URL ||
        process.env.NEXTAUTH_URL ||
        request.nextUrl.origin
      ).replace(/\/$/, "")}/q/${existingQRCode.qrCodeData}`;

      const buffer = await QRCode.toBuffer(scanUrl, {
        type: "png",
        width: 500,
        color: {
          dark: "#000000",
          light: "#ffffff",
        },
      });

      const targetFolder = `qrCodes/${targetCampaign.name.replace(/[\\/]/g, "-")}`;
      try {
        await cloudinary.api.create_folder(targetFolder);
      } catch (error: unknown) {
        const cloudinaryError = error as { http_code?: number; message?: string };
        if (
          !(
            cloudinaryError?.http_code === 409 ||
            /already exists/i.test(cloudinaryError?.message || "")
          )
        ) {
          console.warn(
            "[brand/qr-codes][PATCH] Cloudinary create_folder warning:",
            cloudinaryError?.message || error,
          );
        }
      }

      const uploadResult = await cloudinary.uploader.upload(
        `data:image/png;base64,${buffer.toString("base64")}`,
        {
          folder: targetFolder,
          public_id: `qr_${existingQRCode.qrCodeData}`,
          overwrite: true,
          resource_type: "image",
        },
      );

      newImageUrl = uploadResult.secure_url;
    }

    await prisma.qRCode.update({
      where: { id },
      data: {
        campaignId,
        status: nextStatus,
        usedAt: nextUsedAt,
        redeemedById,
        email,
        qrCodeUrl: newImageUrl,
      },
    });

    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    console.error("[brand/qr-codes][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update QR code." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
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

    const { id } = await params;
    const record = await prisma.qRCode.findFirst({
      where: {
        id,
        ...(brandId ? { campaign: { brandId } } : {}),
      },
      select: {
        id: true,
        qrCodeUrl: true,
      },
    });

    if (!record) {
      return NextResponse.json({ error: "QR code not found." }, { status: 404 });
    }

    if (record.qrCodeUrl) {
      try {
        const publicId = extractCloudinaryPublicId(record.qrCodeUrl);
        if (publicId) {
          await cloudinary.uploader.destroy(publicId, { resource_type: "image" });
        }
      } catch (error) {
        console.error("[brand/qr-codes][DELETE] Cloudinary deletion error:", error);
      }
    }

    await prisma.qRCode.delete({ where: { id } });
    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    console.error("[brand/qr-codes][DELETE] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete QR code." },
      { status: 500 },
    );
  }
}
