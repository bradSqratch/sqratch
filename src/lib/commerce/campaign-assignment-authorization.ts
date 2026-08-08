/**
 * Authorization facts shared by public campaign-assignment rendering and the
 * corresponding click hop. `isVisibleInShop` is deliberately absent: it is a
 * generic brand-storefront control, not campaign-assignment authorization.
 */
export type CampaignAssignmentAuthorizationFacts = {
  assignment: {
    campaignId: string;
    brandId: string;
    isActive: boolean;
  };
  campaign: {
    id: string;
    brandId: string | null;
  };
  brandCommerceProduct: {
    brandId: string;
    isCampaignEligible: boolean;
    connectedProduct: {
      brandId: string;
      isAvailable: boolean;
    };
  };
};

/**
 * Defense-in-depth verification for an already-contained assignment row.
 * Experience containment is intentionally checked in each caller's query;
 * this predicate covers the campaign/brand/catalog invariants both callers
 * must agree on.
 */
export function isCampaignAssignmentCatalogAuthorized(
  facts: CampaignAssignmentAuthorizationFacts,
): boolean {
  const { assignment, campaign, brandCommerceProduct } = facts;

  return (
    assignment.isActive &&
    assignment.campaignId === campaign.id &&
    assignment.brandId === campaign.brandId &&
    brandCommerceProduct.brandId === assignment.brandId &&
    brandCommerceProduct.isCampaignEligible &&
    brandCommerceProduct.connectedProduct.brandId === assignment.brandId &&
    brandCommerceProduct.connectedProduct.isAvailable
  );
}
