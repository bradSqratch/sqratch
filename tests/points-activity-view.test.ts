import "./env-setup"; // DATABASE_URL before points → prisma import
import assert from "node:assert/strict";
import { test, describe } from "node:test";

import {
  buildPointsActivityView,
  parsePointTransactionMetadata,
  resolveDeterministicCampaignByExperience,
  type CampaignSummary,
  type CourseSummary,
  type LessonSummary,
  type RawPointTransactionRow,
  type RedemptionRewardSummary,
} from "../src/lib/points";

function makeCampaign(id: string, overrides: Partial<CampaignSummary> = {}): CampaignSummary {
  return {
    id,
    name: `Campaign ${id}`,
    slug: `campaign-${id}`,
    brand: { id: `brand-${id}`, name: `Brand ${id}`, slug: `brand-${id}` },
    ...overrides,
  };
}

function baseRow(overrides: Partial<RawPointTransactionRow> = {}): RawPointTransactionRow {
  return {
    id: "tx-1",
    points: 10,
    reason: "BONUS",
    type: "EARN",
    sourceType: null,
    sourceId: null,
    shopifyRewardRedemptionId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    metadata: null,
    qrCode: null,
    ...overrides,
  };
}

const emptyContext = {
  lessonById: new Map<string, LessonSummary>(),
  courseById: new Map<string, CourseSummary>(),
  redemptionById: new Map<string, RedemptionRewardSummary>(),
  campaignByExperienceId: new Map<string, CampaignSummary | null>(),
  campaignById: new Map<string, CampaignSummary>(),
};

// ---------------------------------------------------------------------------
// parsePointTransactionMetadata
// ---------------------------------------------------------------------------

describe("parsePointTransactionMetadata", () => {
  test("returns null campaignId for null metadata", () => {
    assert.deepEqual(parsePointTransactionMetadata(null), { campaignId: null });
  });

  test("extracts a valid campaignId", () => {
    assert.deepEqual(parsePointTransactionMetadata({ campaignId: "camp-1" }), {
      campaignId: "camp-1",
    });
  });

  test("ignores malformed shapes without throwing", () => {
    assert.deepEqual(parsePointTransactionMetadata("just a string"), { campaignId: null });
    assert.deepEqual(parsePointTransactionMetadata(42), { campaignId: null });
    assert.deepEqual(parsePointTransactionMetadata(["array"]), { campaignId: null });
    assert.deepEqual(parsePointTransactionMetadata({ campaignId: 5 }), { campaignId: null });
    assert.deepEqual(parsePointTransactionMetadata({ campaignId: "" }), { campaignId: null });
    assert.deepEqual(parsePointTransactionMetadata({}), { campaignId: null });
  });
});

// ---------------------------------------------------------------------------
// resolveDeterministicCampaignByExperience — the core anti-fabrication rule
// ---------------------------------------------------------------------------

describe("resolveDeterministicCampaignByExperience", () => {
  test("an experience with exactly one campaign resolves to that campaign", () => {
    const result = resolveDeterministicCampaignByExperience([
      { experienceId: "exp-1", campaign: makeCampaign("c1") },
    ]);
    assert.equal(result.get("exp-1")?.id, "c1");
  });

  test("an experience attached to multiple campaigns is never resolved — no arbitrary first pick", () => {
    const result = resolveDeterministicCampaignByExperience([
      { experienceId: "exp-1", campaign: makeCampaign("c1") },
      { experienceId: "exp-1", campaign: makeCampaign("c2") },
    ]);
    assert.equal(result.get("exp-1"), null);
  });

  test("duplicate links to the same campaign still count as one (deterministic)", () => {
    const result = resolveDeterministicCampaignByExperience([
      { experienceId: "exp-1", campaign: makeCampaign("c1") },
      { experienceId: "exp-1", campaign: makeCampaign("c1") },
    ]);
    assert.equal(result.get("exp-1")?.id, "c1");
  });

  test("an experience with no links at all has no map entry", () => {
    const result = resolveDeterministicCampaignByExperience([]);
    assert.equal(result.has("exp-1"), false);
  });
});

// ---------------------------------------------------------------------------
// buildPointsActivityView
// ---------------------------------------------------------------------------

