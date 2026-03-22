import { NextRequest, NextResponse } from "next/server";
import { getViewerContext } from "@/lib/experience-access";
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

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ postId: string; commentId: string }> },
) {
  try {
    const { postId, commentId } = await context.params;
    const viewer = await getViewerContext(request);

    if (!viewer.userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const comment = await prisma.postComment.findUnique({
      where: { id: commentId },
      select: {
        postId: true,
        post: {
          select: {
            experience: {
              select: {
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
        },
      },
    });

    if (!comment || comment.postId !== postId) {
      return NextResponse.json({ error: "Comment not found." }, { status: 404 });
    }

    const brandIds =
      comment.post.experience.campaigns
        .map((item) => item.campaign.brandId)
        .filter((id): id is string => Boolean(id));

    const canDelete = await canDeleteComment({
      viewerUserId: viewer.userId,
      viewerRole: viewer.session?.user?.role,
      experienceCreatorUserId: comment.post.experience.creator.userId,
      brandIds,
    });

    if (!canDelete) {
      return NextResponse.json(
        { error: "You do not have permission to delete this comment." },
        { status: 403 },
      );
    }

    await prisma.postComment.delete({ where: { id: commentId } });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("[posts/[postId]/comments/[commentId]][DELETE] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete comment." },
      { status: 500 },
    );
  }
}
