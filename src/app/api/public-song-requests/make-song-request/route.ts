import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function POST(request: Request) {
  try {
    const { name, email, song } = await request.json();

    // basic validation
    if (!name || !song) {
      return NextResponse.json(
        { error: "Name and song are required." },
        { status: 400 }
      );
    }

    // insert as PENDING
    const created = await prisma.songRequest.create({
      data: {
        name,
        email:
          typeof email === "string" && email.trim() !== "" ? email.trim() : "",
        song,
        status: "PENDING",
        // statusById & statusChanged get set later by admin actions
      },
    });

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (err) {
    console.error("make-song-request error:", err);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
