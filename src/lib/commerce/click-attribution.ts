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
 * PHASE 8. Every surface now resolves through the canonical catalog chain
 * (`CampaignLessonProduct` / `CampaignCommerceProduct` / `BrandCommerceProduct`
 * -> `ConnectedCommerceProduct` -> `CommerceConnection`). The legacy
 * `ExperienceProductLink` / `LessonProductLink` snapshot surfaces and the
 * `sourceShopDomain`-based connection guess they required are gone, so the
 * connection, provider and destination are all pinned by the same query that
 * authorized the click. A product with no publicly reachable storefront URL now
 * fails CLOSED here (see `PUBLICLY_CLICKABLE_CONNECTED_PRODUCT`).
 *
 * TRANSPORT. For Shopify, Phase 12's Theme App Extension reads only the
 * namespaced token and writes it to a cart attribute. A later HMAC-verified
 * order delivery can claim it only when provider, connection, redirect, hash,
 * expiry, and immutable brand evidence all match.
 */

import { NextResponse, type NextRequest } from "next/server";
import type {
  CommerceProvider,
  // Aliased because this module already exports its own richer
  // `CommerceClickSurface` (the per-request discriminated union below). The
  // Prisma enum is the PERSISTED projection of that union's `kind`, and
  // importing it keeps the two tied together at compile time.
  CommerceClickSurface as PersistedClickSurface,
} from "@prisma/client";
import {
  getExperienceAccessContext,
  type ExperienceAccessContext,
} from "@/lib/experience-access";
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
import {
  isPublicCampaignScopedContentVisible,
  type PublicCampaignScopedContent,
} from "@/lib/campaign-context";
import { isCampaignAssignmentCatalogAuthorized } from "@/lib/commerce/campaign-assignment-authorization";
import { providerTrustsSuppliedStorefrontUrl } from "@/lib/commerce/provider-capabilities";

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
 * Which click surface this request came from. Every one of them carries ONLY an
 * internal SQRATCH id: never a destination URL, never a provider product id,
 * never a campaign id, never a brand id, never a provider.
 *
 * PHASE 8: the `EXPERIENCE_SHOP` surface is gone with `ExperienceProductLink`.
 * Every remaining surface resolves through the canonical catalog chain
 * (`BrandCommerceProduct -> ConnectedCommerceProduct -> CommerceConnection`),
 * which is what supplies the destination, the provider, and the connection.
 */
export type CommerceClickSurface =
  | { kind: "BRAND_STOREFRONT"; brandCommerceProductId: string }
  | { kind: "CAMPAIGN_PRODUCT"; campaignAssignmentId: string }
  | { kind: "LESSON"; lessonId: string; campaignLessonProductId: string };

/**
 * One resolved, authorized click target.
 *
 * Every field is server-derived from the canonical chain. In particular
 * `connectedProductId`, `commerceConnectionId` and `provider` are resolved by
 * the finder query itself rather than guessed later from a shop domain, so the
 * attribution row is always pinned to the exact connection that owns the
 * destination.
 */
type ResolvedLink = {
  id: string;
  productUrl: string;
  brandId: string | null;
  courseId: string | null;
  lessonId: string | null;
  campaignLessonProductId: string | null;
  /**
   * The campaign-scoped attachment this click is authorized by, or null for the
   * generic brand-storefront surface, which has no campaign scope at all: its
   * authorization is entirely the `isVisibleInShop` + brand-linked-to-this-
   * Experience predicate inside its own query. Every campaign-scoped surface
   * populates this, and `isPublicCampaignScopedContentVisible` is applied to it.
   */
  scope: PublicCampaignScopedContent | null;
  brandCommerceProductId: string;
  connectedProductId: string;
  commerceConnectionId: string;
  provider: CommerceProvider;
  /**
   * The connection's own `externalAccountId` (for Shopify, the shop domain).
   * This pins a synthesized Shopify fallback URL to the installed shop. A
   * provider-supplied Shopify URL may instead use the merchant's custom domain;
   * its provenance is a server-persisted metadata fact, never client input.
   */
  connectionExternalAccountId: string;
  hasProviderSuppliedStorefrontUrl: boolean;
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
  findBrandStorefrontProduct(options: {
    brandCommerceProductId: string;
    experienceId: string;
    entryCampaignId: string | null;
  }): Promise<ResolvedLink | null>;
  findCampaignProduct(options: {
    campaignAssignmentId: string;
    experienceId: string;
  }): Promise<ResolvedLink | null>;
  findCampaignLessonProduct(options: {
    campaignLessonProductId: string;
    lessonId: string;
    experienceId: string;
    canAccessPrivate: boolean;
  }): Promise<ResolvedLink | null>;
  recordAttribution(input: AttributionInput): Promise<void>;
};

