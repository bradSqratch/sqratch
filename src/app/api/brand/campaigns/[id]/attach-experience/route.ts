import { NextRequest, NextResponse } from "next/server";
import {
  getBrandAdminContext,
  getBrandContextFailure,
  getOwnedBrandCampaign,
} from "@/lib/brand-auth";
import prisma from "@/lib/prisma";

const MAX_SORT_ORDER = 1_000_000;

/**
 * Bounds CampaignExperience.sortOrder to the same closed range this repo uses
 * for every other brand-writable ordering column (see MAX_DISPLAY_ORDER in
 * src/app/api/brand/campaigns/[id]/commerce-products/route.ts).
 *
 * An Experience can be co-sponsored by several brands, and each brand controls
 * the sortOrder of its OWN join row on that shared Experience. Unbounded, a
 * co-sponsoring brand could write an extreme negative value to sort itself
 * first everywhere the campaign list was read, capturing the shared
 * Experience's primary brand and click attribution. Ordering is no longer a
 * security boundary — every consumer now goes through
 * src/lib/campaign-context.ts, which refuses to pick "the first of several"
 * and applies a code-level campaignId tiebreak — but the value must still not
 * be unbounded.
 *
 * Returns null for a non-integer or out-of-range value, which callers reject
 * with a 400. `undefined` keeps the historical default of 0.
 */
function parseSortOrder(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return 0;
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 0 || value > MAX_SORT_ORDER) return null;
  return value;
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const brand = await getBrandAdminContext();

    if (!brand?.membership?.brand) {
      const failure = getBrandContextFailure(brand);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    const { id } = await context.params;
    const q = String(request.nextUrl.searchParams.get("q") || "").trim();
    const campaign = await getOwnedBrandCampaign(id, brand.membership.brand.id);

    if (!campaign) {
      return NextResponse.json(
        { error: "Campaign not found." },
        { status: 404 },
      );
    }

    const attachedRows = await prisma.campaignExperience.findMany({
      where: {
        campaignId: campaign.id,
      },
      orderBy: { sortOrder: "asc" },
      select: {
        experienceId: true,
        sortOrder: true,
      },
    });

    const attachedIds = new Set(attachedRows.map((row) => row.experienceId));
    const experiences = await prisma.experience.findMany({
      where: {
        AND: [
          {
            OR: [{ isActive: true }, { id: { in: Array.from(attachedIds) } }],
          },
          ...(q
            ? [
                {
                  OR: [
                    { title: { contains: q, mode: "insensitive" as const } },
                    { slug: { contains: q, mode: "insensitive" as const } },
                  ],
                },
              ]
            : []),
        ],
      },
      orderBy: { updatedAt: "desc" },
      take: 50,
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        isActive: true,
      },
    });

    return NextResponse.json({
      data: {
        campaign,
        experiences: experiences.map((experience) => ({
          id: experience.id,
          title: experience.title,
          slug: experience.slug,
          description: experience.description,
          status: experience.isActive ? "PUBLISHED" : "DRAFT",
          attached: attachedIds.has(experience.id),
          sortOrder:
            attachedRows.find((row) => row.experienceId === experience.id)
              ?.sortOrder ?? null,
        })),
      },
    });
  } catch (error) {
    console.error("[brand/campaigns/[id]/attach-experience][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load campaign experiences." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const brand = await getBrandAdminContext();

    if (!brand?.membership?.brand) {
      const failure = getBrandContextFailure(brand);
      return NextResponse.json(
        { error: failure.error, ...(failure.code ? { code: failure.code } : {}) },
        { status: failure.status },
      );
    }

    const { id } = await context.params;
    const campaign = await getOwnedBrandCampaign(id, brand.membership.brand.id);

    if (!campaign) {
      return NextResponse.json(
        { error: "Campaign not found." },
        { status: 404 },
      );
    }

    const body = await request.json();
    const experienceId = String(body?.experienceId || "").trim();
    const attach = Boolean(body?.attach);
    const sortOrder = parseSortOrder(body?.sortOrder);

    if (!experienceId) {
      return NextResponse.json(
        { error: "experienceId is required." },
        { status: 400 },
      );
    }

    if (sortOrder === null) {
      return NextResponse.json(
        { error: "sortOrder must be a whole number from 0 to 1000000." },
        { status: 400 },
      );
    }

    const experience = await prisma.experience.findUnique({
      where: { id: experienceId },
      select: { id: true, isActive: true },
    });

    if (!experience) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    if (attach && !experience.isActive) {
      return NextResponse.json(
        { error: "Draft experiences cannot be attached to campaigns." },
        { status: 400 },
      );
    }

    if (attach) {
      await prisma.campaignExperience.upsert({
        where: {
          campaignId_experienceId: {
            campaignId: campaign.id,
            experienceId,
          },
        },
        update: {
          sortOrder,
        },
        create: {
          campaignId: campaign.id,
          experienceId,
          sortOrder,
        },
      });
    } else {
      await prisma.campaignExperience.deleteMany({
        where: {
          campaignId: campaign.id,
          experienceId,
        },
      });
    }

    return NextResponse.json({ data: { ok: true } });
  } catch (error) {
    console.error("[brand/campaigns/[id]/attach-experience][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to update campaign sponsorships." },
      { status: 500 },
    );
  }
}
