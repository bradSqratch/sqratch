import type prisma from "./prisma";

/**
 * Presentation-only viewer state for the claimant rewards card. It never
 * authorizes anything: every claim/cancel/retry route still calls
 * getRewardClaimContext. SIGNED_OUT and LOCKED carry no offers, claims or points.
 */
export type Commerce7RewardViewerState = "SIGNED_OUT" | "LOCKED" | "READY";
type Db = Pick<typeof prisma, "experience" | "campaign" | "brandRewardOffer">;

/**
 * Whether the experience/campaign is linked to a Brand with a Commerce7
 * rewards program configured (offers in any state). Reveals one boolean and no
 * offer, value or Brand detail, so a signed-out viewer of a Shopify-only
 * experience is not shown an unrelated "Commerce7 rewards" card.
 */
export async function commerce7RewardsApply(db: Db, scope: { experienceSlug?: string | null; campaignId?: string | null }): Promise<boolean> {
  let brandIds: string[] = [];
  if (scope.experienceSlug) {
    const experience = await db.experience.findUnique({ where: { slug: scope.experienceSlug }, select: { campaigns: { select: { campaign: { select: { brandId: true } } } } } });
    brandIds = experience?.campaigns.flatMap((item) => item.campaign.brandId ? [item.campaign.brandId] : []) ?? [];
  } else if (scope.campaignId) {
    const campaign = await db.campaign.findUnique({ where: { id: scope.campaignId }, select: { brandId: true } });
    brandIds = campaign?.brandId ? [campaign.brandId] : [];
  }
  if (!brandIds.length) return false;
  return (await db.brandRewardOffer.count({ where: { provider: "COMMERCE7", brandId: { in: [...new Set(brandIds)] } } })) > 0;
}
/** The only shape a viewer without private access can receive. */
export function restrictedViewer(state: "SIGNED_OUT" | "LOCKED", applies: boolean) {
  return { viewerState: (applies ? state : "READY") as Commerce7RewardViewerState, offers: [] as never[], claims: [] as never[], points: null };
}
