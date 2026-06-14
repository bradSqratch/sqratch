"use client";

type SignedUploadAuthorization = {
  bucket: string;
  path: string;
  signedUrl: string;
};

async function readHttpError(response: Response, fallback: string) {
  const contentType = response.headers.get("content-type") || "";

  if (contentType.includes("application/json")) {
    const json = await response.json().catch(() => null);
    return json?.error || json?.message || fallback;
  }

  const text = await response.text().catch(() => "");
  return text.trim() || fallback;
}

export async function requestLessonVideoUploadAuthorization(options: {
  courseId: string;
  file: Pick<File, "name" | "type" | "size">;
}) {
  const response = await fetch("/api/uploads/video", {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      courseId: options.courseId,
      fileName: options.file.name,
      fileType: options.file.type,
      fileSize: options.file.size,
    }),
  });

  if (!response.ok) {
    throw new Error(
      await readHttpError(response, "Failed to prepare lesson video upload."),
    );
  }

  const json = await response.json().catch(() => null);
  const data = json?.data as SignedUploadAuthorization | undefined;

  if (
    !data?.signedUrl ||
    !data.bucket ||
    !data.path
  ) {
    throw new Error("The upload authorization response was incomplete.");
  }

  return data;
}

export function uploadFileToSignedStorage(options: {
  signedUrl: string;
  file: File;
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
}) {
  return new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    const abort = () => request.abort();

    request.open("PUT", options.signedUrl);
    request.setRequestHeader("x-upsert", "false");

    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable || event.total <= 0) {
        return;
      }

      options.onProgress?.(
        Math.min(100, Math.round((event.loaded / event.total) * 100)),
      );
    });

    request.addEventListener("load", () => {
      options.signal?.removeEventListener("abort", abort);

      if (request.status >= 200 && request.status < 300) {
        options.onProgress?.(100);
        resolve();
        return;
      }

      let message = request.responseText?.trim();

      try {
        const json = JSON.parse(request.responseText || "{}");
        message = json?.error || json?.message || message;
      } catch {
        // Supabase can return non-JSON gateway errors.
      }

      reject(new Error(message || "Failed to upload video to storage."));
    });
    request.addEventListener("error", () => {
      options.signal?.removeEventListener("abort", abort);
      reject(new Error("The storage upload failed due to a network error."));
    });
    request.addEventListener("abort", () => {
      options.signal?.removeEventListener("abort", abort);
      reject(new DOMException("The video upload was cancelled.", "AbortError"));
    });

    if (options.signal?.aborted) {
      request.abort();
      return;
    }

    options.signal?.addEventListener("abort", abort, { once: true });

    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", options.file);
    request.send(body);
  });
}

export async function uploadLessonVideoDirect(options: {
  courseId: string;
  file: File;
  signal?: AbortSignal;
  onProgress?: (percentage: number) => void;
}) {
  const authorization = await requestLessonVideoUploadAuthorization(options);

  await uploadFileToSignedStorage({
    signedUrl: authorization.signedUrl,
    file: options.file,
    signal: options.signal,
    onProgress: options.onProgress,
  });

  return authorization;
}
