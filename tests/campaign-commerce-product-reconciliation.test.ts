process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.DIRECT_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  findDuplicateActiveAssignmentGroups,
  reconcileCampaignCommerceProducts,
  type CampaignAssignmentRow,
  type CampaignProductReconciliationDeps,
} from "../src/lib/commerce/campaign-product-reconciliation";

function makeRow(overrides: Partial<CampaignAssignmentRow> = {}): CampaignAssignmentRow {
  return {
    id: "assignment-1",
    brandId: "brand-1",
    campaignId: "campaign-1",
    brandCommerceProductId: "brand-product-1",
    isActive: true,
    createdAt: new Date("2026-08-07T00:00:00.000Z"),
    deactivatedAt: null,
    campaign: {
      id: "campaign-1",
      brandId: "brand-1",
    },
    brandCommerceProduct: {
      id: "brand-product-1",
      brandId: "brand-1",
      isCampaignEligible: true,
      connectedProduct: { id: "product-1", brandId: "brand-1", isAvailable: true },
    },
    ...overrides,
  };
}

class FakeStore {
  assignments: CampaignAssignmentRow[] = [];
  /** Sentinels prove reconciliation has no path to link deletion. */
  lessonLinks = ["lesson-link-1"];
  experienceLinks = ["experience-link-1"];
  deactivationCalls = 0;

  deps(): CampaignProductReconciliationDeps {
    return {
      listAssignments: async ({ brandId, campaignId, limit }) => {
        let rows = this.assignments.filter(
          (row) => (!brandId || row.brandId === brandId) && (!campaignId || row.campaignId === campaignId),
        );
        rows = [...rows].sort((a, b) => a.campaignId.localeCompare(b.campaignId) || a.id.localeCompare(b.id));
        if (limit) rows = rows.slice(0, limit);
        return rows.map((row) => structuredClone(row));
      },
      deactivateAssignment: async (assignmentId, deactivatedAt) => {
        this.deactivationCalls += 1;
        const row = this.assignments.find((candidate) => candidate.id === assignmentId);
        if (!row) return { updated: false };
        row.isActive = false;
        row.deactivatedAt = deactivatedAt;
        return { updated: true };
      },
    };
  }
}

describe("campaign commerce product reconciliation", () => {
  test("dry run is the default and never writes or deletes historical links", async () => {
    const store = new FakeStore();
    store.assignments.push(
      makeRow({ id: "a1" }),
      makeRow({ id: "a2", createdAt: new Date("2026-08-08T00:00:00.000Z") }),
    );

    const report = await reconcileCampaignCommerceProducts(store.deps());

    assert.equal(report.mode, "dry_run");
    assert.equal(report.totals.deactivated, 1);
    assert.equal(store.deactivationCalls, 0);
    assert.equal(store.assignments.every((row) => row.isActive), true);
    assert.deepEqual(store.lessonLinks, ["lesson-link-1"]);
    assert.deepEqual(store.experienceLinks, ["experience-link-1"]);
  });

  test("detects every non-destructive ownership and current-validity anomaly", async () => {
    const store = new FakeStore();
    store.assignments.push(
      makeRow({ id: "missing-campaign", brandCommerceProductId: "bp-1", campaign: null }),
      makeRow({ id: "missing-selection", brandCommerceProductId: "bp-2", brandCommerceProduct: null }),
      makeRow({
        id: "cross-brand",
        brandCommerceProductId: "bp-3",
        campaign: { id: "campaign-1", brandId: "brand-2" },
      }),
      makeRow({
        id: "wrong-product-brand",
        brandCommerceProductId: "bp-4",
        brandCommerceProduct: {
          id: "brand-product-1",
          brandId: "brand-1",
          isCampaignEligible: true,
          connectedProduct: { id: "product-1", brandId: "brand-2", isAvailable: true },
        },
      }),
      makeRow({
        id: "ineligible-unavailable",
        brandCommerceProductId: "bp-5",
        brandCommerceProduct: {
          id: "brand-product-1",
          brandId: "brand-1",
          isCampaignEligible: false,
          connectedProduct: { id: "product-1", brandId: "brand-1", isAvailable: false },
        },
      }),
    );

    const report = await reconcileCampaignCommerceProducts(store.deps());
    const kinds = new Set(report.findings.map((finding) => finding.kind));

    assert.deepEqual(kinds, new Set([
      "missing_campaign",
      "missing_brand_commerce_product",
      "cross_brand_assignment",
      "product_wrong_brand",
      "product_not_campaign_eligible",
      "product_unavailable",
    ]));
    assert.equal(store.deactivationCalls, 0);
    assert.equal(store.assignments.find((row) => row.id === "ineligible-unavailable")?.isActive, true);
  });

  test("apply deterministically keeps the earliest duplicate and deactivates the rest", async () => {
    const store = new FakeStore();
    store.assignments.push(
      makeRow({ id: "later", createdAt: new Date("2026-08-09T00:00:00.000Z") }),
      makeRow({ id: "winner", createdAt: new Date("2026-08-07T00:00:00.000Z") }),
      makeRow({ id: "other-product", brandCommerceProductId: "brand-product-2" }),
    );

    const first = await reconcileCampaignCommerceProducts(store.deps(), { apply: true });
    assert.equal(first.totals.deactivated, 1);
    assert.equal(store.deactivationCalls, 1);
    assert.equal(store.assignments.find((row) => row.id === "winner")?.isActive, true);
    assert.equal(store.assignments.find((row) => row.id === "later")?.isActive, false);
    assert.ok(store.assignments.find((row) => row.id === "later")?.deactivatedAt);

    const second = await reconcileCampaignCommerceProducts(store.deps(), { apply: true });
    assert.equal(second.totals.deactivated, 0);
    assert.equal(store.deactivationCalls, 1);
    assert.deepEqual(store.lessonLinks, ["lesson-link-1"]);
    assert.deepEqual(store.experienceLinks, ["experience-link-1"]);
  });

  test("duplicate helper only groups active rows by internal campaign and selection ids", () => {
    const groups = findDuplicateActiveAssignmentGroups([
      makeRow({ id: "active-a" }),
      makeRow({ id: "active-b" }),
      makeRow({ id: "inactive", isActive: false }),
      makeRow({ id: "other", campaignId: "campaign-2" }),
    ]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].map((row) => row.id).sort(), ["active-a", "active-b"]);
  });

  test("brand/campaign filters and limit are forwarded to injected storage", async () => {
    const store = new FakeStore();
    store.assignments.push(
      makeRow({ id: "a", brandId: "brand-1", campaignId: "campaign-1" }),
      makeRow({ id: "b", brandId: "brand-2", campaignId: "campaign-2" }),
      makeRow({ id: "c", brandId: "brand-1", campaignId: "campaign-3" }),
    );
    const byBrand = await reconcileCampaignCommerceProducts(store.deps(), { brandId: "brand-1" });
    assert.equal(byBrand.totals.assignmentsScanned, 2);
    const byCampaign = await reconcileCampaignCommerceProducts(store.deps(), { campaignId: "campaign-2" });
    assert.equal(byCampaign.totals.assignmentsScanned, 1);
    const limited = await reconcileCampaignCommerceProducts(store.deps(), { limit: 1 });
    assert.equal(limited.totals.assignmentsScanned, 1);
  });

  test("diagnostics contain no secret-shaped values or provider metadata", async () => {
    const store = new FakeStore();
    store.assignments.push(makeRow({ campaign: null }));
    const report = await reconcileCampaignCommerceProducts(store.deps());
    assert.equal(report.lines.join("\n").match(/token|secret|encrypted|password|metadata|authorization/i), null);
  });
});
