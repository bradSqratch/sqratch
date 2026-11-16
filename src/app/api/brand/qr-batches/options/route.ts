import { NextRequest, NextResponse } from "next/server";
import { realAuthResolvers, type AuthResolvers } from "@/lib/auth-session";
import { getBrandContextFailure } from "@/lib/brand-auth";
import prisma from "@/lib/prisma";
import { archivedBatchWhere } from "@/lib/qr-archive";
import { parseOptionsQuery } from "@/lib/qr-inventory";

export async function GET(request: NextRequest) {
  return listQrOptionsImpl(request, realAuthResolvers);
}

/**
 * Searchable, cursor-paginated batch or campaign choices for the QR inventory
 * filters. Always scoped to the active brand; the cursor is only an id inside
 * that scope; a cursor that is not a row of this brand's filtered set yields an
 * empty page, so a foreign id can neither position the page nor drop a row.
 */
export async function listQrOptionsImpl(request: NextRequest, deps: AuthResolvers) {
  try {
    const session = await deps.resolveSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const brand = await deps.resolveBrandAdminContext();
    if (!brand?.membership?.brand) {
      const failure = getBrandContextFailure(brand);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }
    const brandId = brand.membership.brand.id;

    const parsed = parseOptionsQuery(request.nextUrl.searchParams);
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
    const { type, q, cursor, limit, archived, campaignId } = parsed.query;

    const empty = () => NextResponse.json({ data: { items: [], nextCursor: null } });

    if (type === "campaigns") {
      if (cursor && !(await prisma.campaign.findFirst({ where: { id: cursor, brandId }, select: { id: true } }))) return empty();
      const rows = await prisma.campaign.findMany({
        where: {
          brandId,
          ...(q ? { OR: [{ name: { contains: q, mode: "insensitive" } }, { slug: { contains: q, mode: "insensitive" } }] } : {}),
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: { id: true, name: true, slug: true },
      });
      const page = rows.slice(0, limit);
      return NextResponse.json({
        data: {
          items: page.map((row) => ({ id: row.id, name: row.name, detail: row.slug })),
          nextCursor: rows.length > limit ? page[page.length - 1].id : null,
        },
      });
    }

    if (cursor && !(await prisma.qRCodeBatch.findFirst({ where: { id: cursor, campaign: { brandId } }, select: { id: true } }))) return empty();
    const rows = await prisma.qRCodeBatch.findMany({
      where: {
        campaign: { brandId },
        AND: [
          archivedBatchWhere(archived),
          ...(campaignId ? [{ campaignId }] : []),
          ...(q ? [{ name: { contains: q, mode: "insensitive" as const } }] : []),
        ],
      },
      orderBy: [{ name: "asc" }, { id: "asc" }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, name: true, campaign: { select: { name: true } } },
    });
    const page = rows.slice(0, limit);
    return NextResponse.json({
      data: {
        items: page.map((row) => ({ id: row.id, name: row.name, detail: row.campaign?.name ?? null })),
        nextCursor: rows.length > limit ? page[page.length - 1].id : null,
      },
    });
  } catch (error) {
    console.error("[brand/qr-batches/options][GET] Error:", error);
    return NextResponse.json({ error: "Failed to load options." }, { status: 500 });
  }
}
