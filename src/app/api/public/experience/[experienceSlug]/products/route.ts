import { NextRequest, NextResponse } from "next/server";
import { decryptSecret } from "@/lib/crypto";
import {
  createAnalyticsEvent,
  getExperienceAccessContext,
} from "@/lib/experience-access";
import prisma from "@/lib/prisma";
import { attachSessionCookie, ensureViewerSession } from "@/lib/session";
import { SHOPIFY_API_VERSION } from "@/lib/shopify";

type ShopifyProductImage = {
  src: string | null;
};

type ShopifyProductVariant = {
  id: number | string;
  price: string | null;
};

type ShopifyProduct = {
  id: number | string;
  title: string;
  handle: string;
  images?: ShopifyProductImage[];
  variants?: ShopifyProductVariant[];
};

type ShopifyProductsResponse = {
  products?: ShopifyProduct[];
};

function getProductHandle(productUrl: string) {
  try {
    const url = new URL(productUrl);
    const match = url.pathname.match(/\/products\/([^/?#]+)/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function formatPriceText(prices: number[]) {
  const numericPrices = prices.filter((price) => Number.isFinite(price));

  if (numericPrices.length === 0) {
    return null;
  }

  const minPrice = Math.min(...numericPrices);
  const maxPrice = Math.max(...numericPrices);
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  });

  if (minPrice === maxPrice) {
    return formatter.format(minPrice);
  }

  return `${formatter.format(minPrice)} - ${formatter.format(maxPrice)}`;
}

async function fetchProductByHandle(options: {
  shopDomain: string;
  encryptedToken: string;
  handle: string;
}) {
  const accessToken = decryptSecret(options.encryptedToken);
  const response = await fetch(
    `https://${options.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json?handle=${encodeURIComponent(options.handle)}&fields=id,title,handle,images,variants,status`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    return null;
  }

  const json = (await response.json().catch(() => null)) as
    | ShopifyProductsResponse
    | null;

  return json?.products?.[0] || null;
}

async function fetchCampaignProducts(options: {
  shopDomain: string;
  encryptedToken: string;
}) {
  const accessToken = decryptSecret(options.encryptedToken);
  const response = await fetch(
    `https://${options.shopDomain}/admin/api/${SHOPIFY_API_VERSION}/products.json?limit=12&fields=id,title,handle,images,variants,status`,
    {
      headers: {
        "X-Shopify-Access-Token": accessToken,
        "Content-Type": "application/json",
      },
      cache: "no-store",
    },
  );

  if (!response.ok) {
    return [];
  }

  const json = (await response.json().catch(() => null)) as
    | ShopifyProductsResponse
    | null;

  return json?.products || [];
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
          },
        })
      : [];

    const brandMap = new Map(brands.map((brand) => [brand.id, brand]));
    const primaryBrand = primaryCampaign?.campaign.brand?.id
      ? brandMap.get(primaryCampaign.campaign.brand.id) || null
      : null;

    const linkedProducts = await Promise.all(
      productLinks.map(async (link) => {
        const linkedBrand =
          (link.brandId ? brandMap.get(link.brandId) : null) || primaryBrand;
        const handle = getProductHandle(link.productUrl);
        const shopifyProduct =
          linkedBrand?.shopifyShopDomain &&
          linkedBrand.shopifyAdminAccessTokenEncrypted &&
          handle
            ? await fetchProductByHandle({
                shopDomain: linkedBrand.shopifyShopDomain,
                encryptedToken:
                  linkedBrand.shopifyAdminAccessTokenEncrypted,
                handle,
              })
            : null;

        if (shopifyProduct) {
          const prices = (shopifyProduct.variants || []).map((variant) =>
            Number(variant.price || 0),
          );

          return {
            id: link.id,
            productId: String(shopifyProduct.id),
            productLinkId: link.id,
            title: shopifyProduct.title,
            imageUrl: shopifyProduct.images?.[0]?.src || link.imageUrl || null,
            priceText: formatPriceText(prices) || link.priceText || null,
            productUrl: link.productUrl,
            brand: linkedBrand
              ? {
                  id: linkedBrand.id,
                  name: linkedBrand.name,
                  slug: linkedBrand.slug,
                }
              : null,
            source: "LINKED" as const,
          };
        }

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
          source: "LINKED" as const,
        };
      }),
    );

    let campaignProducts: Array<{
      id: string;
      productId: string;
      productLinkId: null;
      title: string;
      imageUrl: string | null;
      priceText: string | null;
      productUrl: string;
      brand: {
        id: string;
        name: string;
        slug: string;
      } | null;
      source: "CAMPAIGN";
    }> = [];

    if (
      linkedProducts.length === 0 &&
      primaryBrand?.shopifyShopDomain &&
      primaryBrand.shopifyAdminAccessTokenEncrypted
    ) {
      const products = await fetchCampaignProducts({
        shopDomain: primaryBrand.shopifyShopDomain,
        encryptedToken: primaryBrand.shopifyAdminAccessTokenEncrypted,
      });

      campaignProducts = products.map((product) => ({
        id: `campaign-${product.id}`,
        productId: String(product.id),
        productLinkId: null,
        title: product.title,
        imageUrl: product.images?.[0]?.src || null,
        priceText: formatPriceText(
          (product.variants || []).map((variant) => Number(variant.price || 0)),
        ),
        productUrl: `https://${primaryBrand.shopifyShopDomain}/products/${product.handle}`,
        brand: {
          id: primaryBrand.id,
          name: primaryBrand.name,
          slug: primaryBrand.slug,
        },
        source: "CAMPAIGN",
      }));
    }

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
