import { NextRequest, NextResponse } from "next/server";
import { v2 as cloudinary } from "cloudinary";
import prisma from "@/lib/prisma";
import { resolveSession, resolveBrandAdminContext } from "@/lib/auth-session";

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

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await resolveSession();

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const brand = await resolveBrandAdminContext();
    const brandId = brand?.membership?.brand?.id || null;
    if (!brandId) {
      return NextResponse.json({ error: "Select an active brand.", code: "ACTIVE_BRAND_REQUIRED" }, { status: 409 });
    }

    const { id } = await params;

    const batch = await prisma.qRCodeBatch.findFirst({
      where: {
        id,
        campaign: { brandId },
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
