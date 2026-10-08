import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getBrandManagementContext, getBrandContextFailure } from "@/lib/brand-auth";
import { getActiveCommerceConnection, isConnectionUsable } from "@/lib/commerce/connection-service";
import { getCommerce7AppConfig } from "@/lib/commerce/providers/commerce7";
import { Commerce7RewardsClient } from "@/lib/commerce/providers/commerce7-rewards-client";
import { COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT, commerce7ExclusiveSecurity, commerce7GrantableTag, frozenExclusiveAccess, RewardClaimError } from "@/lib/commerce7-reward-domain";
import { rewardErrorResponse } from "@/lib/commerce7-reward-http";
export const maxDuration = 30;
/** Bounded live reads per request; a product secured to more tags is refused rather than partially resolved. */
const MAX_TAGS = 10;
/**
 * Brand-only: the Customer Tags securing one synchronized exclusive-eligible product, each resolved live by UUID through the
 * public Tag read API (GET /v1/tag/customer/{id}). Read-only. The UUID is returned only as the selector's value; titles are for
 * display and never identify a tag in business logic. Only Manual Customer tags are selectable.
 */
export async function GET(request: NextRequest) {
  try {
    const context = await getBrandManagementContext();
    if (!context?.membership?.brand) { const failure = getBrandContextFailure(context); return NextResponse.json({ error: failure.error }, { status: failure.status }); }
    const brandId = context.membership.brand.id;
    const productId = request.nextUrl.searchParams.get("productId");
    const offerId = request.nextUrl.searchParams.get("offerId");
    if (!productId || productId.length > 100 || (offerId !== null && offerId.length > 100)) throw new RewardClaimError("INVALID_OFFER", "Choose a synchronized product.", 400);
    const connection = await getActiveCommerceConnection(brandId, "COMMERCE7");
    if (!connection || !isConnectionUsable(connection)) throw new RewardClaimError("CONNECTION_UNAVAILABLE", "Connect Commerce7 before configuring rewards.");
    const catalog = await prisma.connectedCommerceProduct.findMany({ where: { brandId, connectionId: connection.id, provider: "COMMERCE7", isAvailable: true }, select: { externalId: true, title: true, providerMetadata: true }, take: 500 });
    const product = catalog.find((row) => row.externalId === productId);
    const tagIds = product ? commerce7ExclusiveSecurity(product.providerMetadata)?.tagIds ?? null : null;
    if (!product || !tagIds) throw new RewardClaimError("INVALID_OFFER", "Choose a product secured to a Customer Tag in Commerce7, then sync products in SQRATCH.", 400);
    if (tagIds.length > MAX_TAGS) throw new RewardClaimError("INVALID_OFFER", `This product is secured to more than ${MAX_TAGS} Customer Tags. Choose a product with fewer tags.`, 400);
    if (!getCommerce7AppConfig()) throw new RewardClaimError("SETUP_INCOMPLETE", "Commerce7 rewards are not configured on the server. Contact SQRATCH support.");
    // The tag an existing offer already grants, so Edit can show it selected without the Brand payload carrying UUIDs.
    const offer = offerId ? await prisma.brandRewardOffer.findFirst({ where: { id: offerId, brandId, provider: "COMMERCE7", connectionId: connection.id }, select: { commerce7Config: true } }) : null;
    const frozenTag = offer ? frozenExclusiveAccess(offer.commerce7Config)?.tagId ?? null : null;
    const current = frozenTag && tagIds.includes(frozenTag) ? frozenTag : null;
    const client = new Commerce7RewardsClient(connection.externalAccountId);
    const tags = [];
    for (const id of tagIds) {
      const tag = await client.customerTag(id);
      const selectable = commerce7GrantableTag(tag, id);
      const shared = catalog.filter((row) => row.externalId !== productId && (commerce7ExclusiveSecurity(row.providerMetadata)?.tagIds ?? []).includes(id));
      tags.push({
        id, title: tag?.title ?? null, selectable, current: id === current,
        reason: !tag ? "NOT_FOUND" : selectable ? null : tag.type !== COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.tagType ? "NOT_MANUAL" : "NOT_CUSTOMER",
        sharedProductCount: shared.length, sharedProductTitles: shared.slice(0, 5).map((row) => row.title),
      });
    }
    return NextResponse.json({
      productTitle: product.title, tagCount: tagIds.length, multiTagAccessVerified: COMMERCE7_EXCLUSIVE_ACCESS_CONTRACT.multiTagAccessVerified,
      // Preselect only a single-tag product's one selectable tag (or an edited offer's current tag); several tags need an explicit choice.
      preselectedTagId: current ?? (tags.length === 1 && tags[0].selectable ? tags[0].id : null),
      tags,
    });
  } catch (error) { return rewardErrorResponse(error); }
}
