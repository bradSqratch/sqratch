/**
 * POST /api/internal/reconcile-redemptions
 *
 * Internal worker that reconciles ShopifyRewardRedemption rows stuck in
 * POINTS_DEBITED status (crash between TX commit and ISSUED update).
 *
 * Authentication: x-cron-secret header must match process.env.CRON_SECRET.
 *
 * Supabase Cron is managed manually outside this repository and invokes this
 * endpoint every 10 minutes. Do not add a Vercel cron configuration here.
 *
 * SECURITY: The secret value is never logged — only its presence/absence is
 * checked. This mirrors the email-worker auth pattern.
 */

import { NextResponse } from "next/server";
import { reconcileStuckRedemptions } from "@/lib/reward-reconciliation";

/**
 * Compares the incoming cron secret to the expected env value without logging
 * either. Returns true only when both are non-empty strings that match exactly.
 */
function requireCronSecret(req: Request): boolean {
  const got = req.headers.get("x-cron-secret");
  const expected = process.env.CRON_SECRET;
  return !!got && !!expected && got === expected;
}

export async function POST(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const summary = await reconcileStuckRedemptions({
      limit: 20,
      minAgeMs: 5 * 60 * 1000,  // 5 minutes
      maxAttempts: 5,
    });

    console.log("[reconcile-redemptions] DONE", summary);

    return NextResponse.json({ ok: true, summary });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[reconcile-redemptions] ERROR", { message });
    return NextResponse.json(
      { error: "Reconciliation failed.", detail: message },
      { status: 500 },
    );
  }
}
