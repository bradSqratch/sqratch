/**
 * Shared, deterministic campaign-context resolution.
 *
 * An Experience can be co-sponsored by several campaigns belonging to several
 * brands. Historically the codebase resolved "the campaign" by reading
 * `campaigns[0]` — the first row of an array ordered only by a brand-writable
 * `CampaignExperience.sortOrder`, with no secondary tiebreak. That let a
 * co-sponsoring brand influence which brand is treated as primary on a shared
 * Experience, and it silently guessed a campaign where none was determined.
 *
 * This module is the single source of truth that replaces those reads. It
 * generalizes the principle already established by
 * `resolveDeterministicCampaignByExperience` in `src/lib/points.ts`
 * ("deterministic only when an experience has exactly one. Never 'the first of
 * several.'") to any number of contexts, to explicit client selection, and to
 * curated and legacy campaigns alike.
 *
 * It is deliberately PURE: no Prisma import, no I/O, no `Date.now()`. Callers
 * load their own rows and map them into `CampaignContextSource`. That keeps it
 * unit-testable with plain objects and keeps the ordering rule in code rather
 * than in a database `ORDER BY` that a later query change could silently drop.
 */

/**
 * Whether a campaign's products come from the Phase-4 curated catalog
 * (`CampaignCommerceProduct` -> `BrandCommerceProduct`) or from the legacy
 * free-form `LessonProductLink` snapshot path. Both are legitimate eligible
 * contexts; a selector must be able to render them together without collapsing
 * one into the other.
 */
export type CampaignContextMode = "CURATED" | "LEGACY";

/**
 * Caller-normalized input row. Every field is required on purpose: an optional
 * `curationEnabled` that silently defaults to `false` when a query forgot to
 * select it would downgrade a curated campaign to legacy mode, which is an
 * authorization downgrade. Callers must map explicitly.
 *
 * `sortOrder` is the persisted `CampaignExperience.sortOrder` when the caller
 * loaded it. A caller that only has an already-ordered list (because its query
 * ordered by `sortOrder` but did not select the column) may pass the array
 * index, which preserves that same order. `sortOrder` is only ever a
 * *presentation* hint — it is never a security boundary, because
 * `buildEligibleCampaignContexts` always applies `campaignId` as a secondary,
 * code-level tiebreak and no consumer may take "the first of several".
 */
export type CampaignContextSource = {
  campaignId: string;
  campaignName: string;
  sortOrder: number;
  /** Null for a brandless campaign; such a campaign is never eligible. */
  brandId: string | null;
  /** Null only when the caller did not load the brand relation. */
  brandName: string | null;
  curationEnabled: boolean;
};

/**
 * An eligible campaign context: a campaign that is linked to the Experience
 * AND owns a brand. `brandId` is non-null by construction.
 */
export type CampaignContextCandidate = {
  campaignId: string;
  campaignName: string;
  brandId: string;
  brandName: string | null;
  curationEnabled: boolean;
  mode: CampaignContextMode;
  /** Carried through for stable presentation ordering only. */
  sortOrder: number;
};

export type CampaignSelectionResult =
  | { kind: "none" }
  | { kind: "resolved"; context: CampaignContextCandidate }
  | { kind: "selection_required"; contexts: CampaignContextCandidate[] }
  | { kind: "invalid_campaign" };

/**
 * Public Experience entry is explicit: a campaign context is present only
 * when the server has a stored, eligible campaign acquisition signal.  A
 * missing signal is a direct/unscoped entry even if the Experience currently
 * has exactly one linked campaign.  This prevents direct Experience entry
 * from fabricating acquisition attribution from topology alone.
 */
export type PublicExperienceEntryContext =
  | { kind: "DIRECT" }
  | { kind: "CAMPAIGN"; campaignId: string };

/**
 * The minimal server-derived scope attached to a public lesson product.  A
 * missing scope is a legacy/global link; an inactive scope is deliberately
 * not the same thing.  Deactivation revokes that attachment rather than
 * turning it into a global product.
 */
export type PublicCampaignScopedContent = {
  campaignId: string;
  isActive: boolean;
};

/**
 * Shared authorization predicate for public campaign-scoped lesson content.
 *
 * The list route and its outbound click route must apply the exact same rule:
 * a visible card must be clickable, and a hidden card must never be
 * redirectable. `eligibleCampaignIds` is derived from CampaignExperience
 * rows for the current Experience (and filters out brandless campaigns), so
 * a stale CampaignLessonProduct remains denied after its campaign is removed
 * from the Experience.
 */
export function isPublicCampaignScopedContentVisible(options: {
  scope: PublicCampaignScopedContent | null;
  entryContext: PublicExperienceEntryContext;
  resolvedCampaignId: string | null;
  eligibleCampaignIds: readonly string[];
}): boolean {
  const { scope, entryContext, resolvedCampaignId, eligibleCampaignIds } = options;

  // No row is the pre-Phase-5 global compatibility case. An inactive row is
  // an explicit revocation and must not be downgraded into a global link.
  if (!scope) {
    return true;
  }

  if (!scope.isActive || !eligibleCampaignIds.includes(scope.campaignId)) {
    return false;
  }

  // Direct Experience entry intentionally unions every active, currently
  // linked campaign scope without fabricating acquisition attribution.
  if (entryContext.kind === "DIRECT") {
    return true;
  }

  // A campaign entry needs the independently resolved, validated campaign as
  // well as the marker. This fails closed if a malformed/stale access object
  // claims CAMPAIGN but cannot resolve that campaign against the Experience.
  return scope.campaignId === resolvedCampaignId;
}

