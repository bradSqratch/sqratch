process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.NEXTAUTH_SECRET = "test-experience-campaign-context-navigation";

import "./env-setup";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPERIENCE_TAB_KEYS,
  experienceTabHref,
} from "../src/components/experience/experience-tabs";
import {
  resolveExperienceDisplayCampaign,
  resolvePublicExperienceEntryContext,
} from "../src/lib/campaign-context";
import {
  createCampaignExperienceEntryToken,
  isSameExperienceNavigation,
  resolveExperienceHubEntry,
} from "../src/lib/public-experience-entry";

const HOST = "sqratch.test";
const SLUG = "wine-cinema";
const origin = `https://${HOST}`;

type Campaign = {
  id: string;
  name: string;
  brand: { name: string } | null;
};

const benje: Campaign = {
  id: "campaign-benje",
  name: "BENJE BLANCO",
  brand: { name: "Envinate" },
};
const other: Campaign = {
  id: "campaign-other",
  name: "OTHER CAMPAIGN",
  brand: { name: "Other Brand" },
};

/**
 * A faithful in-memory model of what `/x/:slug` does per request: decide with
 * the real `resolveExperienceHubEntry`, clear the session campaign exactly when
 * the page would, then resolve the entry context with the real resolver.
 */
class Visitor {
  sessionCampaignId: string | null = null;

  /** `/api/public/campaign/:slug/experience/:slug` stamps the session. */
  handoff(campaign: Campaign, now: number) {
    this.sessionCampaignId = campaign.id;
    return createCampaignExperienceEntryToken({
      campaignId: campaign.id,
      experienceSlug: SLUG,
      now,
    });
  }

  openHub(options: {
    campaigns: Campaign[];
    token?: string | null;
    referer?: string | null;
    secFetchSite?: string | null;
    now?: number;
  }) {
    const entry = resolveExperienceHubEntry({
      token: options.token ?? null,
      experienceSlug: SLUG,
      sessionCampaignId: this.sessionCampaignId,
      referer: options.referer ?? null,
      host: HOST,
      secFetchSite: options.secFetchSite ?? null,
      now: options.now,
    });

    if (!entry.keepSessionCampaign) {
      this.sessionCampaignId = null;
    }

    return resolvePublicExperienceEntryContext({
      storedCampaignId: this.sessionCampaignId,
      eligibleCampaignIds: options.campaigns.map((campaign) => campaign.id),
    });
  }
}

describe("campaign context survives Experience navigation", () => {
  test("campaign -> Experience -> Shop -> WHY keeps the campaign, even after the handoff token expires", () => {
    const visitor = new Visitor();
    const campaigns = [benje, other];
    const t0 = 1_000_000;
    const token = visitor.handoff(benje, t0);

    // Handoff landing, signed token still fresh.
    assert.deepEqual(
      visitor.openHub({ campaigns, token, now: t0 + 1_000 }),
      { kind: "CAMPAIGN", campaignId: benje.id },
    );

    // Shop is not the hub; it never clears. Ten minutes later (token long
    // expired) the visitor presses WHY: plain URL, Referer = the Shop page.
    assert.deepEqual(
      visitor.openHub({
        campaigns,
        referer: `${origin}${experienceTabHref("shop", SLUG)}`,
        secFetchSite: "same-origin",
        now: t0 + 10 * 60 * 1000,
      }),
      { kind: "CAMPAIGN", campaignId: benje.id },
    );
    assert.equal(visitor.sessionCampaignId, benje.id);
  });

  test("an expired token alone does not keep context on a manual open", () => {
    const visitor = new Visitor();
    const token = visitor.handoff(benje, 1_000);

    assert.deepEqual(
      visitor.openHub({
        campaigns: [benje, other],
        token,
        now: 1_000 + 3 * 60 * 1000,
      }),
      { kind: "DIRECT" },
    );
    assert.equal(visitor.sessionCampaignId, null);
  });

  test("manually opening /x/:slug later is DIRECT and clears the stale campaign", () => {
    const visitor = new Visitor();
    visitor.handoff(benje, 1_000);

    assert.deepEqual(visitor.openHub({ campaigns: [benje, other] }), {
      kind: "DIRECT",
    });
    assert.equal(visitor.sessionCampaignId, null);
  });

  test("every Experience tab can navigate to every other tab, keeping the campaign", () => {
    // The hub is the only destination that makes a context decision (the other
    // destinations are asserted not to clear it in the wiring tests below), so
    // WHY is checked from every origin tab, including itself.
    for (const from of EXPERIENCE_TAB_KEYS) {
      const visitor = new Visitor();
      visitor.handoff(benje, 1_000);

      assert.deepEqual(
        visitor.openHub({
          campaigns: [benje, other],
          referer: `${origin}${experienceTabHref(from, SLUG)}`,
          secFetchSite: "same-origin",
        }),
        { kind: "CAMPAIGN", campaignId: benje.id },
        `${from} -> hub`,
      );
    }

    assert.deepEqual(
      EXPERIENCE_TAB_KEYS.map((tab) => experienceTabHref(tab, SLUG)),
      [
        `/x/${SLUG}`,
        `/x/${SLUG}/learn`,
        `/x/${SLUG}/posts`,
        `/x/${SLUG}/qa`,
        `/x/${SLUG}/shop`,
      ],
    );
  });

  test("course and lesson pages also count as the same Experience", () => {
    for (const path of [
      `/x/${SLUG}/courses/c1`,
      `/x/${SLUG}/lessons/l1?x=1`,
      `/x/${SLUG}?campaignEntry=expired`,
    ]) {
      assert.equal(
        isSameExperienceNavigation({
          referer: `${origin}${path}`,
          host: HOST,
          experienceSlug: SLUG,
        }),
        true,
        path,
      );
    }
  });
});

