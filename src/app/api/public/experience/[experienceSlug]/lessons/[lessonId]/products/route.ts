import { NextRequest, NextResponse } from "next/server";
import {
  createAnalyticsEvent,
  getExperienceAccessContext,
  type ExperienceAccessContext,
} from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";
import { isProductLinkCurrent } from "@/lib/product-link-compatibility";
import { externalAccountIdFromShopDomain } from "@/lib/commerce/connection-service";
import { isPublicCampaignScopedContentVisible } from "@/lib/campaign-context";

/**
 * The campaign context this visitor is in on this Experience, or null when it
 * is genuinely ambiguous (two or more eligible sponsors, no trusted session
 * campaign). Never `campaigns[0]`.
 */
function resolveVisitorCampaign(access: ExperienceAccessContext) {
  // `entryContext` is the server-owned decision established at the public
  // Experience boundary. In particular, DIRECT must override an old valid
  // UserSession.campaignId: a direct product-click beacon must not credit a
  // campaign merely because the visitor arrived through one earlier.
  const resolvedCampaignId =
    access.entryContext.kind === "CAMPAIGN"
      ? access.entryContext.campaignId
      : null;

  return (
    access.experience.campaigns.find(
      (item) => item.campaignId === resolvedCampaignId,
    ) || null
  );
}

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
            sourceShopDomain: true,
            // Campaign scoping only. Deliberately just these two columns: the
            // scoping row's own id, `brandCommerceProductId`, `brandId` and
            // `displayOrder` are internal and must never reach a public
            // response, so they are not even loaded here.
            campaignProductLink: {
              select: {
                campaignId: true,
                isActive: true,
              },
            },
          },
        },
      },
    });

    if (!lesson) {
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }

    const canAccess =
      lesson.course.access === "PUBLIC" || access.canAccessPrivate;

    // A stored link is current only when its sourceShopDomain matches the
    // linked brand's current Shopify domain. Stale/unknown-source links are
    // hidden from this public list (never deleted).
    const brandIds = Array.from(
      new Set(
        lesson.productLinks
          .map((link) => link.brandId)
          .filter((brandId): brandId is string => Boolean(brandId)),
      ),
    );
    const brands = brandIds.length
      ? await prisma.brand.findMany({
          where: { id: { in: brandIds } },
          select: { id: true, shopifyShopDomain: true },
        })
      : [];
    const domainByBrandId = new Map(
      brands.map((brand) => [brand.id, externalAccountIdFromShopDomain(brand.shopifyShopDomain)]),
    );
    const currentProductLinks = lesson.productLinks.filter((link) =>
      isProductLinkCurrent(link, domainByBrandId),
    );

    // CAMPAIGN-SCOPED VISIBILITY, applied server-side before serialization.
    //
    //  - A link with NO CampaignLessonProduct row is global legacy content.
    //  - An INACTIVE row is a revocation, never a downgrade into global content.
    //  - An active scope must still name a brand-owning campaign currently
    //    linked to this Experience. Direct entry unions all such scopes;
    //    campaign entry exposes only its own scope. The shared predicate is
    //    also used by the lesson click route.
    const visitorCampaign = resolveVisitorCampaign(access);
    const eligibleCampaignIds = access.experience.campaigns
      .filter((item) => item.campaign.brand !== null)
      .map((item) => item.campaignId);
    const visibleProductLinks = currentProductLinks.filter((link) => {
      const scope = link.campaignProductLink;

      return isPublicCampaignScopedContentVisible({
        scope,
        entryContext: access.entryContext,
        resolvedCampaignId: visitorCampaign?.campaignId ?? null,
        eligibleCampaignIds,
      });
    });

    return NextResponse.json({
      data: {
        // Projected field by field so the scoping row stays server-side. The
        // shape is byte-identical to the pre-scoping response.
        items: canAccess
          ? visibleProductLinks.map((link) => ({
              id: link.id,
              productUrl: link.productUrl,
              title: link.title,
              imageUrl: link.imageUrl,
              priceText: link.priceText,
              currency: link.currency,
              brandId: link.brandId,
              sourceShopDomain: link.sourceShopDomain,
            }))
          : [],
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

    if (!productLinkId) {
      return NextResponse.json(
        { error: "productLinkId is required." },
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

    // This beacon is supplementary analytics only, but it still must not
    // accept a client-provided merchant URL. The id is contained to this
    // lesson and the recorded URL is always re-derived from the stored link.
    const linkedProduct = await prisma.lessonProductLink.findFirst({
      where: {
        id: productLinkId,
        lessonId: lesson.id,
      },
      select: {
        id: true,
        brandId: true,
        productUrl: true,
        title: true,
        campaignProductLink: {
          select: {
            campaignId: true,
            isActive: true,
          },
        },
      },
    });

    if (!linkedProduct) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    // A beacon is not authorization evidence, but it is still a public click
    // endpoint. Apply the exact same scope predicate as rendering and the
    // server redirect so a forged POST cannot create cross-campaign or
    // revoked-product analytics that the visitor could never have clicked.
    const visitorCampaign = resolveVisitorCampaign(access);
    const eligibleCampaignIds = access.experience.campaigns
      .filter((item) => item.campaign.brand !== null)
      .map((item) => item.campaignId);
    if (!isPublicCampaignScopedContentVisible({
      scope: linkedProduct.campaignProductLink,
      entryContext: access.entryContext,
      resolvedCampaignId: visitorCampaign?.campaignId ?? null,
      eligibleCampaignIds,
    })) {
      return NextResponse.json({ error: "Product not found." }, { status: 404 });
    }

    // Attribution follows the visitor's resolved context. When it is ambiguous
    // the campaign attribution is omitted (AnalyticsEvent.campaignId and
    // .brandId are both nullable) rather than credited to an arbitrary
    // co-sponsor; the click itself is still recorded. The clicked link's OWN
    // brand still attributes normally — it is a property of the product, not a
    // guess about the visitor.
    const sessionId =
      access.viewer.sessionId ||
      (await ensureViewerSession({
        request,
        userId: access.viewer.userId,
        campaignId: visitorCampaign?.campaignId || null,
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
      brandId: linkedProduct.brandId || visitorCampaign?.campaign.brand?.id || null,
      campaignId: visitorCampaign?.campaignId || null,
      qrCodeId: viewerSession?.qrCodeId || null,
      experienceId: access.experience.id,
      courseId: lesson.courseId,
      lessonId: lesson.id,
      userId: access.viewer.userId,
      sessionId,
      pagePath: `/x/${access.experience.slug}/lessons/${lesson.id}`,
      data: {
        productLinkId: linkedProduct.id,
        productTitle: linkedProduct.title,
        productUrl: linkedProduct.productUrl,
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
