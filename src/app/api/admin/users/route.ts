import { NextRequest, NextResponse } from "next/server";
import { getAdminContext, normalizeUserRole } from "@/lib/admin-auth";
import prisma from "@/lib/prisma";
import { changeUserAccess, adminMutationError } from "@/lib/admin-user-mutations";

export async function GET(request: NextRequest) {
  try {
    const context = await getAdminContext();

    if (!context) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }

    const query = request.nextUrl.searchParams.get("q")?.trim() || "";

    const users = await prisma.user.findMany({
      where: query
        ? {
            OR: [
              {
                name: {
                  contains: query,
                  mode: "insensitive",
                },
              },
              {
                email: {
                  contains: query,
                  mode: "insensitive",
                },
              },
            ],
          }
        : undefined,
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        isEmailVerified: true,
        createdAt: true,
        isActive: true,
        creatorProfile: {
          select: {
            id: true,
          },
        },
        brandMembers: {
          select: {
            id: true,
            role: true,
            brand: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
          take: 3,
          orderBy: {
            createdAt: "asc",
          },
        },
      },
    });

    return NextResponse.json({
      data: users.map((user) => ({
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        isEmailVerified: user.isEmailVerified,
        createdAt: user.createdAt,
        isActive: user.isActive,
        hasCreatorProfile: Boolean(user.creatorProfile),
        brands: user.brandMembers.map((member) => ({
          id: member.brand.id,
          name: member.brand.name,
          slug: member.brand.slug,
          membershipRole: member.role,
        })),
      })),
    });
  } catch (error) {
    console.error("[admin/users][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load users." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const context = await getAdminContext();

    if (!context) {
      return NextResponse.json({ error: "Admins only." }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    const userId = String(body?.userId || "").trim();
    const nextRole = body?.role === undefined ? undefined : normalizeUserRole(body.role);
    const isActive =
      typeof body?.isActive === "boolean" ? body.isActive : undefined;

    if (!userId) {
      return NextResponse.json(
        { error: "User id is required." },
        { status: 400 },
      );
    }

    if (body?.role !== undefined && !nextRole) {
      return NextResponse.json({ error: "Invalid role." }, { status: 400 });
    }

    if (nextRole === undefined && isActive === undefined) {
      return NextResponse.json(
        { error: "No changes were provided." },
        { status: 400 },
      );
    }

    const updatedUser = await changeUserAccess({ actorId: context.userId, targetId: userId, role: nextRole || undefined, isActive });

    return NextResponse.json({ data: updatedUser });
  } catch (error) {
    if (error instanceof Error && error.message === "ACTOR_NOT_ADMIN") return NextResponse.json({ error: "Administrator access is no longer active." }, { status: 403 });
    const conflict = adminMutationError(error);
    if (conflict) return NextResponse.json(conflict, { status: 409 });
    if (error instanceof Error && error.message === "USER_NOT_FOUND") {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    console.error("[admin/users][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update user." },
      { status: 500 },
    );
  }
}
