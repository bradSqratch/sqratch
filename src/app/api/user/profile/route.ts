import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { deleteStorageObjectByUrl } from "@/lib/storage-upload";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        name: true,
        email: true,
        imageUrl: true,
      },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    return NextResponse.json({ data: user });
  } catch (error) {
    console.error("[user/profile][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load profile." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = await request.json();
    const name = String(body?.name || "").trim();
    const imageUrl = String(body?.imageUrl || "").trim();

    const existing = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        imageUrl: true,
      },
    });

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        name: name || null,
        imageUrl: imageUrl || null,
      },
      select: {
        id: true,
        name: true,
        email: true,
        imageUrl: true,
      },
    });

    if (existing?.imageUrl && existing.imageUrl !== user.imageUrl) {
      await deleteStorageObjectByUrl(existing.imageUrl);
    }

    return NextResponse.json({ data: user });
  } catch (error) {
    console.error("[user/profile][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update profile." },
      { status: 500 },
    );
  }
}
