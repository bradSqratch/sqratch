import { NextRequest, NextResponse } from "next/server";
import {
  getCreatorContext,
  isPublishedStatus,
  normalizeExperienceStatus,
  normalizeVideoSource,
  slugifyValue,
} from "@/lib/creator-auth";
import { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

export async function GET() {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const experiences = await prisma.experience.findMany({
      where: {
        creatorId: creator.creatorProfile.id,
      },
      orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
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
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            courses: true,
            posts: true,
            questions: true,
          },
        },
      },
    });

    return NextResponse.json({
      data: experiences.map((experience) => ({
        id: experience.id,
        title: experience.title,
        slug: experience.slug,
        description: experience.description,
        coverImageUrl: experience.coverImageUrl,
        status: experience.isActive ? "PUBLISHED" : "DRAFT",
        createdAt: experience.createdAt,
        updatedAt: experience.updatedAt,
        counts: {
          courses: experience._count.courses,
          posts: experience._count.posts,
          questions: experience._count.questions,
        },
      })),
    });
  } catch (error) {
    console.error("[creator/experiences][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load creator experiences." },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
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
    const slug = slugifyValue(rawSlug || title);

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

    const existing = await prisma.experience.findUnique({
      where: { slug },
      select: { id: true },
    });

    if (existing) {
      return NextResponse.json(
        { error: "An experience with this slug already exists." },
        { status: 409 },
      );
    }

    const experience = await prisma.experience.create({
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
        creatorId: creator.creatorProfile.id,
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
        createdAt: true,
        updatedAt: true,
      },
    });

    return NextResponse.json(
      {
        data: {
          ...experience,
          status: experience.isActive ? "PUBLISHED" : "DRAFT",
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2002") {
        return NextResponse.json(
          { error: "An experience with this slug already exists." },
          { status: 409 },
        );
      }
    }

    console.error("[creator/experiences][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create experience." },
      { status: 500 },
    );
  }
}
