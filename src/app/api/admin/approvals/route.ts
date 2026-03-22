import { NextResponse } from "next/server";
import { getAdminContext } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const context = await getAdminContext();

    if (!context) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }

    const [
      creatorRequests,
      brandRequests,
      processedCreatorRequests,
      processedBrandRequests,
    ] = await Promise.all([
      prisma.creatorRequest.findMany({
        where: { status: "PENDING" },
        orderBy: [{ createdAt: "desc" }],
        select: {
          id: true,
          status: true,
          reason: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              isEmailVerified: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.brandRequest.findMany({
        where: { status: "PENDING" },
        orderBy: [{ createdAt: "desc" }],
        select: {
          id: true,
          status: true,
          reason: true,
          proposedBrandName: true,
          proposedStoreUrl: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              isEmailVerified: true,
              createdAt: true,
            },
          },
        },
      }),
      prisma.creatorRequest.findMany({
        where: { status: { not: "PENDING" } },
        orderBy: [{ updatedAt: "desc" }],
        select: {
          id: true,
          status: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              isEmailVerified: true,
              createdAt: true,
            },
          },
          reviewedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      }),
      prisma.brandRequest.findMany({
        where: { status: { not: "PENDING" } },
        orderBy: [{ updatedAt: "desc" }],
        select: {
          id: true,
          status: true,
          proposedBrandName: true,
          createdAt: true,
          updatedAt: true,
          user: {
            select: {
              id: true,
              name: true,
              email: true,
              role: true,
              isEmailVerified: true,
              createdAt: true,
            },
          },
          reviewedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
      }),
    ]);

    const approvalHistory = [
      ...processedCreatorRequests.map((request) => ({
        id: request.id,
        requestType: "CREATOR" as const,
        status: request.status,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        proposedBrandName: null,
        user: request.user,
        reviewedBy: request.reviewedBy,
      })),
      ...processedBrandRequests.map((request) => ({
        id: request.id,
        requestType: "BRAND" as const,
        status: request.status,
        createdAt: request.createdAt,
        updatedAt: request.updatedAt,
        proposedBrandName: request.proposedBrandName,
        user: request.user,
        reviewedBy: request.reviewedBy,
      })),
    ].sort(
      (left, right) =>
        new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
    );

    return NextResponse.json({
      data: {
        creatorRequests,
        brandRequests,
        approvalHistory,
      },
    });
  } catch (error) {
    console.error("[admin/approvals][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load approvals." },
      { status: 500 },
    );
  }
}
