/**
 * Collect all distinct, non-empty anon-key candidates to merge during
 * email-verification.  Order matters: sqr_session (the active session cookie
 * written by the scan route) is returned first so it takes precedence, then
 * any legacy cookies (anonKey / deviceKey) and finally the body-supplied key.
 *
 * A stale legacy cookie must NOT shadow the active sqr_session — we merge ALL
 * distinct identifiers so every anonymous unlock is carried over regardless of
 * which cookie jar entry is present.
 */
export function collectAnonMergeKeys(input: {
  bodyAnonKey?: string | null;
  anonKeyCookie?: string | null;
  deviceKeyCookie?: string | null;
  sessionCookie?: string | null;
}): string[] {
  const { bodyAnonKey, anonKeyCookie, deviceKeyCookie, sessionCookie } = input;

  // Ordered candidates: active session first, then legacy identifiers
  const candidates = [
    sessionCookie,
    anonKeyCookie,
    deviceKeyCookie,
    bodyAnonKey,
  ];

  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of candidates) {
    const trimmed = (raw ?? "").trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      result.push(trimmed);
    }
  }

  return result;
}
