const DEFAULT_REDIRECT_PATH = "/dashboard";
const INTERNAL_URL_BASE = "https://sqratch.local";

export function normalizeInternalRedirectPath(
  value: string | null | undefined,
  fallback = DEFAULT_REDIRECT_PATH,
) {
  const candidate = value?.trim();

  if (
    !candidate ||
    !candidate.startsWith("/") ||
    candidate.startsWith("//") ||
    candidate.startsWith("/\\")
  ) {
    return fallback;
  }

  try {
    const parsed = new URL(candidate, INTERNAL_URL_BASE);

    if (parsed.origin !== INTERNAL_URL_BASE) {
      return fallback;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}` || fallback;
  } catch {
    return fallback;
  }
}

export function buildLoginPathWithCallback(path: string) {
  const safePath = normalizeInternalRedirectPath(path);
  return `/login?callbackUrl=${encodeURIComponent(safePath)}`;
}
