import { NextRequest, NextResponse } from "next/server";
import { transferAnonymousState } from "@/lib/anonymous-transfer";
import { SESSION_COOKIE_NAME } from "@/lib/session";
import { isValidSessionId } from "@/lib/session-id";
import { AuthResolvers, realAuthResolvers } from "@/lib/auth-session";

export async function POST(request: NextRequest) {
  return mergeImpl(request, realAuthResolvers);
}

/**
 * Authenticated entry point for moving the browser's anonymous progress to the
 * signed-in account. The browser session comes only from the caller's own
 * `sqr_session` cookie. A transfer that cannot finish still answers 200 with
 * `status: "retry_required"`; calling it again is always safe.
 */
export async function mergeImpl(request: NextRequest, deps: AuthResolvers) {
  try {
    const session = await deps.resolveSession();
    const userId = session?.user?.id || null;
    const userEmail = session?.user?.email || null;
    const rawSessionId = request.cookies.get(SESSION_COOKIE_NAME)?.value || null;
    const sessionId = isValidSessionId(rawSessionId) ? rawSessionId : null;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    const data = await transferAnonymousState({ userId, userEmail, sessionId });
    return NextResponse.json({ data });
  } catch (error) {
    console.error("[progress/merge] Error:", error);
    return NextResponse.json(
      { error: "Failed to merge progress." },
      { status: 500 },
    );
  }
}
