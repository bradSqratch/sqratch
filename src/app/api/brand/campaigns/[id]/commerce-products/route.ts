import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import {
  getBrandContextFailure,
  getBrandManagementContext,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";

const MAX_DISPLAY_ORDER = 1_000_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

function decodeCursor(value: string | null): { title: string; id: string } | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    return typeof parsed?.title === "string" && typeof parsed?.id === "string"
      ? { title: parsed.title, id: parsed.id }
      : null;
  } catch { return null; }
}

function encodeCursor(cursor: { title: string; id: string }) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function pageSize(value: string | null) {
  const parsed = Number.parseInt(value || "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
}

function parseDisplayOrder(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_DISPLAY_ORDER) return null;
  return value;
}

async function getCampaignForBrand(campaignId: string, brandId: string) {
  return prisma.campaign.findFirst({
    where: { id: campaignId, brandId },
    select: {
      id: true,
      name: true,
      commerceProductCurationEnabled: true,
    },
  });
}

/**
 * A safe brand-admin catalogue view. Product data comes only from persisted
 * SQRATCH records; provider metadata and connection credentials are never
 * selected or serialized.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getBrandManagementContext();
    if (!auth?.membership?.brand) {
      const failure = getBrandContextFailure(auth);
      return NextResponse.json({ error: failure.error, ...(failure.code ? { code: failure.code } : {}) }, { status: failure.status });
    }

    const { id } = await context.params;
    const brandId = auth.membership.brand.id;
    const campaign = await getCampaignForBrand(id, brandId);
    if (!campaign) return NextResponse.json({ error: "Campaign not found." }, { status: 404 });

    const q = String(request.nextUrl.searchParams.get("q") || "").trim();
    const limit = pageSize(request.nextUrl.searchParams.get("limit"));
    const cursor = decodeCursor(request.nextUrl.searchParams.get("cursor"));
    const where: Prisma.BrandCommerceProductWhereInput = {
      brandId,
      // The historical BCP -> connected-product FK predates Phase 4 and is
      // single-column. Hide any legacy ownership drift rather than exposing
      // another brand's product through this administrative catalog.
      connectedProduct: { brandId },
      ...(q ? {
        connectedProduct: {
          brandId,
          OR: [{ title: { contains: q, mode: "insensitive" } }, { sku: { contains: q, mode: "insensitive" } }],
        },
      } : {}),
      ...(cursor ? {
        OR: [
          { connectedProduct: { brandId, title: { gt: cursor.title } } },
          { connectedProduct: { brandId, title: cursor.title }, id: { gt: cursor.id } },
        ],
      } : {}),
    };
    const rows = await prisma.brandCommerceProduct.findMany({
      where,
      orderBy: [{ connectedProduct: { title: "asc" } }, { id: "asc" }],
      take: limit + 1,
      select: {
        id: true,
        isCampaignEligible: true,
        titleOverride: true,
        shortDescriptionOverride: true,
        connectedProduct: {
          select: { id: true, title: true, imageUrl: true, isAvailable: true, productUrl: true },
        },
        campaignAssignments: {
          where: { campaignId: campaign.id },
          select: { id: true, isActive: true, displayOrder: true, deactivatedAt: true },
          take: 1,
        },
      },
    });

    const hasNextPage = rows.length > limit;
    const page = hasNextPage ? rows.slice(0, limit) : rows;
    const last = page.at(-1);
    return NextResponse.json({
      data: {
        campaign,
        products: page.map((row) => {
          const assignment = row.campaignAssignments[0] ?? null;
          return {
            brandCommerceProductId: row.id,
            title: row.titleOverride || row.connectedProduct.title,
            description: row.shortDescriptionOverride || null,
            imageUrl: row.connectedProduct.imageUrl,
            productUrl: row.connectedProduct.productUrl,
            isCampaignEligible: row.isCampaignEligible,
            isAvailable: row.connectedProduct.isAvailable,
            assignment: assignment
              ? {
                  id: assignment.id,
                  isActive: assignment.isActive,
                  displayOrder: assignment.displayOrder,
                  deactivatedAt: assignment.deactivatedAt,
                }
              : null,
          };
        }),
      },
      meta: {
        hasNextPage,
        nextCursor: hasNextPage && last
          ? encodeCursor({ title: last.connectedProduct.title, id: last.id })
          : null,
        limit,
      },
    });
  } catch (error) {
    console.error("[brand/campaigns/[id]/commerce-products][GET] Error:", error);
    return NextResponse.json({ error: "Failed to load campaign products." }, { status: 500 });
  }
}

/** Create or reactivate an assignment. A client-supplied product URL, title,
 * provider id, or brand id is deliberately ignored: only the owned internal
 * BrandCommerceProduct id is accepted. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getBrandManagementContext();
    if (!auth?.membership?.brand) {
      const failure = getBrandContextFailure(auth);
      return NextResponse.json({ error: failure.error, ...(failure.code ? { code: failure.code } : {}) }, { status: failure.status });
    }
    const { id } = await context.params;
    const brandId = auth.membership.brand.id;
    const campaign = await getCampaignForBrand(id, brandId);
    if (!campaign) return NextResponse.json({ error: "Campaign not found." }, { status: 404 });

    const body = await request.json().catch(() => null);
    const brandCommerceProductId = typeof body?.brandCommerceProductId === "string" ? body.brandCommerceProductId.trim() : "";
    const displayOrder = parseDisplayOrder(body?.displayOrder);
    if (!brandCommerceProductId || displayOrder === null) {
      return NextResponse.json({ error: "A product id and a display order from 0 to 1000000 are required." }, { status: 400 });
    }

    const product = await prisma.brandCommerceProduct.findFirst({
      where: {
        id: brandCommerceProductId,
        brandId,
        isCampaignEligible: true,
        connectedProduct: { brandId, isAvailable: true },
      },
      select: { id: true },
    });
    if (!product) return NextResponse.json({ error: "Eligible available product not found." }, { status: 404 });

    const assignment = await prisma.campaignCommerceProduct.upsert({
      where: { campaignId_brandCommerceProductId: { campaignId: campaign.id, brandCommerceProductId: product.id } },
      create: { campaignId: campaign.id, brandId, brandCommerceProductId: product.id, isActive: true, displayOrder, deactivatedAt: null },
      update: { isActive: true, displayOrder, deactivatedAt: null },
      select: { id: true, brandCommerceProductId: true, isActive: true, displayOrder: true, deactivatedAt: true },
    });
    return NextResponse.json({ data: assignment }, { status: 201 });
  } catch (error) {
    console.error("[brand/campaigns/[id]/commerce-products][POST] Error:", error);
    return NextResponse.json({ error: "Failed to assign campaign product." }, { status: 500 });
  }
}

/** Reversible state/order update. Deactivation intentionally keeps history. */
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await getBrandManagementContext();
    if (!auth?.membership?.brand) {
      const failure = getBrandContextFailure(auth);
      return NextResponse.json({ error: failure.error, ...(failure.code ? { code: failure.code } : {}) }, { status: failure.status });
    }
    const { id } = await context.params;
    const brandId = auth.membership.brand.id;
    const campaign = await getCampaignForBrand(id, brandId);
    if (!campaign) return NextResponse.json({ error: "Campaign not found." }, { status: 404 });

    const body = await request.json().catch(() => null);
    const assignmentId = typeof body?.assignmentId === "string" ? body.assignmentId.trim() : "";
    const displayOrder = body?.displayOrder === undefined ? undefined : parseDisplayOrder(body.displayOrder);
    const isActive = body?.isActive;
    if (!assignmentId || (isActive !== undefined && typeof isActive !== "boolean") || displayOrder === null || (isActive === undefined && displayOrder === undefined)) {
      return NextResponse.json({ error: "Provide an assignment and a valid state or display order." }, { status: 400 });
    }

    const assignment = await prisma.campaignCommerceProduct.findFirst({
      where: {
        id: assignmentId,
        campaignId: campaign.id,
        brandId,
        brandCommerceProduct: { brandId, connectedProduct: { brandId } },
      },
      select: { id: true, brandCommerceProduct: { select: { isCampaignEligible: true, connectedProduct: { select: { isAvailable: true } } } } },
    });
    if (!assignment) return NextResponse.json({ error: "Campaign product not found." }, { status: 404 });
    if (isActive === true && (!assignment.brandCommerceProduct.isCampaignEligible || !assignment.brandCommerceProduct.connectedProduct.isAvailable)) {
      return NextResponse.json({ error: "Only eligible available products can be activated." }, { status: 409 });
    }

    const updated = await prisma.campaignCommerceProduct.update({
      where: { id: assignment.id },
      data: {
        ...(displayOrder !== undefined ? { displayOrder } : {}),
        ...(isActive !== undefined ? { isActive, deactivatedAt: isActive ? null : new Date() } : {}),
      },
      select: { id: true, brandCommerceProductId: true, isActive: true, displayOrder: true, deactivatedAt: true },
    });
    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error("[brand/campaigns/[id]/commerce-products][PATCH] Error:", error);
    return NextResponse.json({ error: "Failed to update campaign product." }, { status: 500 });
  }
}
