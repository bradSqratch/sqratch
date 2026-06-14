import {
  validateLessonVideoStorageObject,
  validateLessonVideoStorageUrl,
} from "@/lib/storage-upload";

export type LessonVideoStorageReference = {
  bucket: string;
  path: string;
};

type LessonVideoRecord = {
  videoStorageBucket?: string | null;
  videoStoragePath?: string | null;
  videoUploadUrl?: string | null;
};

export function resolveLessonVideoStorageReference(options: {
  lesson: LessonVideoRecord;
  courseId: string;
  experienceSlug: string;
}): LessonVideoStorageReference | null {
  const bucket = options.lesson.videoStorageBucket?.trim() || "";
  const path = options.lesson.videoStoragePath?.trim() || "";

  if (bucket || path) {
    if (!bucket || !path) {
      return null;
    }

    return validateLessonVideoStorageObject({
      bucket,
      path,
      courseId: options.courseId,
      experienceSlug: options.experienceSlug,
    });
  }

  const legacyUrl = options.lesson.videoUploadUrl?.trim() || "";

  if (!legacyUrl) {
    return null;
  }

  return validateLessonVideoStorageUrl({
    url: legacyUrl,
    courseId: options.courseId,
    experienceSlug: options.experienceSlug,
  });
}

export async function authorizeLessonVideoPlayback(options: {
  canAccess: boolean;
  videoSource: "YOUTUBE" | "UPLOAD";
  lesson: LessonVideoRecord;
  courseId: string;
  experienceSlug: string;
  sign: (reference: LessonVideoStorageReference) => Promise<string>;
}) {
  if (!options.canAccess || options.videoSource !== "UPLOAD") {
    return null;
  }

  const reference = resolveLessonVideoStorageReference(options);

  if (!reference) {
    return null;
  }

  return options.sign(reference);
}
