import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma"; // Adjust the import based on your setup
import bcryptjs from "bcryptjs";
import crypto from "crypto"; // Use to generate the token
import { sendVerificationEmail } from "@/helpers/mailer";

export async function POST(request: NextRequest) {
  try {
    const reqBody = await request.json();
    const { email, name, password, qrCodeId } = reqBody;

    // Check for missing fields
    if (!email || !name || !password) {
      return NextResponse.json(
        { error: "All fields are required" },
        { status: 400 }
      );
    }

    // Check if the user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      return NextResponse.json(
        { error: "Email is already registered" },
        { status: 400 }
      );
    }

    // Hash the password
    const salt = await bcryptjs.genSalt(10);
    const hashedPassword = await bcryptjs.hash(password, salt);

    // Check if a QR Code ID is provided
    let newUser;
    if (qrCodeId) {
      // Validate QR Code ID
      const qrCode = await prisma.qRCode.findUnique({
        where: { id: qrCodeId },
      });

      if (!qrCode) {
        return NextResponse.json(
          { error: "Invalid QR Code ID" },
          { status: 400 }
        );
      }

      // Create a temporary user
      newUser = await prisma.user.create({
        data: {
          email,
          name,
          password: hashedPassword,
        },
      });
    } else {
      // Create a permanent user
      newUser = await prisma.user.create({
        data: {
          email,
          name,
          password: hashedPassword,
        },
      });
    }
    // Generate a unique verification token
    const verificationToken = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 48 * 60 * 60 * 1000); // Token valid for 24 hours

    await prisma.emailVerificationToken.create({
      data: {
        userId: newUser.id,
        emailVerifyToken: verificationToken,
        expires,
      },
    });

    // Send the verification email
    await sendVerificationEmail(email, verificationToken);

    return NextResponse.json(
      { message: "User registered successfully", user: newUser },
      { status: 201 }
    );
  } catch (error: any) {
    console.error("Signup error:", error);
    return NextResponse.json(
      { error: "An error occurred during registration" },
      { status: 500 }
    );
  }
}
