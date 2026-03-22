import { NextRequest, NextResponse } from "next/server";
import { getBrandAdminContext } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";

function getDateRange(request: NextRequest) {
  const dateFrom = request.nextUrl.searchParams.get("dateFrom");
  const dateTo = request.nextUrl.searchParams.get("dateTo");

  const start = dateFrom ? new Date(dateFrom) : null;
  const end = dateTo ? new Date(dateTo) : null;

  if (end) {
    end.setHours(23, 59, 59, 999);
  }

  return { start, end };
}

export async function GET(request: NextRequest) {
  try {
    const context = await getBrandAdminContext();

    if (!context?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const campaignId = request.nextUrl.searchParams.get("campaignId");
    const { start, end } = getDateRange(request);

    const campaigns = await prisma.campaign.findMany({
      where: {
        brandId: context.membership.brand.id,
        ...(campaignId ? { id: campaignId } : {}),
      },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
      },
    });

    const campaignIds = campaigns.map((campaign) => campaign.id);

    const analyticsDateFilter = start || end
      ? {
          createdAt: {
            ...(start ? { gte: start } : {}),
            ...(end ? { lte: end } : {}),
          },
        }
      : {};

    const [
      scanGroups,
      lessonStarts,
      lessonCompletions,
      shopClicks,
      unlockGroups,
    ] = await Promise.all([
      campaignIds.length
        ? prisma.analyticsEvent.groupBy({
            by: ["campaignId"],
            where: {
              campaignId: { in: campaignIds },
              name: "qr_scan",
              ...analyticsDateFilter,
            },
            _count: { _all: true },
          })
        : [],
      campaignIds.length
        ? prisma.analyticsEvent.groupBy({
            by: ["campaignId"],
            where: {
              campaignId: { in: campaignIds },
              name: "lesson_started",
              ...analyticsDateFilter,
            },
            _count: { _all: true },
          })
        : [],
      campaignIds.length
        ? prisma.analyticsEvent.groupBy({
            by: ["campaignId"],
            where: {
              campaignId: { in: campaignIds },
              name: "lesson_completed",
              ...analyticsDateFilter,
            },
            _count: { _all: true },
          })
        : [],
      campaignIds.length
        ? prisma.analyticsEvent.groupBy({
            by: ["campaignId"],
            where: {
              campaignId: { in: campaignIds },
              name: "shop_click",
              ...analyticsDateFilter,
            },
            _count: { _all: true },
          })
        : [],
      campaignIds.length
        ? prisma.campaignUnlock.groupBy({
            by: ["campaignId"],
            where: {
              campaignId: { in: campaignIds },
              ...(start || end
                ? {
                    createdAt: {
                      ...(start ? { gte: start } : {}),
                      ...(end ? { lte: end } : {}),
                    },
                  }
                : {}),
            },
            _count: { _all: true },
          })
        : [],
    ]);

    const scanMap = new Map(scanGroups.map((row) => [row.campaignId, row._count._all]));
    const startMap = new Map(
      lessonStarts.map((row) => [row.campaignId, row._count._all]),
    );
    const completionMap = new Map(
      lessonCompletions.map((row) => [row.campaignId, row._count._all]),
    );
    const shopClickMap = new Map(
      shopClicks.map((row) => [row.campaignId, row._count._all]),
    );
    const unlockMap = new Map(
      unlockGroups.map((row) => [row.campaignId, row._count._all]),
    );

    const byCampaign = campaigns.map((campaign) => ({
      id: campaign.id,
      name: campaign.name,
      slug: campaign.slug,
      scans: scanMap.get(campaign.id) || 0,
      unlocks: unlockMap.get(campaign.id) || 0,
      lessonStarts: startMap.get(campaign.id) || 0,
      lessonCompletions: completionMap.get(campaign.id) || 0,
      shopClicks: shopClickMap.get(campaign.id) || 0,
    }));

    return NextResponse.json({
      data: {
        campaigns,
        totals: {
          scans: byCampaign.reduce((total, row) => total + row.scans, 0),
          unlocks: byCampaign.reduce((total, row) => total + row.unlocks, 0),
          lessonStarts: byCampaign.reduce(
            (total, row) => total + row.lessonStarts,
            0,
          ),
          lessonCompletions: byCampaign.reduce(
            (total, row) => total + row.lessonCompletions,
            0,
          ),
          shopClicks: byCampaign.reduce(
            (total, row) => total + row.shopClicks,
            0,
          ),
        },
        byCampaign,
      },
    });
  } catch (error) {
    console.error("[brand/analytics][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load brand analytics." },
      { status: 500 },
    );
  }
}
