import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { awardQrScanPoint } from "@/lib/points";
import { redeemQrCodeForUser } from "@/lib/qr-redemption";
import { rateLimit, getRequestIp, rateLimitResponse } from "@/lib/rate-limit";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";

const COOKIE_NAME = "sqr_session";

export async function POST(request: NextRequest) {
  return scanImpl(request, realAuthResolvers);
}

export async function scanImpl(request: NextRequest, deps: AuthResolvers) {
  try {
    const ip = getRequestIp(request);
    const rl = rateLimit(`scan:${ip}`, 60, 60 * 60 * 1000);
    if (!rl.success) {
      return rateLimitResponse(rl.resetAt);
    }

    const session = await deps.resolveSession();
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
    const userEmail = session?.user?.email || null;
    const brandId = qr.campaign.brandId || null;
    const isRedeemed = qr.status === "USED";

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

    if (isRedeemed) {
      await prisma.analyticsEvent.create({
        data: {
          name: "qr_scan_redeemed",
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

      return NextResponse.json({
        ok: true,
        campaignSlug: qr.campaign.slug || qr.campaign.id,
      });
    }

    if (userId) {
      const redemptionResult = await prisma.$transaction(async (tx) => {
        const redemption = await redeemQrCodeForUser({
          qrCodeId: qr.id,
          userId,
          userEmail,
          db: tx,
        });

        if (!redemption.redeemed) {
          return redemption;
        }

        const existingUnlock = await tx.campaignUnlock.findFirst({
          where: {
            campaignId: qr.campaign.id,
            userId,
          },
          select: { id: true },
        });

        if (!existingUnlock) {
          await tx.campaignUnlock.create({
            data: {
              campaignId: qr.campaign.id,
              userId,
              qrCodeId: qr.id,
            },
          });
        }

        await awardQrScanPoint({
          userId,
          qrCodeId: qr.id,
          db: tx,
        });

        return redemption;
      });

      if (!redemptionResult.redeemed) {
        await prisma.analyticsEvent.create({
          data: {
            name: "qr_scan_redeemed",
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

        return NextResponse.json({
          ok: true,
          campaignSlug: qr.campaign.slug || qr.campaign.id,
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
        try {
          await prisma.campaignUnlock.create({
            data: {
              campaignId: qr.campaign.id,
              anonKey: sessionId,
              qrCodeId: qr.id,
            },
          });
        } catch (err) {
          // P2002: concurrent scan already created this anon unlock — idempotent
          if (
            !(
              err instanceof Prisma.PrismaClientKnownRequestError &&
              err.code === "P2002"
            )
          ) {
            throw err;
          }
        }
      }
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
