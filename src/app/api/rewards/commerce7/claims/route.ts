import { NextRequest, NextResponse } from "next/server";
import { resolveSession } from "@/lib/auth-session";
import { getRewardClaimContext } from "@/lib/reward-access";
import { claimCommerce7Reward } from "@/lib/commerce7-rewards";
import { serializeCommerce7Claim, requireValue } from "@/lib/commerce7-reward-domain";
import { object } from "@/lib/commerce/providers/commerce7-rewards-client";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  try {
    const session = await resolveSession();
    if (!session?.user.id) return NextResponse.json({ error: "Sign in to claim rewards." }, { status: 401 });
    const body = object(await request.json().catch(() => null));
    requireValue(body && typeof body.offerId === "string" && body.offerId.length <= 100, "Choose a reward offer.");
    requireValue(body.experienceSlug == null || typeof body.experienceSlug === "string", "Invalid experience.");
    requireValue(body.campaignId == null || typeof body.campaignId === "string", "Invalid campaign.");
    const context = await getRewardClaimContext({ request, userId: session.user.id, experienceSlug: body.experienceSlug as string | undefined, campaignId: body.campaignId as string | undefined });
    if (!context.ok) return NextResponse.json({ error: context.error }, { status: context.status });
    const result = await claimCommerce7Reward(session.user.id, body.offerId, body.idempotencyKey, context.brandIds);
    return NextResponse.json({ data: serializeCommerce7Claim(result.claim) }, { status: 200 });
  } catch (error) { return rewardErrorResponse(error); }
}
