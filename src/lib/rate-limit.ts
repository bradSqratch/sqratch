/**
 * In-memory sliding-window rate limiter.
 *
 * LIMITATION: This uses a module-level Map. On serverless platforms (Vercel),
 * each function instance has its own Map that resets on cold start. This means
 * the effective limit is per-instance, not per-deployment. For low-volume
 * abuse protection (spam, enumeration) this is sufficient. For stricter limits
 * use a shared store (Upstash, Redis).
 */

import { NextResponse } from "next/server";

export interface RateLimitEntry {
  count: number;
  resetAt: number;
}

export const store = new Map<string, RateLimitEntry>();
const MAX_IN_MEMORY_KEYS = 10_000;

export interface RateLimitResult {
  success: boolean;
  remaining: number;
  resetAt: number;
}

export interface RateLimitBackend {
  check(key: string, limit: number, windowMs: number): RateLimitResult;
}

function pruneExpiredEntries(now: number) {
  for (const [key, entry] of store) {
    if (entry.resetAt <= now) store.delete(key);
  }

  while (store.size >= MAX_IN_MEMORY_KEYS) {
    const oldestKey = store.keys().next().value as string | undefined;
    if (!oldestKey) break;
    store.delete(oldestKey);
  }
}

/**
 * Check and increment the rate limit for a key.
 *
 * @param key      Unique key (combine IP + endpoint + optional identifier)
 * @param limit    Maximum allowed requests per window
 * @param windowMs Window duration in milliseconds
 */
export function rateLimit(
  key: string,
  limit: number,
  windowMs: number,
): RateLimitResult {
  const now = Date.now();
  if (store.size >= MAX_IN_MEMORY_KEYS) pruneExpiredEntries(now);
  const entry = store.get(key);

  if (!entry || entry.resetAt <= now) {
    // New window.
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { success: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  if (entry.count >= limit) {
    return { success: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { success: true, remaining: limit - entry.count, resetAt: entry.resetAt };
}

/**
 * Extract the best available IP address from a Next.js request.
 * Prefers x-forwarded-for (set by Vercel), falls back to x-real-ip.
 * Returns "unknown" if neither header is present (e.g., local dev without a proxy).
 */
export function getRequestIp(req: { headers: { get(name: string): string | null } }): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    // x-forwarded-for can be "client, proxy1, proxy2" — take the first.
    return forwarded.split(",")[0].trim();
  }
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * Build a 429 NextResponse with Retry-After header.
 */
export function rateLimitResponse(resetAt: number): NextResponse {
  const retryAfterSec = Math.ceil((resetAt - Date.now()) / 1000);
  return NextResponse.json(
    { error: "Too many requests. Please try again later." },
    {
      status: 429,
      headers: { "Retry-After": String(retryAfterSec) },
    },
  );
}
