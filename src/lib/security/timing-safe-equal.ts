import { timingSafeEqual as nodeTimingSafeEqual } from "node:crypto";

/**
 * Constant-time string equality for comparing secrets (API keys, cron
 * tokens, webhook signatures, etc.) against a caller-supplied value.
 *
 * - Returns `false` (never throws) when either value is missing/empty.
 * - Returns `false` safely when lengths differ — `crypto.timingSafeEqual`
 *   throws on a length mismatch, so the length check runs first.
 * - Never logs or otherwise surfaces the compared values.
 */
export function timingSafeEqualString(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }

  const bufferA = Buffer.from(a, "utf8");
  const bufferB = Buffer.from(b, "utf8");

  if (bufferA.length !== bufferB.length) {
    return false;
  }

  return nodeTimingSafeEqual(bufferA, bufferB);
}
