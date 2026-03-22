import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";

const COOKIE_NAME = "sqr_session";

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const body = await request.json();
    const qrCodeData = String(body?.qrCodeData || "").trim();

    if (!qrCodeData) {
      return NextResponse.json(
        { error: "qrCodeData is required." },
        { status: 400 },
      );
    }

    const qr = await prisma.qRCode.findUnique({
      where: { qrCodeData },
      include: {
        campaign: {
          include: {
            brand: {
              select: {
                id: true,
                slug: true,
                name: true,
              },
            },
          },
        },
      },
    });

    if (!qr || !qr.campaign) {
      return NextResponse.json(
        { error: "QR code not found." },
        { status: 404 },
      );
    }

    const sessionId = request.cookies.get(COOKIE_NAME)?.value || null;
    const userId = session?.user?.id || null;
    const brandId = qr.campaign.brandId || null;

    if (sessionId) {
      await prisma.userSession.upsert({
        where: { id: sessionId },
        update: {
          lastSeenAt: new Date(),
          campaignId: qr.campaign.id,
          qrCodeId: qr.id,
          userId: userId || undefined,
        },
        create: {
          id: sessionId,
          anonKey: sessionId,
          campaignId: qr.campaign.id,
          qrCodeId: qr.id,
          userId: userId || undefined,
        },
      });
    }

    await prisma.analyticsEvent.create({
      data: {
        name: "qr_scan",
        brandId,
        campaignId: qr.campaign.id,
        qrCodeId: qr.id,
        userId,
        sessionId,
        pagePath: `/q/${qrCodeData}`,
        data: {
          batchId: qr.batchId,
          qrCodeData: qr.qrCodeData,
        },
      },
    });

    if (userId) {
      const existingUnlock = await prisma.campaignUnlock.findFirst({
        where: {
          campaignId: qr.campaign.id,
          userId,
        },
        select: { id: true },
      });

      if (!existingUnlock) {
        await prisma.campaignUnlock.create({
          data: {
            campaignId: qr.campaign.id,
            userId,
            qrCodeId: qr.id,
          },
        });
      }
    } else if (sessionId) {
      const existingAnonUnlock = await prisma.campaignUnlock.findFirst({
        where: {
          campaignId: qr.campaign.id,
          anonKey: sessionId,
          userId: null,
        },
        select: { id: true },
      });

      if (!existingAnonUnlock) {
        await prisma.campaignUnlock.create({
          data: {
            campaignId: qr.campaign.id,
            anonKey: sessionId,
            qrCodeId: qr.id,
          },
        });
      }
    }

    return NextResponse.json({
      ok: true,
      campaignSlug: qr.campaign.slug || qr.campaign.id,
    });
  } catch (error) {
    console.error("[public/scan] Error:", error);
    return NextResponse.json(
      { error: "Failed to process QR scan." },
      { status: 500 },
    );
  }
}
