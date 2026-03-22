import { NextRequest, NextResponse } from "next/server";
import {
  getCreatorContext,
  isPublishedStatus,
  normalizeExperienceStatus,
  slugifyValue,
} from "@/lib/creator-auth";
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
    const status = normalizeExperienceStatus(body?.status);
    const slug = slugifyValue(rawSlug || title);

    if (!title || !slug) {
      return NextResponse.json(
        { error: "Title and slug are required." },
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
        isActive: isPublishedStatus(status),
        creatorId: creator.creatorProfile.id,
      },
      select: {
        id: true,
        title: true,
        slug: true,
        description: true,
        coverImageUrl: true,
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
    console.error("[creator/experiences][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create experience." },
      { status: 500 },
    );
  }
}
