import { NextRequest, NextResponse } from "next/server";
import {
  getBrandAdminContext,
  getBrandContextFailure,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { endOfUtcDay, parseUtcCalendarDate } from "@/lib/commerce/commerce-click-analytics";

function getDateRange(request: NextRequest) {
  const dateFrom = request.nextUrl.searchParams.get("dateFrom");
  const dateTo = request.nextUrl.searchParams.get("dateTo");

  const start = dateFrom ? parseUtcCalendarDate(dateFrom) : null;
  const parsedEnd = dateTo ? parseUtcCalendarDate(dateTo) : null;
  const end = parsedEnd ? endOfUtcDay(parsedEnd) : null;
  if ((dateFrom && !start) || (dateTo && !end) || (start && end && end < start)) {
    return { error: "Choose a valid From and To date range." } as const;
  }

  return { start, end };
}

export async function GET(request: NextRequest) {
  try {
    const context = await getBrandAdminContext();

    if (!context?.membership?.brand) {
      const failure = getBrandContextFailure(context);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    const campaignId = request.nextUrl.searchParams.get("campaignId");
    const dateRange = getDateRange(request);
    if ("error" in dateRange) return NextResponse.json({ error: dateRange.error }, { status: 400 });
    const { start, end } = dateRange;

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
        ? prisma.commerceClickAttribution.groupBy({
            by: ["entryCampaignId"],
            where: {
              entryCampaignId: { in: campaignIds },
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
      shopClicks.map((row) => [row.entryCampaignId, row._count._all]),
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
  } catch {
    console.error("[brand/analytics][GET] Failed");
    return NextResponse.json(
      { error: "Failed to load brand analytics." },
      { status: 500 },
    );
  }
}
