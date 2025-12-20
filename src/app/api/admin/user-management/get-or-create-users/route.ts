import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { sendVerificationEmail } from "@/helpers/mailer";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session || session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Admins only" }, { status: 403 });
  }

  const users = await prisma.user.findMany({
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      points: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ data: users });
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
      { status: 400 }
    );
  }

  try {
    const hashed = await bcrypt.hash(password, 10);

    // Prepare token BEFORE the DB write, but don't send email yet
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000);

    // Prisma 7 safe transaction: use the "array of queries" form
    const newUser = await prisma.$transaction(async (tx) => {
      // 1) Create user
      const created = await tx.user.create({
        data: { name, email, password: hashed, role },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          points: true,
          createdAt: true,
        },
      });

      // 2) Clear existing tokens
      await tx.emailVerificationToken.deleteMany({
        where: { userId: created.id },
      });

      // 3) Create fresh token
      await tx.emailVerificationToken.create({
        data: { userId: created.id, emailVerifyToken: token, expires },
      });

      return created;
    });

    // 4) Send verification email AFTER transaction commits
    await sendVerificationEmail(newUser.email, token);

    return NextResponse.json(
      { data: newUser, message: "User created; verification email sent." },
      { status: 201 }
    );
  } catch (err: any) {
    if (err.code === "P2002" && err.meta?.target?.includes("email")) {
      return NextResponse.json(
        { error: "Email already in use" },
        { status: 409 }
      );
    }
    console.error("Create user error:", err);
    return NextResponse.json(
      { error: "Failed to create user" },
      { status: 500 }
    );
  }
}
