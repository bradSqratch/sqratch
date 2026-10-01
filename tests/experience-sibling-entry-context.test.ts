process.env.DATABASE_URL = "postgresql://blocked:blocked@127.0.0.1:1/sqratch_blocked";
process.env.NEXTAUTH_SECRET = "test-experience-sibling-entry-context";

import "./env-setup";

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EXPERIENCE_TAB_KEYS,
  experienceTabHref,
} from "../src/components/experience/experience-tabs";
import { resolvePublicExperienceEntryContext } from "../src/lib/campaign-context";
import {
  appendCampaignEntryToken,
  CAMPAIGN_ENTRY_QUERY_PARAM,
} from "../src/lib/experience-entry-url";
import {
  createCampaignExperienceEntryToken,
  mintCampaignReturnToken,
  resolveExperienceEntry,
} from "../src/lib/public-experience-entry";
import { normalizeInternalRedirectPath } from "../src/lib/safe-redirect";

const HOST = "sqratch.test";
const origin = `https://${HOST}`;
const SLUG = "wine-cinema";
const MINUTE = 60 * 1000;

const CAMPAIGN_A = "campaign-a";
const CAMPAIGN_B = "campaign-b";
const ELIGIBLE = [CAMPAIGN_A, CAMPAIGN_B];

/** Every public Experience route a visitor can land on. */
const ROUTES = [
  `/x/${SLUG}`,
  `/x/${SLUG}/learn`,
  `/x/${SLUG}/posts`,
  `/x/${SLUG}/qa`,
  `/x/${SLUG}/shop`,
  `/x/${SLUG}/courses/course-1`,
  `/x/${SLUG}/lessons/lesson-1`,
];

/**
 * Models `enforceExperienceEntryContext` + the entry context the API resolves
 * afterwards, using the real decision and resolver functions.
 */
class Visitor {
  constructor(public sessionCampaignId: string | null = null) {}

  open(options: {
    route: string;
    token?: string | null;
    referer?: string | null;
    secFetchSite?: string | null;
    now?: number;
    experienceSlug?: string;
  }) {
    const entry = resolveExperienceEntry({
      token: options.token ?? null,
      experienceSlug: options.experienceSlug ?? SLUG,
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
      eligibleCampaignIds: ELIGIBLE,
    });
  }
}

function pathOf(url: string) {
  return new URL(url, origin).pathname;
}

describe("direct entry to every Experience route is DIRECT", () => {
  const untrustedReferers: Array<[string, string | null, string | null]> = [
    ["typed URL / bookmark (no referer)", null, null],
    ["external site", `https://google.com/search?q=${SLUG}`, null],
    ["another Experience", `${origin}/x/another-experience/shop`, null],
    ["app home", `${origin}/`, null],
    ["campaign landing page", `${origin}/c/benje-blanco`, null],
    ["cross-site fetch metadata", `${origin}/x/${SLUG}/shop`, "cross-site"],
    ["lookalike slug", `${origin}/x/${SLUG}-evil/shop`, null],
  ];

  for (const route of ROUTES) {
    test(`${route} ignores a stale session campaign`, () => {
      for (const [label, referer, secFetchSite] of untrustedReferers) {
        const visitor = new Visitor(CAMPAIGN_A);

        assert.deepEqual(
          visitor.open({ route, referer, secFetchSite }),
          { kind: "DIRECT" },
          label,
        );
        assert.equal(visitor.sessionCampaignId, null, label);
      }
    });
  }

  test("forged, expired and mismatched tokens do not rescue a direct entry", () => {
    const stale = createCampaignExperienceEntryToken({
      campaignId: CAMPAIGN_A,
      experienceSlug: SLUG,
      now: 0,
    });
    const forTheOtherCampaign = createCampaignExperienceEntryToken({
      campaignId: CAMPAIGN_B,
      experienceSlug: SLUG,
      now: 0,
    });
    const forTheOtherExperience = createCampaignExperienceEntryToken({
      campaignId: CAMPAIGN_A,
      experienceSlug: "another-experience",
      now: 0,
    });

    for (const route of ROUTES) {
      for (const token of [
        `${stale.slice(0, -2)}xx`,
        stale,
        forTheOtherCampaign,
        forTheOtherExperience,
        "garbage",
      ]) {
        const visitor = new Visitor(CAMPAIGN_A);

        assert.deepEqual(
          visitor.open({ route, token, now: 5 * MINUTE }),
          { kind: "DIRECT" },
          `${route} ${token.slice(0, 12)}`,
        );
      }
    }
  });
});

