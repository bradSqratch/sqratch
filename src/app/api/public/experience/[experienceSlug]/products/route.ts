import { NextRequest, NextResponse } from "next/server";
import {
  createAnalyticsEvent,
  getExperienceAccessContext,
} from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";
import { fetchNormalizedShopifyProducts } from "@/lib/shopify-products";
import { isProductLinkCurrent } from "@/lib/product-link-compatibility";

type PublicShopProduct = {
  id: string;
  productId: string;
  productLinkId: string | null;
  title: string;
  imageUrl: string | null;
  priceText: string | null;
  productUrl: string;
  brand: {
    id: string;
    name: string;
    slug: string;
  } | null;
  source: "LINKED" | "CAMPAIGN";
};

type CampaignFallbackBrand = {
  id: string;
  name: string;
  slug: string;
  shopifyShopDomain: string | null;
  shopifyConnectionStatus: string;
};

function logCampaignFallbackIssue(options: {
  experienceSlug: string;
  experienceId: string;
  directProductCount: number;
  fallbackProductCount: number;
  primaryBrand: CampaignFallbackBrand | null;
  reason: string;
  tokenReason?: string;
}) {
  console.warn("[public/experience/products][GET] Campaign fallback skipped:", {
    experienceSlug: options.experienceSlug,
    experienceId: options.experienceId,
    directProductCount: options.directProductCount,
    fallbackProductCount: options.fallbackProductCount,
    primaryBrand: options.primaryBrand
      ? {
          id: options.primaryBrand.id,
          name: options.primaryBrand.name,
        }
      : null,
    shopifyConnectionStatus:
      options.primaryBrand?.shopifyConnectionStatus || null,
    reason: options.reason,
    tokenResultReason: options.tokenReason || null,
  });
}

