import { NextRequest, NextResponse } from "next/server";
import {
  getCreatorContext,
  getOwnedExperienceForCreator,
  isPublishedStatus,
  normalizeExperienceStatus,
  slugifyValue,
} from "@/lib/creator-auth";
import prisma from "@/lib/prisma";

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const { id } = await context.params;
    const experience = await getOwnedExperienceForCreator(id, creator.userId);

    if (!experience) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    return NextResponse.json({
      data: {
        id: experience.id,
        title: experience.title,
        slug: experience.slug,
        description: experience.description,
        coverImageUrl: experience.coverImageUrl,
        status: experience.isActive ? "PUBLISHED" : "DRAFT",
      },
    });
  } catch (error) {
    console.error("[creator/experiences/[id]][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load experience." },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const { id } = await context.params;
    const existing = await getOwnedExperienceForCreator(id, creator.userId);

    if (!existing) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const body = await request.json();
    const title = String(body?.title || "").trim();
    const rawSlug = String(body?.slug || "").trim();
    const description = String(body?.description || "").trim();
    const coverImageUrl = String(body?.coverImageUrl || "").trim();
    const status = normalizeExperienceStatus(body?.status);
    const slug = slugifyValue(rawSlug || title || existing.slug);

    if (!title || !slug) {
      return NextResponse.json(
        { error: "Title and slug are required." },
        { status: 400 },
      );
    }

    const conflicting = await prisma.experience.findFirst({
      where: {
        slug,
        id: {
          not: existing.id,
        },
      },
      select: { id: true },
    });

    if (conflicting) {
      return NextResponse.json(
        { error: "An experience with this slug already exists." },
        { status: 409 },
      );
    }

    const experience = await prisma.experience.update({
      where: { id: existing.id },
      data: {
        title,
        slug,
        description: description || null,
        coverImageUrl: coverImageUrl || null,
        isActive: isPublishedStatus(status),
      },
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        coverImageUrl: true,
        isActive: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({
      data: {
        ...experience,
        status: experience.isActive ? "PUBLISHED" : "DRAFT",
      },
    });
  } catch (error) {
    console.error("[creator/experiences/[id]][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update experience." },
      { status: 500 },
    );
  }
}
