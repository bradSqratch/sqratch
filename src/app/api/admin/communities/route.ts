// src/app/api/admin/communities/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const data = await prisma.community.findMany({
    orderBy: { name: "asc" }, // nicer for dropdowns
    select: { id: true, name: true, type: true, createdAt: true },
  });
  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }

  // ✅ Extract BOTH fields
  const { name, type } = (await request.json()) as {
    name?: string;
    type?: "BETTERMODE" | "GENERIC";
  };

  // ✅ Validate name
  if (!name || !name.trim()) {
    return NextResponse.json(
      { error: "Community name is required" },
      { status: 400 }
    );
  }

  try {
    const created = await prisma.community.create({
      data: {
        name: name.trim(),
        type: type ?? "GENERIC",
      },
      select: { id: true, name: true, type: true, createdAt: true },
    });
    return NextResponse.json({ data: created }, { status: 201 });
  } catch (e: any) {
    if (e.code === "P2002") {
      return NextResponse.json(
        { error: "Community name already exists" },
        { status: 409 }
      );
    }
    // Optional: expose prisma message during dev
    // console.error("Create community failed:", e);
    return NextResponse.json({ error: "Create failed" }, { status: 500 });
  }
}
