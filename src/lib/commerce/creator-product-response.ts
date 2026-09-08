/**
 * src/lib/commerce/creator-product-response.ts
 *
 * PHASE 29 — runtime validation for
 * `GET /api/creator/lessons/[lessonId]/available-products`, the Creator's
 * product-attachment picker.
 *
 * ===========================================================================
 * WHY THIS EXISTS
 * ===========================================================================
 * `lesson-product-links-section.tsx` read this endpoint as
 * `fetchJson<AvailableLessonProductsResponse>(...)` — a bare compile-time
 * cast, `fetchJson`'s own final statement being `as T`. Nothing checked that
 * `result.items` was really an array before `available.items.filter(...)`
 * and `available.items.length` ran on it, the same class of defect the
 * public shop/lesson/campaign surfaces were hardened against (see
 * `public-commerce-response.ts`'s header) and the Brand campaign-products
 * page's own dead "Load more" control (see
 * `parseCampaignProductEnvelope`'s header). This module closes the last
 * unvalidated commerce response surface.
 *
 * ===========================================================================
 * POLICY (matching `public-commerce-response.ts` exactly)
 * ===========================================================================
 * 1. NEVER THROW — `null` means malformed, and a caller's `catch` is never
 *    load-bearing for a shape error.
 * 2. `null` MEANS MALFORMED, NEVER "EMPTY". A genuinely product-less picker
 *    (no assignments yet) parses to `items: []` and renders normally.
 * 3. ONE BAD ROW INVALIDATES THE PAGE — never a partial, silently-shrunk
 *    catalog that reads as complete.
 * 4. VALIDATE, DO NOT REPAIR — no defaulting a missing title, no coercing a
 *    numeric price into a string.
 */

const MAX_CREATOR_PICKER_ITEMS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || value === undefined || typeof value === "string";
}

export type CreatorAvailableProduct = {
  id: string;
  catalogProductId: string;
  title: string;
  handle: string;
  productUrl: string;
  images: string[];
  imageUrl: string | null;
  priceRange: { min: number | null; max: number | null };
  priceText: string | null;
  currency: string;
  variantIds: string[];
};

export type CreatorPickerCampaignOption = {
  id: string;
  name: string;
  brandId: string;
  brandName: string | null;
};

export type CreatorPickerCuration = {
  enabled: boolean;
  campaignId?: string;
  requiresCampaignSelection: boolean;
  campaigns: CreatorPickerCampaignOption[];
};

export type CreatorAvailableProductsPayload = {
  brand: { id: string; name: string; slug: string } | null;
  candidateBrandCount: number;
  connected: boolean;
  items: CreatorAvailableProduct[];
  /**
   * `true` when the server's own bound (`MAX_CREATOR_AVAILABLE_PRODUCTS`)
   * truncated the real result. Absent on an older server response is treated
   * as `false` — a picker that already worked without this field must not
   * become malformed the moment this validator ships.
   */
  hasMore: boolean;
  curation?: CreatorPickerCuration;
};

function isNumberOrNull(value: unknown): value is number | null {
  return value === null || typeof value === "number";
}

function isCreatorAvailableProduct(value: unknown): value is CreatorAvailableProduct {
  if (!isRecord(value)) return false;
  // `catalogProductId` is the ONLY value ever sent back when attaching — see
  // this file's header — so it is held to the stricter non-empty check even
  // though it is not interpolated into a URL path here (the attach route
  // re-derives everything server-side from it; see `campaign-product-curation.ts`).
  if (!isNonEmptyString(value.catalogProductId)) return false;
  if (!isNonEmptyString(value.id)) return false;
  if (typeof value.title !== "string") return false;
  if (typeof value.handle !== "string") return false;
  if (!isNonEmptyString(value.productUrl)) return false;
  if (!Array.isArray(value.images) || !value.images.every((v) => typeof v === "string")) {
    return false;
  }
  if (!isNullableString(value.imageUrl)) return false;
  if (!isNullableString(value.priceText)) return false;
  if (typeof value.currency !== "string") return false;
  if (!Array.isArray(value.variantIds) || !value.variantIds.every((v) => typeof v === "string")) {
    return false;
  }
  const priceRange = value.priceRange;
  if (!isRecord(priceRange)) return false;
  if (!isNumberOrNull(priceRange.min) || !isNumberOrNull(priceRange.max)) return false;
  return true;
}

function isCampaignOption(value: unknown): value is CreatorPickerCampaignOption {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.name === "string" &&
    isNonEmptyString(value.brandId) &&
    isNullableString(value.brandName)
  );
}

export function parseCreatorAvailableProducts(data: unknown): CreatorAvailableProductsPayload | null {
  if (!isRecord(data)) return null;

  const brand = data.brand;
  if (brand !== null && brand !== undefined) {
    if (!isRecord(brand)) return null;
    if (!isNonEmptyString(brand.id)) return null;
    if (typeof brand.name !== "string") return null;
    if (typeof brand.slug !== "string") return null;
  }

  if (typeof data.candidateBrandCount !== "number" || !Number.isInteger(data.candidateBrandCount)) {
    return null;
  }
  if (typeof data.connected !== "boolean") return null;

  // THE DEFECT THIS MODULE EXISTS FOR: `items` must be a real array before
  // anything reads `.length`/`.filter`/`.map` off it.
  if (!Array.isArray(data.items)) return null;
  if (data.items.length > MAX_CREATOR_PICKER_ITEMS) return null;
  if (!data.items.every(isCreatorAvailableProduct)) return null;

  // Backward-compatible for ABSENCE only: an older server response simply
  // lacks the field, which reads as `false` rather than a validation
  // failure — see `hasMore`'s own doc comment above. A response that DOES
  // carry the field but with the wrong type is a genuine contract
  // violation, exactly like every other field this module checks, and must
  // still invalidate the whole payload rather than being silently defaulted.
  if (data.hasMore !== undefined && typeof data.hasMore !== "boolean") {
    return null;
  }
  const hasMore = data.hasMore === true;

  const curation = data.curation;
  let parsedCuration: CreatorPickerCuration | undefined;
  if (curation !== undefined) {
    if (!isRecord(curation)) return null;
    if (typeof curation.enabled !== "boolean") return null;
    if (typeof curation.requiresCampaignSelection !== "boolean") return null;
    if (!Array.isArray(curation.campaigns) || !curation.campaigns.every(isCampaignOption)) {
      return null;
    }
    if (curation.campaignId !== undefined && typeof curation.campaignId !== "string") {
      return null;
    }
    parsedCuration = {
      enabled: curation.enabled,
      requiresCampaignSelection: curation.requiresCampaignSelection,
      campaigns: curation.campaigns as CreatorPickerCampaignOption[],
      ...(typeof curation.campaignId === "string" ? { campaignId: curation.campaignId } : {}),
    };
  }

  return {
    brand: isRecord(brand)
      ? { id: brand.id as string, name: brand.name as string, slug: brand.slug as string }
      : null,
    candidateBrandCount: data.candidateBrandCount,
    connected: data.connected,
    items: data.items as CreatorAvailableProduct[],
    hasMore,
    ...(parsedCuration ? { curation: parsedCuration } : {}),
  };
}
