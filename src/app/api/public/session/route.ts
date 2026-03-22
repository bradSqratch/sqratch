import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import crypto from "crypto";

const COOKIE_NAME = "sqr_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

function generateSessionId() {
  return crypto.randomBytes(24).toString("hex");
}

export async function POST(request: NextRequest) {
  try {
    const existingSessionId = request.cookies.get(COOKIE_NAME)?.value;
    const sessionId = existingSessionId || generateSessionId();

    const existingSession = await prisma.userSession.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });

    if (!existingSession) {
      await prisma.userSession.create({
        data: {
          id: sessionId,
          anonKey: sessionId,
        },
      });
    } else {
      await prisma.userSession.update({
        where: { id: sessionId },
        data: {
          lastSeenAt: new Date(),
        },
      });
    }

    const response = NextResponse.json({
      ok: true,
      sessionId,
    });

    response.cookies.set(COOKIE_NAME, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });

    return response;
  } catch (error) {
    console.error("[public/session] Error:", error);
    return NextResponse.json(
      { error: "Failed to initialize session." },
      { status: 500 },
    );
  }
}
