import type { NextRequest, NextResponse } from "next/server";
import { handleCommerceClick } from "@/lib/commerce/click-attribution";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string; brandCommerceProductId: string }> },
): Promise<NextResponse> {
  const { experienceSlug, brandCommerceProductId } = await context.params;
  return handleCommerceClick(request, {
    experienceSlug,
    surface: { kind: "CAMPAIGN_CATALOG", brandCommerceProductId },
  });
}
