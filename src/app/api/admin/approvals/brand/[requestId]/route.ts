import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { getAdminContext, createUniqueSlug } from "@/lib/admin-auth";
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

async function createUniqueBrandName(
  baseValue: string,
  tx: Prisma.TransactionClient,
) {
  const baseName = baseValue.trim() || "New Brand";
  let candidate = baseName;
  let suffix = 2;

  while (
    await tx.brand.findFirst({
      where: { name: candidate },
      select: { id: true },
    })
  ) {
    candidate = `${baseName} ${suffix}`;
    suffix += 1;
  }

  return candidate;
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

    const brandRequest = await prisma.brandRequest.findUnique({
      where: { id: requestId },
      select: {
        id: true,
        status: true,
        userId: true,
        proposedBrandName: true,
        proposedStoreUrl: true,
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    if (!brandRequest) {
      return NextResponse.json(
        { error: "Brand request not found." },
        { status: 404 },
      );
    }

    if (brandRequest.status !== "PENDING") {
      return NextResponse.json(
        { error: "This brand request has already been processed." },
        { status: 409 },
      );
    }

    const response = await prisma.$transaction(
      async (tx) => {
        const updatedRequest = await tx.brandRequest.update({
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

        if (action === "reject") {
          return {
            request: updatedRequest,
            brand: null,
          };
        }

        await tx.user.update({
          where: { id: brandRequest.userId },
          data: { role: "BRAND_ADMIN" },
        });

        const existingMemberships = await tx.brandMember.findMany({
          where: { userId: brandRequest.userId },
          select: {
            brand: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        });

        if (existingMemberships.length > 1) {
          throw new Error("USER_HAS_MULTIPLE_BRANDS");
        }

        if (existingMemberships[0]?.brand) {
          return {
            request: updatedRequest,
            brand: existingMemberships[0].brand,
          };
        }

        const requestedName =
          brandRequest.proposedBrandName?.trim() ||
          brandRequest.user.name?.trim() ||
          brandRequest.user.email.split("@")[0] ||
          "New Brand";

        const uniqueName = await createUniqueBrandName(requestedName, tx);
        const uniqueSlug = await createUniqueSlug(
          uniqueName,
          async (candidate) =>
            Boolean(
              await tx.brand.findFirst({
                where: { slug: candidate },
                select: { id: true },
              }),
            ),
          "brand",
        );

        const brand = await tx.brand.create({
          data: {
            name: uniqueName,
            slug: uniqueSlug,
            websiteUrl: brandRequest.proposedStoreUrl?.trim() || null,
          },
          select: {
            id: true,
            name: true,
            slug: true,
          },
        });

        await tx.brandMember.create({
          data: {
            brandId: brand.id,
            userId: brandRequest.userId,
            role: "ADMIN",
          },
        });

        return {
          request: updatedRequest,
          brand,
        };
      },
      {
        maxWait: 10_000,
        timeout: 15_000,
      },
    );

    if (action === "approve") {
      try {
        await sendApprovalEmail(
          brandRequest.user.email,
          "brand",
          brandRequest.user.name || brandRequest.proposedBrandName || undefined,
        );
      } catch (mailError) {
        console.warn(
          "[admin/approvals/brand][POST] Approval email failed:",
          mailError,
        );
      }
    }

    return NextResponse.json({ data: response });
  } catch (error) {
    if (error instanceof Error && error.message === "USER_HAS_MULTIPLE_BRANDS") {
      return NextResponse.json(
        { error: "This user has multiple brands; choose the destination explicitly." },
        { status: 409 },
      );
    }
    console.error("[admin/approvals/brand][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to process brand request." },
      { status: 500 },
    );
  }
}
