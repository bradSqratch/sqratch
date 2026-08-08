process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";

/**
 * tests/campaign-context.test.ts
 *
 * Pure unit coverage for src/lib/campaign-context.ts — the single shared
 * resolver for "which campaign context is this request/visitor in?" used by
 * both the creator curation policy (campaign-product-curation.ts) and every
 * public route (experience-access.ts, public-experience.ts, progress route).
 *
 * No DB, no I/O: the module under test is pure, so these tests exercise it
 * directly with plain objects.
 */

import "./env-setup";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  buildEligibleCampaignContexts,
  isPublicCampaignScopedContentVisible,
  resolveCampaignSelection,
  resolvePublicExperienceEntryContext,
  resolveValidatedPublicCampaignContext,
  type CampaignContextCandidate,
  type CampaignContextSource,
} from "../src/lib/campaign-context";

function source(overrides: Partial<CampaignContextSource> = {}): CampaignContextSource {
  return {
    campaignId: "campaign-1",
    campaignName: "Campaign",
    sortOrder: 0,
    brandId: "brand-1",
    brandName: "Brand",
    curationEnabled: false,
    ...overrides,
  };
}

describe("buildEligibleCampaignContexts", () => {
  test("drops brandless campaigns entirely", () => {
    const result = buildEligibleCampaignContexts([
      source({ campaignId: "brandless", brandId: null }),
      source({ campaignId: "has-brand", brandId: "brand-1" }),
    ]);
    assert.deepEqual(result.map((c) => c.campaignId), ["has-brand"]);
  });

  test("orders by sortOrder ascending, then campaignId ascending as a tiebreak", () => {
    const result = buildEligibleCampaignContexts([
      source({ campaignId: "zzz", sortOrder: 5 }),
      source({ campaignId: "bbb", sortOrder: 1 }),
      // Tied sortOrder: campaignId must be the deciding tiebreak, not array
      // input order.
      source({ campaignId: "ccc", sortOrder: 1 }),
      source({ campaignId: "aaa", sortOrder: 1 }),
    ]);
    assert.deepEqual(result.map((c) => c.campaignId), ["aaa", "bbb", "ccc", "zzz"]);
  });

  test("a tied sortOrder never lets input array order silently decide", () => {
    // Same tie set, reversed input order: output must be identical.
    const forward = buildEligibleCampaignContexts([
      source({ campaignId: "a", sortOrder: 0 }),
      source({ campaignId: "b", sortOrder: 0 }),
    ]);
    const reversed = buildEligibleCampaignContexts([
      source({ campaignId: "b", sortOrder: 0 }),
      source({ campaignId: "a", sortOrder: 0 }),
    ]);
    assert.deepEqual(forward.map((c) => c.campaignId), ["a", "b"]);
    assert.deepEqual(reversed.map((c) => c.campaignId), ["a", "b"]);
  });

  test("mode reflects curationEnabled exactly, CURATED or LEGACY", () => {
    const result = buildEligibleCampaignContexts([
      source({ campaignId: "curated", curationEnabled: true }),
      source({ campaignId: "legacy", curationEnabled: false }),
    ]);
    const byId = new Map(result.map((c) => [c.campaignId, c.mode]));
    assert.equal(byId.get("curated"), "CURATED");
    assert.equal(byId.get("legacy"), "LEGACY");
  });

  test("empty input yields empty output", () => {
    assert.deepEqual(buildEligibleCampaignContexts([]), []);
  });
});

function candidate(overrides: Partial<CampaignContextCandidate> = {}): CampaignContextCandidate {
  return {
    campaignId: "campaign-1",
    campaignName: "Campaign",
    brandId: "brand-1",
    brandName: "Brand",
    curationEnabled: false,
    mode: "LEGACY",
    sortOrder: 0,
    ...overrides,
  };
}

