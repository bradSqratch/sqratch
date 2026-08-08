process.env.DATABASE_URL =
  "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isCampaignAssignmentCatalogAuthorized,
  type CampaignAssignmentAuthorizationFacts,
} from "../src/lib/commerce/campaign-assignment-authorization";

function facts(
  overrides: Partial<CampaignAssignmentAuthorizationFacts> = {},
): CampaignAssignmentAuthorizationFacts {
  const base: CampaignAssignmentAuthorizationFacts = {
    assignment: {
      campaignId: "campaign-a",
      brandId: "brand-a",
      isActive: true,
    },
    campaign: {
      id: "campaign-a",
      brandId: "brand-a",
      commerceProductCurationEnabled: true,
    },
    brandCommerceProduct: {
      brandId: "brand-a",
      isCampaignEligible: true,
      connectedProduct: { brandId: "brand-a", isAvailable: true },
    },
  };

  return {
    ...base,
    ...overrides,
    assignment: { ...base.assignment, ...overrides.assignment },
    campaign: { ...base.campaign, ...overrides.campaign },
    brandCommerceProduct: {
      ...base.brandCommerceProduct,
      ...overrides.brandCommerceProduct,
      connectedProduct: {
        ...base.brandCommerceProduct.connectedProduct,
        ...overrides.brandCommerceProduct?.connectedProduct,
      },
    },
  };
}

describe("campaign-assignment catalog authorization", () => {
  test("a campaign-eligible product remains authorized when it is hidden from the generic storefront", () => {
    // `isVisibleInShop: false` is intentionally not an authorization fact on
    // this surface. It controls only the generic BrandCommerceProduct shop.
    const hiddenGenericStorefrontRow = {
      ...facts(),
      isVisibleInShop: false,
    };

    assert.equal(
      isCampaignAssignmentCatalogAuthorized(hiddenGenericStorefrontRow),
      true,
    );
  });

  test("inactive, unavailable, campaign-ineligible, and cross-brand rows fail closed", () => {
    assert.equal(
      isCampaignAssignmentCatalogAuthorized(
        facts({
          assignment: {
            campaignId: "campaign-a",
            brandId: "brand-a",
            isActive: false,
          },
        }),
      ),
      false,
    );
    assert.equal(
      isCampaignAssignmentCatalogAuthorized(
        facts({
          brandCommerceProduct: {
            brandId: "brand-a",
            isCampaignEligible: true,
            connectedProduct: { brandId: "brand-a", isAvailable: false },
          },
        }),
      ),
      false,
    );
    assert.equal(
      isCampaignAssignmentCatalogAuthorized(
        facts({
          brandCommerceProduct: {
            brandId: "brand-a",
            isCampaignEligible: false,
            connectedProduct: { brandId: "brand-a", isAvailable: true },
          },
        }),
      ),
      false,
    );
    assert.equal(
      isCampaignAssignmentCatalogAuthorized(
        facts({
          campaign: {
            id: "campaign-a",
            brandId: "brand-other",
            commerceProductCurationEnabled: true,
          },
        }),
      ),
      false,
    );
    assert.equal(
      isCampaignAssignmentCatalogAuthorized(
        facts({
          brandCommerceProduct: {
            brandId: "brand-a",
            isCampaignEligible: true,
            connectedProduct: { brandId: "brand-other", isAvailable: true },
          },
        }),
      ),
      false,
    );
  });

  test("render and click queries use the same campaign authorization policy, while generic catalog clicks retain storefront visibility", () => {
    const publicProductsSource = readFileSync(
      join(
        process.cwd(),
        "src/app/api/public/experience/[experienceSlug]/products/route.ts",
      ),
      "utf8",
    );
    const attributionSource = readFileSync(
      join(process.cwd(), "src/lib/commerce/click-attribution.ts"),
      "utf8",
    );
    const assignmentClickSection = attributionSource.slice(
      attributionSource.indexOf("async findCampaignAssignmentCatalogProduct"),
      attributionSource.indexOf("async recordAttribution"),
    );
    const genericClickSection = attributionSource.slice(
      attributionSource.indexOf("async findCampaignCatalogProduct"),
      attributionSource.indexOf("async findCampaignAssignmentCatalogProduct"),
    );
    const campaignRenderSection = publicProductsSource.slice(
      publicProductsSource.indexOf(
        "findCampaignProducts({ campaignId, brandId })",
      ),
      publicProductsSource.indexOf("fetchLegacyCampaignProducts"),
    );

    assert.match(publicProductsSource, /isCampaignAssignmentCatalogAuthorized/);
    assert.match(
      assignmentClickSection,
      /isCampaignAssignmentCatalogAuthorized/,
    );
    assert.doesNotMatch(campaignRenderSection, /isVisibleInShop/);
    assert.doesNotMatch(assignmentClickSection, /isVisibleInShop/);
    assert.match(
      assignmentClickSection,
      /commerceProductCurationEnabled: true/,
    );
    assert.match(assignmentClickSection, /isCampaignEligible: true/);
    assert.match(assignmentClickSection, /isAvailable: true/);
    assert.match(
      assignmentClickSection,
      /experiences: \{ some: \{ experienceId \} \}/,
    );
    // Generic BrandCommerceProduct storefront clicks must not inherit the
    // campaign exception for hidden products.
    assert.match(genericClickSection, /isVisibleInShop: true/);
  });
});