describe("campaign context is not granted by untrusted signals", () => {
  const sameOriginShopReferer = `${origin}/x/${SLUG}/shop`;

  test("forged, wrong-experience and tampered tokens never keep context", () => {
    const real = createCampaignExperienceEntryToken({
      campaignId: other.id,
      experienceSlug: SLUG,
      now: 1_000,
    });
    const [version, payload] = real.split(".");
    const forged = `${version}.${payload}.${"A".repeat(43)}`;
    const wrongExperience = createCampaignExperienceEntryToken({
      campaignId: benje.id,
      experienceSlug: "another-experience",
      now: 1_000,
    });

    for (const token of [
      forged,
      wrongExperience,
      `${real}x`,
      "garbage",
      "",
      null,
    ]) {
      const visitor = new Visitor();
      visitor.sessionCampaignId = benje.id;

      assert.deepEqual(
        visitor.openHub({ campaigns: [benje, other], token, now: 1_500 }),
        { kind: "DIRECT" },
        String(token),
      );
    }
  });

  test("a valid token for a different campaign than the session does not keep it", () => {
    const visitor = new Visitor();
    visitor.sessionCampaignId = benje.id;
    const token = createCampaignExperienceEntryToken({
      campaignId: other.id,
      experienceSlug: SLUG,
      now: 1_000,
    });

    assert.deepEqual(
      visitor.openHub({ campaigns: [benje, other], token, now: 1_500 }),
      { kind: "DIRECT" },
    );
  });

  test("external, other-origin, other-experience and lookalike referers are DIRECT", () => {
    const cases: Array<[string, string | null, string | null]> = [
      ["no referer", null, null],
      ["external site", `https://google.com/x/${SLUG}/shop`, null],
      ["lookalike host", `https://${HOST}.evil.example/x/${SLUG}/shop`, null],
      ["other experience", `${origin}/x/another-experience/shop`, null],
      ["slug prefix lookalike", `${origin}/x/${SLUG}-evil/shop`, null],
      ["app home", `${origin}/`, null],
      ["campaign landing", `${origin}/c/benje-blanco`, null],
      ["not a path under /x", `${origin}/y/${SLUG}`, null],
      ["cross-site fetch metadata", sameOriginShopReferer, "cross-site"],
      ["none fetch metadata", sameOriginShopReferer, "none"],
      ["malformed referer", "not a url", null],
      ["non-http referer", `javascript:alert(1)//${HOST}/x/${SLUG}`, null],
    ];

    for (const [label, referer, secFetchSite] of cases) {
      const visitor = new Visitor();
      visitor.sessionCampaignId = benje.id;

      assert.deepEqual(
        visitor.openHub({
          campaigns: [benje, other],
          referer,
          secFetchSite,
        }),
        { kind: "DIRECT" },
        label,
      );
      assert.equal(visitor.sessionCampaignId, null, label);
    }
  });

  test("no cross-brand/campaign leakage: a session campaign unrelated to this Experience never becomes context", () => {
    const visitor = new Visitor();
    visitor.sessionCampaignId = "campaign-from-another-brand";

    // Even a trusted same-Experience navigation only retains the session value;
    // eligibility against this Experience's campaigns still rejects it.
    assert.deepEqual(
      visitor.openHub({
        campaigns: [benje, other],
        referer: sameOriginShopReferer,
        secFetchSite: "same-origin",
      }),
      { kind: "DIRECT" },
    );
  });

  test("a campaign context for one Experience's token cannot be replayed on another", () => {
    const token = createCampaignExperienceEntryToken({
      campaignId: benje.id,
      experienceSlug: SLUG,
      now: 1_000,
    });

    assert.deepEqual(
      resolveExperienceHubEntry({
        token,
        experienceSlug: "another-experience",
        sessionCampaignId: benje.id,
        referer: null,
        host: HOST,
        now: 1_500,
      }),
      { keepSessionCampaign: false, reason: "direct" },
    );
  });
});

