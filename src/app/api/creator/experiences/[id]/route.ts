import { NextRequest, NextResponse } from "next/server";
import {
  getCreatorContext,
  getOwnedExperienceForCreator,
  isPublishedStatus,
  normalizeExperienceStatus,
  normalizeVideoSource,
  slugifyValue,
} from "@/lib/creator-auth";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";
import { deleteStorageObjectByUrl } from "@/lib/storage-upload";

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
        whyVideoSource: experience.whyVideoSource,
        whyYoutubeUrl: experience.whyYoutubeUrl,
        whyVideoUploadUrl: experience.whyVideoUploadUrl,
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
    const whyVideoSource = normalizeVideoSource(body?.whyVideoSource);
    const whyYoutubeUrl = String(body?.whyYoutubeUrl || "").trim();
    const whyVideoAssetUrl = String(body?.whyVideoAssetUrl || "").trim();
    const status = normalizeExperienceStatus(body?.status);
    const slug = slugifyValue(rawSlug || title || existing.slug);

    if (!title || !slug) {
      return NextResponse.json(
        { error: "Title and slug are required." },
        { status: 400 },
      );
    }

    if (whyVideoSource === "YOUTUBE" && !whyYoutubeUrl) {
      return NextResponse.json(
        { error: "whyYoutubeUrl is required for YouTube WHY videos." },
        { status: 400 },
      );
    }

    if (whyVideoSource === "UPLOAD" && !whyVideoAssetUrl) {
      return NextResponse.json(
        { error: "whyVideoAssetUrl is required for uploaded WHY videos." },
        { status: 400 },
      );
    }

    const conflicting = await prisma.experience.findFirst({
      where: {
        slug,
        id: { not: existing.id },
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
        whyVideoSource,
        whyYoutubeUrl: whyVideoSource === "YOUTUBE" ? whyYoutubeUrl : null,
        whyVideoUploadUrl:
          whyVideoSource === "UPLOAD" ? whyVideoAssetUrl : null,
        isActive: isPublishedStatus(status),
      },
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        coverImageUrl: true,
        whyVideoSource: true,
        whyYoutubeUrl: true,
        whyVideoUploadUrl: true,
        isActive: true,
        updatedAt: true,
      },
    });

    if (
      existing.coverImageUrl &&
      existing.coverImageUrl !== experience.coverImageUrl
    ) {
      await deleteStorageObjectByUrl(existing.coverImageUrl);
    }

    if (
      existing.whyVideoUploadUrl &&
      existing.whyVideoUploadUrl !== experience.whyVideoUploadUrl
    ) {
      await deleteStorageObjectByUrl(existing.whyVideoUploadUrl);
    }

    return NextResponse.json({
      data: {
        ...experience,
        status: experience.isActive ? "PUBLISHED" : "DRAFT",
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return NextResponse.json(
          { error: "An experience with this slug already exists." },
          { status: 409 },
        );
      }
    }

    console.error("[creator/experiences/[id]][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update experience." },
      { status: 500 },
    );
  }
}
