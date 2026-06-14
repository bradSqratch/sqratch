export const DEFAULT_MAX_VIDEO_UPLOAD_BYTES = 250 * 1024 * 1024;

export const ALLOWED_VIDEO_MIME_TYPES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
  "video/mpeg",
  "video/x-m4v",
] as const;

export const ALLOWED_VIDEO_EXTENSIONS = [
  ".mp4",
  ".webm",
  ".mov",
  ".mpeg",
  ".mpg",
  ".m4v",
] as const;

const allowedVideoMimeTypeSet = new Set<string>(ALLOWED_VIDEO_MIME_TYPES);

export function isAllowedVideoMimeType(value: string) {
  return allowedVideoMimeTypeSet.has(value.trim().toLowerCase());
}

export function hasAllowedVideoExtension(fileName: string) {
  const normalized = fileName.trim().toLowerCase();
  return ALLOWED_VIDEO_EXTENSIONS.some((extension) =>
    normalized.endsWith(extension),
  );
}

