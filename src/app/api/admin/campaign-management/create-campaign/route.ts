import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import { v2 as cloudinary } from "cloudinary";

// Cloudinary config
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

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
    // Duplicate check (case-insensitive for name and inviteUrl)
    const dup = await prisma.campaign.findFirst({
      where: {
        OR: [
          { name: { equals: name, mode: "insensitive" } },
          { inviteUrl: { equals: inviteUrl, mode: "insensitive" } },
        ],
      },
      select: { id: true },
    });
    if (dup) {
      return NextResponse.json(
        { error: "Campaign name or invite URL already exists" },
        { status: 409 }
      );
    }

    // Ensure Cloudinary folder exists: qrCodes/<campaignName>
    const safeName = name.replace(/[\\/]/g, "-");
    const folderPath = `qrCodes/${safeName}`;
    try {
      await cloudinary.api.create_folder(folderPath);
    } catch (e: any) {
      // If already exists, ignore; otherwise log and continue
      if (!(e?.http_code === 409 || /already exists/i.test(e?.message || ""))) {
        console.warn("Cloudinary create_folder warning:", e?.message || e);
      }
    }

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
