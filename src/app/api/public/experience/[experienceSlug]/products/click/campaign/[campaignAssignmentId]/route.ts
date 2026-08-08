import type { NextRequest, NextResponse } from "next/server";
import { handleCommerceClick } from "@/lib/commerce/click-attribution";

/**
 * Campaign-assignment catalog click hop.
 *
 * The path contains only the opaque CampaignCommerceProduct id. The handler
 * re-derives the linked Experience, active assignment, same-brand catalog row,
 * availability, merchant destination, and product campaign server-side.
 */
export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ experienceSlug: string; campaignAssignmentId: string }>;
  },
): Promise<NextResponse> {
  const { experienceSlug, campaignAssignmentId } = await context.params;
  return handleCommerceClick(request, {
    experienceSlug,
    surface: { kind: "CAMPAIGN_ASSIGNMENT_CATALOG", campaignAssignmentId },
  });
}
