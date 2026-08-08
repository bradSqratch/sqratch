import { NextRequest, NextResponse } from "next/server";
import {
  createAnalyticsEvent,
  getExperienceAccessContext,
  resolvePublicCampaignId,
} from "@/lib/experience-access";
import { loadPublicExperience } from "@/lib/public-experience";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
) {
  try {
    const { experienceSlug } = await context.params;
    const result = await loadPublicExperience(experienceSlug, request);

    if (!result) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }
    const { access, data, primaryBrandId, primaryCampaignId } = result;

    const sessionId =
      access.viewer.sessionId ||
      (await ensureViewerSession({
        request,
        userId: access.viewer.userId,
        campaignId: primaryCampaignId,
      }));

    await createAnalyticsEvent({
      request,
      name: "experience_view",
      brandId: primaryBrandId,
      campaignId: primaryCampaignId,
      experienceId: access.experience.id,
      userId: access.viewer.userId,
      sessionId,
      pagePath: `/x/${access.experience.slug}`,
      data: {
        canAccessPrivate: access.canAccessPrivate,
        canInteract: access.canInteract,
        visibleCourseCount: data.courseSummary.visibleCourseCount,
      },
    });

    const response = NextResponse.json(
      { data },
      {
        headers: {
          "Cache-Control": "private, no-store",
        },
      },
    );

    attachSessionCookie(response, sessionId);
    return response;
  } catch (error) {
    console.error("[public/experience/[experienceSlug]] Error:", error);
    return NextResponse.json(
      { error: "Failed to load experience." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
) {
  try {
    const { experienceSlug } = await context.params;
    const access = await getExperienceAccessContext(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    // Attributed to the visitor's own resolved campaign context, never to
    // `campaigns[0]`. On a co-sponsored Experience with no trusted signal the
    // view is recorded with a null brand/campaign (both columns are nullable)
    // rather than credited to an arbitrary sponsor.
    const resolvedCampaignId = resolvePublicCampaignId({
      campaigns: access.experience.campaigns.map((item) => ({
        campaignId: item.campaignId,
        brandId: item.campaign.brand?.id ?? null,
      })),
      storedCampaignId: access.storedCampaignId,
    });
    const primaryCampaign =
      access.experience.campaigns.find(
        (item) => item.campaignId === resolvedCampaignId,
      ) || null;

    const sessionId =
      access.viewer.sessionId ||
      (await ensureViewerSession({
        request,
        userId: access.viewer.userId,
        campaignId: primaryCampaign?.campaignId || null,
      }));

    await createAnalyticsEvent({
      request,
      name: "experience_view",
      brandId: primaryCampaign?.campaign.brand?.id || null,
      campaignId: primaryCampaign?.campaignId || null,
      experienceId: access.experience.id,
      userId: access.viewer.userId,
      sessionId,
      pagePath: `/x/${access.experience.slug}`,
      data: {
        canAccessPrivate: access.canAccessPrivate,
        canInteract: access.canInteract,
      },
    });

    const response = new NextResponse(null, { status: 204 });
    attachSessionCookie(response, sessionId);
    return response;
  } catch (error) {
    console.error("[public/experience/[experienceSlug]] View Error:", error);
    return NextResponse.json(
      { error: "Failed to track experience view." },
      { status: 500 },
    );
  }
}
