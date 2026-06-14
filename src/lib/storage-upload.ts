import {
  DEFAULT_MAX_VIDEO_UPLOAD_BYTES,
  hasAllowedVideoExtension,
  isAllowedVideoMimeType,
} from "@/lib/video-upload-config";

type UploadToStorageInput = {
  bucket: string;
  path: string;
  file: File;
  cacheControl?: string;
  upsert?: boolean;
};

type SignedUploadUrlInput = {
  bucket: string;
  path: string;
  upsert?: boolean;
};

function getStorageUrl() {
  return (
    process.env.SUPABASE_STORAGE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL ||
    ""
  ).trim();
}

function getStorageServiceRoleKey() {
  return (
    process.env.SUPABASE_STORAGE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    ""
  ).trim();
}

export function getMaxUploadBytes() {
  const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || "5");
  const safeMaxUploadMb =
    Number.isFinite(maxUploadMb) && maxUploadMb > 0 ? maxUploadMb : 5;

  return safeMaxUploadMb * 1024 * 1024;
}

export function getMaxVideoUploadBytes() {
  const maxUploadMb = Number(process.env.MAX_VIDEO_UPLOAD_MB || "250");
  const safeMaxUploadMb =
    Number.isFinite(maxUploadMb) && maxUploadMb > 0
      ? maxUploadMb
      : DEFAULT_MAX_VIDEO_UPLOAD_BYTES / (1024 * 1024);

  return safeMaxUploadMb * 1024 * 1024;
}

export function getLessonVideoBucket() {
  return process.env.SUPABASE_LESSON_VIDEO_BUCKET || "lesson-videos";
}

export function assertStorageConfigured() {
  const storageUrl = getStorageUrl();
  const serviceRoleKey = getStorageServiceRoleKey();

  if (!storageUrl || !serviceRoleKey) {
    throw new Error(
      "Supabase storage is not configured. Set SUPABASE_STORAGE_URL and SUPABASE_STORAGE_SERVICE_ROLE_KEY.",
    );
  }

  return { storageUrl, serviceRoleKey };
}

export async function uploadFileToStorage(input: UploadToStorageInput) {
  const { storageUrl, serviceRoleKey } = assertStorageConfigured();
  const uploadResponse = await fetch(
    `${storageUrl}/storage/v1/object/${input.bucket}/${input.path}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": input.file.type || "application/octet-stream",
        "Cache-Control": input.cacheControl || "3600",
        "x-upsert": String(Boolean(input.upsert)),
      },
      body: Buffer.from(await input.file.arrayBuffer()),
    },
  );

  const uploadJson = await uploadResponse.json().catch(() => null);

  if (!uploadResponse.ok) {
    throw new Error(
      uploadJson?.error ||
        uploadJson?.message ||
        "Failed to upload file to Supabase Storage.",
    );
  }

  return {
    fileUrl: getPublicStorageUrl(input.bucket, input.path),
    bucket: input.bucket,
    path: input.path,
  };
}

export function getPublicStorageUrl(bucket: string, path: string) {
  const { storageUrl } = assertStorageConfigured();
  return `${storageUrl}/storage/v1/object/public/${bucket}/${path}`;
}

function encodeStoragePath(path: string) {
  return path
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function resolveSignedUploadUrl(storageUrl: string, signedPath: string) {
  if (signedPath.startsWith("http://") || signedPath.startsWith("https://")) {
    return signedPath;
  }

  const cleanStorageUrl = storageUrl.replace(/\/$/, "");

  if (signedPath.startsWith("/storage/v1/")) {
    return `${cleanStorageUrl}${signedPath}`;
  }

  return `${cleanStorageUrl}/storage/v1${signedPath.startsWith("/") ? "" : "/"}${signedPath}`;
}

export async function createSignedUploadUrl(input: SignedUploadUrlInput) {
  const { storageUrl, serviceRoleKey } = assertStorageConfigured();
  const encodedPath = encodeStoragePath(input.path);
  const response = await fetch(
    `${storageUrl}/storage/v1/object/upload/sign/${input.bucket}/${encodedPath}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "Content-Type": "application/json",
        "x-upsert": String(Boolean(input.upsert)),
      },
      body: "{}",
    },
  );

  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      json?.error ||
        json?.message ||
        "Failed to create signed upload URL.",
    );
  }

  const signedPath =
    json?.signedUrl || json?.signedURL || json?.url || json?.data?.signedUrl;

  if (!signedPath || typeof signedPath !== "string") {
    throw new Error("Supabase did not return a signed upload URL.");
  }

  return {
    signedUrl: resolveSignedUploadUrl(storageUrl, signedPath),
    fileUrl: getPublicStorageUrl(input.bucket, input.path),
    bucket: input.bucket,
    path: input.path,
  };
}

