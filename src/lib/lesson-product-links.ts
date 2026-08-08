import type { Prisma, Role } from "@prisma/client";
import { getServerSession } from "next-auth";
import { authOptions } from "@/app/api/auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { buildEligibleCampaignContexts, type CampaignContextCandidate } from "@/lib/campaign-context";
import type { LessonCampaignContext } from "@/lib/commerce/campaign-product-curation";

type LessonProductActor = {
  userId: string;
  role: Extract<Role, "ADMIN" | "CREATOR">;
};

/**
 * Includes every field `isLegacyShopifyBrandConnectionUsable` (and, via it,
 * `mapLegacyBrandToConnectionSummary`) needs to decide connectivity through
 * the provider-neutral commerce connection service — NOT
 * `shopifyAdminAccessTokenEncrypted`, which that service deliberately never
 * needs (see `src/lib/commerce/connection-service.ts`'s file header for why
 * `status` alone reproduces the old three-part check). None of these fields
 * are ever serialized directly — every consumer only ever projects
 * `{ id, name, slug }` out of a `CandidateBrand`.
 */
export type CandidateBrand = {
  id: string;
  name: string;
  slug: string;
  shopifyShopDomain: string | null;
  shopifyConnectionStatus: "DISCONNECTED" | "CONNECTED" | "UNINSTALLED" | "REQUIRES_RECONNECT";
  shopifyInstalledAt: Date | null;
  shopifyUninstalledAt: Date | null;
  shopifyLastProductSyncAt: Date | null;
  shopifyGrantedScopes: string | null;
};

export type LessonProductManagementContext = {
  actor: LessonProductActor;
  lesson: {
    id: string;
    title: string;
    course: {
      id: string;
      title: string;
      experience: {
        id: string;
        title: string;
        slug: string;
        creatorUserId: string;
      };
    };
  };
  /**
   * Every brand reachable from this Lesson's Experience through a linked
   * campaign, de-duplicated. This stays a LIST on purpose: it is what the
   * campaign selector needs. There is deliberately no `primaryBrand` — "the
   * first connected brand" was a guess that let a co-sponsoring brand capture
   * a shared Experience by writing an extreme
   * `CampaignExperience.sortOrder`.
   */
  candidateBrands: CandidateBrand[];
  /** Campaigns actually linked to this Lesson's Experience, in the persisted
   * campaign sort order. This is server-only context for curation; it is never
   * inferred from a client-supplied brand or provider id. */
  campaigns: LessonCampaignContext[];
  /**
   * The eligible (brand-owning) campaign contexts derived from `campaigns` via
   * the shared resolver, deterministically ordered. Replaces `primaryBrand` as
   * the thing callers resolve a brand from.
   */
  campaignContexts: CampaignContextCandidate[];
};

export async function getLessonProductManagementContext(
  lessonId: string,
): Promise<
  | { ok: false; status: number; error: string }
  | { ok: true; data: LessonProductManagementContext }
