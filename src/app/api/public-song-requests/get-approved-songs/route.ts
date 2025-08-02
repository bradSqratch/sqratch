import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
  // Always return only APPROVED requests
  const data = await prisma.songRequest.findMany({
    where: { status: "APPROVED" },
    select: {
      id: true,
      song: true,
      name: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return NextResponse.json({ data });
}