describe("buildPointsActivityView — lesson completion", () => {
  test("resolves lesson/course/experience context and a deterministic single campaign", () => {
    const lesson: LessonSummary = {
      id: "lesson-1",
      title: "Intro to SQRATCH",
      course: { id: "course-1", title: "Getting Started" },
      experience: { id: "exp-1", title: "Brand Onboarding" },
    };
    const campaign = makeCampaign("camp-1");

    const [item] = buildPointsActivityView(
      [baseRow({ sourceType: "LESSON_COMPLETION", sourceId: "lesson-1" })],
      {
        ...emptyContext,
        lessonById: new Map([["lesson-1", lesson]]),
        campaignByExperienceId: new Map([["exp-1", campaign]]),
      },
    );

    assert.deepEqual(item.lesson, lesson);
    assert.equal(item.campaign?.id, "camp-1");
    assert.equal(item.course, null);
    assert.equal(item.reward, null);
    assert.equal(item.qrCodeData, null);
  });

  test("omits campaign when the experience has no reliable (single) campaign", () => {
    const lesson: LessonSummary = {
      id: "lesson-1",
      title: "Intro to SQRATCH",
      course: { id: "course-1", title: "Getting Started" },
      experience: { id: "exp-1", title: "Brand Onboarding" },
    };

    const [item] = buildPointsActivityView(
      [baseRow({ sourceType: "LESSON_COMPLETION", sourceId: "lesson-1" })],
      {
        ...emptyContext,
        lessonById: new Map([["lesson-1", lesson]]),
        // exp-1 attached to two campaigns => ambiguous => no map entry with
        // a single campaign (simulates resolveDeterministicCampaignByExperience's null).
        campaignByExperienceId: new Map([["exp-1", null]]),
      },
    );

    assert.equal(item.lesson?.id, "lesson-1");
    assert.equal(item.campaign, null);
  });

  test("never infers a QR code for a lesson completion", () => {
    const lesson: LessonSummary = {
      id: "lesson-1",
      title: "Intro to SQRATCH",
      course: { id: "course-1", title: "Getting Started" },
      experience: { id: "exp-1", title: "Brand Onboarding" },
    };

    const [item] = buildPointsActivityView(
      [
        baseRow({
          sourceType: "LESSON_COMPLETION",
          sourceId: "lesson-1",
          // Even if a qrCode relation were somehow present on the raw row,
          // it must never leak into a lesson-completion activity item.
          qrCode: {
            id: "qr-1",
            qrCodeData: "SHOULD-NOT-APPEAR",
            campaign: makeCampaign("wrong-campaign"),
          },
        }),
      ],
      { ...emptyContext, lessonById: new Map([["lesson-1", lesson]]) },
    );

    assert.equal(item.qrCodeData, null);
    assert.notEqual(item.campaign?.id, "wrong-campaign");
  });

  test("historical row with no reliable context (lesson deleted / unresolved) omits the field entirely", () => {
    const [item] = buildPointsActivityView(
      [baseRow({ sourceType: "LESSON_COMPLETION", sourceId: "missing-lesson" })],
      emptyContext,
    );

    assert.equal(item.lesson, null);
    assert.equal(item.campaign, null);
  });
});

describe("buildPointsActivityView — course completion", () => {
  test("resolves course/experience context and campaign the same way as lessons", () => {
    const course: CourseSummary = {
      id: "course-1",
      title: "Getting Started",
      experience: { id: "exp-1", title: "Brand Onboarding" },
    };
    const campaign = makeCampaign("camp-1");

    const [item] = buildPointsActivityView(
      [baseRow({ sourceType: "COURSE_COMPLETION", sourceId: "course-1" })],
      {
        ...emptyContext,
        courseById: new Map([["course-1", course]]),
        campaignByExperienceId: new Map([["exp-1", campaign]]),
      },
    );

    assert.deepEqual(item.course, course);
    assert.equal(item.campaign?.id, "camp-1");
    assert.equal(item.lesson, null);
  });
});

describe("buildPointsActivityView — QR scan", () => {
  test("retains campaign and QR identifier", () => {
    const [item] = buildPointsActivityView(
      [
        baseRow({
          sourceType: "QR_SCAN",
          qrCode: {
            id: "qr-1",
            qrCodeData: "SAFE-QR-CODE",
            campaign: makeCampaign("camp-1"),
          },
        }),
      ],
      emptyContext,
    );

    assert.equal(item.qrCodeData, "SAFE-QR-CODE");
    assert.equal(item.campaign?.id, "camp-1");
  });
});

