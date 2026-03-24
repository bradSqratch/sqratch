import { NextRequest, NextResponse } from "next/server";
import {
  createAnalyticsEvent,
  getExperienceAccessContext,
} from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ experienceSlug: string; lessonId: string }>;
  },
) {
  try {
    const { experienceSlug, lessonId } = await context.params;
    const access = await getExperienceAccessContext(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const lesson = await prisma.lesson.findFirst({
      where: {
        id: lessonId,
        isActive: true,
        course: {
          experienceId: access.experience.id,
          isActive: true,
        },
      },
      select: {
        course: {
          select: {
            access: true,
          },
        },
        productLinks: {
          orderBy: [{ createdAt: "desc" }],
          select: {
            id: true,
            productUrl: true,
            title: true,
            imageUrl: true,
            priceText: true,
            currency: true,
            brandId: true,
          },
        },
      },
    });

    if (!lesson) {
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }

    const canAccess =
      lesson.course.access === "PUBLIC" || access.canAccessPrivate;

    return NextResponse.json({
      data: {
        items: canAccess ? lesson.productLinks : [],
      },
    });
  } catch (error) {
    console.error(
      "[public/experience/[experienceSlug]/lessons/[lessonId]/products][GET] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to load lesson products." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ experienceSlug: string; lessonId: string }>;
  },
) {
  try {
    const { experienceSlug, lessonId } = await context.params;
    const access = await getExperienceAccessContext(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const body = await request.json().catch(() => null);
    const productLinkId = String(body?.productLinkId || "").trim();
    const productUrl = String(body?.productUrl || "").trim();

    if (!productUrl) {
      return NextResponse.json(
        { error: "productUrl is required." },
        { status: 400 },
      );
    }

    const lesson = await prisma.lesson.findFirst({
      where: {
        id: lessonId,
        isActive: true,
        course: {
          experienceId: access.experience.id,
          isActive: true,
        },
      },
      select: {
        id: true,
        courseId: true,
        course: {
          select: {
            access: true,
          },
        },
      },
    });

    if (!lesson) {
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }

    const canAccess =
      lesson.course.access === "PUBLIC" || access.canAccessPrivate;

    if (!canAccess) {
      return NextResponse.json(
        { error: "Lesson is locked." },
        { status: 403 },
      );
    }

    const linkedProduct = productLinkId
      ? await prisma.lessonProductLink.findFirst({
          where: {
            id: productLinkId,
            lessonId: lesson.id,
          },
          select: {
            id: true,
            brandId: true,
            productUrl: true,
            title: true,
          },
        })
      : await prisma.lessonProductLink.findFirst({
          where: {
            lessonId: lesson.id,
            productUrl,
          },
          select: {
            id: true,
            brandId: true,
            productUrl: true,
            title: true,
          },
        });

    const primaryCampaign = access.experience.campaigns[0];
    const sessionId =
      access.viewer.sessionId ||
      (await ensureViewerSession({
        request,
        userId: access.viewer.userId,
        campaignId: primaryCampaign?.campaignId || null,
      }));

    const viewerSession = await prisma.userSession.findUnique({
      where: { id: sessionId },
      select: {
        qrCodeId: true,
        qrCode: {
          select: {
            batchId: true,
          },
        },
      },
    });

    await createAnalyticsEvent({
      request,
      name: "lesson_product_click",
      brandId: linkedProduct?.brandId || primaryCampaign?.campaign.brand?.id || null,
      campaignId: primaryCampaign?.campaignId || null,
      qrCodeId: viewerSession?.qrCodeId || null,
      experienceId: access.experience.id,
      courseId: lesson.courseId,
      lessonId: lesson.id,
      userId: access.viewer.userId,
      sessionId,
      pagePath: `/x/${access.experience.slug}/lessons/${lesson.id}`,
      data: {
        productLinkId: linkedProduct?.id || productLinkId || null,
        productTitle: linkedProduct?.title || null,
        productUrl: linkedProduct?.productUrl || productUrl,
        batchId: viewerSession?.qrCode?.batchId || null,
      },
    });

    const response = NextResponse.json({ ok: true });
    attachSessionCookie(response, sessionId);
    return response;
  } catch (error) {
    console.error(
      "[public/experience/[experienceSlug]/lessons/[lessonId]/products][POST] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to track lesson product click." },
      { status: 500 },
    );
  }
}
