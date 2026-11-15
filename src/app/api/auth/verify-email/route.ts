import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { cookies } from "next/headers";
import { transferAnonymousState, type AnonymousTransferResult } from "@/lib/anonymous-transfer";
import { collectAnonMergeKeys } from "@/lib/anon-merge-keys";
import { verifyAndConsumeEmailVerificationCode } from "@/lib/auth/email-verification";
import { isValidSessionId } from "@/lib/session-id";
import { withAuthNoStore } from "@/lib/auth/auth-response";

async function handlePost(request: NextRequest) {
  try {
    const body = await request.json();
    // Anonymous browser identity comes only from this browser's own cookies,
    // never from the request body: a body-supplied key could nominate someone
    // else's anonymous session for transfer.
    const { email, code }: { email?: string; code?: string } = body || {};

    const normalizedEmail = String(email || "").trim().toLowerCase();
    const cleanCode = String(code || "").trim();
    const genericFailure =
      "Unable to verify this code. Request a new code and try again.";

    if (!normalizedEmail || !/^\d{6}$/.test(cleanCode)) {
      return NextResponse.json({ error: genericFailure }, { status: 400 });
    }

    const outcome = await verifyAndConsumeEmailVerificationCode(
      normalizedEmail,
      cleanCode,
    );

    if (outcome !== "verified") {
      return NextResponse.json({ error: genericFailure }, { status: 400 });
    }

    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, email: true },
    });

    if (!user) {
      return NextResponse.json({ error: genericFailure }, { status: 400 });
    }

    const cookieStore = await cookies();
    const anonKeyFromCookie = cookieStore.get("anonKey")?.value || null;
    const deviceKeyCookie = cookieStore.get("deviceKey")?.value || null;
    const rawSessionId = cookieStore.get("sqr_session")?.value || null;
    const sessionIdFromCookie = isValidSessionId(rawSessionId)
      ? rawSessionId
      : null;
    const validAnonymousKey = (value: string | null | undefined) => {
      const trimmed = value?.trim() || null;
      return isValidSessionId(trimmed) ? trimmed : null;
    };

    // Merge ALL distinct anon-key candidates so that a stale legacy cookie
    // (anonKey / deviceKey) does NOT shadow the active sqr_session.  The active
    // session is always processed first.
    const mergeKeys = collectAnonMergeKeys({
      anonKeyCookie: validAnonymousKey(anonKeyFromCookie),
      deviceKeyCookie: validAnonymousKey(deviceKeyCookie),
      sessionCookie: sessionIdFromCookie,
    });

    // Verification has succeeded and its one-time code is spent. Moving
    // anonymous progress is a separate outcome: it must never turn a verified
    // account into an error, and a failed transfer is retried at sign-in.
    let transfer: AnonymousTransferResult = {
      status: "retry_required",
      mergedLessons: 0,
      mergedUnlocks: 0,
      pointsAwarded: 0,
    };
    try {
      transfer = await transferAnonymousState({
        userId: user.id,
        userEmail: user.email,
        sessionId: sessionIdFromCookie,
        unlockKeys: mergeKeys,
      });
    } catch {
      console.error("[auth/verify-email] transfer failed", { outcome: "transfer_failed" });
    }

    return NextResponse.json({
      ok: true,
      message: "Email verified successfully.",
      user,
      transfer,
    });
  } catch {
    console.error("[auth/verify-email] Error", { outcome: "request_failed" });
    return NextResponse.json(
      { error: "An error occurred during verification." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  return withAuthNoStore(await handlePost(request));
}
