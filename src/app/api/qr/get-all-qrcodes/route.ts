import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const qrCodes = await prisma.qRCode.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      campaign: true,
      redeemedBy: true, // join user
    },
  });

  const formatted = qrCodes.map((q) => ({
    id: q.id,
    campaignId: q.campaignId,
    campaignName: q.campaign?.name || "Unknown",
    code: q.qrCodeData,
    status: q.status === "USED" ? "REDEEMED" : "NEW",
    usedBy: q.redeemedBy?.email || null,
    usedAt: q.usedAt || null,
    createdAt: q.createdAt,
    imageUrl: q.qrCodeUrl || "",
  }));

  return NextResponse.json({ data: formatted });
}