describe("navigation within the same Experience keeps campaign context", () => {
  test("every route is reachable from every tab and from course/lesson pages", () => {
    const origins = [
      ...EXPERIENCE_TAB_KEYS.map((tab) => experienceTabHref(tab, SLUG)),
      `/x/${SLUG}/courses/course-1`,
      `/x/${SLUG}/lessons/lesson-1?x=1`,
      `/x/${SLUG}?campaignEntry=expired`,
    ];

    for (const route of ROUTES) {
      for (const from of origins) {
        const visitor = new Visitor(CAMPAIGN_A);

        assert.deepEqual(
          visitor.open({
            route,
            referer: `${origin}${from}`,
            secFetchSite: "same-origin",
          }),
          { kind: "CAMPAIGN", campaignId: CAMPAIGN_A },
          `${from} -> ${route}`,
        );
      }
    }
  });

  test("campaign -> Experience -> Shop -> Learn -> Posts -> Q&A -> WHY never loses the campaign", () => {
    const visitor = new Visitor(CAMPAIGN_A);
    const handoff = createCampaignExperienceEntryToken({
      campaignId: CAMPAIGN_A,
      experienceSlug: SLUG,
      now: 0,
    });
    const steps = [
      { route: ROUTES[0], token: handoff, referer: null, now: 1_000 },
      { route: ROUTES[4], referer: `${origin}${ROUTES[0]}?campaignEntry=x` },
      { route: ROUTES[1], referer: `${origin}${ROUTES[4]}` },
      { route: ROUTES[2], referer: `${origin}${ROUTES[1]}` },
      { route: ROUTES[3], referer: `${origin}${ROUTES[2]}` },
      { route: ROUTES[0], referer: `${origin}${ROUTES[3]}` },
    ];

    for (const step of steps) {
      assert.deepEqual(
        visitor.open({ ...step, secFetchSite: step.token ? null : "same-origin" }),
        { kind: "CAMPAIGN", campaignId: CAMPAIGN_A },
        step.route,
      );
    }
  });

  test("a session campaign unrelated to this Experience never becomes context", () => {
    for (const route of ROUTES) {
      const visitor = new Visitor("campaign-of-another-brand");

      assert.deepEqual(
        visitor.open({
          route,
          referer: `${origin}${ROUTES[4]}`,
          secFetchSite: "same-origin",
        }),
        { kind: "DIRECT" },
        route,
      );
    }
  });
});

describe("login/signup/verify return flows preserve legitimate campaign context", () => {
  function leaveForAuth(visitor: Visitor, returnTo: string, now: number) {
    // The Experience page's server data is built from the validated entry
    // context; the GatePanel appends whatever token that produced.
    const entryContext = resolvePublicExperienceEntryContext({
      storedCampaignId: visitor.sessionCampaignId,
      eligibleCampaignIds: ELIGIBLE,
    });
    const token = mintCampaignReturnToken({
      entryContext,
      experienceSlug: SLUG,
      now,
    });

    return { token, next: appendCampaignEntryToken(returnTo, token) };
  }

  test("login from a gated page returns to it in the same campaign, via login and signup + verify-email", () => {
    for (const returnTo of ROUTES.slice(1)) {
      const visitor = new Visitor(CAMPAIGN_A);
      const { token, next } = leaveForAuth(visitor, returnTo, 0);

      assert.ok(token);

      // login/signup/verify-email all pass `next` through the same normaliser.
      const afterAuth = normalizeInternalRedirectPath(
        normalizeInternalRedirectPath(normalizeInternalRedirectPath(next)),
      );
      assert.equal(pathOf(afterAuth), returnTo);

      const landing = new URL(afterAuth, origin);

      assert.deepEqual(
        visitor.open({
          route: returnTo,
          token: landing.searchParams.get(CAMPAIGN_ENTRY_QUERY_PARAM),
          // Navigation comes from the auth page, not the Experience.
          referer: `${origin}/login?next=${encodeURIComponent(next)}`,
          secFetchSite: "same-origin",
          now: 55 * MINUTE,
        }),
        { kind: "CAMPAIGN", campaignId: CAMPAIGN_A },
        returnTo,
      );
    }
  });

  test("a return that takes longer than the token lifetime falls back to DIRECT", () => {
    const visitor = new Visitor(CAMPAIGN_A);
    const { token } = leaveForAuth(visitor, ROUTES[2], 0);

    assert.deepEqual(
      visitor.open({
        route: ROUTES[2],
        token,
        referer: `${origin}/login`,
        now: 61 * MINUTE,
      }),
      { kind: "DIRECT" },
    );
  });

  test("a direct visitor gets no token, so their login return stays DIRECT", () => {
    const visitor = new Visitor(null);
    const { token, next } = leaveForAuth(visitor, ROUTES[2], 0);

    assert.equal(token, null);
    assert.equal(next, ROUTES[2]);
    assert.deepEqual(
      visitor.open({
        route: ROUTES[2],
        referer: `${origin}/login`,
      }),
      { kind: "DIRECT" },
    );
  });

  test("a visitor whose session campaign is not linked to this Experience gets no token", () => {
    const visitor = new Visitor("campaign-of-another-brand");

    assert.equal(leaveForAuth(visitor, ROUTES[2], 0).token, null);
  });

  test("a return token is bound to its campaign, Experience and the visitor's own session", () => {
    const owner = new Visitor(CAMPAIGN_A);
    const { token } = leaveForAuth(owner, ROUTES[2], 0);

    // Shared link: a different visitor whose session campaign differs.
    assert.deepEqual(
      new Visitor(CAMPAIGN_B).open({ route: ROUTES[2], token, now: MINUTE }),
      { kind: "DIRECT" },
    );
    // Replayed on another Experience.
    assert.deepEqual(
      new Visitor(CAMPAIGN_A).open({
        route: ROUTES[2],
        token,
        now: MINUTE,
        experienceSlug: "another-experience",
      }),
      { kind: "DIRECT" },
    );
    // Tampered.
    assert.deepEqual(
      new Visitor(CAMPAIGN_A).open({
        route: ROUTES[2],
        token: `${token}x`,
        now: MINUTE,
      }),
      { kind: "DIRECT" },
    );
  });

  test("appendCampaignEntryToken preserves the path and query, replaces an old token and ignores a missing one", () => {
    assert.equal(appendCampaignEntryToken("/x/a/qa", null), "/x/a/qa");
    assert.equal(appendCampaignEntryToken("/x/a/qa", ""), "/x/a/qa");
    assert.equal(
      appendCampaignEntryToken("/x/a/lessons/l1?t=1#top", "tok"),
      "/x/a/lessons/l1?t=1&campaignEntry=tok#top",
    );
    assert.equal(
      appendCampaignEntryToken("/x/a?campaignEntry=old", "new"),
      "/x/a?campaignEntry=new",
    );
  });

  test("the 2-minute campaign handoff token is unchanged", () => {
    const handoff = createCampaignExperienceEntryToken({
      campaignId: CAMPAIGN_A,
      experienceSlug: SLUG,
      now: 0,
    });
    const visitor = new Visitor(CAMPAIGN_A);

    assert.deepEqual(
      visitor.open({ route: ROUTES[0], token: handoff, now: MINUTE }),
      { kind: "CAMPAIGN", campaignId: CAMPAIGN_A },
    );
    assert.deepEqual(
      new Visitor(CAMPAIGN_A).open({
        route: ROUTES[0],
        token: handoff,
        now: 3 * MINUTE,
      }),
      { kind: "DIRECT" },
    );
  });
});

