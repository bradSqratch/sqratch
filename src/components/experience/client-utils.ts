"use client";

export async function fetchJson<T>(
  input: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    credentials: "include",
    ...init,
  });
  const json = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(json?.error || "Request failed.");
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

export async function deleteUploadedAsset(url: string) {
  if (!url) {
    return false;
  }

  try {
    const response = await fetch("/api/uploads/storage-object", {
      method: "DELETE",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ url }),
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
