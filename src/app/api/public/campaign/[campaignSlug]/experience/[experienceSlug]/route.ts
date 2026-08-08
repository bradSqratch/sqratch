import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { createCampaignExperienceEntryToken } from "@/lib/public-experience-entry";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";

/**
 * Server-validated handoff from a Campaign landing page into an Experience.
 * The signed query proof lets `/x/:slug` distinguish this trusted campaign
 * navigation from a later direct URL visit carrying a stale session cookie.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ campaignSlug: string; experienceSlug: string }> },
) {
  try {
    const { campaignSlug, experienceSlug } = await context.params;
    const campaign = await prisma.campaign.findFirst({
      where: {
        OR: [{ slug: campaignSlug }, { id: campaignSlug }],
        experiences: {
          some: {
            experience: {
              slug: experienceSlug,
            },
          },
        },
      },
      select: { id: true },
    });

    if (!campaign) {
      return NextResponse.json(
        { error: "Campaign Experience not found." },
        { status: 404 },
      );
    }

    const authSession = await getServerSession(authOptions);
    const sessionId = await ensureViewerSession({
      request,
      userId: authSession?.user?.id || null,
      campaignId: campaign.id,
    });
    const destination = new URL(`/x/${encodeURIComponent(experienceSlug)}`, request.url);
    destination.searchParams.set(
      "campaignEntry",
      createCampaignExperienceEntryToken({
        campaignId: campaign.id,
        experienceSlug,
      }),
    );

    return attachSessionCookie(NextResponse.redirect(destination), sessionId);
  } catch (error) {
    console.error("[public/campaign/[campaignSlug]/experience/[experienceSlug]] Error:", error);
    return NextResponse.json(
      { error: "Failed to open Experience." },
      { status: 500 },
    );
  }
}
