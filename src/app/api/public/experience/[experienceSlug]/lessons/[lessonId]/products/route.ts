/**
 * Public lesson commerce products (list + supplementary click beacon).
 *
 * PHASE 8: THE QUERY ROOT IS `CampaignLessonProduct`.
 *
 * This route used to read `Lesson.productLinks` (`LessonProductLink`) — a
 * free-form snapshot table carrying its own `productUrl`, `title`, `priceText`
 * and `sourceShopDomain`, with campaign scoping hanging off it as an OPTIONAL
 * side relation. That shape made two bad states representable: a product with
 * no campaign scope at all (globally visible to every visitor of every
 * co-sponsoring campaign), and a snapshot whose merchant URL had drifted from
 * the brand's actual catalog.
 *
 * Both are gone. Every item here is a `CampaignLessonProduct` row, and all
 * display data is derived through `BrandCommerceProduct -> ConnectedCommerceProduct`
 * — the same synchronized catalog rows the brand curated and the click route
 * redirects to. `campaignId` is NOT NULL on that root, so there is no unscoped
 * lesson product, and `productUrl` is never a stale local copy.
 *
 * PUBLIC STOREFRONT GATE. A product is listed only when its connected catalog
 * row has BOTH `isAvailable === true` (provider lifecycle/inventory status) AND
 * `hasPublicStorefrontUrl === true` (the provider confirmed Online Store
 * publication). Neither implies the other: a Shopify product can be
 * `status: ACTIVE` while unpublished from the Online Store channel. A
 * password-protected development store can still be published and use the
 * canonical fallback URL. The click route applies the IDENTICAL pair of
 * conditions, so a card that renders is clickable and a card that is hidden is
 * not redirectable.
 */

import { NextRequest, NextResponse } from "next/server";
import { getExperienceAccessContext, type ExperienceAccessContext } from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { isPublicCampaignScopedContentVisible } from "@/lib/campaign-context";
import { formatMinorUnitPriceRange } from "@/lib/commerce/money";

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

/**
 * The brand-owning campaigns currently linked to this Experience. A brandless
 * campaign is never eligible: it owns no catalog and can authorize nothing, so
 * after Phase 8 it simply has no commerce products (there is no unscoped
 * fallback for it to inherit).
 */
function eligibleCampaignIdsFor(access: ExperienceAccessContext): string[] {
  return access.experience.campaigns
    .filter((item) => item.campaign.brand !== null)
    .map((item) => item.campaignId);
}

/**
 * BOTH conditions, always. `isAvailable` is provider lifecycle status;
 * `hasPublicStorefrontUrl` is provider-confirmed Online Store publication.
 * Neither substitutes for the other.
 */
const PUBLICLY_LISTABLE_CONNECTED_PRODUCT = {
  isAvailable: true,
  hasPublicStorefrontUrl: true,
} as const;

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
        campaignProducts: {
          // A deactivated attachment is a revocation and is excluded here as
          // well as by the shared predicate below.
          where: {
            isActive: true,
            brandCommerceProduct: {
              connectedProduct: PUBLICLY_LISTABLE_CONNECTED_PRODUCT,
            },
          },
          orderBy: [
            { displayOrder: "asc" },
            { createdAt: "desc" },
            { id: "asc" },
          ],
          select: {
            id: true,
            brandId: true,
            // Campaign scoping only. The scoping row's internal catalog keys are
            // never loaded here, so they cannot reach a public response.
            campaignId: true,
            isActive: true,
            brandCommerceProduct: {
              select: {
                titleOverride: true,
                connectedProduct: {
                  select: {
                    title: true,
                    productUrl: true,
                    imageUrl: true,
                    currencyCode: true,
                    priceMinMinor: true,
                    priceMaxMinor: true,
                    priceMinorUnitExponent: true,
                  },
                },
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

    // CAMPAIGN-SCOPED VISIBILITY, applied server-side before serialization.
    //
    //  - Campaign A entry exposes only A's active attachments; Campaign B entry
    //    only B's.
    //  - DIRECT root entry exposes the deterministic union of active
    //    attachments across every eligible (brand-owning) campaign currently
    //    linked to this Experience.
    //  - An INACTIVE attachment is a revocation, never a downgrade to global.
    //  - An active attachment whose campaign is no longer brand-owning or no
    //    longer linked to this Experience is hidden.
    //
    // The predicate is the shared one, byte-for-byte the same call the click
    // route makes. There is deliberately no second copy of this rule.
    const visitorCampaign = resolveVisitorCampaign(access);
    const eligibleCampaignIds = eligibleCampaignIdsFor(access);
    const visibleAttachments = lesson.campaignProducts.filter((attachment) =>
      isPublicCampaignScopedContentVisible({
        scope: {
          campaignId: attachment.campaignId,
          isActive: attachment.isActive,
        },
        entryContext: access.entryContext,
        resolvedCampaignId: visitorCampaign?.campaignId ?? null,
        eligibleCampaignIds,
      }),
    );

    return NextResponse.json({
      data: {
        // Projected field by field so no catalog key or scoping key can reach a
        // public response. `id` is the opaque CampaignLessonProduct id the
        // click route and the beacon below both address.
        items: canAccess
          ? visibleAttachments.map((attachment) => {
              const catalog = attachment.brandCommerceProduct;
              const product = catalog.connectedProduct;

              return {
                id: attachment.id,
                productUrl: product.productUrl,
                title: catalog.titleOverride?.trim() || product.title,
                imageUrl: product.imageUrl,
                priceText: formatMinorUnitPriceRange(product),
                currency: product.currencyCode,
                brandId: attachment.brandId,
              };
            })
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
