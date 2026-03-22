import { NextRequest, NextResponse } from "next/server";
import { getAdminContext } from "@/lib/admin-auth";
import { sendApprovalEmail } from "@/helpers/mailer";
import prisma from "@/lib/prisma";

type ApprovalAction = "approve" | "reject";

function parseAction(value: unknown): ApprovalAction | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();

  if (normalized === "approve" || normalized === "reject") {
    return normalized;
  }

  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ requestId: string }> },
) {
  try {
    const context = await getAdminContext();

    if (!context) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }

    const { requestId } = await params;
    const body = await request.json().catch(() => null);
    const action = parseAction(body?.action);
    const reason = String(body?.reason || "").trim() || null;

    if (!action) {
      return NextResponse.json(
        { error: "A valid action is required." },
        { status: 400 },
      );
    }

    const result = await prisma.$transaction(async (tx) => {
      const creatorRequest = await tx.creatorRequest.findUnique({
        where: { id: requestId },
        select: {
          id: true,
          status: true,
          userId: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      });

      if (!creatorRequest) {
        return { error: "Creator request not found.", status: 404 as const };
      }

      if (creatorRequest.status !== "PENDING") {
        return {
          error: "This creator request has already been processed.",
          status: 409 as const,
        };
      }

      const updatedRequest = await tx.creatorRequest.update({
        where: { id: requestId },
        data: {
          status: action === "approve" ? "APPROVED" : "REJECTED",
          reason,
          reviewedById: context.userId,
        },
        select: {
          id: true,
          status: true,
          reason: true,
          updatedAt: true,
        },
      });

      if (action === "approve") {
        await tx.user.update({
          where: { id: creatorRequest.userId },
          data: { role: "CREATOR" },
        });

        const displayName =
          creatorRequest.user.name?.trim() ||
          creatorRequest.user.email.split("@")[0];

        await tx.creatorProfile.upsert({
          where: { userId: creatorRequest.userId },
          update: {
            displayName,
            isActive: true,
          },
          create: {
            userId: creatorRequest.userId,
            displayName,
            isActive: true,
          },
        });
      }

      return {
        data: updatedRequest,
        approvedUser:
          action === "approve"
            ? {
                email: creatorRequest.user.email,
                name: creatorRequest.user.name,
              }
            : null,
      };
    });

    if ("error" in result) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status },
      );
    }

    if (result.approvedUser) {
      try {
        await sendApprovalEmail(
          result.approvedUser.email,
          "creator",
          result.approvedUser.name || undefined,
        );
      } catch (mailError) {
        console.warn(
          "[admin/approvals/creator][POST] Approval email failed:",
          mailError,
        );
      }
    }

    return NextResponse.json({ data: result.data });
  } catch (error) {
    console.error("[admin/approvals/creator][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to process creator request." },
      { status: 500 },
    );
  }
}
