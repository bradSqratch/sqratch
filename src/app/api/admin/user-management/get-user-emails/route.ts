import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const url = new URL(req.url || "");
  const query = url.searchParams.get("query")?.toLowerCase() || "";

  const users = await prisma.user.findMany({
    where: {
      email: {
        contains: query,
        mode: "insensitive",
      },
    },
    select: { email: true },
    take: 10,
  });

  return NextResponse.json({ data: users.map((u) => u.email) });
}
