/**
 * Phase 6: the single server hop on the outbound commerce path.
 *
 * WHAT CHANGED. Before Phase 6 the shop and lesson clients called
 * `window.open(product.productUrl, ...)` directly on the raw merchant URL and
 * then fired a fire-and-forget analytics beacon. Nothing server-side stood
 * between the visitor and the merchant, so there was no unforgeable artifact
 * tying a visitor, a validated campaign context, and a destination together.
 * This module is that hop: one GET request that resolves the link server-side,
 * resolves the visitor's campaign context server-side, validates the
 * destination, mints a `CommerceClickAttribution` row, and issues the redirect.
 *
 * WHY ONE REQUEST. The client can point its existing synchronous
 * `window.open(...)` call at this route's URL directly, with no awaited fetch
 * beforehand, so no popup blocker is ever triggered. Splitting "mint" and
 * "redirect" into two requests would have required an async round trip inside
 * the click handler, which browsers treat as a non-user-initiated popup.
 *
 * WHAT IS NEVER TRUSTED. The brand, the campaign, and the destination URL are
 * ALL re-derived server-side — from the link row addressed by an internal
 * SQRATCH id in the path, and from the visitor's cookie-backed session. None of
 * them is ever read from a query parameter, a request body, or a header. That
 * is what structurally prevents cross-brand token reuse and cross-campaign
 * confusion here: there is no client-supplied input that could express either.
 *
 * TRANSPORT REALITY. SQRATCH's Shopify app holds only `read_products`,
 * `read_discounts`, `write_discounts` — no `read_orders`, no orders webhook, no
 * checkout/theme/admin extension. The token appended to the destination URL
 * therefore has NO guaranteed mechanism today to survive into a merchant order.
 * It is an inert, forward-compatible seam, and this module must never be
 * described as live order attribution.
 */

