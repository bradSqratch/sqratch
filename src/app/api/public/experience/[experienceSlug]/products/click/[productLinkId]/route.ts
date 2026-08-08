/**
 * Experience-shop click hop.
 *
 * GET /api/public/experience/[experienceSlug]/products/click/[productLinkId]
 *
 * Nested directly under the existing public shop-products route so the click
 * surface lives beside the catalog it belongs to. `productLinkId` is an
 * internal `ExperienceProductLink.id` — the ONLY thing this route accepts. The
 * brand, the campaign context, and the destination URL are all re-derived
 * server-side; none of them can be supplied by the caller.
 *
 * This replaces what the client used to pass to `window.open(...)`. It does not
 * replace, change, or duplicate the existing `shop_click` analytics beacon,
 * which is the POST handler on the parent route and still fires as before.
 */

import type { NextRequest, NextResponse } from "next/server";
import { handleCommerceClick } from "@/lib/commerce/click-attribution";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string; productLinkId: string }> },
): Promise<NextResponse> {
  const { experienceSlug, productLinkId } = await context.params;

  return handleCommerceClick(request, {
    experienceSlug,
    surface: { kind: "EXPERIENCE_SHOP", productLinkId },
  });
}
