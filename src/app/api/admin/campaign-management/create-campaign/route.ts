import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  let body: {
    name: string;
    description?: string;
    inviteUrl: string;
    communityId?: string;
  };

  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { name, description, inviteUrl, communityId } = body;

  if (!name || !inviteUrl) {
    return NextResponse.json(
      { error: "Name and invite URL are required" },
      { status: 400 }
    );
  }

  try {
    const created = await prisma.campaign.create({
      data: {
        name,
        description,
        inviteUrl,
        createdById: session.user.id,
        communityId: body.communityId ?? null,
      },
      select: {
        id: true,
        name: true,
        inviteUrl: true,
        description: true,
        createdAt: true,
        community: { select: { id: true, name: true, type: true } },
      },
    });

    return NextResponse.json({ data: created });
  } catch (err: any) {
    if (err.code === "P2002") {
      return NextResponse.json(
        { error: "Campaign name or invite URL already exists" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { error: "Failed to create campaign" },
      { status: 500 }
    );
  }
}
