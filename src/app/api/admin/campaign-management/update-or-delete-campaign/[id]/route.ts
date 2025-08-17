// src/app/api/admin/update-campaign/[id]/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 }
    );
  }

  let body: {
    name?: string;
    description?: string;
    inviteUrl?: string;
    communityId?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { name, description, inviteUrl, communityId } = body;
  if (!name || !inviteUrl) {
    return NextResponse.json(
      { error: "Name and Invite URL are required" },
      { status: 400 }
    );
  }

  try {
    const updated = await prisma.campaign.update({
      where: { id },
      data: { name, description, inviteUrl, communityId: communityId ?? null },
      select: {
        id: true,
        name: true,
        description: true,
        inviteUrl: true,
        createdAt: true,
        communityId: true,
      },
    });

    return NextResponse.json({ data: updated });
  } catch (err) {
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 }
    );
  }

  try {
    await prisma.campaign.delete({ where: { id } });
    return NextResponse.json({});
  } catch {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