> {
  const session = await getServerSession(authOptions);
  const userId = session?.user?.id || null;
  const role = session?.user?.role || null;

  if (!userId) {
    return { ok: false, status: 401, error: "Unauthorized." };
  }

  if (role !== "CREATOR" && role !== "ADMIN") {
    return { ok: false, status: 403, error: "Creator or admin access required." };
  }

  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      title: true,
      course: {
        select: {
          id: true,
          title: true,
          experience: {
            select: {
              id: true,
              title: true,
              slug: true,
              creator: {
                select: {
                  userId: true,
                },
              },
              campaigns: {
                // `sortOrder` is brand-writable and not unique, so it alone
                // leaves ties undefined. The `campaignId` tiebreak matches the
                // code-level tiebreak in `buildEligibleCampaignContexts`.
                orderBy: [{ sortOrder: "asc" }, { campaignId: "asc" }],
                select: {
                  sortOrder: true,
                  campaign: {
                    select: {
                      id: true,
                      name: true,
                      brandId: true,
                      brand: {
                        select: {
                          id: true,
                          name: true,
                          slug: true,
                          shopifyShopDomain: true,
                          shopifyConnectionStatus: true,
                          shopifyInstalledAt: true,
                          shopifyUninstalledAt: true,
                          shopifyLastProductSyncAt: true,
                          shopifyGrantedScopes: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!lesson) {
    return { ok: false, status: 404, error: "Lesson not found." };
  }

  if (role === "CREATOR" && lesson.course.experience.creator.userId !== userId) {
    return { ok: false, status: 403, error: "Lesson access denied." };
  }

  const brandMap = new Map<string, CandidateBrand>();
  lesson.course.experience.campaigns.forEach((item) => {
    const brand = item.campaign.brand;

    if (brand && !brandMap.has(brand.id)) {
      brandMap.set(brand.id, brand);
    }
  });

  const candidateBrands = Array.from(brandMap.values());
  const campaigns = lesson.course.experience.campaigns.map((item) => ({
    id: item.campaign.id,
    name: item.campaign.name,
    brandId: item.campaign.brandId,
    brandName: item.campaign.brand?.name ?? null,
    sortOrder: item.sortOrder,
  }));

  const campaignContexts = buildEligibleCampaignContexts(
    campaigns.map((campaign) => ({
      campaignId: campaign.id,
      campaignName: campaign.name,
      sortOrder: campaign.sortOrder,
      brandId: campaign.brandId,
      brandName: campaign.brandName,
    })),
  );

  return {
    ok: true,
    data: {
      actor: {
        userId,
        role,
      },
      lesson: {
        id: lesson.id,
        title: lesson.title,
        course: {
          id: lesson.course.id,
          title: lesson.course.title,
          experience: {
            id: lesson.course.experience.id,
            title: lesson.course.experience.title,
            slug: lesson.course.experience.slug,
            creatorUserId: lesson.course.experience.creator.userId,
          },
        },
      },
      candidateBrands,
      campaigns,
      campaignContexts,
    },
  };
}


/**
 * The campaign-scoped identity of one canonical lesson product attachment.
 *
 * This is now keyed ENTIRELY on the `@@unique([campaignId, lessonId,
 * brandCommerceProductId])` tuple. `CampaignLessonProduct.legacyLessonProductLinkId`
 * is deliberately never read or written here anymore: the canonical attachment
 * IS the row, and there is no snapshot for it to point at. (The column itself
 * still exists in the schema and is removed by a later, separately-reviewed
 * destructive migration.)
 */
export type CampaignLessonProductScope = {
  campaignId: string;
  brandId: string;
  lessonId: string;
  brandCommerceProductId: string;
  /** Optional presentation order. Omitted leaves an existing row's order untouched. */
  displayOrder?: number;
};

export type CampaignLessonProductRow = {
  id: string;
  lessonId: string;
  displayOrder: number;
  createdAt: Date;
};

/**
 * Creates or reactivates the canonical attachment row for one
 * (campaign, lesson, brand product) tuple. Mirrors CampaignCommerceProduct's
 * reactivate-don't-duplicate lifecycle: the unique tuple index makes a second
 * active row structurally impossible, so a previously deactivated attachment is
 * revived rather than duplicated.
 *
 * `brandId` is part of both composite foreign keys
 * (`(campaignId, brandId) -> Campaign` and
 * `(brandCommerceProductId, brandId) -> BrandCommerceProduct`), so PostgreSQL
 * itself rejects a cross-brand attachment even if a caller bypasses the
 * authorization service. It must always come from the server-resolved campaign
 * context, never from client input.
 */
export async function upsertCampaignLessonProductScope(
  tx: Prisma.TransactionClient,
  scope: CampaignLessonProductScope,
): Promise<CampaignLessonProductRow> {
  return tx.campaignLessonProduct.upsert({
    where: {
      campaignId_lessonId_brandCommerceProductId: {
        campaignId: scope.campaignId,
        lessonId: scope.lessonId,
        brandCommerceProductId: scope.brandCommerceProductId,
      },
    },
    create: {
      brandId: scope.brandId,
      campaignId: scope.campaignId,
      lessonId: scope.lessonId,
      brandCommerceProductId: scope.brandCommerceProductId,
      isActive: true,
      ...(scope.displayOrder === undefined ? {} : { displayOrder: scope.displayOrder }),
    },
    update: {
      isActive: true,
      deactivatedAt: null,
      ...(scope.displayOrder === undefined ? {} : { displayOrder: scope.displayOrder }),
    },
    select: { id: true, lessonId: true, displayOrder: true, createdAt: true },
  });
}

/**
 * Deactivates ONE canonical attachment, addressed by its own id and always
 * scoped by `lessonId` in the same predicate.
 *
 * The row is kept (`isActive: false` + `deactivatedAt`) rather than deleted:
 * its campaign-scoped attribution history cannot be re-derived. Returns `false`
 * when nothing matched, which callers must translate into the SAME generic
 * "not found" response they use for an id that does not exist at all — a
 * lesson-scoped miss must never be distinguishable from a nonexistent id, or
 * the response leaks whether some other lesson owns that id.
 *
 * `updateMany` (not `update`) is deliberate: it lets the lesson scope live in
 * the WHERE clause, so there is no read-then-write window in which the row
 * could move out of scope.
 */
export async function deactivateCampaignLessonProduct(
  tx: Prisma.TransactionClient,
  options: {
    lessonId: string;
    campaignLessonProductId: string;
    now?: Date;
  },
): Promise<boolean> {
  const result = await tx.campaignLessonProduct.updateMany({
    where: {
      id: options.campaignLessonProductId,
      lessonId: options.lessonId,
      isActive: true,
    },
    data: {
      isActive: false,
      deactivatedAt: options.now ?? new Date(),
    },
  });

  return result.count > 0;
}
