import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getLessonProductManagementContext,
  loadLessonProductLinks,
  parseLessonProductInput,
  resolveSourceShopDomainForBrand,
} from "@/lib/lesson-product-links";
import { isProductLinkCurrent } from "@/lib/product-link-compatibility";

export async function GET(
  _request: NextRequest,
  context: {
    params: Promise<{ lessonId: string }>;
  },
) {
  try {
    const { lessonId } = await context.params;
    const access = await getLessonProductManagementContext(lessonId);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status },
      );
    }

    const items = await loadLessonProductLinks(lessonId);
    const domainByBrandId = new Map(
      access.data.candidateBrands.map((brand) => [
        brand.id,
        brand.shopifyShopDomain,
      ]),
    );

    return NextResponse.json({
      data: {
        brand: access.data.primaryBrand
          ? {
              id: access.data.primaryBrand.id,
              name: access.data.primaryBrand.name,
              slug: access.data.primaryBrand.slug,
            }
          : null,
        candidateBrandCount: access.data.candidateBrands.length,
        // Stale/incompatible links are never hidden here — they're
        // annotated so the creator can see they need relinking rather than
        // silently treating them as current.
        items: items.map((item) => ({
          ...item,
          needsRelinking: !isProductLinkCurrent(item, domainByBrandId),
        })),
      },
    });
  } catch (error) {
    console.error("[creator/lessons/[lessonId]/products][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load lesson products." },
      { status: 500 },
    );
  }
}

export async function POST(
  request: NextRequest,
  context: {
    params: Promise<{ lessonId: string }>;
  },
) {
  try {
    const { lessonId } = await context.params;
    const access = await getLessonProductManagementContext(lessonId);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status },
      );
    }

    const body = await request.json().catch(() => null);
    const parsed = parseLessonProductInput(body, {
      defaultBrandId: access.data.primaryBrand?.id || null,
      allowedBrandIds: access.data.candidateBrands.map((brand) => brand.id),
    });

    if (!parsed.ok) {
      return NextResponse.json(
        { error: parsed.error },
        { status: 400 },
      );
    }

    const existing = await prisma.lessonProductLink.findFirst({
      where: {
        lessonId,
        productUrl: parsed.value.productUrl,
      },
      select: {
        id: true,
        lessonId: true,
        productUrl: true,
        title: true,
        imageUrl: true,
        priceText: true,
        currency: true,
        brandId: true,
        sourceShopDomain: true,
        createdAt: true,
      },
    });

    if (existing) {
      return NextResponse.json({ data: existing });
    }

    // Server-derived from the resolved brand's current connection state —
    // never trusts a client-provided source domain.
    const sourceShopDomain = resolveSourceShopDomainForBrand(
      access.data.candidateBrands,
      parsed.value.brandId,
    );

    const created = await prisma.lessonProductLink.create({
      data: {
        lessonId,
        productUrl: parsed.value.productUrl,
        title: parsed.value.title,
        imageUrl: parsed.value.imageUrl,
        priceText: parsed.value.priceText,
        currency: parsed.value.currency,
        brandId: parsed.value.brandId,
        sourceShopDomain,
      },
      select: {
        id: true,
        lessonId: true,
        productUrl: true,
        title: true,
        imageUrl: true,
        priceText: true,
        currency: true,
        brandId: true,
        sourceShopDomain: true,
        createdAt: true,
      },
    });

    return NextResponse.json({ data: created }, { status: 201 });
  } catch (error) {
    console.error("[creator/lessons/[lessonId]/products][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create lesson product link." },
      { status: 500 },
    );
  }
}
