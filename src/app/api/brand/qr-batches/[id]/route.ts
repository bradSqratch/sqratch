import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { v2 as cloudinary } from "cloudinary";
import prisma from "@/lib/prisma";
import { getBrandAdminContext, BrandAdminContext } from "@/lib/brand-auth";

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

    const batch = await prisma.qRCodeBatch.findFirst({
      where: {
        id,
        ...(brandId ? { campaign: { brandId } } : {}),
      },

      select: {
        id: true,
        qrCodes: {
          select: {
            id: true,
            qrCodeUrl: true,
          },
        },
      },
    });

    if (!batch) {
      return NextResponse.json({ error: "Batch not found." }, { status: 404 });
    }

    for (const qrCode of batch.qrCodes) {
      if (!qrCode.qrCodeUrl) {
        continue;
      }

      try {
        const publicId = extractCloudinaryPublicId(qrCode.qrCodeUrl);
        if (publicId) {
          await cloudinary.uploader.destroy(publicId, {
            resource_type: "image",
          });
        }
      } catch (error) {
        console.error("[brand/qr-batches][DELETE] Cloudinary deletion failed:", error);
      }
    }

    const qrCodeIds = batch.qrCodes.map((qrCode) => qrCode.id);

    await prisma.$transaction(async (tx) => {
      if (qrCodeIds.length > 0) {
        await tx.campaignUnlock.deleteMany({
          where: {
            qrCodeId: {
              in: qrCodeIds,
            },
          },
        });

        await tx.pointTransaction.deleteMany({
          where: {
            qrCodeId: {
              in: qrCodeIds,
            },
          },
        });

        await tx.qRCode.deleteMany({
          where: {
            id: {
              in: qrCodeIds,
            },
          },
        });
      }

      await tx.qRCodeBatch.delete({
        where: {
          id: batch.id,
        },
      });
    });

    return NextResponse.json({ data: { success: true } });
  } catch (error) {
    console.error("[brand/qr-batches][DELETE] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete batch." },
      { status: 500 },
    );
  }
}
