import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { getViewerSessionRecord, hasRedeemedQrWarning } from "@/lib/session";

const COOKIE_NAME = "sqr_session";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ campaignSlug: string }> },
) {
  try {
    const session = await getServerSession(authOptions);
    const { campaignSlug } = await context.params;

    const campaign = await prisma.campaign.findFirst({
      where: {
        OR: [{ slug: campaignSlug }, { id: campaignSlug }],
      },
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            slug: true,
            logoUrl: true,
          },
        },
        experiences: {
          orderBy: {
            sortOrder: "asc",
          },
          include: {
            experience: {
              select: {
                slug: true,
                title: true,
                coverImageUrl: true,
              },
            },
          },
        },
      },
    });

    if (!campaign) {
      return NextResponse.json(
        { error: "Campaign not found." },
        { status: 404 },
      );
    }

    const userId = session?.user?.id || null;
    const sessionId = request.cookies.get(COOKIE_NAME)?.value || null;
    const viewerSession = await getViewerSessionRecord(request);

    let isUnlocked = false;

    if (userId) {
      const unlock = await prisma.campaignUnlock.findFirst({
        where: {
          campaignId: campaign.id,
          userId,
        },
        select: { id: true },
      });

      isUnlocked = Boolean(unlock);
    } else if (sessionId) {
      const unlock = await prisma.campaignUnlock.findFirst({
        where: {
          campaignId: campaign.id,
          anonKey: sessionId,
          userId: null,
        },
        select: { id: true },
      });

      isUnlocked = Boolean(unlock);
    }

    const showRedeemedQrWarning =
      !isUnlocked &&
      hasRedeemedQrWarning({
        viewerSession,
        currentUserId: userId,
        allowedCampaignIds: [campaign.id],
      });

    if (sessionId) {
      await prisma.userSession.updateMany({
        where: { id: sessionId },
        data: {
          lastSeenAt: new Date(),
          campaignId: campaign.id,
          userId: userId || undefined,
        },
      });

      await prisma.analyticsEvent.create({
        data: {
          name: "campaign_view",
          brandId: campaign.brandId,
          campaignId: campaign.id,
          userId,
          sessionId,
          pagePath: `/c/${campaignSlug}`,
        },
      });
    }

    return NextResponse.json({
      data: {
        id: campaign.id,
        name: campaign.name,
        description: campaign.description,
        brand: campaign.brand
          ? {
              id: campaign.brand.id,
              name: campaign.brand.name,
              slug: campaign.brand.slug,
              logoUrl: campaign.brand.logoUrl,
            }
          : null,
        experiences: campaign.experiences.map((item) => ({
          slug: item.experience.slug,
          title: item.experience.title,
          coverImageUrl: item.experience.coverImageUrl,
        })),
        isUnlocked,
        hasRedeemedQrWarning: showRedeemedQrWarning,
      },
    });
  } catch (error) {
    console.error("[public/campaign/[campaignSlug]] Error:", error);
    return NextResponse.json(
      { error: "Failed to load campaign." },
      { status: 500 },
    );
  }
}
