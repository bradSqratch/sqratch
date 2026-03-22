import { NextRequest, NextResponse } from "next/server";
import { getExperienceAccessContext, getViewerContext } from "@/lib/experience-access";
import prisma from "@/lib/prisma";

export async function GET(request: NextRequest) {
  try {
    const experienceSlug = request.nextUrl.searchParams.get("experienceSlug");

    if (!experienceSlug) {
      return NextResponse.json(
        { error: "experienceSlug is required." },
        { status: 400 },
      );
    }

    const access = await getExperienceAccessContext(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    if (!access.viewer.userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    if (!access.canInteract) {
      return NextResponse.json(
        { error: "You do not have access to posts." },
        { status: 403 },
      );
    }

    const posts = await prisma.post.findMany({
      where: {
        experienceId: access.experience.id,
        isActive: true,
      },
      orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
      select: {
        id: true,
        title: true,
        body: true,
        isPinned: true,
        createdAt: true,
        _count: {
          select: {
            comments: true,
          },
        },
      },
    });

    return NextResponse.json({
      data: {
        experience: {
          id: access.experience.id,
          slug: access.experience.slug,
          title: access.experience.title,
        },
        creator: {
          displayName:
            access.experience.creator.displayName ||
            access.experience.creator.user.name ||
            "Creator",
        },
        canCreate: access.isCreatorOwner,
        posts: posts.map((post) => ({
          id: post.id,
          title: post.title,
          body: post.body,
          isPinned: post.isPinned,
          createdAt: post.createdAt,
          commentCount: post._count.comments,
        })),
      },
    });
  } catch (error) {
    console.error("[posts][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load posts." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const viewer = await getViewerContext(request);

    if (!viewer.userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = await request.json();
    const experienceId = String(body?.experienceId || "").trim();
    const title = String(body?.title || "").trim();
    const content = String(body?.body || "").trim();

    if (!experienceId || !content) {
      return NextResponse.json(
        { error: "experienceId and body are required." },
        { status: 400 },
      );
    }

    const experience = await prisma.experience.findUnique({
      where: { id: experienceId },
      select: {
        id: true,
        creator: {
          select: {
            userId: true,
          },
        },
      },
    });

    if (!experience) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    if (experience.creator.userId !== viewer.userId) {
      return NextResponse.json(
        { error: "Only the creator can publish posts." },
        { status: 403 },
      );
    }

    const post = await prisma.post.create({
      data: {
        experienceId: experience.id,
        title: title || null,
        body: content,
      },
      select: {
        id: true,
        title: true,
        body: true,
        isPinned: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ data: post }, { status: 201 });
  } catch (error) {
    console.error("[posts][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create post." },
      { status: 500 },
    );
  }
}
