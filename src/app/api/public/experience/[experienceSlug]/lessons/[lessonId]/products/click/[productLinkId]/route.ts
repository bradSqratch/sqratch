/**
 * Lesson-product click hop.
 *
 * GET /api/public/experience/[experienceSlug]/lessons/[lessonId]/products/click/[productLinkId]
 *
 * Nested under the existing public lesson-products route for the same reason
 * the Experience-shop variant is nested under its catalog route: the click
 * surface belongs beside the list it is clicked from, and the `lessonId`
 * segment gives the containment check (link -> lesson -> active course -> this
 * Experience) for free, exactly as the sibling GET/POST handlers do it.
 *
 * `productLinkId` is an internal `LessonProductLink.id` and is the ONLY thing
 * this route accepts. Campaign scoping, brand, and destination are all
 * re-derived server-side.
 *
 * Two routes rather than one generic route with a type discriminator: a
 * discriminator in the path would have been a second client-supplied input
 * governing which table is queried, and it would have sat outside this repo's
 * established `/experience/[slug]/...` and `/experience/[slug]/lessons/[id]/...`
 * nesting. Both routes delegate to one shared implementation, so there is still
 * exactly one copy of the behavior.
 */

import type { NextRequest, NextResponse } from "next/server";
import { handleCommerceClick } from "@/lib/commerce/click-attribution";

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{
      experienceSlug: string;
      lessonId: string;
      productLinkId: string;
    }>;
  },
): Promise<NextResponse> {
  const { experienceSlug, lessonId, productLinkId } = await context.params;

  return handleCommerceClick(request, {
    experienceSlug,
    surface: { kind: "LESSON", lessonId, productLinkId },
  });
}
