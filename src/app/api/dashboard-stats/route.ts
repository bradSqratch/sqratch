// src/app/api/admin/dashboard-stats/route.ts
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const url = new URL(request.url);
  const scope = url.searchParams.get("scope") || "all";

  let dateFilter: { gte: Date } | undefined = undefined;

  if (scope === "current-month") {
    const now = new Date();
    const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
    dateFilter = { gte: firstDay };
  }

  const [totalRedemptions, qrTotals, qrRedeemed] = await Promise.all([
    prisma.qRCode.count({
      where: {
        usedAt: dateFilter ? dateFilter : { not: null },
      },
    }),
    prisma.qRCode.groupBy({
      by: ["campaignId"],
      where: {
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      _count: {
        campaignId: true,
      },
    }),
    prisma.qRCode.groupBy({
      by: ["campaignId"],
      where: {
        status: "USED",
        ...(dateFilter ? { createdAt: dateFilter } : {}),
      },
      _count: {
        campaignId: true,
      },
    }),
  ]);

  const campaignIds = qrTotals.map((item) => item.campaignId);

  const campaigns = campaignIds.length
    ? await prisma.campaign.findMany({
        where: {
          id: {
            in: campaignIds,
          },
        },
        select: {
          id: true,
          name: true,
        },
      })
    : [];

  const campaignNameMap = new Map(
    campaigns.map((campaign) => [campaign.id, campaign.name]),
  );
  const redeemedMap = new Map(
    qrRedeemed.map((item) => [item.campaignId, item._count.campaignId || 0]),
  );

  const campaignStats = qrTotals
    .map((item) => ({
      campaignId: item.campaignId,
      campaignName:
        campaignNameMap.get(item.campaignId) || "Unknown campaign",
      totalQRCodes: item._count.campaignId || 0,
      redeemedCount: redeemedMap.get(item.campaignId) || 0,
    }))
    .sort((a, b) => b.totalQRCodes - a.totalQRCodes);

  return NextResponse.json({
    data: {
      totalRedemptions,
      activeCampaigns: qrTotals.length,
      campaignStats,
    },
  });
}
