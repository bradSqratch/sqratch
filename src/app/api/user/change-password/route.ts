import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import bcrypt from "bcryptjs";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { PASSWORD_POLICY_MESSAGE, validatePassword } from "@/lib/password-policy";
import { withAuthNoStore } from "@/lib/auth/auth-response";

async function handlePost(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const body = await request.json();
    const currentPassword = String(body?.currentPassword || "");
    const newPassword = String(body?.newPassword || "");
    const confirmPassword = String(body?.confirmPassword || "");

    if (!currentPassword || !newPassword || !confirmPassword) {
      return NextResponse.json(
        { error: "All password fields are required." },
        { status: 400 },
      );
    }

    if (newPassword !== confirmPassword) {
      return NextResponse.json(
        { error: "New password and confirmation do not match." },
        { status: 400 },
      );
    }

    if (newPassword === currentPassword) {
      return NextResponse.json(
        { error: "New password must be different from the current password." },
        { status: 400 },
      );
    }

    if (validatePassword(newPassword)) {
      return NextResponse.json(
        { error: PASSWORD_POLICY_MESSAGE },
        { status: 400 },
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        password: true,
      },
    });

    if (!user || !user.password) {
      return NextResponse.json(
        { error: "Password login is not enabled for this account." },
        { status: 400 },
      );
    }

    const matches = await bcrypt.compare(currentPassword, user.password);

    if (!matches) {
      return NextResponse.json(
        { error: "Current password is incorrect." },
        { status: 400 },
      );
    }

    const hashed = await bcrypt.hash(newPassword, 12);

    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: {
          password: hashed,
          sessionVersion: { increment: 1 },
        },
      });
    });

    return NextResponse.json({ data: { success: true } });
  } catch {
    console.error("[user/change-password][POST] Error", {
      outcome: "request_failed",
    });
    return NextResponse.json(
      { error: "Failed to change password." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  return withAuthNoStore(await handlePost(request));
}
