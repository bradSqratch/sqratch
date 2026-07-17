import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { generateSessionId } from "@/lib/session";
import { isValidSessionId } from "@/lib/session-id";

const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year

export async function POST(request: NextRequest) {
  try {
    const existingSessionId = request.cookies.get("sqr_session")?.value;
    const sessionId = isValidSessionId(existingSessionId)
      ? existingSessionId
      : generateSessionId();

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

    const response = NextResponse.json({ ok: true });
    response.headers.set("Cache-Control", "no-store");

    response.cookies.set("sqr_session", sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: COOKIE_MAX_AGE,
    });

    return response;
  } catch {
    console.error("[public/session] Error", { outcome: "request_failed" });
    return NextResponse.json(
      { error: "Failed to initialize session." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
