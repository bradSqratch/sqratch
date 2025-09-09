// src/app/api/admin/update-campaign/[id]/route.ts
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
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 }
    );
  }

  let body: {
    name?: string;
    description?: string;
    inviteUrl?: string;
    communityId?: string | null;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { name, description, inviteUrl, communityId } = body;
  if (!name || !inviteUrl) {
    return NextResponse.json(
      { error: "Name and Invite URL are required" },
      { status: 400 }
    );
  }

  try {
    const updated = await prisma.campaign.update({
      where: { id },
      data: { name, description, inviteUrl, communityId: communityId ?? null },
      select: {
        id: true,
        name: true,
        description: true,
        inviteUrl: true,
        createdAt: true,
        community: { select: { id: true, name: true, type: true } },
      },
    });

    return NextResponse.json({ data: updated });
  } catch (err) {
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
    return NextResponse.json(
      { error: "Access denied. Admins only." },
      { status: 403 }
    );
  }

  try {
    // First, get the campaign to be deleted to track its name
    const campaign = await prisma.campaign.findUnique({
      where: { id },
      select: { id: true, name: true },
    });

    if (!campaign) {
      return NextResponse.json(
        { error: "Campaign not found" },
        { status: 404 }
      );
    }

    // Get all QR codes for this campaign before we delete it
    const qrCodes = await prisma.qRCode.findMany({
      where: { campaignId: id },
      select: { id: true, qrCodeData: true, campaignId: true },
    });

    // First, update all QR codes associated with the campaign
    for (const qrCode of qrCodes) {
      try {
        await prisma.qRCode.update({
          where: { id: qrCode.id },
          data: {
            status: "INVALID",
            isActive: false,
            deletedCampaignName: campaign.name,
            campaignId: "cmfa7v2gn0001y15t5n1hfoea",
          },
        });
      } catch (error) {
        console.error(`Error updating QR code ${qrCode.id}:`, error);
      }
    }

    // Finally, delete the campaign itself
    await prisma.campaign.delete({
      where: { id },
    });

    return NextResponse.json({
      message: `Campaign "${campaign.name}" and its ${qrCodes.length} QR codes have been deleted.`,
    });
  } catch (error) {
    console.error("Delete campaign error:", error);
    return NextResponse.json({ error: "Delete failed" }, { status: 500 });
  }
}
