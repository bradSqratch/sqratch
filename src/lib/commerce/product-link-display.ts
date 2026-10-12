/**
 * Which product links a Brand Admin product row may render. Pure and client-safe.
 *
 * `productUrl` is the canonical PUBLIC destination (product sync leaves it empty for anything Commerce7 secures, such as a
 * Customer-Tag-restricted wine). An empty, relative, malformed or non-HTTPS value must never become an anchor: an empty
 * `href` silently reloads SQRATCH itself. `adminPreviewUrl` is a separate, Brand-Admin-only "Open in Commerce7" link to the
 * store's own product page, where Commerce7 enforces login and Customer Tag access. It is never a public or attribution
 * destination.
 */

/** An absolute HTTPS URL without embedded credentials, or `null`. */
export function safeExternalProductUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) return null;
  return parsed.toString();
}

export type BrandProductLinkInput = {
  productUrl: string | null | undefined;
  /** Commerce7 secures the product (login / Customer Tag); never carries the tag ids themselves. */
  accessRestricted?: boolean;
  adminPreviewUrl?: string | null;
};

export type BrandProductLinks = {
  /** Clickable public product page, or `null` (render title and image as plain content). */
  publicUrl: string | null;
  /** Brand-Admin-only store preview, offered only when there is no public link. */
  previewUrl: string | null;
  /** Short explanation shown when there is no public link. */
  note: string | null;
};

export function brandProductLinks(product: BrandProductLinkInput): BrandProductLinks {
  const publicUrl = safeExternalProductUrl(product.productUrl);
  if (publicUrl) return { publicUrl, previewUrl: null, note: null };
  return {
    publicUrl: null,
    previewUrl: product.accessRestricted ? safeExternalProductUrl(product.adminPreviewUrl) : null,
    note: product.accessRestricted ? "Restricted in Commerce7 — no public product link." : "No public product link.",
  };
}
