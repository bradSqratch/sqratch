import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import bcrypt from "bcryptjs";
import { sendVerificationEmail } from "@/helpers/mailer";
import { issueEmailVerificationChallenge } from "@/lib/auth/email-verification";
import { PASSWORD_POLICY_MESSAGE, validatePassword } from "@/lib/password-policy";
import { normalizeUserRole } from "@/lib/admin-auth";

export async function GET(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() || "";

  const users = await prisma.user.findMany({
    where: query
      ? {
          OR: [
            {
              name: {
                contains: query,
                mode: "insensitive",
              },
            },
            {
              email: {
                contains: query,
                mode: "insensitive",
              },
            },
          ],
        }
      : undefined,
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      createdAt: true,
      isActive: true,
      creatorProfile: {
        select: {
          id: true,
        },
      },
      brandMembers: {
        select: {
          id: true,
          role: true,
          brand: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
        take: 3,
        orderBy: {
          createdAt: "asc",
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    data: users.map((user) => ({
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      isActive: user.isActive,
      hasCreatorProfile: Boolean(user.creatorProfile),
      brands: user.brandMembers.map((member) => ({
        id: member.brand.id,
        name: member.brand.name,
        slug: member.brand.slug,
        membershipRole: member.role,
      })),
    })),
  });
}

export async function POST(request: Request) {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const { name, email, password, role } = await request.json();
  if (!name || !email || !password || !role) {
    return NextResponse.json(
      { error: "All fields are required" },
      { status: 400 },
    );
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const requestedRole = normalizeUserRole(role);
  if (!cleanEmail) {
    return NextResponse.json({ error: "Email is required" }, { status: 400 });
  }
  if (!requestedRole) {
    return NextResponse.json({ error: "Invalid role" }, { status: 400 });
  }

  const passwordError = validatePassword(String(password));
  if (passwordError) {
    return NextResponse.json(
      { error: PASSWORD_POLICY_MESSAGE },
      { status: 400 },
    );
  }

  try {
    const hashed = await bcrypt.hash(password, 12);

    // Prisma 7 safe transaction: use the "array of queries" form
    const newUser = await prisma.$transaction(async (tx) => {
      // 1) Create user
      const created = await tx.user.create({
        data: {
          name,
          email: cleanEmail,
          password: hashed,
          role: requestedRole,
        },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          createdAt: true,
          isActive: true,
        },
      });

      if (requestedRole === "CREATOR") {
        await tx.creatorProfile.upsert({
          where: { userId: created.id },
          update: {
            displayName: created.name?.trim() || created.email.split("@")[0],
            isActive: true,
          },
          create: {
            userId: created.id,
            displayName: created.name?.trim() || created.email.split("@")[0],
            isActive: true,
          },
        });
      }

      const challenge = await issueEmailVerificationChallenge(
        tx,
        created.id,
        created.email,
        {
          welcomeEligible: false,
        },
      );

      return { user: created, code: challenge.code };
    });

    // 4) Send verification email AFTER transaction commits
    await sendVerificationEmail(newUser.user.email, newUser.code);

    return NextResponse.json(
      { data: newUser.user, message: "User created; verification email sent." },
      { status: 201 },
    );
  } catch (error: unknown) {
    const err = error as { code?: string; meta?: { target?: string[] } };

    if (err.code === "P2002" && err.meta?.target?.includes("email")) {
      return NextResponse.json(
        { error: "Email already in use" },
        { status: 409 },
      );
    }
    console.error("Create user error", { outcome: "request_failed" });
    return NextResponse.json(
      { error: "Failed to create user" },
      { status: 500 },
    );
  }
}
