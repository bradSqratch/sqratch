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
import { reconcileCommerce7Claims } from "@/lib/commerce7-rewards";
import { reconcileCommerce7RewardOrders } from "@/lib/commerce/providers/commerce7-reward-orders";
import { reconcileStuckRedemptions } from "@/lib/reward-reconciliation";
import { timingSafeEqualString } from "@/lib/security/timing-safe-equal";
export const maxDuration = 60;

/**
 * Compares the incoming cron secret to the expected env value in constant
 * time, without logging either. Returns true only when both are non-empty
 * strings that match exactly.
 */
function requireCronSecret(req: Request): boolean {
  return timingSafeEqualString(
    req.headers.get("x-cron-secret"),
    process.env.CRON_SECRET,
  );
}

export async function POST(req: Request) {
  if (!requireCronSecret(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [shopify, claims, orders] = await Promise.allSettled([
      reconcileStuckRedemptions({ limit: 20, minAgeMs: 5 * 60 * 1000, maxAttempts: 5 }),
      reconcileCommerce7Claims(),
      reconcileCommerce7RewardOrders(),
    ]);
    const summary = shopify.status === "fulfilled" ? shopify.value : null;
    const commerce7 = claims.status === "fulfilled" ? claims.value : null;
    const commerce7Orders = orders.status === "fulfilled" ? orders.value : null;
    const failedWorkers = [shopify, claims, orders].filter((result) => result.status === "rejected").length;
    console.log("[reconcile-redemptions] DONE", { summary, commerce7, commerce7Orders, failedWorkers });
    return NextResponse.json({ ok: failedWorkers === 0, summary, commerce7, commerce7Orders, failedWorkers }, { status: failedWorkers ? 500 : 200 });
  } catch {
    console.error("[reconcile-redemptions] ERROR");
    return NextResponse.json(
      { error: "Reconciliation failed." },
      { status: 500 },
    );
  }
}
