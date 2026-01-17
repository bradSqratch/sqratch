// src/app/api/users/signup/route.ts
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import bcryptjs from "bcryptjs";

export async function POST(request: NextRequest) {
  try {
    const { email, name, password } = await request.json();

    if (!email || !name || !password) {
      return NextResponse.json(
        { error: "All fields are required" },
        { status: 400 }
      );
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const cleanName = String(name).trim();

    // 1) Must already exist
    const existingUser = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, role: true, password: true }, // <-- include password
    });

    if (!existingUser) {
      // Don’t allow anyone not pre-created/invited
      return NextResponse.json(
        { error: "This email is not invited. Please contact support." },
        { status: 403 }
      );
    }

    // 2) Only EXTERNAL accounts can be claimed here
    if (existingUser.role !== "EXTERNAL") {
      return NextResponse.json(
        {
          error: "You are not an invited user who can claim an account.",
        },
        { status: 400 }
      );
    }

    // 3) If EXTERNAL but password already set => already claimed
    if (existingUser.password) {
      return NextResponse.json(
        { error: "You are already registered. Please log in." },
        { status: 400 }
      );
    }

    // 4) Claim account: set password + mark verified (for now)
    const salt = await bcryptjs.genSalt(10);
    const hashedPassword = await bcryptjs.hash(password, salt);

    const now = new Date();

    const result = await prisma.user.updateMany({
      where: {
        email: normalizedEmail,
        role: "EXTERNAL",
        password: null, // only claim if not claimed yet
      },
      data: {
        name: cleanName,
        password: hashedPassword,
        isEmailVerified: true,
        emailVerifiedAt: now,
        isActive: true,
      },
    });

    if (result.count === 0) {
      // Means: not invited, not EXTERNAL anymore, or already claimed (password already set)
      return NextResponse.json(
        {
          error:
            "You are already registered or not eligible to claim this account.",
        },
        { status: 400 }
      );
    }

    // optional: fetch the user to return id/email (since updateMany doesn't return the row)
    const updated = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true },
    });

    if (!updated) {
      return NextResponse.json(
        { error: "User not found after update." },
        { status: 500 }
      );
    }

    return NextResponse.json(
      { message: "Account activated. Please log in.", user: updated },
      { status: 200 }
    );
  } catch (error) {
    console.error("Signup error:", error);
    return NextResponse.json(
      { error: "An error occurred during registration" },
      { status: 500 }
    );
  }
}

// import { NextRequest, NextResponse } from "next/server";
// import prisma from "@/lib/prisma"; // Adjust the import based on your setup
// import bcryptjs from "bcryptjs";
// import crypto from "crypto"; // Use to generate the token
// import { sendVerificationEmail } from "@/helpers/mailer";

// export async function POST(request: NextRequest) {
//   try {
//     const reqBody = await request.json();
//     const { email, name, password } = reqBody;

//     // Check for missing fields
//     if (!email || !name || !password) {
//       return NextResponse.json(
//         { error: "All fields are required" },
//         { status: 400 }
//       );
//     }

//     // Check if the user already exists
//     const existingUser = await prisma.user.findUnique({
//       where: { email },
//     });
//     if (existingUser) {
//       return NextResponse.json(
//         { error: "Email is already registered" },
//         { status: 400 }
//       );
//     }

//     // Hash the password
//     const salt = await bcryptjs.genSalt(10);
//     const hashedPassword = await bcryptjs.hash(password, salt);

//     // Check if a QR Code ID is provided
//     let newUser;

//     // Create a permanent user
//     newUser = await prisma.user.create({
//       data: {
//         email,
//         name,
//         password: hashedPassword,
//       },
//     });
//     // Generate a unique verification token
//     const verificationToken = crypto.randomBytes(32).toString("hex");
//     const expires = new Date(Date.now() + 48 * 60 * 60 * 1000); // Token valid for 24 hours

//     await prisma.emailVerificationToken.create({
//       data: {
//         userId: newUser.id,
//         emailVerifyToken: verificationToken,
//         expires,
//       },
//     });

//     // Send the verification email
//     await sendVerificationEmail(email, verificationToken);

//     return NextResponse.json(
//       { message: "User registered successfully", user: newUser },
//       { status: 201 }
//     );
//   } catch (error: any) {
//     console.error("Signup error:", error);
//     return NextResponse.json(
//       { error: "An error occurred during registration" },
//       { status: 500 }
//     );
//   }
// }
