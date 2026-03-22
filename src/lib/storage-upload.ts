type UploadToStorageInput = {
  bucket: string;
  path: string;
  file: File;
  cacheControl?: string;
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
    Number.isFinite(maxUploadMb) && maxUploadMb > 0 ? maxUploadMb : 250;

  return safeMaxUploadMb * 1024 * 1024;
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

export function parsePublicStorageUrl(url: string) {
  const storageUrl = getStorageUrl().replace(/\/$/, "");

  if (!storageUrl) {
    return null;
  }

  const prefix = `${storageUrl}/storage/v1/object/public/`;

  if (!url.startsWith(prefix)) {
    return null;
  }

  const remainder = url.slice(prefix.length);
  const [bucket, ...rest] = remainder.split("/");

  if (!bucket || rest.length === 0) {
    return null;
  }

  return { bucket, path: rest.join("/") };
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