/**
 * Filters to eligible contexts and orders them deterministically.
 *
 * A campaign with a null `brandId` is NEVER an eligible context: brand
 * ownership is what makes a campaign able to authorize a product, stamp a
 * source shop domain, or receive click attribution. A brandless campaign has
 * nothing to authorize against, so including it would create a context that
 * every downstream authorization check would have to special-case away.
 *
 * Ordering is `sortOrder` ascending, then `campaignId` ascending. The
 * `campaignId` tiebreak is applied here, in code, and never left to the
 * database's return order: a query whose `orderBy` loses its secondary key
 * must not be able to change which context a consumer sees first.
 */
export function buildEligibleCampaignContexts(
  sources: CampaignContextSource[],
): CampaignContextCandidate[] {
  const eligible: CampaignContextCandidate[] = [];

  for (const source of sources) {
    if (!source.brandId) {
      continue;
    }

    eligible.push({
      campaignId: source.campaignId,
      campaignName: source.campaignName,
      brandId: source.brandId,
      brandName: source.brandName,
      curationEnabled: source.curationEnabled,
      mode: source.curationEnabled ? "CURATED" : "LEGACY",
      sortOrder: source.sortOrder,
    });
  }

  return eligible.sort((a, b) => {
    if (a.sortOrder !== b.sortOrder) {
      return a.sortOrder - b.sortOrder;
    }
    return a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0;
  });
}

/**
 * Resolves which campaign context a request operates in.
 *
 * Rules, in order:
 *  - No eligible context at all -> `none`.
 *  - An explicitly requested campaign id is ALWAYS validated against the
 *    eligible set. It is never silently dropped, and an id outside the set is
 *    `invalid_campaign` rather than a fallback. (The previous curation
 *    resolver returned early on the legacy path before it looked at the
 *    requested id, so a client-supplied id was silently ignored there.)
 *  - Exactly one eligible context and no explicit request -> `resolved`. This
 *    is the only auto-inference permitted: it is unambiguous.
 *  - Two or more eligible contexts and no explicit request ->
 *    `selection_required`, carrying the full ordered list.
 *
 * There is deliberately no code path that returns `contexts[0]` when more than
 * one context exists. That guess is the bug this module exists to eliminate.
 */
export function resolveCampaignSelection(
  contexts: CampaignContextCandidate[],
  requestedCampaignId?: string | null,
): CampaignSelectionResult {
  if (contexts.length === 0) {
    return { kind: "none" };
  }

  const requested = typeof requestedCampaignId === "string"
    ? requestedCampaignId.trim()
    : "";

  if (requested) {
    const match = contexts.find((context) => context.campaignId === requested);
    return match
      ? { kind: "resolved", context: match }
      : { kind: "invalid_campaign" };
  }

  if (contexts.length === 1) {
    return { kind: "resolved", context: contexts[0] };
  }

  return { kind: "selection_required", contexts };
}

/**
 * Resolves the campaign context for a PUBLIC (visitor-facing) read.
 *
 * The only trusted public campaign signal is the visitor's stored
 * `UserSession.campaignId`. It is cookie-backed (`sqr_session`, httpOnly) and
 * is stamped server-side by `/api/public/scan` (QR scan) and
 * `/api/public/campaign/[slug]` (campaign landing) — never by a client-supplied
 * request parameter. It is trusted here ONLY after being validated against the
 * campaigns actually linked to the Experience being viewed, so a session
 * stamped for an unrelated campaign cannot select a context on this Experience.
 *
 *  - Stored id present AND eligible -> use it (the visitor's real context).
 *  - Otherwise -> `null`. A missing signal means direct/unscoped Experience
 *    entry even where exactly one campaign happens to be linked; topology is
 *    not acquisition attribution. Never `eligibleCampaignIds[0]`, never a
 *    guess.
 *
 * Pure: the caller passes the already-loaded stored value and the already
 * loaded eligible id list.
 */
export function resolveValidatedPublicCampaignContext(options: {
  storedCampaignId: string | null;
  eligibleCampaignIds: string[];
}): string | null {
  const entry = resolvePublicExperienceEntryContext(options);
  return entry.kind === "CAMPAIGN" ? entry.campaignId : null;
}

export function resolvePublicExperienceEntryContext(options: {
  storedCampaignId: string | null;
  eligibleCampaignIds: string[];
}): PublicExperienceEntryContext {
  const { storedCampaignId, eligibleCampaignIds } = options;

  if (storedCampaignId && eligibleCampaignIds.includes(storedCampaignId)) {
    return { kind: "CAMPAIGN", campaignId: storedCampaignId };
  }

  return { kind: "DIRECT" };
}