function logPublicShopProductResult(options: {
  experienceSlug: string;
  experienceId: string;
  directProductCount: number;
  fallbackProductCount: number;
  primaryBrand: CampaignFallbackBrand | null;
}) {
  console.info("[public/experience/products][GET] Products loaded:", {
    experienceSlug: options.experienceSlug,
    experienceId: options.experienceId,
    directProductCount: options.directProductCount,
    fallbackProductCount: options.fallbackProductCount,
    primaryBrand: options.primaryBrand
      ? {
          id: options.primaryBrand.id,
          name: options.primaryBrand.name,
          shopifyConnectionStatus: options.primaryBrand.shopifyConnectionStatus,
        }
      : null,
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
) {
  try {
    const { experienceSlug } = await context.params;
    const access = await getExperienceAccessContext(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const primaryCampaign = access.experience.campaigns[0];
    const sessionId =
      access.viewer.sessionId ||
      (await ensureViewerSession({
        request,
        userId: access.viewer.userId,
        campaignId: primaryCampaign?.campaignId || null,
      }));

    const productLinks = await prisma.experienceProductLink.findMany({
      where: {
        experienceId: access.experience.id,
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        productUrl: true,
        title: true,
        imageUrl: true,
        priceText: true,
        currency: true,
        brandId: true,
        sourceShopDomain: true,
      },
    });

    const candidateBrandIds = new Set<string>();
    productLinks.forEach((link) => {
      if (link.brandId) {
        candidateBrandIds.add(link.brandId);
      }
    });
    access.experience.campaigns.forEach((campaignLink) => {
      if (campaignLink.campaign.brand?.id) {
        candidateBrandIds.add(campaignLink.campaign.brand.id);
      }
    });

    const brands = candidateBrandIds.size
      ? await prisma.brand.findMany({
          where: {
            id: {
              in: Array.from(candidateBrandIds),
            },
          },
          select: {
            id: true,
            name: true,
            slug: true,
            shopifyShopDomain: true,
            shopifyAdminAccessTokenEncrypted: true,
            shopifyConnectionStatus: true,
            shopifyCurrencyCode: true,
          },
        })
      : [];

    const brandMap = new Map(brands.map((brand) => [brand.id, brand]));
    const primaryBrand = primaryCampaign?.campaign.brand?.id
      ? brandMap.get(primaryCampaign.campaign.brand.id) || null
      : null;

    // A stored direct link is current only when its sourceShopDomain matches
    // its brand's current Shopify domain. Stale/unknown-source links are
    // treated as absent here (never deleted) so they don't suppress the
    // campaign-products fallback below.
    const domainByBrandId = new Map(
      brands.map((brand) => [brand.id, brand.shopifyShopDomain]),
    );
    const currentProductLinks = productLinks.filter((link) =>
      isProductLinkCurrent(link, domainByBrandId),
    );

    const linkedProducts: PublicShopProduct[] = currentProductLinks.map((link) => {
      const linkedBrand =
        (link.brandId ? brandMap.get(link.brandId) : null) || primaryBrand;

      return {
        id: link.id,
        productId: link.id,
        productLinkId: link.id,
        title: link.title || "Shop product",
        imageUrl: link.imageUrl,
        priceText: link.priceText,
        productUrl: link.productUrl,
        brand: linkedBrand
          ? {
              id: linkedBrand.id,
              name: linkedBrand.name,
              slug: linkedBrand.slug,
            }
          : null,
        source: "LINKED",
      };
    });

    let campaignProducts: PublicShopProduct[] = [];

    if (
      linkedProducts.length === 0 &&
      primaryBrand?.shopifyShopDomain &&
      primaryBrand.shopifyAdminAccessTokenEncrypted &&
      primaryBrand.shopifyConnectionStatus === "CONNECTED"
    ) {
      const products = await fetchNormalizedShopifyProducts({
        shopDomain: primaryBrand.shopifyShopDomain,
        brandId: primaryBrand.id,
        limit: 100,
        currency: primaryBrand.shopifyCurrencyCode || "USD",
      });

      if (products.ok) {
        campaignProducts = products.items.map((product) => ({
          id: `campaign-${product.id}`,
          productId: product.id,
          productLinkId: null,
          title: product.title,
          imageUrl: product.imageUrl,
          priceText: product.priceText,
          productUrl: product.productUrl,
          brand: {
            id: primaryBrand.id,
            name: primaryBrand.name,
            slug: primaryBrand.slug,
          },
          source: "CAMPAIGN",
        }));
      } else {
        logCampaignFallbackIssue({
          experienceSlug,
          experienceId: access.experience.id,
          directProductCount: linkedProducts.length,
          fallbackProductCount: campaignProducts.length,
          primaryBrand,
          reason: products.error,
          tokenReason: products.tokenReason,
        });
      }
    } else if (linkedProducts.length === 0) {
      logCampaignFallbackIssue({
        experienceSlug,
        experienceId: access.experience.id,
        directProductCount: linkedProducts.length,
        fallbackProductCount: campaignProducts.length,
        primaryBrand,
        reason: primaryBrand?.shopifyShopDomain
          ? "Primary brand Shopify connection is not connected."
          : "Primary brand Shopify shop domain is missing.",
      });
    }

    logPublicShopProductResult({
      experienceSlug,
      experienceId: access.experience.id,
      directProductCount: linkedProducts.length,
      fallbackProductCount: campaignProducts.length,
      primaryBrand,
    });

    const response = NextResponse.json({
      data: {
        experience: {
          id: access.experience.id,
          slug: access.experience.slug,
          title: access.experience.title,
        },
        campaign: primaryCampaign
          ? {
              id: primaryCampaign.campaign.id,
              name: primaryCampaign.campaign.name,
              brand: primaryCampaign.campaign.brand,
            }
          : null,
        products: linkedProducts.length > 0 ? linkedProducts : campaignProducts,
      },
    });

    attachSessionCookie(response, sessionId);
    return response;
  } catch (error) {
    console.error("[public/experience/products][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load shop products." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ experienceSlug: string }> },
) {
  try {
    const { experienceSlug } = await context.params;
    const access = await getExperienceAccessContext(experienceSlug, request);

    if (!access) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const body = await request.json().catch(() => null);
    const productId = String(body?.productId || "").trim();
    const productLinkId = String(body?.productLinkId || "").trim() || null;
    const productUrl = String(body?.productUrl || "").trim();

    if (!productId || !productUrl) {
      return NextResponse.json(
        { error: "productId and productUrl are required." },
        { status: 400 },
      );
    }

    const primaryCampaign = access.experience.campaigns[0];
    const sessionId =
      access.viewer.sessionId ||
      (await ensureViewerSession({
        request,
        userId: access.viewer.userId,
        campaignId: primaryCampaign?.campaignId || null,
      }));

    const viewerSession = await prisma.userSession.findUnique({
      where: { id: sessionId },
      select: {
        qrCodeId: true,
        qrCode: {
          select: {
            batchId: true,
          },
        },
      },
    });

    await createAnalyticsEvent({
      request,
      name: "shop_click",
      brandId: primaryCampaign?.campaign.brand?.id || null,
      campaignId: primaryCampaign?.campaignId || null,
      qrCodeId: viewerSession?.qrCodeId || null,
      experienceId: access.experience.id,
      userId: access.viewer.userId,
      sessionId,
      pagePath: `/x/${access.experience.slug}/shop`,
      data: {
        productId,
        productLinkId,
        productUrl,
        batchId: viewerSession?.qrCode?.batchId || null,
      },
    });

    const response = NextResponse.json({ ok: true });
    attachSessionCookie(response, sessionId);
    return response;
  } catch (error) {
    console.error("[public/experience/products][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to track shop click." },
      { status: 500 },
    );
  }
}
