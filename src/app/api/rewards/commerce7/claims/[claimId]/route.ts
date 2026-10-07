import { NextRequest, NextResponse } from "next/server";
import { resolveSession } from "@/lib/auth-session";
import { cancelCommerce7Claim, provisionCommerce7Claim } from "@/lib/commerce7-rewards";
import { serializeCommerce7Claim } from "@/lib/commerce7-reward-domain";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";
export const maxDuration = 60;
type Context = { params: Promise<{ claimId: string }> };
export async function POST(_request: NextRequest, context: Context) {
  try {
    const session = await resolveSession();
    if (!session?.user.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { claimId } = await context.params;
    const claim = await provisionCommerce7Claim(claimId, session.user.id);
    return claim ? NextResponse.json({ data: serializeCommerce7Claim(claim) }) : NextResponse.json({ error: "Claim not found." }, { status: 404 });
  } catch (error) { return rewardErrorResponse(error); }
}
export async function DELETE(_request: NextRequest, context: Context) {
  try {
    const session = await resolveSession();
    if (!session?.user.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { claimId } = await context.params;
    return NextResponse.json({ data: serializeCommerce7Claim(await cancelCommerce7Claim(session.user.id, claimId)) });
  } catch (error) { return rewardErrorResponse(error); }
}
