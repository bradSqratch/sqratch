import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

/**
 * GET /api/public/campaign-name?campaignId=...
 * Returns: { name: string } or { name: null }
 * No auth; exposes only the campaign's public-facing name.
 */
export async function GET(req: NextRequest) {
  try {
    const campaignId = req.nextUrl.searchParams.get("campaignId");
    if (!campaignId) {
      return NextResponse.json({ name: null }, { status: 400 });
    }

    const campaign = await prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { name: true },
    });

    return NextResponse.json({ name: campaign?.name ?? null });
  } catch (e) {
    return NextResponse.json({ name: null }, { status: 500 });
  }
}
