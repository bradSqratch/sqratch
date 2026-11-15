"use client";

export class RequestError extends Error {
  readonly outcome: "rejected" | "unknown";
  constructor(message: string, readonly status: number | null, readonly code?: string) {
    super(message);
    this.name = "RequestError";
    this.outcome = status !== null && status >= 400 && status < 500 ? "rejected" : "unknown";
  }
}

export function isDefiniteSaveRejection(error: unknown): boolean {
  return error instanceof RequestError && error.outcome === "rejected";
}

export async function fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(input, { credentials: "include", ...init });
  } catch (error) {
    throw new RequestError(error instanceof Error ? error.message : "Request failed.", null);
  }
  let json;
  try {
    json = await response.json();
  } catch {
    if (response.ok) throw new RequestError("Request failed.", response.status);
    json = null;
  }
  if (!response.ok) {
    throw new RequestError(json?.error || "Request failed.", response.status, json?.code);
  }
  return (json?.data ?? json) as T;
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return fallback;
}

export function postBeacon(url: string, body?: Record<string, unknown>) {
  const payload = body ? JSON.stringify(body) : undefined;

  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    if (payload) {
      return navigator.sendBeacon(
        url,
        new Blob([payload], { type: "application/json" }),
      );
    }

    return navigator.sendBeacon(url);
  }

  void fetch(url, {
    method: "POST",
    credentials: "include",
    keepalive: true,
    headers: payload
      ? {
          "Content-Type": "application/json",
        }
      : undefined,
    body: payload,
  });

  return false;
}

export async function deleteUploadedAsset(
  url: string,
  options?: {
    courseId?: string;
    bucket?: string;
    path?: string;
    fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
  },
) {
  if (!url && !options?.bucket && !options?.path) {
    return false;
  }

  try {
    const response = await (options?.fetcher || fetch)("/api/uploads/storage-object", {
      method: "DELETE",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        courseId: options?.courseId,
        bucket: options?.bucket,
        path: options?.path,
      }),
    });

    if (!response.ok) {
      return false;
    }

    const json = await response.json().catch(() => null);
    return Boolean(json?.data?.deleted);
  } catch {
    return false;
  }
}
