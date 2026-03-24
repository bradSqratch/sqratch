import { NextRequest, NextResponse } from "next/server";
import { getCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import { deleteStorageObjectByUrl } from "@/lib/storage-upload";

function normalizeVideoSource(value: unknown) {
  const normalized = String(value || "YOUTUBE")
    .trim()
    .toUpperCase();

  return normalized === "UPLOAD" ? "UPLOAD" : "YOUTUBE";
}

export async function GET(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const courseId = request.nextUrl.searchParams.get("courseId");

    if (!courseId) {
      return NextResponse.json(
        { error: "courseId is required." },
        { status: 400 },
      );
    }

    const course = await prisma.course.findFirst({
      where: {
        id: courseId,
        experience: {
          creator: {
            userId: creator.userId,
          },
        },
      },
      select: {
        id: true,
        title: true,
        access: true,
        experience: {
          select: {
            id: true,
            title: true,
            slug: true,
          },
        },
      },
    });

    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }

    const lessons = await prisma.lesson.findMany({
      where: {
        courseId: course.id,
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        description: true,
        sortOrder: true,
        videoSource: true,
        youtubeUrl: true,
        videoUploadUrl: true,
        productLinks: {
          orderBy: {
            createdAt: "desc",
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
        },
      },
    });

    return NextResponse.json({
      data: {
        course,
        lessons: lessons.map((lesson) => ({
          id: lesson.id,
          title: lesson.title,
          description: lesson.description,
          sortOrder: lesson.sortOrder,
          videoSource: lesson.videoSource,
          youtubeUrl: lesson.youtubeUrl,
          videoAssetUrl: lesson.videoUploadUrl,
          productLinks: lesson.productLinks,
        })),
      },
    });
  } catch (error) {
    console.error("[creator/lessons][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load lessons." },
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
    const courseId = String(body?.courseId || "").trim();
    const title = String(body?.title || "").trim();
    const description = String(body?.description || "").trim();
    const sortOrder = Number(body?.sortOrder || 0);
    const videoSource = normalizeVideoSource(body?.videoSource);
    const youtubeUrl = String(body?.youtubeUrl || "").trim();
    const videoAssetUrl = String(body?.videoAssetUrl || "").trim();

    if (!courseId || !title) {
      return NextResponse.json(
        { error: "courseId and title are required." },
        { status: 400 },
      );
    }

    if (videoSource === "YOUTUBE" && !youtubeUrl) {
      return NextResponse.json(
        { error: "youtubeUrl is required for YouTube lessons." },
        { status: 400 },
      );
    }

    if (videoSource === "UPLOAD" && !videoAssetUrl) {
      return NextResponse.json(
        { error: "videoAssetUrl is required for uploaded lessons." },
        { status: 400 },
      );
    }

    const course = await prisma.course.findFirst({
      where: {
        id: courseId,
        experience: {
          creator: {
            userId: creator.userId,
          },
        },
      },
      select: { id: true },
    });

    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }

    const lesson = await prisma.lesson.create({
      data: {
        courseId: course.id,
        title,
        description: description || null,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
        videoSource,
        youtubeUrl: videoSource === "YOUTUBE" ? youtubeUrl : null,
        videoUploadUrl: videoSource === "UPLOAD" ? videoAssetUrl : null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        sortOrder: true,
        videoSource: true,
        youtubeUrl: true,
        videoUploadUrl: true,
      },
    });

    return NextResponse.json(
      {
        data: {
          ...lesson,
          videoAssetUrl: lesson.videoUploadUrl,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    console.error("[creator/lessons][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create lesson." },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const id = String(body?.id || "").trim();
    const title = String(body?.title || "").trim();
    const description = String(body?.description || "").trim();
    const sortOrder = Number(body?.sortOrder || 0);
    const videoSource = normalizeVideoSource(body?.videoSource);
    const youtubeUrl = String(body?.youtubeUrl || "").trim();
    const videoAssetUrl = String(body?.videoAssetUrl || "").trim();

    if (!id || !title) {
      return NextResponse.json(
        { error: "Lesson id and title are required." },
        { status: 400 },
      );
    }

    if (videoSource === "YOUTUBE" && !youtubeUrl) {
      return NextResponse.json(
        { error: "youtubeUrl is required for YouTube lessons." },
        { status: 400 },
      );
    }

    if (videoSource === "UPLOAD" && !videoAssetUrl) {
      return NextResponse.json(
        { error: "videoAssetUrl is required for uploaded lessons." },
        { status: 400 },
      );
    }

    const existing = await prisma.lesson.findFirst({
      where: {
        id,
        course: {
          experience: {
            creator: {
              userId: creator.userId,
            },
          },
        },
      },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }

    const lesson = await prisma.lesson.update({
      where: { id: existing.id },
      data: {
        title,
        description: description || null,
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
        videoSource,
        youtubeUrl: videoSource === "YOUTUBE" ? youtubeUrl : null,
        videoUploadUrl: videoSource === "UPLOAD" ? videoAssetUrl : null,
      },
      select: {
        id: true,
        title: true,
        description: true,
        sortOrder: true,
        videoSource: true,
        youtubeUrl: true,
        videoUploadUrl: true,
      },
    });

    return NextResponse.json({
      data: {
        ...lesson,
        videoAssetUrl: lesson.videoUploadUrl,
      },
    });
  } catch (error) {
    console.error("[creator/lessons][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update lesson." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const body = await request.json();
    const id = String(body?.id || "").trim();

    if (!id) {
      return NextResponse.json(
        { error: "Lesson id is required." },
        { status: 400 },
      );
    }

    const lesson = await prisma.lesson.findFirst({
      where: {
        id,
        course: {
          experience: {
            creator: {
              userId: creator.userId,
            },
          },
        },
      },
      select: {
        id: true,
        videoUploadUrl: true,
      },
    });

    if (!lesson) {
      return NextResponse.json({ error: "Lesson not found." }, { status: 404 });
    }

    await prisma.lesson.delete({ where: { id: lesson.id } });

    if (lesson.videoUploadUrl) {
      await deleteStorageObjectByUrl(lesson.videoUploadUrl);
    }

    return NextResponse.json({ data: { id: lesson.id } });
  } catch (error) {
    console.error("[creator/lessons][DELETE] Error:", error);
    return NextResponse.json(
      { error: "Failed to delete lesson." },
      { status: 500 },
    );
  }
}
