import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { getBrandAdminContext, BrandAdminContext } from "@/lib/brand-auth";

export const dynamic = "force-dynamic";

interface CustomSession {
  user: {
    id: string;
    role: string;
    email?: string | null;
  };
}

export async function GET(request: NextRequest) {
  const g = globalThis as Record<string, unknown>;
  const mockSession = g.__mockGetServerSession as
    | ((options: unknown) => Promise<CustomSession | null>)
    | undefined;
  const session = mockSession
    ? await mockSession(authOptions)
    : ((await getServerSession(authOptions)) as CustomSession | null);

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let brandId: string | null = null;
  if (session.user.role === "BRAND_ADMIN") {
    const mockBrandCtx = g.__mockGetBrandAdminContext as (() => Promise<BrandAdminContext | null>) | undefined;
    const brand = mockBrandCtx
      ? await mockBrandCtx()
      : await getBrandAdminContext();
    if (!brand?.membership?.brand) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    brandId = brand.membership.brand.id;
  } else if (session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const PAGE_SIZE = 100;
  const MAX_PAGE_SIZE = 200;
  const page = Math.max(1, parseInt(searchParams.get("page") ?? "1", 10) || 1);
  const take = Math.min(
    Math.max(1, parseInt(searchParams.get("pageSize") ?? String(PAGE_SIZE), 10) || PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const skip = (page - 1) * take;

  const where = brandId ? { campaign: { brandId } } : {};

  const [qrCodes, qrCodeTotal] = await Promise.all([
    prisma.qRCode.findMany({
      where,
      orderBy: [
        { createdAt: "desc" },
        { id: "asc" },
      ],
      take,
      skip,
      select: {
        id: true,
        campaignId: true,
        campaign: {
          select: {
            name: true,
          },
        },
        qrCodeData: true,
        status: true,
        usedAt: true,
        createdAt: true,
        qrCodeUrl: true,
        redeemedBy: {
          select: {
            email: true,
          },
        },
      },
    }),
    prisma.qRCode.count({ where }),
  ]);

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

  return NextResponse.json({
    data: formatted,
    pagination: {
      page,
      pageSize: take,
      total: qrCodeTotal,
      totalPages: Math.ceil(qrCodeTotal / take),
    },
  });
}