describe("resolveCampaignSelection", () => {
  test("no eligible context at all -> none", () => {
    assert.deepEqual(resolveCampaignSelection([], null), { kind: "none" });
  });

  test("exactly one eligible context and no explicit request -> resolved (item 1)", () => {
    const one = candidate({ campaignId: "only" });
    const result = resolveCampaignSelection([one], null);
    assert.deepEqual(result, { kind: "resolved", context: one });
  });

  test("two or more eligible contexts and no explicit request -> selection_required (item 2)", () => {
    const a = candidate({ campaignId: "a" });
    const b = candidate({ campaignId: "b" });
    const result = resolveCampaignSelection([a, b], null);
    assert.equal(result.kind, "selection_required");
    if (result.kind === "selection_required") {
      assert.deepEqual(result.contexts, [a, b]);
    }
  });

  test("an explicitly requested id that is in the eligible set always wins, even with only one context", () => {
    const only = candidate({ campaignId: "only" });
    const result = resolveCampaignSelection([only], "only");
    assert.deepEqual(result, { kind: "resolved", context: only });
  });

  test("an explicitly requested id outside the eligible set is invalid_campaign, never a fallback (item 8)", () => {
    const a = candidate({ campaignId: "a" });
    const result = resolveCampaignSelection([a], "unrelated-or-forged");
    assert.deepEqual(result, { kind: "invalid_campaign" });
  });

  test("a requested id is validated even on a single-context Experience (previous bug: legacy path never looked at it)", () => {
    const only = candidate({ campaignId: "only", mode: "LEGACY" });
    const result = resolveCampaignSelection([only], "forged");
    assert.deepEqual(result, { kind: "invalid_campaign" });
  });

  test("blank/whitespace-only requested id is treated as no request", () => {
    const only = candidate({ campaignId: "only" });
    assert.deepEqual(resolveCampaignSelection([only], "   "), {
      kind: "resolved",
      context: only,
    });
  });

  test("there is no code path that returns contexts[0] for 2+ contexts and no request", () => {
    const a = candidate({ campaignId: "a" });
    const b = candidate({ campaignId: "b" });
    const c = candidate({ campaignId: "c" });
    const result = resolveCampaignSelection([a, b, c], undefined);
    assert.notEqual(result.kind, "resolved");
    assert.equal(result.kind, "selection_required");
  });
});

describe("resolveValidatedPublicCampaignContext", () => {
  test("a stored campaign id that is eligible for this Experience is trusted", () => {
    const result = resolveValidatedPublicCampaignContext({
      storedCampaignId: "campaign-b",
      eligibleCampaignIds: ["campaign-a", "campaign-b"],
    });
    assert.equal(result, "campaign-b");
  });

  test("a stored campaign id for an UNRELATED experience is never trusted (item 8, public side)", () => {
    const result = resolveValidatedPublicCampaignContext({
      storedCampaignId: "campaign-from-other-experience",
      eligibleCampaignIds: ["campaign-a", "campaign-b"],
    });
    assert.equal(result, null);
  });

  test("no stored id, exactly one eligible campaign stays direct/unscoped", () => {
    const result = resolveValidatedPublicCampaignContext({
      storedCampaignId: null,
      eligibleCampaignIds: ["only"],
    });
    assert.equal(result, null);
  });

  test("no stored id, 2+ eligible campaigns -> null, never the first (item 20)", () => {
    const result = resolveValidatedPublicCampaignContext({
      storedCampaignId: null,
      eligibleCampaignIds: ["a", "b"],
    });
    assert.equal(result, null);
  });

  test("stored id present but not eligible, and 2+ eligible campaigns -> null, not a fallback to [0]", () => {
    const result = resolveValidatedPublicCampaignContext({
      storedCampaignId: "unrelated",
      eligibleCampaignIds: ["a", "b"],
    });
    assert.equal(result, null);
  });

  test("no eligible campaigns at all -> null regardless of stored id", () => {
    const result = resolveValidatedPublicCampaignContext({
      storedCampaignId: "anything",
      eligibleCampaignIds: [],
    });
    assert.equal(result, null);
  });

  test("exposes direct entry explicitly rather than conflating it with campaign ambiguity", () => {
    assert.deepEqual(
      resolvePublicExperienceEntryContext({
        storedCampaignId: null,
        eligibleCampaignIds: ["campaign-a", "campaign-b"],
      }),
      { kind: "DIRECT" },
    );
  });

  test("a valid stored campaign creates a trusted campaign-scoped entry", () => {
    assert.deepEqual(
      resolvePublicExperienceEntryContext({
        storedCampaignId: "campaign-b",
        eligibleCampaignIds: ["campaign-a", "campaign-b"],
      }),
      { kind: "CAMPAIGN", campaignId: "campaign-b" },
    );
  });
});

