import { NextRequest, NextResponse } from "next/server";
import { getExperienceAccessContext } from "@/lib/experience-access";
import prisma from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  context: {
    params: Promise<{ experienceSlug: string; courseSlug: string }>;
  },
) {
  try {
    const { experienceSlug, courseSlug } = await context.params;
    const access = await getExperienceAccessContext(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const course = await prisma.course.findFirst({
      where: {
        id: courseSlug,
        experienceId: access.experience.id,
        isActive: true,
      },
      select: {
        id: true,
        title: true,
        description: true,
        access: true,
        lessons: {
          where: { isActive: true },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            title: true,
            description: true,
            sortOrder: true,
          },
        },
      },
    });

    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }

    const canAccess = course.access === "PUBLIC" || access.canAccessPrivate;

    return NextResponse.json({
      data: {
        experience: {
          id: access.experience.id,
          slug: access.experience.slug,
          title: access.experience.title,
          description: access.experience.description,
          coverImageUrl: access.experience.coverImageUrl,
          creator: {
            id: access.experience.creator.id,
            displayName:
              access.experience.creator.displayName ||
              access.experience.creator.user.name ||
              "Creator",
            bio: access.experience.creator.bio,
            avatarUrl: access.experience.creator.avatarUrl,
          },
          campaigns: access.experience.campaigns.map((item) => ({
            id: item.campaign.id,
            name: item.campaign.name,
            brand: item.campaign.brand,
          })),
          isLoggedIn: access.isLoggedIn,
          hasUnlockedCampaign: access.hasUnlockedCampaign,
          isCreatorOwner: access.isCreatorOwner,
          canAccessPrivate: access.canAccessPrivate,
          canInteract: access.canInteract,
        },
        course: {
          id: course.id,
          title: course.title,
          description: course.description,
          access: course.access,
          lessons: canAccess ? course.lessons : [],
        },
        canAccess,
      },
    });
  } catch (error) {
    console.error(
      "[public/experience/[experienceSlug]/courses/[courseSlug]] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to load course." },
      { status: 500 },
    );
  }
}