describe("buildPointsActivityView — reward redemption / refund", () => {
  const reward: RedemptionRewardSummary = {
    status: "ISSUED",
    discountType: "FIXED_AMOUNT",
    discountAmountCents: 1000,
    discountPercentageBasisPoints: null,
    currencyCode: "CAD",
    offer: { id: "offer-1", title: "$10 off" },
    brand: { id: "brand-1", name: "Acme", slug: "acme" },
  };

  test("resolves offer and brand context", () => {
    const [item] = buildPointsActivityView(
      [
        baseRow({
          sourceType: "SHOPIFY_REWARD_REDEMPTION",
          shopifyRewardRedemptionId: "redemption-1",
          points: -100,
          type: "SPEND",
        }),
      ],
      { ...emptyContext, redemptionById: new Map([["redemption-1", reward]]) },
    );

    assert.deepEqual(item.reward, reward);
  });

  test("records campaign context only when it was deterministically recorded on the transaction", () => {
    const [item] = buildPointsActivityView(
      [
        baseRow({
          sourceType: "SHOPIFY_REWARD_REDEMPTION",
          shopifyRewardRedemptionId: "redemption-1",
          metadata: { campaignId: "camp-1" },
        }),
      ],
      {
        ...emptyContext,
        redemptionById: new Map([["redemption-1", reward]]),
        campaignById: new Map([["camp-1", makeCampaign("camp-1")]]),
      },
    );

    assert.equal(item.campaign?.id, "camp-1");
  });

  test("historical redemption with no metadata resolves offer/brand but omits campaign", () => {
    const [item] = buildPointsActivityView(
      [
        baseRow({
          sourceType: null, // predates sourceType existing
          reason: "SHOPIFY_REWARD_REDEMPTION",
          shopifyRewardRedemptionId: "redemption-old",
          metadata: null,
        }),
      ],
      { ...emptyContext, redemptionById: new Map([["redemption-old", reward]]) },
    );

    assert.deepEqual(item.reward, reward);
    assert.equal(item.campaign, null);
  });

  test("refund transactions resolve the same reward context via the shared redemption id", () => {
    const [item] = buildPointsActivityView(
      [
        baseRow({
          sourceType: "SHOPIFY_REWARD_REFUND",
          shopifyRewardRedemptionId: "redemption-1",
          points: 100,
          type: "REFUND",
        }),
      ],
      { ...emptyContext, redemptionById: new Map([["redemption-1", reward]]) },
    );

    assert.deepEqual(item.reward, reward);
  });

  test("never exposes fields beyond the safe reward summary shape (no discount code, no Shopify node ids)", () => {
    const [item] = buildPointsActivityView(
      [
        baseRow({
          sourceType: "SHOPIFY_REWARD_REDEMPTION",
          shopifyRewardRedemptionId: "redemption-1",
        }),
      ],
      { ...emptyContext, redemptionById: new Map([["redemption-1", reward]]) },
    );

    const rewardKeys = Object.keys(item.reward ?? {});
    assert.deepEqual(
      rewardKeys.sort(),
      [
        "brand",
        "currencyCode",
        "discountAmountCents",
        "discountPercentageBasisPoints",
        "discountType",
        "offer",
        "status",
      ].sort(),
    );
    assert.ok(!rewardKeys.includes("code"));
    assert.ok(!rewardKeys.includes("shopifyDiscountNodeId"));
    assert.ok(!rewardKeys.includes("shopifyUserErrors"));
    assert.ok(!rewardKeys.includes("shopifyShopDomain"));
  });
});

describe("buildPointsActivityView — ledger fields are passed through unchanged", () => {
  test("points, type, reason, createdAt are preserved verbatim", () => {
    const createdAt = new Date("2026-02-02T12:00:00Z");
    const [item] = buildPointsActivityView(
      [baseRow({ id: "tx-42", points: -25, type: "SPEND", reason: "SHOPIFY_REWARD_REDEMPTION", createdAt })],
      emptyContext,
    );

    assert.equal(item.id, "tx-42");
    assert.equal(item.points, -25);
    assert.equal(item.type, "SPEND");
    assert.equal(item.reason, "SHOPIFY_REWARD_REDEMPTION");
    assert.equal(item.createdAt, createdAt);
  });
});
