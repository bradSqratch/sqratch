import { getCreatorContext } from "@/lib/creator-auth";
import prisma from "@/lib/prisma";
import { createLessonVideoUploadHandler } from "@/lib/lesson-video-upload-handler";
import { createSignedUploadUrl } from "@/lib/storage-upload";

export const POST = createLessonVideoUploadHandler({
  getCreator: getCreatorContext,
  findOwnedCourse: (courseId, userId) =>
    prisma.course.findFirst({
      where: {
        id: courseId,
        experience: {
          creator: {
            userId,
          },
        },
      },
      select: {
        id: true,
        experience: {
          select: {
            slug: true,
          },
        },
      },
    }),
  signUpload: createSignedUploadUrl,
});
