import "server-only";

import {
  assertStorageConfigured,
  getLessonVideoBucket,
} from "@/lib/storage-upload";
import {
  authorizeLessonVideoPlayback,
  type LessonVideoStorageReference,
} from "@/lib/lesson-video-reference";

export {
  resolveLessonVideoStorageReference,
  type LessonVideoStorageReference,
} from "@/lib/lesson-video-reference";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 3600;
const MIN_SIGNED_URL_TTL_SECONDS = 60;
const MAX_SIGNED_URL_TTL_SECONDS = 14_400;

function encodeStoragePath(path: string) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function resolveSignedDownloadUrl(storageUrl: string, signedPath: string) {
  if (signedPath.startsWith("http://") || signedPath.startsWith("https://")) {
    const candidate = new URL(signedPath);
    const configured = new URL(storageUrl);

    if (candidate.origin !== configured.origin) {
      throw new Error("Supabase returned an unexpected signed URL origin.");
    }

    return candidate.toString();
  }

  const cleanStorageUrl = storageUrl.replace(/\/$/, "");

  if (signedPath.startsWith("/storage/v1/")) {
    return `${cleanStorageUrl}${signedPath}`;
  }

  return `${cleanStorageUrl}/storage/v1${signedPath.startsWith("/") ? "" : "/"}${signedPath}`;
}

export function getLessonVideoSignedUrlTtlSeconds() {
  const configured = Number(
    process.env.LESSON_VIDEO_SIGNED_URL_TTL_SECONDS ||
      DEFAULT_SIGNED_URL_TTL_SECONDS,
  );

  if (!Number.isFinite(configured)) {
    return DEFAULT_SIGNED_URL_TTL_SECONDS;
  }

  return Math.min(
    MAX_SIGNED_URL_TTL_SECONDS,
    Math.max(MIN_SIGNED_URL_TTL_SECONDS, Math.floor(configured)),
  );
}

export async function createSignedLessonVideoUrl(
  reference: LessonVideoStorageReference,
) {
  if (reference.bucket !== getLessonVideoBucket()) {
    throw new Error("Invalid lesson video storage bucket.");
  }

  const pathParts = reference.path.split("/");

  if (
    pathParts.length < 6 ||
    pathParts[0] !== "experiences" ||
    pathParts[2] !== "courses" ||
    pathParts[4] !== "lessons" ||
    pathParts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        part.includes("\0"),
    )
  ) {
    throw new Error("Invalid lesson video storage path.");
  }

  const { storageUrl, serviceRoleKey } = assertStorageConfigured();
  const response = await fetch(
    `${storageUrl}/storage/v1/object/sign/${encodeURIComponent(reference.bucket)}/${encodeStoragePath(reference.path)}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expiresIn: getLessonVideoSignedUrlTtlSeconds(),
      }),
      cache: "no-store",
    },
  );
  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error("Failed to authorize lesson video playback.");
  }

  const signedPath =
    json?.signedURL || json?.signedUrl || json?.url || json?.data?.signedUrl;

  if (!signedPath || typeof signedPath !== "string") {
    throw new Error("Supabase did not return a signed playback URL.");
  }

  return resolveSignedDownloadUrl(storageUrl, signedPath);
}

export async function getAuthorizedLessonVideoUrl(options: {
  canAccess: boolean;
  videoSource: "YOUTUBE" | "UPLOAD";
  lesson: {
    videoStorageBucket?: string | null;
    videoStoragePath?: string | null;
    videoUploadUrl?: string | null;
  };
  courseId: string;
  experienceSlug: string;
}) {
  return authorizeLessonVideoPlayback({
    ...options,
    sign: createSignedLessonVideoUrl,
  });
}
