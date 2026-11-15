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

    const creatorRequest = await prisma.creatorRequest.findUnique({
      where: { id: requestId },
      select: { id: true, userId: true, user: { select: { id: true, name: true, email: true } } },
    });
    if (!creatorRequest) return NextResponse.json({ error: "Creator request not found." }, { status: 404 });

    const result = await prisma.$transaction(async (tx) => {
      const claim = await tx.creatorRequest.updateMany({
        where: { id: requestId, status: "PENDING" },
        data: { status: action === "approve" ? "APPROVED" : "REJECTED", reason, reviewedById: context.userId },
      });
      if (claim.count !== 1) throw new Error("REQUEST_ALREADY_DECIDED");
      const updatedRequest = await tx.creatorRequest.findUniqueOrThrow({
        where: { id: requestId }, select: { id: true, status: true, reason: true, updatedAt: true },
      });

      if (action === "approve") {
        const promoted = await tx.user.updateMany({
          where: { id: creatorRequest.userId, role: { not: "ADMIN" } },
          data: { role: "CREATOR" },
        });
        if (promoted.count !== 1) throw new Error("TARGET_IS_ADMIN");

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
    if (error instanceof Error && ["REQUEST_ALREADY_DECIDED", "TARGET_IS_ADMIN"].includes(error.message)) {
      return NextResponse.json({ code: error.message, error: error.message === "TARGET_IS_ADMIN" ? "Administrators cannot be changed by an approval." : "This request has already been decided." }, { status: 409 });
    }
    console.error("[admin/approvals/creator][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to process creator request." },
      { status: 500 },
    );
  }
}
