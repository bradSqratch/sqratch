import { NextRequest, NextResponse } from "next/server";
import { getExperienceAccessContext, getViewerContext } from "@/lib/experience-access";
import prisma from "@/lib/prisma";

async function canDeleteComment(options: {
  viewerUserId: string;
  viewerRole?: string;
  experienceCreatorUserId: string;
  brandIds: string[];
}) {
  const { viewerUserId, viewerRole, experienceCreatorUserId, brandIds } = options;

  if (!viewerUserId) {
    return false;
  }

  if (
    viewerRole === "ADMIN" ||
    viewerRole === "BRAND_ADMIN" ||
    viewerUserId === experienceCreatorUserId
  ) {
    return true;
  }

  if (brandIds.length === 0) {
    return false;
  }

  const brandMember = await prisma.brandMember.findFirst({
    where: {
      userId: viewerUserId,
      brandId: {
        in: brandIds,
      },
      role: "ADMIN",
    },
    select: { id: true },
  });

  return Boolean(brandMember);
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ postId: string }> },
) {
  try {
    const { postId } = await context.params;
    const viewer = await getViewerContext(request);

    if (!viewer.userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        experience: {
          select: {
            slug: true,
            creator: { select: { userId: true } },
            campaigns: {
              select: {
                campaign: {
                  select: { brandId: true },
                },
              },
            },
          },
        },
      },
    });

    if (!post) {
      return NextResponse.json({ error: "Post not found." }, { status: 404 });
    }

    const access = await getExperienceAccessContext(post.experience.slug, request);

    if (!access || !access.canInteract) {
      return NextResponse.json(
        { error: "You do not have access to comments." },
        { status: access ? 403 : 404 },
      );
    }

    const comments = await prisma.postComment.findMany({
      where: { postId },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    const brandIds =
      post.experience.campaigns
        .map((item) => item.campaign.brandId)
        .filter((id): id is string => Boolean(id));

    const canDelete = await canDeleteComment({
      viewerUserId: access.viewer.userId!,
      viewerRole: access.viewer.session?.user?.role,
      experienceCreatorUserId: post.experience.creator.userId,
      brandIds,
    });

    return NextResponse.json({
      data: comments.map((comment) => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        user: {
          id: comment.user.id,
          name: comment.user.name || comment.user.email,
        },
        canDelete,
      })),
    });
  } catch (error) {
    console.error("[posts/[postId]/comments][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load comments." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ postId: string }> },
) {
  try {
    const { postId } = await context.params;
    const viewer = await getViewerContext(request);

    if (!viewer.userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = await request.json();
    const content = String(body?.body || "").trim();

    if (!content) {
      return NextResponse.json(
        { error: "Comment body is required." },
        { status: 400 },
      );
    }

    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: {
        experience: {
          select: {
            slug: true,
            creator: { select: { userId: true } },
            campaigns: {
              select: {
                campaign: {
                  select: { brandId: true },
                },
              },
            },
          },
        },
      },
    });

    if (!post) {
      return NextResponse.json({ error: "Post not found." }, { status: 404 });
    }

    const access = await getExperienceAccessContext(post.experience.slug, request);

    if (!access || !access.canInteract) {
      return NextResponse.json(
        { error: "You do not have access to comment on this post." },
        { status: access ? 403 : 404 },
      );
    }

    const comment = await prisma.postComment.create({
      data: {
        postId,
        userId: viewer.userId,
        body: content,
      },
      select: {
        id: true,
        body: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    const brandIds =
      post.experience.campaigns
        .map((item) => item.campaign.brandId)
        .filter((id): id is string => Boolean(id));

    const canDelete = await canDeleteComment({
      viewerUserId: viewer.userId,
      viewerRole: viewer.session?.user?.role,
      experienceCreatorUserId: post.experience.creator.userId,
      brandIds,
    });

    return NextResponse.json(
      {
        data: {
          id: comment.id,
          body: comment.body,
          createdAt: comment.createdAt,
          user: {
            id: comment.user.id,
            name: comment.user.name || comment.user.email,
          },
          canDelete,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[posts/[postId]/comments][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to add comment." },
      { status: 500 },
    );
  }
}
