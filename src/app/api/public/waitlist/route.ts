// src/app/api/waitlist/route.ts
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { headers } from "next/headers"; // Import headers to get IP/User-Agent

function isValidEmail(email: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(req: Request) {
  let body: { email?: string; source?: string };

  try {
    body = await req.json();
  } catch (error) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = (body.email || "").trim().toLowerCase();
  const source = body.source?.trim() || "homepage";

  // Get Request Headers
  const headerList = await headers();
  const ip = headerList.get("x-forwarded-for") || "unknown";

  if (!email) {
    return NextResponse.json({ error: "Email required" }, { status: 400 });
  }

  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  try {
    const created = await prisma.waitlistEntry.create({
      data: {
        email,
        source,
        ip,
      },
      select: { id: true, email: true, createdAt: true },
    });

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (err: any) {
    if (err?.code === "P2002") {
      // 200 OK because the user's intent (joining) is satisfied, even if they were already there.
      return NextResponse.json(
        { message: "You are already on the list!" },
        { status: 200 }
      );
    }

    console.error("Waitlist API Error:", err); // Log the actual error for debugging
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
