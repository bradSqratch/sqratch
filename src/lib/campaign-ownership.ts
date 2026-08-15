/** The stable API code returned when an existing Campaign owner is changed. */
export const CAMPAIGN_BRAND_IMMUTABLE = "CAMPAIGN_BRAND_IMMUTABLE";

/**
 * Existing Campaign ownership is immutable. Omitted owner is normal metadata
 * editing; an echoed current owner is accepted for older clients.
 */
export function isCampaignBrandMutationAllowed(
  currentBrandId: string,
  providedBrandId: string | null,
): boolean {
  return providedBrandId === null || providedBrandId === currentBrandId;
}

/** Metadata-only Prisma data. Ownership must never appear in this object. */
export function buildCampaignMetadataUpdate(input: {
  name: string;
  slug: string;
  description: string | null;
  isActive: boolean;
}) {
  return {
    name: input.name,
    slug: input.slug,
    description: input.description,
    isActive: input.isActive,
  };
}
