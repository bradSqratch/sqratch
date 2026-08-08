import prisma from "@/lib/prisma";
import {
  buildEligibleCampaignContexts,
  type CampaignContextCandidate,
  type CampaignContextSource,
} from "@/lib/campaign-context";

/**
 * The single Prisma-backed loader for "which campaign contexts apply to this
 * Experience". Kept out of `src/lib/campaign-context.ts` so that module stays
 * pure and trivially unit-testable; this file is the thin I/O shell around it.
 *
 * Any surface that needs eligible campaign contexts for an Experience should
 * go through here rather than re-deriving the query, so the ordering and the
 * brandless-campaign exclusion have exactly one definition.
 */
export type ExperienceCampaignRow = {
  sortOrder: number;
  campaign: {
    id: string;
    name: string;
    brandId: string | null;
    brand: {
      id: string;
      name: string;
      shopifyShopDomain: string | null;
    } | null;
  };
};

/**
 * Loads the Experience's campaign join rows.
 *
 * The `campaignId` tiebreak matches the code-level tiebreak applied by
 * `buildEligibleCampaignContexts`: `sortOrder` is brand-writable and not
 * unique, so on its own it leaves ties undefined. Consumers must still resolve
 * through `resolveCampaignSelection` — a stable order is not permission to
 * take the first row.
 */
export async function loadExperienceCampaignRows(
  experienceId: string,
): Promise<ExperienceCampaignRow[]> {
  return prisma.campaignExperience.findMany({
    where: { experienceId },
    orderBy: [{ sortOrder: "asc" }, { campaignId: "asc" }],
    select: {
      sortOrder: true,
      campaign: {
        select: {
          id: true,
          name: true,
          brandId: true,
          brand: {
            select: {
              id: true,
              name: true,
              shopifyShopDomain: true,
            },
          },
        },
      },
    },
  });
}

/** Explicit row -> source mapping. No field is inferred or defaulted. */
export function toCampaignContextSources(
  rows: ExperienceCampaignRow[],
): CampaignContextSource[] {
  return rows.map((row) => ({
    campaignId: row.campaign.id,
    campaignName: row.campaign.name,
    sortOrder: row.sortOrder,
    brandId: row.campaign.brandId,
    brandName: row.campaign.brand?.name ?? null,
  }));
}

/** Convenience: load and resolve in one step. */
export async function loadExperienceCampaignContexts(
  experienceId: string,
): Promise<CampaignContextCandidate[]> {
  return buildEligibleCampaignContexts(
    toCampaignContextSources(await loadExperienceCampaignRows(experienceId)),
  );
}
