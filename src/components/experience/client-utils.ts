"use client";

export async function ensurePublicSession() {
  await fetch("/api/public/session", {
    method: "POST",
    credentials: "include",
  });
}

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
