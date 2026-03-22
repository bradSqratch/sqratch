import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id || null;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const unlocks = await prisma.campaignUnlock.findMany({
      where: {
        userId,
      },
      orderBy: {
        createdAt: "desc",
      },
      select: {
        id: true,
        createdAt: true,
        campaign: {
          select: {
            id: true,
            name: true,
            description: true,
            brand: {
              select: {
                id: true,
                name: true,
                slug: true,
                logoUrl: true,
              },
            },
            experiences: {
              orderBy: {
                sortOrder: "asc",
              },
              select: {
                experience: {
                  select: {
                    id: true,
                    slug: true,
                    title: true,
                    description: true,
                    coverImageUrl: true,
                    _count: {
                      select: {
                        courses: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });

    return NextResponse.json({
      data: unlocks.map((unlock) => ({
        unlockId: unlock.id,
        unlockedAt: unlock.createdAt,
        campaign: {
          id: unlock.campaign.id,
          name: unlock.campaign.name,
          description: unlock.campaign.description,
          brand: unlock.campaign.brand,
          experiences: unlock.campaign.experiences.map((item) => ({
            id: item.experience.id,
            slug: item.experience.slug,
            title: item.experience.title,
            description: item.experience.description,
            coverImageUrl: item.experience.coverImageUrl,
            courseCount: item.experience._count.courses,
          })),
        },
      })),
    });
  } catch (error) {
    console.error("[user/unlocks] Error:", error);
    return NextResponse.json(
      { error: "Failed to load user unlocks." },
      { status: 500 },
    );
  }
}
