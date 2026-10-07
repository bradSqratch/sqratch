import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getBrandManagementContext, getBrandContextFailure } from "@/lib/brand-auth";
import { provisionCommerce7Claim } from "@/lib/commerce7-rewards";
import { Commerce7RewardsClient, object } from "@/lib/commerce/providers/commerce7-rewards-client";
import { RewardClaimError, serializeCommerce7Claim } from "@/lib/commerce7-reward-domain";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";
export const maxDuration = 60;
export async function POST(request: NextRequest, context: { params: Promise<{ claimId: string }> }) {
  try {
    const auth = await getBrandManagementContext();
    if (!auth?.membership?.brand) { const failure = getBrandContextFailure(auth); return NextResponse.json({ error: failure.error }, { status: failure.status }); }
    const { claimId } = await context.params;
    const claim = await prisma.commerceRewardRedemption.findFirst({ where: { id: claimId, brandId: auth.membership.brand.id, provider: "COMMERCE7" } });
    if (!claim) throw new RewardClaimError("NOT_FOUND", "Claim not found.", 404);
    const body = object(await request.json().catch(() => null));
    if (body?.action === "RETRY") {
      // Clearing a completed ambiguous request allows lookup recovery only;
      // durable attempt markers are deliberately retained. Live owners stay held.
      if (claim.provisioningOwner) throw new RewardClaimError("OWNER_HELD", "An in-flight or crashed worker owns this claim. Use the documented operator recovery procedure.");
      await prisma.commerceRewardRedemption.updateMany({ where: { id: claim.id, provisioningOwner: null, status: "POINTS_DEBITED" }, data: { needsManualReview: false, providerLastCheckedAt: null } });
      const result = await provisionCommerce7Claim(claim.id);
      return NextResponse.json({ data: result ? serializeCommerce7Claim(result) : null });
    }
    if (body?.action !== "REVOKE" || claim.status !== "ISSUED" || !claim.externalDiscountId) throw new RewardClaimError("INVALID_ACTION", "This claim cannot be revoked.");
    const connection = await prisma.commerceConnection.findFirst({ where: { id: claim.connectionId ?? "", brandId: claim.brandId, provider: "COMMERCE7", externalAccountId: claim.externalAccountId, status: "CONNECTED", uninstalledAt: null } });
    if (!connection) throw new RewardClaimError("CONNECTION_UNAVAILABLE", "Reconnect the original Commerce7 store.");
    await new Commerce7RewardsClient(connection.externalAccountId).revokeCoupon(claim.externalDiscountId);
    await prisma.commerceRewardRedemption.updateMany({ where: { id: claim.id, status: "ISSUED" }, data: { status: "CANCELLED", provisioningState: "REVOKED", externalDiscountStatus: "Deleted", errorMessage: "The store revoked this coupon. Contact the store about any points adjustment." } });
    return NextResponse.json({ ok: true });
  } catch (error) { return rewardErrorResponse(error); }
}
