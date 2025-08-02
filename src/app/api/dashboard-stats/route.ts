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

  const [totalRedemptions, activeCampaigns, campaigns] = await Promise.all([
    prisma.qRCode.count({
      where: {
        usedAt: dateFilter ? dateFilter : { not: null },
      },
    }),
    prisma.campaign.count({
      where: {
        qrCodes: {
          some: dateFilter ? { createdAt: dateFilter } : {},
        },
      },
    }),
    prisma.campaign.findMany({
      include: {
        qrCodes: dateFilter
          ? {
              where: { createdAt: dateFilter },
              select: { status: true },
            }
          : {
              select: { status: true },
            },
      },
    }),
  ]);

  const campaignStats = campaigns.map((c) => {
    const totalQRCodes = c.qrCodes.length;
    const redeemedCount = c.qrCodes.filter((q) => q.status === "USED").length;
    return {
      campaignId: c.id,
      campaignName: c.name,
      totalQRCodes,
      redeemedCount,
    };
  });

  return NextResponse.json({
    data: {
      totalRedemptions,
      activeCampaigns,
      campaignStats,
    },
  });
}