describe("wiring", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");
  const pages = [
    "",
    "/learn",
    "/posts",
    "/qa",
    "/shop",
    "/courses/[courseSlug]",
    "/lessons/[lessonId]",
  ];

  test("every Experience page enforces the entry policy before rendering anything", () => {
    for (const route of pages) {
      const source = read(`src/app/x/[experienceSlug]${route}/page.tsx`);
      const enforce = source.indexOf("await enforceExperienceEntryContext(");

      assert.ok(enforce > 0, route || "hub");
      assert.match(source, /campaignEntry: query\.campaignEntry/, route || "hub");
      assert.match(source, /searchParams: Promise<\{ campaignEntry\?/, route || "hub");
      assert.ok(
        enforce < source.indexOf("return"),
        `${route || "hub"} guard precedes render`,
      );
      assert.equal(
        /clearViewerSessionCampaignContext|resolveExperienceEntry/.test(source),
        false,
        `${route || "hub"} must not re-implement the policy`,
      );
    }
  });

  test("the guard clears only when the entry is not trusted, and only from server-validated inputs", () => {
    const guard = read("src/lib/experience-entry-guard.ts");

    assert.match(guard, /if \(!entry\.keepSessionCampaign\) \{\s*await clearViewerSessionCampaignContext\(\);/);
    assert.match(guard, /sessionCampaignId: viewerSession\?\.campaignId \?\? null/);
    assert.match(guard, /requestHeaders\.get\("referer"\)/);
    assert.equal(/searchParams|request\.url/.test(guard.replace(/\/\*[\s\S]*?\*\//g, "")), false);
  });

  test("login-return tokens are minted server-side on every route that feeds GatePanel", () => {
    for (const file of [
      "src/lib/public-experience.ts",
      "src/app/api/public/experience/[experienceSlug]/courses/[courseSlug]/route.ts",
      "src/app/api/public/experience/[experienceSlug]/lessons/[lessonId]/route.ts",
    ]) {
      const source = read(file);

      assert.match(source, /campaignReturnToken: mintCampaignReturnToken\(\{\s*entryContext: access\.entryContext,/, file);
    }

    const shell = read("src/components/experience/experience-shell.tsx");

    assert.match(shell, /appendCampaignEntryToken\(\s*nextHref,\s*experience\.campaignReturnToken,?\s*\)/);
    assert.match(shell, /\/login\?next=\$\{encodeURIComponent\(returnHref\)\}/);
    assert.match(shell, /\/signup\?next=\$\{encodeURIComponent\(returnHref\)\}/);
  });

  test("the campaign handoff route uses the shared query parameter name", () => {
    assert.match(
      read("src/app/api/public/campaign/[campaignSlug]/experience/[experienceSlug]/route.ts"),
      /CAMPAIGN_ENTRY_QUERY_PARAM,/,
    );
  });
});
