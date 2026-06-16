import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { deleteStorageObjectByUrl } from "@/lib/storage-upload";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { Role } from "@prisma/client";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 },
    );
  }

  const { id } = await params;

  let body: {
    name?: string;
    email?: string;
    role?: Role;
    isActive?: boolean;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim().toLowerCase();
  const role = body.role;
  const isActive =
    typeof body.isActive === "boolean" ? body.isActive : undefined;

  if (!name || !email || !role || isActive === undefined) {
    return NextResponse.json(
      { error: "Name, email, role, and active status are required" },
      { status: 400 },
    );
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const existingUser = await tx.user.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          email: true,
        },
      });

      if (!existingUser) {
        throw new Error("USER_NOT_FOUND");
      }

      const user = await tx.user.update({
        where: { id },
        data: { name, email, role, isActive },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
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

      if (role === "CREATOR") {
        await tx.creatorProfile.upsert({
          where: { userId: id },
          update: {
            displayName: name || existingUser.name?.trim() || email.split("@")[0],
            isActive: true,
          },
          create: {
            userId: id,
            displayName: name || existingUser.name?.trim() || email.split("@")[0],
            isActive: true,
          },
        });
      }

      return user;
    });

    return NextResponse.json({
      data: {
        id: updated.id,
        name: updated.name,
        email: updated.email,
        role: updated.role,
        createdAt: updated.createdAt,
        isActive: updated.isActive,
        hasCreatorProfile: Boolean(updated.creatorProfile),
        brands: updated.brandMembers.map((member) => ({
          id: member.brand.id,
          name: member.brand.name,
          slug: member.brand.slug,
          membershipRole: member.role,
        })),
      },
    });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === "USER_NOT_FOUND") {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const err = error as { code?: string; meta?: { target?: string[] } };

    if (err.code === "P2002" && err.meta?.target?.includes("email")) {
      return NextResponse.json(
        { error: "Email already in use" },
        { status: 409 },
      );
    }

    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 },
    );
  }

  const { id } = await params;

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { imageUrl: true },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const [campaignCount, qrCodeCount] = await Promise.all([
      prisma.campaign.count({ where: { createdById: id } }),
      prisma.qRCode.count({ where: { createdById: id } }),
    ]);

    if (campaignCount > 0 || qrCodeCount > 0) {
      return NextResponse.json(
        {
          error:
            "Cannot delete user: they have created campaigns or QR codes. Deactivate the account instead.",
          blockers: { campaigns: campaignCount, qrCodes: qrCodeCount },
        },
        { status: 409 },
      );
    }

    await prisma.user.delete({ where: { id } });

    if (user.imageUrl) {
      await deleteStorageObjectByUrl(user.imageUrl);
    }

    return NextResponse.json({});
  } catch (err: unknown) {
    const prismaErr = err as { code?: string };
    if (prismaErr.code === "P2003") {
      return NextResponse.json(
        {
          error:
            "Cannot delete user: dependent records exist. Deactivate the account instead.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
