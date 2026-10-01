process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.NEXTAUTH_SECRET = "test-public-experience-entry-secret";

import "./env-setup";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createCampaignExperienceEntryToken,
  verifyCampaignExperienceEntryToken,
} from "../src/lib/public-experience-entry";

describe("campaign Experience handoff token", () => {
  test("preserves only the signed campaign for the intended Experience", () => {
    const token = createCampaignExperienceEntryToken({
      campaignId: "campaign-a",
      experienceSlug: "experience-a",
      now: 1_000,
    });

    assert.equal(
      verifyCampaignExperienceEntryToken({
        token,
        experienceSlug: "experience-a",
        now: 1_001,
      }),
      "campaign-a",
    );
    assert.equal(
      verifyCampaignExperienceEntryToken({
        token,
        experienceSlug: "experience-b",
        now: 1_001,
      }),
      null,
    );
  });

  test("rejects tampering and expiry", () => {
    const token = createCampaignExperienceEntryToken({
      campaignId: "campaign-a",
      experienceSlug: "experience-a",
      now: 1_000,
    });

    assert.equal(
      verifyCampaignExperienceEntryToken({
        token: `${token}tampered`,
        experienceSlug: "experience-a",
        now: 1_001,
      }),
      null,
    );
    assert.equal(
      verifyCampaignExperienceEntryToken({
        token,
        experienceSlug: "experience-a",
        now: 121_001,
      }),
      null,
    );
  });
});

describe("direct Experience entry wiring", () => {
  const root = process.cwd();
  const pageSource = readFileSync(
    join(root, "src/app/x/[experienceSlug]/page.tsx"),
    "utf8",
  );
  const handoffSource = readFileSync(
    join(
      root,
      "src/app/api/public/campaign/[campaignSlug]/experience/[experienceSlug]/route.ts",
    ),
    "utf8",
  );

  test("hub entry runs the shared guard, which clears stale acquisition context before loading", () => {
    const guardSource = readFileSync(
      join(root, "src/lib/experience-entry-guard.ts"),
      "utf8",
    );

    assert.match(pageSource, /await enforceExperienceEntryContext\(\{/);
    assert.match(pageSource, /await enforceExperienceEntryContext\([\s\S]*?loadPublicExperience\(/);
    assert.match(guardSource, /resolveExperienceEntry\(\{/);
    assert.match(guardSource, /if \(!entry\.keepSessionCampaign\) \{\s*await clearViewerSessionCampaignContext\(\);/);
    assert.match(guardSource, /sessionCampaignId: viewerSession\?\.campaignId \?\? null/);
  });

  test("campaign handoff validates the CampaignExperience relation and signs server-derived ids", () => {
    assert.match(handoffSource, /experiences:\s*\{\s*some:/);
    assert.match(handoffSource, /createCampaignExperienceEntryToken\(\{\s*campaignId: campaign\.id,/);
    assert.equal(/request\.nextUrl\.searchParams\.get\([^)]*campaign/i.test(handoffSource), false);
  });
});
