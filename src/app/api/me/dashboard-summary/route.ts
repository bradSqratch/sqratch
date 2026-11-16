import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { normalizeUserRole } from "@/lib/admin-auth";
import { resolveActiveBrandContext } from "@/lib/brand-context";
import { loadCustomerHome } from "@/lib/customer-home";
import { getActiveCommerceConnectionAnyProvider, isConnectionUsable } from "@/lib/commerce/connection-service";

function getStartOfLastDays(days: number) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return date;
}

async function getAdminCards() {
  const recentWindow = getStartOfLastDays(7);

  const [creatorPending, brandPending, totalBrands, totalCampaigns, recentScans] =
    await Promise.all([
      prisma.creatorRequest.count({
        where: { status: "PENDING" },
      }),
      prisma.brandRequest.count({
        where: { status: "PENDING" },
      }),
      prisma.brand.count(),
      prisma.campaign.count(),
      prisma.analyticsEvent.count({
        where: {
          name: "qr_scan",
          createdAt: {
            gte: recentWindow,
          },
        },
      }),
    ]);

  return {
    approvalsPending: creatorPending + brandPending,
    totalBrands,
    totalCampaigns,
    recentScans,
  };
}

async function getBrandAdminCards(userId: string) {
  const recentWindow = getStartOfLastDays(7);

  const active = await resolveActiveBrandContext({
    userId,
    minimumRole: "MANAGER",
  });
  const brand = active?.membership?.brand;

  if (active?.selectionRequired) {
    return {
      selectionRequired: true,
      brands: active.brands,
    };
  }

  if (!brand) {
    return {
      campaignsCount: 0,
      qrBatchCount: 0,
      productSyncStatus: "DISCONNECTED",
      recentScans: 0,
    };
  }

  const [campaignsCount, qrBatchCount, recentScans] = await Promise.all([
    prisma.campaign.count({
      where: {
        brandId: brand.id,
      },
    }),
    prisma.qRCodeBatch.count({
      where: {
        campaign: {
          brandId: brand.id,
        },
      },
    }),
    prisma.analyticsEvent.count({
      where: {
        name: "qr_scan",
        brandId: brand.id,
        createdAt: {
          gte: recentWindow,
        },
      },
    }),
  ]);

  // PHASE 14B.4B: the dashboard's commerce connection/sync-health signal
  // comes from the CANONICAL connection summary — genuinely canonical-first
  // as of this phase (see connection-service.ts) — never Brand.shopify*
  // directly. `isConnectionUsable` reproduces the exact three-part
  // connected/token/status gate this route used to hand-roll.
  //
  // PHASE 16C2: resolved across EVERY provider, not hard-coded to Shopify —
  // a Commerce7-connected brand must see its real sync status here too,
  // never a false "DISCONNECTED" merely because it isn't on Shopify.
  const commerceSummary = await getActiveCommerceConnectionAnyProvider(brand.id);
  const hasCommerceConnection = commerceSummary !== null && isConnectionUsable(commerceSummary);
  const syncWindow = getStartOfLastDays(7);
  const productSyncStatus = !hasCommerceConnection
    ? "DISCONNECTED"
    : commerceSummary?.lastProductSyncAt &&
        commerceSummary.lastProductSyncAt >= syncWindow
      ? "OK"
      : "NEEDS_ATTENTION";

  return {
    campaignsCount,
    qrBatchCount,
    productSyncStatus,
    recentScans,
  };
}

async function getCreatorCards(userId: string) {
  const creatorProfile = await prisma.creatorProfile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!creatorProfile) {
    return {
      experiencesCount: 0,
      draftsCount: 0,
      unansweredQACount: 0,
      views: 0,
    };
  }

  const experienceIds = (
    await prisma.experience.findMany({
      where: {
        creatorId: creatorProfile.id,
      },
      select: { id: true },
    })
  ).map((experience) => experience.id);

  const [experiencesCount, draftsCount, unansweredQACount, views] =
    await Promise.all([
      prisma.experience.count({
        where: {
          creatorId: creatorProfile.id,
        },
      }),
      prisma.experience.count({
        where: {
          creatorId: creatorProfile.id,
          isActive: false,
        },
      }),
      prisma.question.count({
        where: {
          experience: {
            creatorId: creatorProfile.id,
          },
          status: "OPEN",
        },
      }),
      experienceIds.length
        ? prisma.analyticsEvent.count({
            where: {
              name: "experience_view",
              experienceId: {
                in: experienceIds,
              },
            },
          })
        : 0,
    ]);

  return {
    experiencesCount,
    draftsCount,
    unansweredQACount,
    views,
  };
}

export async function GET() {
  const session = await getServerSession(authOptions);

  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const role = normalizeUserRole(session.user.role);
  const userId = session.user.id || null;

  if (!role) {
    return NextResponse.json({ error: "Invalid account role." }, { status: 403 });
  }

  const base = {
    role,
    user: {
      name: session.user.name ?? null,
      email: session.user.email ?? null,
    },
  };

  try {
    if (!userId) {
      return NextResponse.json(
        {
          data: {
            ...base,
            cards: {},
          },
        },
        { status: 200 },
      );
    }

    if (role === "ADMIN") {
      return NextResponse.json({
        data: {
          ...base,
          cards: await getAdminCards(),
        },
      });
    }

    if (role === "BRAND_ADMIN") {
      const cards = await getBrandAdminCards(userId);
      if ("selectionRequired" in cards && cards.selectionRequired) {
        return NextResponse.json(
          {
            code: "ACTIVE_BRAND_REQUIRED",
            error: "Select an active brand before loading dashboard data.",
            data: { ...base, cards },
          },
          { status: 409 },
        );
      }
      return NextResponse.json({ data: { ...base, cards } });
    }

    if (role === "CREATOR") {
      return NextResponse.json({
        data: {
          ...base,
          cards: await getCreatorCards(userId),
        },
      });
    }

    const userData = await loadCustomerHome(userId);
    return NextResponse.json({
      data: {
        ...base,
        ...userData,
      },
    });
  } catch (error) {
    console.error("[me/dashboard-summary][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load dashboard summary." },
      { status: 500 },
    );
  }
}
