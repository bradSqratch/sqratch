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
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ data });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 403 });
  }
  const { type } = (await request.json()) as {
    name: string;
    type: "BETTERMODE" | "GENERIC";
  };

  try {
    const created = await prisma.community.create({
      data: { type: type ?? "GENERIC" },
    });
    return NextResponse.json({ data: created });
  } catch (e: any) {
    if (e.code === "P2002")
      return NextResponse.json(
        { error: "Community name already exists" },
        { status: 409 }
      );
    return NextResponse.json({ error: "Create failed" }, { status: 500 });
  }
}
