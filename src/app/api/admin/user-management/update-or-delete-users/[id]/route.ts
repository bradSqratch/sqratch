// src/app/api/admin/user-management/update-or-delete-users/[id]/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { Role } from "@prisma/client";

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (request.method !== "PATCH") {
    return NextResponse.json(
      { error: "Method not allowed. Only PATCH" },
      { status: 405 }
    );
  }

  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 }
    );
  }

  // **await** the params object before reading its .id
  const { id } = await params;

  let body: { name?: string; email?: string; role?: Role };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { name, email, role } = body;
  if (!name || !email || !role) {
    return NextResponse.json(
      { error: "Name, email & role are required" },
      { status: 400 }
    );
  }

  try {
    const updated = await prisma.user.update({
      where: { id },
      data: { name, email, role },
      select: {
        id: true,
        name: true,
        email: true,
        role: true,
        createdAt: true,
      },
    });
    return NextResponse.json({ data: updated });
  } catch (err: any) {
    // handle unique‐constraint violation on email
    if (err.code === "P2002" && err.meta?.target?.includes("email")) {
      return NextResponse.json(
        { error: "Email already in use" },
        { status: 409 }
      );
    }
    return NextResponse.json({ error: "Update failed" }, { status: 500 });
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  if (request.method !== "DELETE") {
    return NextResponse.json(
      { error: "Method not allowed. Only DELETE" },
      { status: 405 }
    );
  }

  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 }
    );
  }

  // **await** the params object before reading its .id
  const { id } = await params;

  try {
    await prisma.user.delete({ where: { id } });
    return NextResponse.json({});
  } catch {
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
