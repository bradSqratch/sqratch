import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET() {
  // fetch just the song titles from both PENDING & APPROVED
  const data = await prisma.songRequest.findMany({
    where: {
      status: { in: ["PENDING", "APPROVED"] },
    },
    select: {
      song: true,
    },
  });

  return NextResponse.json({ data });
}
