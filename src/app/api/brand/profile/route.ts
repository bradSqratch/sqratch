import { NextRequest, NextResponse } from "next/server";
import { getBrandAdminContext, slugifyValue } from "@/lib/brand-auth";
import { deleteStorageObjectByUrl } from "@/lib/storage-upload";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const context = await getBrandAdminContext({ allowWithoutBrand: true });

    if (!context) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    if (!context.membership?.brand) {
      return NextResponse.json({ data: null });
    }

    const brand = context.membership.brand;

    return NextResponse.json({
      data: {
        id: brand.id,
        name: brand.name,
        slug: brand.slug,
        description: brand.bio,
        websiteUrl: brand.websiteUrl,
        logoUrl: brand.logoUrl,
        coverImageUrl: brand.coverImageUrl,
        shopifyShopDomain: brand.shopifyShopDomain,
        shopifyInstalledAt: brand.shopifyInstalledAt,
        shopifyLastProductSyncAt: brand.shopifyLastProductSyncAt,
      },
    });
  } catch (error) {
    console.error("[brand/profile][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load brand profile." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const context = await getBrandAdminContext({ allowWithoutBrand: true });

    if (!context) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    if (context.membership?.brand) {
      return NextResponse.json(
        { error: "Brand profile already exists for this account." },
        { status: 409 },
      );
    }

    const body = await request.json();
    const name = String(body?.name || "").trim();
    const slug = slugifyValue(String(body?.slug || "").trim() || name);
    const websiteUrl = String(body?.websiteUrl || "").trim();
    const description = String(body?.description || "").trim();
    const logoUrl = String(body?.logoUrl || "").trim();
    const coverImageUrl = String(body?.coverImageUrl || "").trim();

    if (!name || !slug) {
      return NextResponse.json(
        { error: "Brand name and slug are required." },
        { status: 400 },
      );
    }

    const existing = await prisma.brand.findFirst({
      where: {
        OR: [{ name }, { slug }],
      },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: "Brand name or slug is already in use." },
        { status: 409 },
      );
    }

    const brand = await prisma.$transaction(async (tx) => {
      const created = await tx.brand.create({
        data: {
          name,
          slug,
          bio: description || null,
          websiteUrl: websiteUrl || null,
          logoUrl: logoUrl || null,
          coverImageUrl: coverImageUrl || null,
        },
      });

      await tx.brandMember.create({
        data: {
          brandId: created.id,
          userId: context.userId,
          role: "ADMIN",
        },
      });

      return created;
    });

    return NextResponse.json({ data: brand }, { status: 201 });
  } catch (error) {
    console.error("[brand/profile][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create brand profile." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const context = await getBrandAdminContext();

    if (!context?.membership?.brand) {
      return NextResponse.json(
        { error: "Brand admin access required." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const name = String(body?.name || "").trim();
    const slug = slugifyValue(
      String(body?.slug || "").trim() || name || context.membership.brand.slug,
    );
    const websiteUrl = String(body?.websiteUrl || "").trim();
    const description = String(body?.description || "").trim();
    const logoUrl = String(body?.logoUrl || "").trim();
    const coverImageUrl = String(body?.coverImageUrl || "").trim();

    if (!name || !slug) {
      return NextResponse.json(
        { error: "Brand name and slug are required." },
        { status: 400 },
      );
    }

    const conflicting = await prisma.brand.findFirst({
      where: {
        id: {
          not: context.membership.brand.id,
        },
        OR: [{ name }, { slug }],
      },
      select: { id: true },
    });

    if (conflicting) {
      return NextResponse.json(
        { error: "Brand name or slug is already in use." },
        { status: 409 },
      );
    }

    const brand = await prisma.brand.update({
      where: { id: context.membership.brand.id },
      data: {
        name,
        slug,
        bio: description || null,
        websiteUrl: websiteUrl || null,
        logoUrl: logoUrl || null,
        coverImageUrl: coverImageUrl || null,
      },
    });

    await Promise.allSettled([
      logoUrl !== (context.membership.brand.logoUrl || "") &&
      context.membership.brand.logoUrl
        ? deleteStorageObjectByUrl(context.membership.brand.logoUrl)
        : Promise.resolve(false),
      coverImageUrl !== (context.membership.brand.coverImageUrl || "") &&
      context.membership.brand.coverImageUrl
        ? deleteStorageObjectByUrl(context.membership.brand.coverImageUrl)
        : Promise.resolve(false),
    ]);

    return NextResponse.json({ data: brand });
  } catch (error) {
    console.error("[brand/profile][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update brand profile." },
      { status: 500 },
    );
  }
}
