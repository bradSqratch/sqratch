import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  getLessonProductManagementContext,
  parseLessonProductInput,
} from "@/lib/lesson-product-links";

export async function PATCH(
  request: NextRequest,
  context: {
    params: Promise<{ lessonId: string; productLinkId: string }>;
  },
) {
  try {
    const { lessonId, productLinkId } = await context.params;
    const access = await getLessonProductManagementContext(lessonId);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status },
      );
    }

    const existing = await prisma.lessonProductLink.findFirst({
      where: {
        id: productLinkId,
        lessonId,
      },
      select: {
        id: true,
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Lesson product link not found." },
        { status: 404 },
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

    const duplicate = await prisma.lessonProductLink.findFirst({
      where: {
        lessonId,
        productUrl: parsed.value.productUrl,
        NOT: {
          id: productLinkId,
        },
      },
      select: {
        id: true,
      },
    });

    if (duplicate) {
      return NextResponse.json(
        { error: "This product is already linked to the lesson." },
        { status: 409 },
      );
    }

    const updated = await prisma.lessonProductLink.update({
      where: {
        id: productLinkId,
      },
      data: {
        productUrl: parsed.value.productUrl,
        title: parsed.value.title,
        imageUrl: parsed.value.imageUrl,
        priceText: parsed.value.priceText,
        currency: parsed.value.currency,
        brandId: parsed.value.brandId,
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
        createdAt: true,
      },
    });

    return NextResponse.json({ data: updated });
  } catch (error) {
    console.error(
      "[creator/lessons/[lessonId]/products/[productLinkId]][PATCH] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to update lesson product link." },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  context: {
    params: Promise<{ lessonId: string; productLinkId: string }>;
  },
) {
  try {
    const { lessonId, productLinkId } = await context.params;
    const access = await getLessonProductManagementContext(lessonId);

    if (!access.ok) {
      return NextResponse.json(
        { error: access.error },
        { status: access.status },
      );
    }

    const existing = await prisma.lessonProductLink.findFirst({
      where: {
        id: productLinkId,
        lessonId,
      },
      select: {
        id: true,
      },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Lesson product link not found." },
        { status: 404 },
      );
    }

    await prisma.lessonProductLink.delete({
      where: {
        id: productLinkId,
      },
    });

    return NextResponse.json({
      data: {
        id: productLinkId,
      },
    });
  } catch (error) {
    console.error(
      "[creator/lessons/[lessonId]/products/[productLinkId]][DELETE] Error:",
      error,
    );
    return NextResponse.json(
      { error: "Failed to remove lesson product link." },
      { status: 500 },
    );
  }
}
