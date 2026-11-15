import type { Prisma } from "@prisma/client";
import prisma from "@/lib/prisma";

const lessonSelect = {
  id: true, title: true, description: true, sortOrder: true,
  completionPointsReward: true, videoSource: true, youtubeUrl: true,
  videoUploadUrl: true, videoStorageBucket: true, videoStoragePath: true,
} satisfies Prisma.LessonSelect;

/** Serialize creates for a course so concurrent retries of an upload share one lesson. */
export async function createLessonOnce(data: Prisma.LessonUncheckedCreateInput) {
  if (data.videoSource !== "UPLOAD" || !data.videoStorageBucket || !data.videoStoragePath) {
    return { lesson: await prisma.lesson.create({ data, select: lessonSelect }), created: true };
  }
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Course" WHERE id = ${data.courseId} FOR UPDATE`;
    const existing = await tx.lesson.findFirst({ where: { courseId: data.courseId, videoStorageBucket: data.videoStorageBucket, videoStoragePath: data.videoStoragePath }, select: lessonSelect });
    if (existing) return { lesson: existing, created: false };
    return { lesson: await tx.lesson.create({ data, select: lessonSelect }), created: true };
  });
}