import { NextResponse, type NextRequest } from "next/server";
import type { CommerceProvider } from "@prisma/client";
import { getExperienceAccessContext, type ExperienceAccessContext } from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";
import { getRequestIp, rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { normalizeShopDomain } from "@/lib/shopify";
import {
  CLICK_TOKEN_QUERY_PARAM,
  clickTokenPrefix,
  generateClickToken,
  hashClickIp,
  hashClickToken,
} from "@/lib/commerce/click-token";

/**
 * Per-IP click budget. Generous enough that no real visitor is ever stopped,
 * tight enough that enumerating link ids or farming attribution rows is not
 * practical from one address. This uses the existing in-memory limiter
 * (`src/lib/rate-limit.ts`), which is per-serverless-instance and therefore a
 * low-volume abuse control rather than a hard guarantee — the same trade every
 * other public route in this codebase already makes.
 */
const CLICK_RATE_LIMIT = 120;
const CLICK_RATE_WINDOW_MS = 60 * 60 * 1000;

/** A click token is evidence for 30 days, then it is stale by construction. */
const CLICK_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Bounded so a hostile client cannot write unbounded strings into the table. */
const MAX_USER_AGENT_LENGTH = 512;

/**
 * Which click surface this request came from. Both carry ONLY an internal
 * SQRATCH id: never a destination URL, never a provider product id, never a
 * campaign id.
 */
export type CommerceClickSurface =
  | { kind: "EXPERIENCE_SHOP"; productLinkId: string }
  | { kind: "CAMPAIGN_CATALOG"; brandCommerceProductId: string }
  | { kind: "CAMPAIGN_ASSIGNMENT_CATALOG"; campaignAssignmentId: string }
  | { kind: "LESSON"; lessonId: string; productLinkId: string };

type ResolvedLink = {
  id: string;
  productUrl: string;
  brandId: string | null;
  courseId: string | null;
  lessonId: string | null;
  experienceProductLinkId: string | null;
  lessonProductLinkId: string | null;
  campaignLessonProductId: string | null;
  scopedCampaignId: string | null;
  brandCommerceProductId: string | null;
  sourceShopDomain: string | null;
};

export type CommerceClickDeps = {
  getAccess(
    experienceSlug: string,
    request: NextRequest,
  ): Promise<ExperienceAccessContext | null>;
  ensureSession(options: {
    request: NextRequest;
    userId: string | null;
    campaignId: string | null;
  }): Promise<string>;
  findExperienceProductLink(options: {
    productLinkId: string;
    experienceId: string;
  }): Promise<ResolvedLink | null>;
  findCampaignCatalogProduct(options: {
    brandCommerceProductId: string;
    experienceId: string;
    entryCampaignId: string | null;
  }): Promise<ResolvedLink | null>;
  findCampaignAssignmentCatalogProduct(options: {
    campaignAssignmentId: string;
    experienceId: string;
  }): Promise<ResolvedLink | null>;
  findLessonProductLink(options: {
    productLinkId: string;
    lessonId: string;
    experienceId: string;
    canAccessPrivate: boolean;
  }): Promise<ResolvedLink | null>;
  recordAttribution(input: AttributionInput): Promise<void>;
};

export type AttributionInput = {
  tokenHash: string;
  tokenPrefix: string;
  brandId: string | null;
  /** Trusted acquisition context. Null for an explicit direct Experience entry. */
  entryCampaignId: string | null;
  /** Server-derived campaign that authorized this specific product, if scoped. */
  productCampaignId: string | null;
  entryCampaignContextResolved: boolean;
  experienceId: string;
  courseId: string | null;
  lessonId: string | null;
  creatorProfileId: string | null;
  lessonProductLinkId: string | null;
  experienceProductLinkId: string | null;
  campaignLessonProductId: string | null;
  brandCommerceProductId: string | null;
  sourceShopDomain?: string | null;
  destinationUrl: string;
  destinationHost: string;
  /**
   * Best-effort provider derived from the link row alone. Superseded by the
   * catalog row's authoritative provider when one is resolvable.
   */
  providerHint: CommerceProvider | null;
  userId: string | null;
  sessionId: string | null;
  ipHash: string | null;
  userAgent: string | null;
  referrer: string | null;
  expiresAt: Date;
  redirectedAt: Date;
};

/**
 * Uniform failure response.
 *
 * Deliberately identical for "no such Experience", "no such link", "link
 * belongs to another Experience/Lesson", "lesson is locked", "link is scoped to
 * a different campaign", and "destination failed validation". Differential
 * responses across those cases would turn this route into an oracle for
 * enumerating internal link ids and for probing which campaign a visitor's
 * session is in.
 */
function genericNotFound(): NextResponse {
  return NextResponse.json({ error: "Not found." }, { status: 404 });
}

/**
 * The visitor's campaign context on this Experience, or null when it is
 * genuinely ambiguous. Identical resolution to the public products routes —
 * this deliberately calls the shared resolver rather than re-deriving a second,
 * divergent rule. Never `campaigns[0]`.
 */
function resolveVisitorCampaign(access: ExperienceAccessContext) {
  // `entryContext` is established only by the trusted public-entry flow. In
  // particular, an explicit direct Experience entry deliberately ignores an
  // old UserSession.campaignId rather than silently reusing it.
  const resolvedCampaignId =
    access.entryContext.kind === "CAMPAIGN"
      ? access.entryContext.campaignId
      : null;

  return (
    access.experience.campaigns.find(
      (item) => item.campaignId === resolvedCampaignId,
    ) || null
  );
}

/**
 * Defensive re-validation of a stored destination.
 *
 * Phase 5's `assertProductUrlMatchesBrandDomain` already gates new attaches, but
 * rows written before that gate existed are still in the table, so the URL is
 * re-checked here at the moment it would be handed to a browser. Only `http:`
 * and `https:` are accepted: anything else (notably `javascript:`, `data:`) is
 * refused outright rather than redirected to.
 */
function validateDestination(productUrl: string, expectedShopDomain?: string | null): URL | null {
  let parsed: URL;

  try {
    parsed = new URL(productUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  if (!parsed.hostname || !expectedShopDomain) {
    return null;
  }
  // A click redirect is security-sensitive: without a provider domain we
  // cannot prove a historical snapshot remains a product destination. Fail
  // closed instead of turning the route into a durable open redirect.
  const expectedHost = normalizeShopDomain(expectedShopDomain) || expectedShopDomain.toLowerCase();
  if (parsed.hostname !== expectedHost) return null;

  return parsed;
}

function truncate(value: string | null, max: number): string | null {
  if (!value) {
    return null;
  }
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Only Shopify links carry a `sourceShopDomain` in this schema, so its presence
 * is the one provider signal available from a link row alone. Left null rather
 * than guessed when absent.
 */
function providerFromLink(link: ResolvedLink): CommerceProvider | null {
  return link.sourceShopDomain ? "SHOPIFY" : null;
}

const DEFAULT_DEPS: CommerceClickDeps = {
  getAccess: getExperienceAccessContext,
  ensureSession: ensureViewerSession,
  async findExperienceProductLink({ productLinkId, experienceId }) {
    // The `experienceId` predicate is the authorization: a link id belonging to
    // another Experience resolves to null and yields the uniform 404.
    const link = await prisma.experienceProductLink.findFirst({
      where: { id: productLinkId, experienceId },
      select: {
        id: true,
        productUrl: true,
        brandId: true,
        sourceShopDomain: true,
      },
    });

    if (!link) {
      return null;
    }

    return {
      id: link.id,
      productUrl: link.productUrl,
      brandId: link.brandId,
      sourceShopDomain: link.sourceShopDomain,
      courseId: null,
      lessonId: null,
      experienceProductLinkId: link.id,
      lessonProductLinkId: null,
      campaignLessonProductId: null,
      scopedCampaignId: null,
      brandCommerceProductId: null,
    };
  },
  async findLessonProductLink({
    productLinkId,
    lessonId,
    experienceId,
    canAccessPrivate,
  }) {
    // Every containment check is in the query: the link must belong to this
    // Lesson, the Lesson to an active Course, and the Course to THIS Experience.
    const link = await prisma.lessonProductLink.findFirst({
      where: {
        id: productLinkId,
        lessonId,
        lesson: {
          isActive: true,
          course: { experienceId, isActive: true },
        },
      },
      select: {
        id: true,
        productUrl: true,
        brandId: true,
        sourceShopDomain: true,
        lessonId: true,
        lesson: {
          select: {
            courseId: true,
            course: { select: { access: true } },
          },
        },
        campaignProductLink: {
          select: {
            id: true,
            campaignId: true,
            brandCommerceProductId: true,
            isActive: true,
          },
        },
      },
    });

    if (!link) {
      return null;
    }

    // Private courses stay private on this path too. A locked lesson is
    // reported through the same uniform 404 as a missing one.
    if (link.lesson.course.access !== "PUBLIC" && !canAccessPrivate) {
      return null;
    }

    const scope =
      link.campaignProductLink && link.campaignProductLink.isActive
        ? link.campaignProductLink
        : null;

    return {
      id: link.id,
      productUrl: link.productUrl,
      brandId: link.brandId,
      sourceShopDomain: link.sourceShopDomain,
      courseId: link.lesson.courseId,
      lessonId: link.lessonId,
      experienceProductLinkId: null,
      lessonProductLinkId: link.id,
      campaignLessonProductId: scope?.id ?? null,
      scopedCampaignId: scope?.campaignId ?? null,
      brandCommerceProductId: scope?.brandCommerceProductId ?? null,
    };
  },
  async findCampaignCatalogProduct({ brandCommerceProductId, experienceId, entryCampaignId }) {
    const row = await prisma.brandCommerceProduct.findFirst({
      where: {
        id: brandCommerceProductId,
        isVisibleInShop: true,
        connectedProduct: { isAvailable: true },
        brand: {
          campaigns: {
            some: {
              ...(entryCampaignId ? { id: entryCampaignId } : {}),
              experiences: { some: { experienceId } },
            },
          },
        },
      },
      select: {
        id: true, brandId: true,
        connectedProduct: { select: { productUrl: true, connection: { select: { externalAccountId: true } } } },
      },
    });
    return row ? {
      id: row.id, productUrl: row.connectedProduct.productUrl, brandId: row.brandId,
      sourceShopDomain: row.connectedProduct.connection.externalAccountId, courseId: null, lessonId: null,
      experienceProductLinkId: null, lessonProductLinkId: null,
      campaignLessonProductId: null, scopedCampaignId: null,
      brandCommerceProductId: row.id,
    } : null;
  },
  async findCampaignAssignmentCatalogProduct({ campaignAssignmentId, experienceId }) {
    const assignment = await prisma.campaignCommerceProduct.findFirst({
      where: {
        id: campaignAssignmentId,
        isActive: true,
        campaign: { experiences: { some: { experienceId } } },
        brandCommerceProduct: {
          isVisibleInShop: true,
          connectedProduct: { isAvailable: true },
        },
      },
      select: {
        id: true,
        campaignId: true,
        brandId: true,
        brandCommerceProductId: true,
        brandCommerceProduct: {
          select: {
            connectedProduct: {
              select: {
                productUrl: true,
                connection: { select: { externalAccountId: true } },
              },
            },
          },
        },
      },
    });

    return assignment
      ? {
          id: assignment.id,
          productUrl: assignment.brandCommerceProduct.connectedProduct.productUrl,
          brandId: assignment.brandId,
          sourceShopDomain:
            assignment.brandCommerceProduct.connectedProduct.connection.externalAccountId,
          courseId: null,
          lessonId: null,
          experienceProductLinkId: null,
          lessonProductLinkId: null,
          campaignLessonProductId: null,
          scopedCampaignId: assignment.campaignId,
          brandCommerceProductId: assignment.brandCommerceProductId,
        }
      : null;
  },
  async recordAttribution(input) {
    // `connectedProductId`/`commerceConnectionId` are only knowable through the
    // curated catalog row, and only for campaign-scoped lesson attachments.
    // Resolved here (inside the caller's fail-open boundary) rather than in the
    // link query so the common, unscoped path pays nothing for it.
    let connectedProductId: string | null = null;
    let commerceConnectionId: string | null = null;
    let provider: CommerceProvider | null = input.providerHint;

    if (input.brandCommerceProductId) {
      const catalogRow = await prisma.brandCommerceProduct.findUnique({
        where: { id: input.brandCommerceProductId },
        select: {
          connectedProductId: true,
          connectedProduct: {
            select: { connectionId: true, provider: true },
          },
        },
      });

      if (catalogRow) {
        connectedProductId = catalogRow.connectedProductId;
        commerceConnectionId = catalogRow.connectedProduct.connectionId;
        provider = catalogRow.connectedProduct.provider;
      } else {
        // The catalog row was part of the authorization proof used to resolve
        // this click. If it disappeared before minting, do not issue an
        // unpinned token that another same-brand connection could claim.
        throw new Error("Catalog product no longer exists for click attribution");
      }
    }
    if (!commerceConnectionId && input.sourceShopDomain && input.brandId) {
      const connection = await prisma.commerceConnection.findFirst({
        where: {
          brandId: input.brandId,
          provider: "SHOPIFY",
          externalAccountId: input.sourceShopDomain,
        },
        select: { id: true, provider: true },
      });
      if (connection) {
        commerceConnectionId = connection.id;
        provider = connection.provider;
      } else {
        // A Shopify click with a known source domain is not evidence for an
        // arbitrary same-brand connection. Fail attribution minting; the
        // outer handler still performs the already-validated redirect without
        // issuing a token, preserving revenue-path availability.
        throw new Error("Commerce connection not found for link source domain");
      }
    }
    if (!commerceConnectionId && input.brandId && !input.brandCommerceProductId) {
      // Legacy snapshots without a resolvable catalog connection may still be
      // navigable, but cannot mint order-attribution evidence safely.
      throw new Error("Commerce connection cannot be pinned for legacy link");
    }

    const qrCodeId = input.sessionId
      ? (
          await prisma.userSession.findUnique({
            where: { id: input.sessionId },
            select: { qrCodeId: true },
          })
        )?.qrCodeId ?? null
      : null;

    await prisma.commerceClickAttribution.create({
      data: {
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        brandId: input.brandId,
        entryCampaignId: input.entryCampaignId,
        productCampaignId: input.productCampaignId,
        entryCampaignContextResolved: input.entryCampaignContextResolved,
        experienceId: input.experienceId,
        courseId: input.courseId,
        lessonId: input.lessonId,
        creatorProfileId: input.creatorProfileId,
        brandCommerceProductId: input.brandCommerceProductId,
        connectedProductId,
        lessonProductLinkId: input.lessonProductLinkId,
        experienceProductLinkId: input.experienceProductLinkId,
        campaignLessonProductId: input.campaignLessonProductId,
        commerceConnectionId,
        destinationUrl: input.destinationUrl,
        destinationHost: input.destinationHost,
        provider,
        userId: input.userId,
        sessionId: input.sessionId,
        qrCodeId,
        ipHash: input.ipHash,
        userAgent: input.userAgent,
        referrer: input.referrer,
        expiresAt: input.expiresAt,
        redirectedAt: input.redirectedAt,
      },
    });
  },
};

/**
 * Handles one commerce click: resolve, validate, mint, redirect.
 *
 * `overrides` exists solely so this can be exercised with injected doubles, the
 * same pattern `publicExperienceProductsGetImpl` already uses. Production
 * callers pass nothing.
 */
export async function handleCommerceClick(
  request: NextRequest,
  options: { experienceSlug: string; surface: CommerceClickSurface },
  overrides: Partial<CommerceClickDeps> = {},
): Promise<NextResponse> {
  const deps: CommerceClickDeps = { ...DEFAULT_DEPS, ...overrides };

  // ABUSE CONTROL FIRST, before any database read. A rejected request is NOT
  // redirected to the destination: this is a real control, not a best-effort
  // annotation, so it must be able to deny the commerce path outright.
  const ip = getRequestIp(request);
  const limit = rateLimit(
    `commerce-click:${ip}`,
    CLICK_RATE_LIMIT,
    CLICK_RATE_WINDOW_MS,
  );

  if (!limit.success) {
    return rateLimitResponse(limit.resetAt);
  }

  try {
    const access = await deps.getAccess(options.experienceSlug, request);

    if (!access) {
      return genericNotFound();
    }

    const visitorCampaign = resolveVisitorCampaign(access);
    const link =
      options.surface.kind === "EXPERIENCE_SHOP"
        ? await deps.findExperienceProductLink({
            productLinkId: options.surface.productLinkId,
            experienceId: access.experience.id,
          })
        : options.surface.kind === "CAMPAIGN_CATALOG"
          ? await deps.findCampaignCatalogProduct({
                brandCommerceProductId: options.surface.brandCommerceProductId,
                experienceId: access.experience.id,
                entryCampaignId: visitorCampaign?.campaignId ?? null,
              })
          : options.surface.kind === "CAMPAIGN_ASSIGNMENT_CATALOG"
            ? await deps.findCampaignAssignmentCatalogProduct({
                campaignAssignmentId: options.surface.campaignAssignmentId,
                experienceId: access.experience.id,
              })
          : await deps.findLessonProductLink({
            productLinkId: options.surface.productLinkId,
            lessonId: options.surface.lessonId,
            experienceId: access.experience.id,
            canAccessPrivate: access.canAccessPrivate,
          });

    if (!link) {
      return genericNotFound();
    }

    // CAMPAIGN CONTEXT — resolved from the visitor's cookie-backed session
    // only, never from this request's parameters.
    const entryCampaignContextResolved =
      access.entryContext.kind === "CAMPAIGN" && visitorCampaign !== null;
    const resolvedCampaignBrandId = visitorCampaign?.campaign.brand?.id ?? null;

    // A campaign-scoped attachment is clickable only inside its own campaign
    // entry context. Explicit direct entry is deliberately different: direct
    // union rendering may expose the attachment and preserves its campaign as
    // product authorization without fabricating acquisition credit. Invalid
    // campaign entry context still fails closed; unscoped legacy rows remain
    // unaffected.
    if (
      link.scopedCampaignId &&
      access.entryContext.kind === "CAMPAIGN" &&
      link.scopedCampaignId !== visitorCampaign?.campaignId
    ) {
      return genericNotFound();
    }

    const sessionId =
      access.viewer.sessionId ||
      (await deps.ensureSession({
        request,
        userId: access.viewer.userId,
        campaignId: entryCampaignContextResolved ? visitorCampaign!.campaignId : null,
      }));

    // BRAND — re-derived from the link row first, falling back to the resolved
    // context's brand only when the link carries none. This mirrors the
    // existing analytics attribution rule: the link's own brand is a property
    // of the product, not a guess about the visitor.
    const brandId = link.brandId ?? resolvedCampaignBrandId;

    // Acquisition and product authorization are intentionally independent.
    // The entry campaign is evidence of HOW the visitor reached this
    // Experience and may belong to a different brand than the clicked product.
    // The product campaign is evidence of WHICH campaign-scoped attachment
    // authorized the product. Never infer either value from a participating
    // brand or accept one from the request.
    const entryCampaignId = visitorCampaign?.campaignId ?? null;
    const productCampaignId = link.scopedCampaignId;

    const destination = validateDestination(link.productUrl, link.sourceShopDomain);

    if (!destination) {
      // Sanitized: internal ids only. The offending URL is never logged, and no
      // visitor identifier accompanies it.
      console.warn("[commerce/click] Rejected unsafe destination:", {
        surface: options.surface.kind,
        experienceId: access.experience.id,
        productLinkId: link.id,
        brandId,
      });
      // No attribution row, and deliberately NO redirect: a URL that failed
      // validation must never be handed to a browser. Reported through the
      // same uniform response as every other failure.
      return genericNotFound();
    }

    const now = new Date();
    let token: string | null = null;

    // ATTRIBUTION IS EVIDENCE COLLECTION; IT IS NOT PERMITTED TO BECOME AN
    // AVAILABILITY DEPENDENCY ON THE COMMERCE PATH.
    //
    // Everything inside this try — token generation, hashing (which throws when
    // COMMERCE_CLICK_TOKEN_PEPPER is unset), the catalog lookup, the session
    // lookup, and the insert — may fail for reasons that have nothing to do
    // with the visitor: a database outage, a missing environment variable, a
    // constraint surprise. None of those are a reason to deny a visitor the
    // merchant page they asked for. On failure we log a sanitized error and
    // redirect anyway, to the already-validated destination, with no token
    // appended.
    //
    // Do NOT "fix" this into a hard failure. Losing one attribution row is a
    // reporting gap; blocking the redirect is an outage on the revenue path.
    try {
      const mintedToken = generateClickToken();

      await deps.recordAttribution({
        tokenHash: hashClickToken(mintedToken),
        tokenPrefix: clickTokenPrefix(mintedToken),
        brandId,
        entryCampaignId,
        productCampaignId,
        entryCampaignContextResolved,
        experienceId: access.experience.id,
        courseId: link.courseId,
        lessonId: link.lessonId,
        creatorProfileId: access.experience.creator.id,
        lessonProductLinkId: link.lessonProductLinkId,
        experienceProductLinkId: link.experienceProductLinkId,
        campaignLessonProductId: link.campaignLessonProductId,
        brandCommerceProductId: link.brandCommerceProductId,
        sourceShopDomain: link.sourceShopDomain,
        destinationUrl: destination.toString(),
        destinationHost: destination.hostname,
        providerHint: providerFromLink(link),
        userId: access.viewer.userId,
        sessionId,
        ipHash: hashClickIp(ip),
        userAgent: truncate(
          request.headers.get("user-agent"),
          MAX_USER_AGENT_LENGTH,
        ),
        // Referrers commonly carry email addresses, tokens, and opaque query
        // values. Click evidence does not need them, so never persist one.
        referrer: null,
        expiresAt: new Date(now.getTime() + CLICK_TOKEN_TTL_MS),
        redirectedAt: now,
      });

      token = mintedToken;
    } catch (error) {
      // Error NAME only. Never the error object (it can carry query text and
      // parameter values), never the destination, never any visitor identifier.
      console.error("[commerce/click] Attribution mint failed:", {
        surface: options.surface.kind,
        experienceId: access.experience.id,
        productLinkId: link.id,
        brandId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }

    // The token is a forward-compatible seam ONLY. Finding G of the Phase 6
    // audit confirmed there is no mechanism today — no orders scope, no
    // webhook, no extension — by which a merchant would read this parameter or
    // carry it into an order. Appending it is inert and harmless; it must not
    // be read as working order attribution.
    //
    // An existing `ref` on the merchant's own URL is left untouched: clobbering
    // it could break the merchant's own attribution, which is a real harm in
    // exchange for a parameter that currently does nothing.
    if (token && !destination.searchParams.has(CLICK_TOKEN_QUERY_PARAM)) {
      destination.searchParams.set(CLICK_TOKEN_QUERY_PARAM, token);
    }

    const response = NextResponse.redirect(destination.toString(), 302);
    // Never cache a per-visitor redirect that carries a per-visitor token.
    response.headers.set("Cache-Control", "private, no-store");
    // Stops the token — and even the bare click path — from reaching the
    // merchant's server logs through the Referer header.
    response.headers.set("Referrer-Policy", "no-referrer");
    attachSessionCookie(response, sessionId);

    return response;
  } catch (error) {
    console.error("[commerce/click] Error:", {
      surface: options.surface.kind,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return genericNotFound();
  }
}
