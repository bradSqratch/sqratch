// src/app/api/admin/communities/[id]/route.ts
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const { name, type } = await request.json();
  try {
    const updated = await prisma.community.update({
      where: { id },
      data: { type },
    });
    return NextResponse.json({ data: updated });
  } catch {
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
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  try {
    // Optional: check if any campaigns reference it before deleting.
    await prisma.community.delete({ where: { id } });
    return NextResponse.json({});
  } catch {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