describe("isPublicCampaignScopedContentVisible", () => {
  const eligibleCampaignIds = ["campaign-a", "campaign-b"];

  test("Campaign A and B entries each see global content plus only their own active scope", () => {
    const global = { scope: null, eligibleCampaignIds } as const;
    const campaignA = {
      entryContext: { kind: "CAMPAIGN" as const, campaignId: "campaign-a" },
      resolvedCampaignId: "campaign-a",
    };
    const campaignB = {
      entryContext: { kind: "CAMPAIGN" as const, campaignId: "campaign-b" },
      resolvedCampaignId: "campaign-b",
    };

    assert.equal(isPublicCampaignScopedContentVisible({ ...global, ...campaignA }), true);
    assert.equal(isPublicCampaignScopedContentVisible({
      scope: { campaignId: "campaign-a", isActive: true },
      eligibleCampaignIds,
      ...campaignA,
    }), true);
    assert.equal(isPublicCampaignScopedContentVisible({
      scope: { campaignId: "campaign-b", isActive: true },
      eligibleCampaignIds,
      ...campaignA,
    }), false);
    assert.equal(isPublicCampaignScopedContentVisible({
      scope: { campaignId: "campaign-a", isActive: true },
      eligibleCampaignIds,
      ...campaignB,
    }), false);
    assert.equal(isPublicCampaignScopedContentVisible({
      scope: { campaignId: "campaign-b", isActive: true },
      eligibleCampaignIds,
      ...campaignB,
    }), true);
  });

  test("direct entry unions every active linked scope without fabricating a campaign", () => {
    const direct = {
      entryContext: { kind: "DIRECT" as const },
      resolvedCampaignId: null,
      eligibleCampaignIds,
    };

    assert.equal(isPublicCampaignScopedContentVisible({ scope: null, ...direct }), true);
    assert.equal(isPublicCampaignScopedContentVisible({
      scope: { campaignId: "campaign-a", isActive: true },
      ...direct,
    }), true);
    assert.equal(isPublicCampaignScopedContentVisible({
      scope: { campaignId: "campaign-b", isActive: true },
      ...direct,
    }), true);
  });

  test("inactive and no-longer-linked scopes fail closed for both entry modes", () => {
    for (const entryContext of [
      { kind: "DIRECT" as const },
      { kind: "CAMPAIGN" as const, campaignId: "campaign-a" },
    ]) {
      assert.equal(isPublicCampaignScopedContentVisible({
        scope: { campaignId: "campaign-a", isActive: false },
        entryContext,
        resolvedCampaignId: entryContext.kind === "CAMPAIGN" ? "campaign-a" : null,
        eligibleCampaignIds,
      }), false);
      assert.equal(isPublicCampaignScopedContentVisible({
        scope: { campaignId: "foreign-campaign", isActive: true },
        entryContext,
        resolvedCampaignId: entryContext.kind === "CAMPAIGN" ? "campaign-a" : null,
        eligibleCampaignIds,
      }), false);
    }
  });
});

// ---------------------------------------------------------------------------
// Source-inspection regression guard (item 3): the removed silent
// first-brand/first-campaign fallback must never reappear in the shared
// resolver or the curation policy layer built on top of it. Same technique as
// tests/shopify-scope-drift.test.ts / tests/campaign-commerce-product-schema.test.ts
// — grep the actual source rather than only testing behavior, so a future
// edit that reintroduces `[0]` indexing fails a test even if it happens to
// pass some other assertion.
// ---------------------------------------------------------------------------

const root = process.cwd();
const campaignContextSource = readFileSync(join(root, "src/lib/campaign-context.ts"), "utf8");
const campaignCurationSource = readFileSync(
  join(root, "src/lib/commerce/campaign-product-curation.ts"),
  "utf8",
);
const lessonProductLinksSource = readFileSync(
  join(root, "src/lib/lesson-product-links.ts"),
  "utf8",
);

describe("no silent first-of-several fallback (source inspection)", () => {
  test("campaign-context.ts never indexes [0] as a silent multi-context choice", () => {
    // Creator selection still permits exactly-one-context resolution. Public
    // Experience entry intentionally has no topology-based auto-resolution:
    // an unmarked `/x/:slug` entry is direct/unscoped even with one campaign.
    assert.match(
      campaignContextSource,
      /contexts\.length === 1\s*\)\s*\{\s*return \{ kind: "resolved", context: contexts\[0\] \}/,
    );
    const codeOnly = campaignContextSource
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    assert.equal(/eligibleCampaignIds\[0\]/.test(codeOnly), false);
  });

  test("campaign-context.ts documents there is no first-of-several code path", () => {
    assert.match(
      campaignContextSource,
      /no code path that returns `contexts\[0\]` when more than\s*\* one context exists/,
    );
  });

  test("campaign-product-curation.ts contains no literal 'first connected brand' fallback", () => {
    assert.equal(/first[- ]connected brand/i.test(campaignCurationSource), false);
    assert.equal(/primaryBrand/.test(campaignCurationSource), false);
  });

  test("lesson-product-links.ts no longer exposes a primaryBrand field", () => {
    assert.equal(/primaryBrand\s*[:?]/.test(lessonProductLinksSource), false);
    assert.match(lessonProductLinksSource, /campaignContexts: CampaignContextCandidate\[\]/);
  });
});