export type AttributionInput = {
  tokenHash: string;
  tokenPrefix: string;
  /** Trusted acquisition context. Null for an explicit direct Experience entry. */
  entryCampaignId: string | null;
  /** Server-derived campaign that authorized this specific product, if scoped. */
  productCampaignId: string | null;
  entryCampaignContextResolved: boolean;
  experienceId: string;
  courseId: string | null;
  lessonId: string | null;
  creatorProfileId: string | null;
  /**
   * PHASE 8 IDENTITY COLUMNS. The last three are ALWAYS populated: every click
   * surface now resolves through the canonical catalog chain, so there is no
   * "legacy snapshot with no catalog row" case left. `campaignLessonProductId`
   * is populated for the lesson surface and is genuinely null for the two
   * storefront/catalog surfaces, which involve no lesson attachment.
   *
   * `lessonProductLinkId` / `experienceProductLinkId` are deliberately ABSENT
   * from this type: those columns still exist on the table until WS5 drops
   * them, and this module must never write either one again.
   */
  campaignLessonProductId: string | null;
  brandCommerceProductId: string;
  connectedProductId: string;
  commerceConnectionId: string;
  provider: CommerceProvider;
  /**
   * PHASE 10 DURABILITY COLUMNS. Both are optional here purely so existing
   * injected test doubles keep compiling; production always supplies both.
   *
   * `surface` is the persisted projection of `CommerceClickSurface["kind"]`.
   * Recording it is what stops analytics from having to INFER the surface from
   * which optional foreign keys survived, an inference that silently
   * reclassifies a lesson click as a campaign-product click once the
   * attachment is deleted.
   *
   * `attributedBrandId` is the durable Brand snapshot written once, with no
   * foreign key. It is the only persisted Brand attribution on a click.
   */
  surface?: PersistedClickSurface;
  attributedBrandId?: string | null;
  destinationUrl: string;
  destinationHost: string;
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
 * The destination now always comes from a synchronized `ConnectedCommerceProduct`
 * row, but it is still re-checked at the moment it would be handed to a browser:
 * historical rows predate today's gates, and the scheme check in particular must
 * survive regardless of provenance. Only `http:` and `https:` are accepted —
 * anything else (notably `javascript:`, `data:`) is refused outright.
 *
 * NOTE ON WHAT THIS CHECK CANNOT DO. A synthesized URL is pinned to the
 * connection's own `externalAccountId`. A Shopify URL explicitly supplied by
 * the provider may use the merchant's custom domain and is accepted only over
 * HTTPS with server-persisted provenance. Neither structural check proves
 * publication; the `hasPublicStorefrontUrl` predicate in every finder query
 * below supplies that separate provider-confirmed gate.
 */
function validateDestination(
  productUrl: string,
  expectedShopDomain: string,
  provider: CommerceProvider,
  hasProviderSuppliedStorefrontUrl: boolean,
): URL | null {
  let parsed: URL;

  try {
    parsed = new URL(productUrl);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  // Some providers legitimately return a merchant's primary CUSTOM-DOMAIN URL
  // rather than the connection's immutable account host (Shopify's
  // `Product.onlineStoreUrl` is the current example). Honoring that is a
  // per-provider SECURITY decision, so it lives in one reviewed place rather
  // than as an inline provider equality check here — see
  // `providerTrustsSuppliedStorefrontUrl` in `./provider-capabilities.ts`,
  // where every provider must answer explicitly and unknown ones fail closed.
  // It applies only when the synchronized row records that the provider
  // supplied the exact URL; a synthesized fallback remains host-pinned below.
  if (
    providerTrustsSuppliedStorefrontUrl(provider) &&
    hasProviderSuppliedStorefrontUrl
  ) {
    return parsed.protocol === "https:" && parsed.hostname ? parsed : null;
  }

  if (!parsed.hostname || !expectedShopDomain) {
    return null;
  }

  // A click redirect is security-sensitive: without a provider domain we
  // cannot prove a historical snapshot remains a product destination. Fail
  // closed instead of turning the route into a durable open redirect.
  const expectedHost =
    normalizeShopDomain(expectedShopDomain) || expectedShopDomain.toLowerCase();
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
 * THE PUBLIC STOREFRONT GATE.
 *
 * A product may be provider-`ACTIVE`, persisted `isAvailable: true`, curated
 * into SQRATCH, and STILL be unavailable from the merchant's storefront: a
 * product can be ACTIVE without being published to Shopify's Online Store.
 * `src/lib/shopify-products.ts` deliberately keeps a canonical fallback URL for
 * password-protected development stores, so URL shape alone cannot establish
 * publication; `isAvailable` cannot either, because lifecycle status is
 * orthogonal to publication.
 *
 * So the gate lives HERE, in the query predicate, alongside `isAvailable`. Both
 * conditions are required and neither substitutes for the other. A row failing
 * this predicate simply does not resolve, which produces the same generic 404 as
 * every other "cannot proceed" case: no redirect, and no attribution row minted
 * against a destination known to 404. The public lesson/shop list routes apply
 * the identical pair, so a hidden card is never clickable and a rendered card is
 * never denied.
 */
const PUBLICLY_CLICKABLE_CONNECTED_PRODUCT = {
  isAvailable: true,
  hasPublicStorefrontUrl: true,
} as const;

/**
 * Everything the canonical chain must yield for one click: the destination, the
 * connection that owns it, and the provider. Shared by every finder so no
 * surface can accidentally resolve a destination without also pinning its
 * connection.
 */
const CANONICAL_DESTINATION_SELECT = {
  id: true,
  productUrl: true,
  connectionId: true,
  provider: true,
  providerMetadata: true,
  connection: { select: { externalAccountId: true } },
} as const;

function hasProviderSuppliedStorefrontUrl(providerMetadata: unknown): boolean {
  if (!providerMetadata || typeof providerMetadata !== "object" || Array.isArray(providerMetadata)) {
    return false;
  }
  return (
    (providerMetadata as Record<string, unknown>).storefrontUrlSource === "PROVIDER"
  );
}

const DEFAULT_DEPS: CommerceClickDeps = {
  getAccess: getExperienceAccessContext,
  ensureSession: ensureViewerSession,
  async findCampaignLessonProduct({
    campaignLessonProductId,
    lessonId,
    experienceId,
    canAccessPrivate,
  }) {
    // Every containment check is in the query: the attachment must belong to
    // this Lesson, the Lesson to an active Course, and the Course to THIS
    // Experience. An id belonging to another lesson or Experience resolves to
    // null and yields the uniform 404.
    //
    // `isActive` is deliberately NOT filtered here: an inactive attachment must
    // stay visible to the shared authorization predicate, which denies it. A
    // query-level filter would make a revoked attachment indistinguishable from
    // a nonexistent one at the type level and invite a later "no scope means
    // global" regression.
    const attachment = await prisma.campaignLessonProduct.findFirst({
      where: {
        id: campaignLessonProductId,
        lessonId,
        lesson: {
          isActive: true,
          course: { experienceId, isActive: true },
        },
        brandCommerceProduct: {
          connectedProduct: PUBLICLY_CLICKABLE_CONNECTED_PRODUCT,
        },
      },
      select: {
        id: true,
        brandId: true,
        campaignId: true,
        isActive: true,
        lessonId: true,
        brandCommerceProductId: true,
        lesson: {
          select: {
            courseId: true,
            course: { select: { access: true } },
          },
        },
        brandCommerceProduct: {
          select: {
            connectedProduct: { select: CANONICAL_DESTINATION_SELECT },
          },
        },
      },
    });

    if (!attachment) {
      return null;
    }

    // Private courses stay private on this path too. A locked lesson is
    // reported through the same uniform 404 as a missing one.
    if (attachment.lesson.course.access !== "PUBLIC" && !canAccessPrivate) {
      return null;
    }

    const product = attachment.brandCommerceProduct.connectedProduct;

    return {
      id: attachment.id,
      productUrl: product.productUrl,
      brandId: attachment.brandId,
      courseId: attachment.lesson.courseId,
      lessonId: attachment.lessonId,
      campaignLessonProductId: attachment.id,
      scope: {
        campaignId: attachment.campaignId,
        isActive: attachment.isActive,
      },
      brandCommerceProductId: attachment.brandCommerceProductId,
      connectedProductId: product.id,
      commerceConnectionId: product.connectionId,
      provider: product.provider,
      connectionExternalAccountId: product.connection.externalAccountId,
      hasProviderSuppliedStorefrontUrl: hasProviderSuppliedStorefrontUrl(product.providerMetadata),
    };
  },
  async findBrandStorefrontProduct({
    brandCommerceProductId,
    experienceId,
    entryCampaignId,
  }) {
    const row = await prisma.brandCommerceProduct.findFirst({
      where: {
        id: brandCommerceProductId,
        isVisibleInShop: true,
        connectedProduct: PUBLICLY_CLICKABLE_CONNECTED_PRODUCT,
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
        id: true,
        brandId: true,
        connectedProduct: { select: CANONICAL_DESTINATION_SELECT },
      },
    });

    if (!row) {
      return null;
    }

    const product = row.connectedProduct;

    return {
      id: row.id,
      productUrl: product.productUrl,
      brandId: row.brandId,
      courseId: null,
      lessonId: null,
      campaignLessonProductId: null,
      // The generic brand storefront is unscoped BY CONSTRUCTION: it renders a
      // brand's visible catalog, not a campaign's selection, so there is no
      // campaign attachment to authorize against. Its authorization is the
      // `isVisibleInShop` + "this brand owns a campaign linked to THIS
      // Experience" predicate above.
      scope: null,
      brandCommerceProductId: row.id,
      connectedProductId: product.id,
      commerceConnectionId: product.connectionId,
      provider: product.provider,
      connectionExternalAccountId: product.connection.externalAccountId,
      hasProviderSuppliedStorefrontUrl: hasProviderSuppliedStorefrontUrl(product.providerMetadata),
    };
  },
  async findCampaignProduct({
    campaignAssignmentId,
    experienceId,
  }) {
    const assignment = await prisma.campaignCommerceProduct.findFirst({
      where: {
        id: campaignAssignmentId,
        isActive: true,
        campaign: {
          experiences: { some: { experienceId } },
        },
        brandCommerceProduct: {
          isCampaignEligible: true,
          connectedProduct: PUBLICLY_CLICKABLE_CONNECTED_PRODUCT,
        },
      },
      select: {
        id: true,
        campaignId: true,
        brandId: true,
        isActive: true,
        campaign: {
          select: {
            id: true,
            brandId: true,
          },
        },
        brandCommerceProductId: true,
        brandCommerceProduct: {
          select: {
            brandId: true,
            isCampaignEligible: true,
            connectedProduct: {
              select: {
                ...CANONICAL_DESTINATION_SELECT,
                brandId: true,
                isAvailable: true,
              },
            },
          },
        },
      },
    });

    if (
      !assignment ||
      !isCampaignAssignmentCatalogAuthorized({
        assignment,
        campaign: assignment.campaign,
        brandCommerceProduct: assignment.brandCommerceProduct,
      })
    ) {
      return null;
    }

    const product = assignment.brandCommerceProduct.connectedProduct;

    return {
      id: assignment.id,
      productUrl: product.productUrl,
      brandId: assignment.brandId,
      courseId: null,
      lessonId: null,
      campaignLessonProductId: null,
      scope: { campaignId: assignment.campaignId, isActive: true },
      brandCommerceProductId: assignment.brandCommerceProductId,
      connectedProductId: product.id,
      commerceConnectionId: product.connectionId,
      provider: product.provider,
      connectionExternalAccountId: product.connection.externalAccountId,
      hasProviderSuppliedStorefrontUrl: hasProviderSuppliedStorefrontUrl(product.providerMetadata),
    };
  },
  async recordAttribution(input) {
    // Nothing is resolved here anymore. `connectedProductId`,
    // `commerceConnectionId` and `provider` all arrive already pinned by the
    // finder query that authorized this click, so there is no second lookup
    // that could race the authorization, and no shop-domain guess that could
    // attach a click to the wrong same-brand connection.
    const qrCodeId = input.sessionId
      ? ((
          await prisma.userSession.findUnique({
            where: { id: input.sessionId },
            select: { qrCodeId: true },
          })
        )?.qrCodeId ?? null)
      : null;

    await prisma.commerceClickAttribution.create({
      data: {
        tokenHash: input.tokenHash,
        tokenPrefix: input.tokenPrefix,
        entryCampaignId: input.entryCampaignId,
        productCampaignId: input.productCampaignId,
        entryCampaignContextResolved: input.entryCampaignContextResolved,
        experienceId: input.experienceId,
        courseId: input.courseId,
        lessonId: input.lessonId,
        creatorProfileId: input.creatorProfileId,
        // The canonical identity columns. `lessonProductLinkId` and
        // `experienceProductLinkId` are deliberately NOT written: the columns
        // still exist until WS5's destructive migration drops them, and nothing
        // in this module may populate them again.
        campaignLessonProductId: input.campaignLessonProductId,
        brandCommerceProductId: input.brandCommerceProductId,
        connectedProductId: input.connectedProductId,
        commerceConnectionId: input.commerceConnectionId,
        // Written once, never updated. `?? null` keeps the fail-open mint path
        // safe: a caller that omits either value still records the click.
        surface: input.surface ?? null,
        attributedBrandId: input.attributedBrandId ?? null,
        destinationUrl: input.destinationUrl,
        destinationHost: input.destinationHost,
        provider: input.provider,
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
      options.surface.kind === "BRAND_STOREFRONT"
        ? await deps.findBrandStorefrontProduct({
            brandCommerceProductId: options.surface.brandCommerceProductId,
            experienceId: access.experience.id,
            entryCampaignId: visitorCampaign?.campaignId ?? null,
          })
        : options.surface.kind === "CAMPAIGN_PRODUCT"
          ? await deps.findCampaignProduct({
              campaignAssignmentId: options.surface.campaignAssignmentId,
              experienceId: access.experience.id,
            })
          : await deps.findCampaignLessonProduct({
              campaignLessonProductId: options.surface.campaignLessonProductId,
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

    // This is intentionally the same predicate as public lesson rendering.
    // In particular, a direct Experience entry may click any active scope
    // whose campaign remains linked to this Experience, but an inactive or
    // detached scope must not become clickable merely because it is direct.
    //
    // `link.scope` is non-null for every campaign-scoped surface (the lesson
    // attachment and the campaign assignment). It is null ONLY for the generic
    // brand-storefront surface, which has no campaign attachment to authorize
    // and whose authorization lives entirely in its own query predicate — that
    // is why the check is conditional here while the predicate itself no longer
    // accepts a null scope.
    const eligibleCampaignIds = access.experience.campaigns
      .filter((item) => item.campaign.brand !== null)
      .map((item) => item.campaignId);
    if (
      link.scope !== null &&
      !isPublicCampaignScopedContentVisible({
        scope: link.scope,
        entryContext: access.entryContext,
        resolvedCampaignId: visitorCampaign?.campaignId ?? null,
        eligibleCampaignIds,
      })
    ) {
      return genericNotFound();
    }

    const sessionId =
      access.viewer.sessionId ||
      (await deps.ensureSession({
        request,
        userId: access.viewer.userId,
        campaignId: entryCampaignContextResolved
          ? visitorCampaign!.campaignId
          : null,
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
    const productCampaignId = link.scope?.campaignId ?? null;

    const destination = validateDestination(
      link.productUrl,
      link.connectionExternalAccountId,
      link.provider,
      link.hasProviderSuppliedStorefrontUrl,
    );

    if (!destination) {
      // Sanitized: internal ids only. The offending URL is never logged, and no
      // visitor identifier accompanies it.
      console.warn("[commerce/click] Rejected unsafe destination:", {
        surface: options.surface.kind,
        experienceId: access.experience.id,
        clickTargetId: link.id,
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
        entryCampaignId,
        productCampaignId,
        entryCampaignContextResolved,
        experienceId: access.experience.id,
        courseId: link.courseId,
        lessonId: link.lessonId,
        creatorProfileId: access.experience.creator.id,
        campaignLessonProductId: link.campaignLessonProductId,
        brandCommerceProductId: link.brandCommerceProductId,
        connectedProductId: link.connectedProductId,
        commerceConnectionId: link.commerceConnectionId,
        provider: link.provider,
        // The surface and resolved Brand are both snapshotted here. Neither
        // depends on a foreign key that a later deletion can rewrite or null.
        surface: options.surface.kind,
        attributedBrandId: brandId,
        destinationUrl: destination.toString(),
        destinationHost: destination.hostname,
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
        clickTargetId: link.id,
        brandId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }

    // The Shopify Theme App Extension observes this SQRATCH-namespaced query
    // parameter and persists it as a cart attribute. Only our namespaced key
    // is written; merchant referral parameters are left untouched.
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