export function parsePublicStorageUrl(url: string) {
  const storageUrl = getStorageUrl().replace(/\/$/, "");

  if (!storageUrl) {
    return null;
  }

  let candidate: URL;
  let configured: URL;

  try {
    candidate = new URL(url);
    configured = new URL(storageUrl);
  } catch {
    return null;
  }

  if (candidate.origin !== configured.origin) {
    return null;
  }

  const publicPrefix = "/storage/v1/object/public/";

  if (!candidate.pathname.startsWith(publicPrefix)) {
    return null;
  }

  const remainder = candidate.pathname.slice(publicPrefix.length);
  const [encodedBucket, ...encodedParts] = remainder.split("/");

  if (!encodedBucket || encodedParts.length === 0) {
    return null;
  }

  try {
    const bucket = decodeURIComponent(encodedBucket);
    const pathParts = encodedParts.map((part) => decodeURIComponent(part));

    if (
      !bucket ||
      bucket.includes("/") ||
      bucket.includes("\\") ||
      pathParts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.includes("/") ||
          part.includes("\\"),
      )
    ) {
      return null;
    }

    return { bucket, path: pathParts.join("/") };
  } catch {
    return null;
  }
}

export function validateLessonVideoStorageUrl(options: {
  url: string;
  courseId: string;
  experienceSlug: string;
}) {
  const parsed = parsePublicStorageUrl(options.url);

  if (
    !parsed ||
    !validateLessonVideoStorageObject({
      bucket: parsed.bucket,
      path: parsed.path,
      courseId: options.courseId,
      experienceSlug: options.experienceSlug,
    })
  ) {
    return null;
  }

  return parsed;
}

export function validateLessonVideoStorageObject(options: {
  bucket: string;
  path: string;
  courseId: string;
  experienceSlug: string;
}) {
  if (options.bucket !== getLessonVideoBucket()) {
    return null;
  }

  const pathParts = options.path.split("/");
  const expectedPrefix = [
    "experiences",
    options.experienceSlug,
    "courses",
    options.courseId,
    "lessons",
  ];

  if (
    pathParts.length <= expectedPrefix.length ||
    expectedPrefix.some((part, index) => pathParts[index] !== part) ||
    pathParts.some(
      (part) =>
        !part ||
        part === "." ||
        part === ".." ||
        part.includes("\\") ||
        part.includes("\0"),
    )
  ) {
    return null;
  }

  return {
    bucket: options.bucket,
    path: options.path,
  };
}

export async function storageObjectExists(options: {
  bucket: string;
  path: string;
}) {
  const { storageUrl, serviceRoleKey } = assertStorageConfigured();
  const response = await fetch(
    `${storageUrl}/storage/v1/object/${encodeURIComponent(options.bucket)}/${encodeStoragePath(options.path)}`,
    {
      method: "HEAD",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
      cache: "no-store",
    },
  );

  return response.ok;
}

export function validateVideoUploadMetadata(input: {
  fileName: string;
  fileType: string;
  fileSize: number;
}) {
  if (
    !input.fileName ||
    input.fileName === "." ||
    input.fileName === ".." ||
    input.fileName.includes("/") ||
    input.fileName.includes("\\")
  ) {
    return "A valid video file name is required.";
  }

  if (!hasAllowedVideoExtension(input.fileName)) {
    return "The video file extension is not allowed.";
  }

  if (!isAllowedVideoMimeType(input.fileType)) {
    return "Only MP4, MOV, WEBM, MPEG, and M4V videos are allowed.";
  }

  if (!Number.isFinite(input.fileSize) || input.fileSize <= 0) {
    return "A valid video file size is required.";
  }

  if (input.fileSize > getMaxVideoUploadBytes()) {
    return "File is too large.";
  }

  return null;
}

export async function deleteFileFromStorage(bucket: string, path: string) {
  const { storageUrl, serviceRoleKey } = assertStorageConfigured();
  const response = await fetch(
    `${storageUrl}/storage/v1/object/${bucket}/${path}`,
    {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
      },
    },
  );

  return response.ok;
}

export async function deleteStorageObjectByUrl(url: string | null | undefined) {
  if (!url) {
    return false;
  }

  const parsed = parsePublicStorageUrl(url);

  if (!parsed) {
    return false;
  }

  try {
    return await deleteFileFromStorage(parsed.bucket, parsed.path);
  } catch {
    return false;
  }
}
