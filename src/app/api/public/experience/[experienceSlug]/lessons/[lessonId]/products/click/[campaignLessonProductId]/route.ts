/**
 * Lesson-product click hop.
 *
 * GET /api/public/experience/[experienceSlug]/lessons/[lessonId]/products/click/[campaignLessonProductId]
 *
 * Nested under the public lesson-products route it is clicked from: the click
 * surface belongs beside its list, and the `lessonId` segment supplies the
 * containment check (attachment -> lesson -> active course -> THIS Experience)
 * for free, exactly as the sibling GET/POST handlers do it.
 *
 * `campaignLessonProductId` is an internal `CampaignLessonProduct.id` and is the
 * ONLY thing this route accepts. The brand, the campaign scope, the commerce
 * connection, the provider and the destination URL are all re-derived
 * server-side through the canonical catalog chain
 * (`CampaignLessonProduct -> BrandCommerceProduct -> ConnectedCommerceProduct
 * -> CommerceConnection`). None of them can be supplied by the caller: there is
 * no query parameter, body, or header read anywhere on this path.
 *
 * Separate routes per surface rather than one generic route with a type
 * discriminator: a discriminator in the path would have been a second
 * client-supplied input governing which table is queried. All surfaces delegate
 * to one shared implementation, so there is still exactly one copy of the
 * behavior.
 */

import type { NextRequest, NextResponse } from "next/server";
import { handleCommerceClick } from "@/lib/commerce/click-attribution";

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{
      experienceSlug: string;
      lessonId: string;
      campaignLessonProductId: string;
    }>;
  },
): Promise<NextResponse> {
  const { experienceSlug, lessonId, campaignLessonProductId } =
    await context.params;

  return handleCommerceClick(request, {
    experienceSlug,
    surface: { kind: "LESSON", lessonId, campaignLessonProductId },
  });
}
