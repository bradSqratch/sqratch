import { NextRequest, NextResponse } from "next/server";
import { getCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";

export async function GET(request: NextRequest) {
  try {
    const creator = await getCreatorContext();

    if (!creator) {
      return NextResponse.json(
        { error: "Creator access required." },
        { status: 403 },
      );
    }

    const experienceId = request.nextUrl.searchParams.get("experienceId");
    const courseId = request.nextUrl.searchParams.get("courseId");

    if (courseId) {
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
          description: true,
          access: true,
          sortOrder: true,
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

      return NextResponse.json({ data: course });
    }

    if (!experienceId) {
      return NextResponse.json(
        { error: "experienceId is required." },
        { status: 400 },
      );
    }

    const experience = await prisma.experience.findFirst({
      where: {
        id: experienceId,
        creator: {
          userId: creator.userId,
        },
      },
      select: {
        id: true,
        title: true,
        slug: true,
      },
    });

    if (!experience) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const courses = await prisma.course.findMany({
      where: {
        experienceId: experience.id,
      },
      orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        title: true,
        description: true,
        access: true,
        sortOrder: true,
        lessons: {
          where: { isActive: true },
          orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
          select: {
            id: true,
            title: true,
            description: true,
            videoSource: true,
          },
        },
      },
    });

    return NextResponse.json({
      data: {
        experience,
        courses,
      },
    });
  } catch (error) {
    console.error("[creator/courses][GET] Error:", error);
    return NextResponse.json(
      { error: "Failed to load creator courses." },
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
    const experienceId = String(body?.experienceId || "").trim();
    const title = String(body?.title || "").trim();
    const description = String(body?.description || "").trim();
    const access = String(body?.access || "PUBLIC").trim().toUpperCase();
    const sortOrder = Number(body?.sortOrder || 0);

    if (!experienceId || !title) {
      return NextResponse.json(
        { error: "experienceId and title are required." },
        { status: 400 },
      );
    }

    const experience = await prisma.experience.findFirst({
      where: {
        id: experienceId,
        creator: {
          userId: creator.userId,
        },
      },
      select: { id: true },
    });

    if (!experience) {
      return NextResponse.json(
        { error: "Experience not found." },
        { status: 404 },
      );
    }

    const course = await prisma.course.create({
      data: {
        experienceId: experience.id,
        title,
        description: description || null,
        access: access === "PRIVATE" ? "PRIVATE" : "PUBLIC",
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      },
      select: {
        id: true,
        title: true,
        description: true,
        access: true,
        sortOrder: true,
      },
    });

    return NextResponse.json({ data: course }, { status: 201 });
  } catch (error) {
    console.error("[creator/courses][POST] Error:", error);
    return NextResponse.json(
      { error: "Failed to create course." },
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
    const access = String(body?.access || "PUBLIC").trim().toUpperCase();
    const sortOrder = Number(body?.sortOrder || 0);

    if (!id || !title) {
      return NextResponse.json(
        { error: "Course id and title are required." },
        { status: 400 },
      );
    }

    const existing = await prisma.course.findFirst({
      where: {
        id,
        experience: {
          creator: {
            userId: creator.userId,
          },
        },
      },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }

    const course = await prisma.course.update({
      where: { id: existing.id },
      data: {
        title,
        description: description || null,
        access: access === "PRIVATE" ? "PRIVATE" : "PUBLIC",
        sortOrder: Number.isFinite(sortOrder) ? sortOrder : 0,
      },
      select: {
        id: true,
        title: true,
        description: true,
        access: true,
        sortOrder: true,
      },
    });

    return NextResponse.json({ data: course });
  } catch (error) {
    console.error("[creator/courses][PATCH] Error:", error);
    return NextResponse.json(
      { error: "Failed to update course." },
      { status: 500 },
    );
  }
}