describe("Experience hero campaign display", () => {
  test("a resolved campaign is the one shown, whatever the others", () => {
    assert.equal(
      resolveExperienceDisplayCampaign({
        resolvedCampaignId: other.id,
        campaigns: [benje, other],
      }),
      other,
    );
    assert.equal(
      resolveExperienceDisplayCampaign({
        resolvedCampaignId: benje.id,
        campaigns: [benje],
      }),
      benje,
    );
  });

  test("direct entry with one campaign shows its sole sponsor without changing attribution", () => {
    const visitor = new Visitor();
    visitor.handoff(benje, 1_000);

    // Manual direct open of a single-campaign Experience.
    const entry = visitor.openHub({ campaigns: [benje] });
    assert.deepEqual(entry, { kind: "DIRECT" });
    assert.equal(visitor.sessionCampaignId, null);

    const resolvedCampaignId =
      entry.kind === "CAMPAIGN" ? entry.campaignId : null;
    assert.equal(resolvedCampaignId, null);
    assert.equal(
      resolveExperienceDisplayCampaign({
        resolvedCampaignId,
        campaigns: [benje],
      }),
      benje,
    );
  });

  test("direct entry with multiple campaigns shows no sponsor", () => {
    assert.equal(
      resolveExperienceDisplayCampaign({
        resolvedCampaignId: null,
        campaigns: [benje, other],
      }),
      null,
    );
    assert.equal(
      resolveExperienceDisplayCampaign({
        resolvedCampaignId: undefined,
        campaigns: [],
      }),
      null,
    );
  });

  test("a resolved id that is not among the campaigns fails closed instead of guessing", () => {
    assert.equal(
      resolveExperienceDisplayCampaign({
        resolvedCampaignId: "campaign-from-another-brand",
        campaigns: [benje],
      }),
      null,
    );
  });
});

describe("wiring", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  test("only the hub page resets campaign context; sibling Experience routes do not", () => {
    assert.match(
      read("src/app/x/[experienceSlug]/page.tsx"),
      /clearViewerSessionCampaignContext/,
    );

    for (const route of [
      "learn",
      "posts",
      "qa",
      "shop",
      "courses/[courseSlug]",
      "lessons/[lessonId]",
    ]) {
      assert.equal(
        /clearViewerSessionCampaignContext/.test(
          read(`src/app/x/[experienceSlug]/${route}/page.tsx`),
        ),
        false,
        route,
      );
    }
  });

  test("bottom tabs use token-free hrefs and the hero renders nothing without a display campaign", () => {
    assert.match(
      read("src/components/experience/experience-shell.tsx"),
      /experienceTabHref\(tabKey, experienceSlug\)/,
    );
    assert.equal(
      /campaignEntry/.test(read("src/components/experience/experience-tabs.ts")),
      false,
    );

    const hub = read("src/components/experience/hub-client.tsx");
    assert.match(hub, /resolveExperienceDisplayCampaign\(/);
    assert.equal(/"Campaign"|"Brand"/.test(hub), false);
    assert.match(hub, /\{displayCampaign \? \(/);
  });
});
