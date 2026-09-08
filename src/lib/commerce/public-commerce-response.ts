/**
 * src/lib/commerce/public-commerce-response.ts
 *
 * Pure, DB-free, network-free runtime validators for the PUBLIC commerce
 * responses: the Experience shop catalog, the Lesson product list, and the
 * public Campaign payload.
 *
 * ===========================================================================
 * WHY THIS EXISTS — A REAL PUBLIC-STOREFRONT CRASH
 * ===========================================================================
 * `fetchJson` (`@/components/experience/client-utils`) ends in
 * `return (json?.data ?? json) as T`. That `as T` is a TYPESCRIPT claim, not a
 * runtime check: whatever the network produced is handed back wearing `T`'s
 * type. The public shop then did
 *
 *     const productCount = shopData?.products.length ?? 0;
 *
 * The `?.` guards `shopData` being null — it does NOT guard `products` being
 * absent. A body of `{}` therefore yields a truthy `shopData` whose
 * `.products` is `undefined`, and `.length` throws
 * `TypeError: Cannot read properties of undefined`. On a PUBLIC storefront
 * that is a white screen for a shopper, not a caught error state. The Lesson
 * surface had the identical defect via `setProducts(result.items)`.
 *
 * These validators close that hole for the commerce surfaces by refusing to
 * produce a value at all unless the payload genuinely matches.
 *
 * ===========================================================================
 * POLICY
 * ===========================================================================
 * 1. NEVER THROW. Every parser returns `null` for anything that does not
 *    match, so a caller's `catch` is never load-bearing for shape errors.
 *
 * 2. `null` MEANS MALFORMED, NEVER "EMPTY". A genuinely empty catalog parses
 *    to `{ products: [] }` and renders the empty state. Collapsing the two
 *    would tell a brand "you have no products" when the truth is "the
 *    response was broken" — the same distinction the analytics trend
 *    validators draw between a known zero and no activity at all.
 *
 * 3. ONE BAD ROW INVALIDATES THE PAGE. Mirrors `parseOrderListEnvelope`'s
 *    `if (!record.data.every(isOrderListRow)) return null`. Silently dropping
 *    a malformed card would show a partial catalog that both the shopper and
 *    the brand would read as complete.
 *
 * 4. VALIDATE, DO NOT REPAIR. No defaulting a missing title to "", no
 *    coercing a numeric price to a string. A payload that needs repair is a
 *    broken server contract and must surface as an error state.
 *
 * 5. NO MONEY ARITHMETIC HERE. `priceText` is already formatted server-side by
 *    `formatMinorUnitPriceRange`. This module only proves it is a string or
 *    genuinely absent; it never parses, re-derives, or divides it. `null`
 *    price stays `null` so the UI can omit the line rather than print "$0" —
 *    an invented price is worse than no price.
 */

/**
 * A DEFENSIVE ceiling against an absurd/hostile payload — deliberately NOT a
 * pagination limit and deliberately far above any real catalog.
 *
 * WHY IT IS THIS HIGH. The public shop route applies no `take:` at all: it
 * returns EVERY eligible product for the Experience and the client paginates
 * in the browser. A cap set near a plausible catalog size would therefore turn
 * a large-but-legitimate brand's working shop into an error page — a
 * regression caused by the validator rather than by the data. A validator must
 * never be the reason a correct response is rejected.
 *
 * The genuinely unbounded query on the route side is a real (pre-existing)
 * performance concern, but the fix for that belongs on the SERVER, as a
 * bounded query plus a cursor — not here, by breaking the page.
 */
export const MAX_PUBLIC_PRODUCTS = 5000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required, non-empty string. Absent, empty and non-string all fail. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** An optional field: genuinely absent/null, or a string. `""` is allowed. */
function isNullableString(value: unknown): value is string | null {
  return value === null || value === undefined || typeof value === "string";
}

/**
 * The opaque server-minted ids the public click hops address. They are
 * interpolated into a URL PATH, so anything that could change which endpoint
 * is addressed — a slash, a `..`, a query/fragment delimiter, whitespace — is
 * rejected here rather than encoded away. Prisma emits cuids; this accepts the
 * broader url-safe alphabet so a future id scheme does not silently break, but
 * never a path separator.
 *
 * This is defence in depth, not the primary control: the click routes
 * re-derive every identity server-side and own the real authorization.
 */
const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isSafeClickPathSegment(value: unknown): value is string {
  return typeof value === "string" && CLICK_ID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// GET /api/public/experience/[experienceSlug]/products
// Server envelope: { data: {...} } — fetchJson unwraps to the inner object.
// ---------------------------------------------------------------------------

/**
 * The two canonical public card sources. Anything else is a contract
 * violation: `source` drives which click hop the card uses, so an unknown
 * value must never be rendered as though it were purchasable.
 */
export const PUBLIC_PRODUCT_SOURCES = ["CAMPAIGN_PRODUCT", "BRAND_STOREFRONT"] as const;
export type PublicProductSource = (typeof PUBLIC_PRODUCT_SOURCES)[number];

export type PublicShopBrandRef = { id: string; name: string; slug: string };

export type PublicShopProductCard = {
  /**
   * REQUIRED here even though the route's own internal type marks it optional,
   * because the render uses it as the React key, the failed-image set key and
   * the in-flight click key. A card without it cannot be rendered correctly
   * (duplicate keys, cross-talk between cards), so "absent" is a broken
   * payload rather than a tolerable omission. The route always emits one.
   *
   * This is an opaque render key, NOT a path segment — it is deliberately held
   * only to `isNonEmptyString`, since the route legitimately mints values like
   * `campaign-<suffix>`.
   */
  id: string;
  productId: string;
  productLinkId: string | null;
  campaignProductId?: string | null;
  campaignAssignmentId?: string | null;
  title: string;
  description?: string | null;
  imageUrl: string | null;
  priceText: string | null;
  productUrl: string;
  brand: PublicShopBrandRef | null;
  source: PublicProductSource;
  productCampaign?: { id: string; name: string } | null;
};

export type PublicShopResponse = {
  experience: { id: string; slug: string; title: string };
  campaign: { id: string; name: string; brand: PublicShopBrandRef | null } | null;
  products: PublicShopProductCard[];
};

function isBrandRef(value: unknown): value is PublicShopBrandRef {
  if (value === null || value === undefined) return false;
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.id) &&
    typeof value.name === "string" &&
    typeof value.slug === "string"
  );
}

/** `null`/absent is legitimate (a direct, uncampaigned entry). */
function isNullableBrandRef(value: unknown): value is PublicShopBrandRef | null {
  return value === null || value === undefined || isBrandRef(value);
}

function isNamedRef(value: unknown): value is { id: string; name: string } {
  return isRecord(value) && isNonEmptyString(value.id) && typeof value.name === "string";
}

export function isPublicShopProductCard(value: unknown): value is PublicShopProductCard {
  if (!isRecord(value)) return false;

  // Identity + destination: the fields with no sane fallback.
  if (!isNonEmptyString(value.id)) return false;
  if (!isNonEmptyString(value.productId)) return false;
  if (!isNonEmptyString(value.title)) return false;
  if (!isNonEmptyString(value.productUrl)) return false;

  // `source` decides which click hop the card uses — it must be one we know.
  if (!PUBLIC_PRODUCT_SOURCES.includes(value.source as PublicProductSource)) return false;

  // Presentation fields: absent is meaningful and must stay absent.
  if (!isNullableString(value.imageUrl)) return false;
  if (!isNullableString(value.priceText)) return false;
  if (!isNullableString(value.description)) return false;
  if (!isNullableString(value.productLinkId)) return false;

  // Click ids are optional (a card may legitimately carry neither and simply
  // not be clickable) but when present must be path-safe — see
  // `isSafeClickPathSegment`.
  for (const key of ["campaignAssignmentId", "campaignProductId"] as const) {
    const raw = value[key];
    if (raw === null || raw === undefined) continue;
    if (!isSafeClickPathSegment(raw)) return false;
  }

  if (!isNullableBrandRef(value.brand)) return false;

  const productCampaign = value.productCampaign;
  if (productCampaign !== null && productCampaign !== undefined && !isNamedRef(productCampaign)) {
    return false;
  }

  return true;
}

export function parsePublicShopResponse(data: unknown): PublicShopResponse | null {
  if (!isRecord(data)) return null;

  const experience = data.experience;
  if (
    !isRecord(experience) ||
    !isNonEmptyString(experience.id) ||
    !isNonEmptyString(experience.slug) ||
    typeof experience.title !== "string"
  ) {
    return null;
  }

  // Kept as an unnarrowed record so the `brand` sub-field stays reachable:
  // `isNamedRef` narrows to `{ id, name }`, which would hide it.
  const campaign: Record<string, unknown> | null = isRecord(data.campaign)
    ? data.campaign
    : null;
  if (data.campaign !== null && data.campaign !== undefined && !campaign) return null;
  if (campaign) {
    // Checks inlined rather than via `isNamedRef`: that guard would narrow
    // `campaign` to `{ id, name }` for the rest of this scope and hide `brand`.
    if (!isNonEmptyString(campaign.id)) return null;
    if (typeof campaign.name !== "string") return null;
    if (!isNullableBrandRef(campaign.brand)) return null;
  }

  // THE DEFECT THIS MODULE EXISTS FOR: `products` must be a real array before
  // anything reads `.length`/`.slice` off it.
  if (!Array.isArray(data.products)) return null;
  if (data.products.length > MAX_PUBLIC_PRODUCTS) return null;
  if (!data.products.every(isPublicShopProductCard)) return null;

  return {
    experience: {
      id: experience.id,
      slug: experience.slug,
      title: experience.title,
    },
    campaign: campaign
      ? {
          id: campaign.id as string,
          name: campaign.name as string,
          brand: isBrandRef(campaign.brand) ? campaign.brand : null,
        }
      : null,
    products: data.products as PublicShopProductCard[],
  };
}

/**
 * PHASE 29 — the public shop route now paginates and answers
 * `{ data: {...}, meta: {hasNextPage, nextCursor, limit} }` with `meta`
 * OUTSIDE `data`, matching this repository's other keyset-pagination
 * envelopes (`parseOrderListEnvelope`, `parseCampaignProductEnvelope`).
 *
 * `fetchJson` ends in `return (json?.data ?? json) as T`, so a caller using
 * it would receive ONLY `data` and `result.meta` would be `undefined` —
 * exactly the bug `parseCampaignProductEnvelope`'s own header documents as
 * having silently killed the Brand campaign-products "Load more" control.
 * Callers of the public shop route MUST use a plain `fetch()` and this
 * parser on the FULL body, never `fetchJson<PublicShopResponse>()`.
 */
export type PublicShopEnvelope = {
  data: PublicShopResponse;
  meta: { hasNextPage: boolean; nextCursor: string | null; limit: number };
};

export function parsePublicShopEnvelope(json: unknown): PublicShopEnvelope | null {
  if (!isRecord(json)) return null;

  const data = parsePublicShopResponse(json.data);
  if (!data) return null;

  const meta = json.meta;
  if (!isRecord(meta)) return null;
  if (typeof meta.hasNextPage !== "boolean") return null;
  if (typeof meta.limit !== "number" || !Number.isInteger(meta.limit) || meta.limit < 1) {
    return null;
  }
  // An opaque base64url token — validated as a non-empty string, never
  // decoded or interpreted client-side.
  const nextCursor =
    typeof meta.nextCursor === "string" && meta.nextCursor !== "" ? meta.nextCursor : null;

  return { data, meta: { hasNextPage: meta.hasNextPage, nextCursor, limit: meta.limit } };
}

// ---------------------------------------------------------------------------
// GET /api/public/experience/[experienceSlug]/lessons/[lessonId]/products
// Server envelope: { data: { items: [...] } } — fetchJson unwraps to
// `{ items }`. `items` is `[]` (not absent) when the viewer cannot access the
// lesson, so an empty array is a legitimate, non-error answer.
// ---------------------------------------------------------------------------

export type PublicLessonProductCard = {
  /** Opaque CampaignLessonProduct id; the click hop's only path parameter. */
  id: string;
  productUrl: string;
  title: string | null;
  imageUrl: string | null;
  priceText: string | null;
  currency: string | null;
};

export function isPublicLessonProductCard(value: unknown): value is PublicLessonProductCard {
  if (!isRecord(value)) return false;
  // `id` addresses the click route directly, so it is held to the path-safe
  // alphabet rather than merely "is a string".
  if (!isSafeClickPathSegment(value.id)) return false;
  if (!isNonEmptyString(value.productUrl)) return false;
  return (
    isNullableString(value.title) &&
    isNullableString(value.imageUrl) &&
    isNullableString(value.priceText) &&
    isNullableString(value.currency)
  );
}

export function parsePublicLessonProducts(
  data: unknown,
): { items: PublicLessonProductCard[] } | null {
  if (!isRecord(data)) return null;
  if (!Array.isArray(data.items)) return null;
  if (data.items.length > MAX_PUBLIC_PRODUCTS) return null;
  if (!data.items.every(isPublicLessonProductCard)) return null;
  return { items: data.items as PublicLessonProductCard[] };
}

// ---------------------------------------------------------------------------
// GET /api/public/campaign/[campaignSlug]
// This page previously did `setData(json.data)` on a raw `fetch` with no
// checks at all, then rendered `data.experiences.map(...)`.
// ---------------------------------------------------------------------------

export type PublicCampaignExperienceCard = {
  slug: string;
  title: string;
  coverImageUrl: string | null;
};

export type PublicCampaignPayload = {
  id: string;
  name: string;
  description: string | null;
  brand: { id: string; name: string; slug: string; logoUrl: string | null } | null;
  experiences: PublicCampaignExperienceCard[];
  isUnlocked: boolean;
  hasRedeemedQrWarning: boolean;
};

function isCampaignExperienceCard(value: unknown): value is PublicCampaignExperienceCard {
  if (!isRecord(value)) return false;
  // `slug` builds the outbound `/x/<slug>` link; an empty slug would produce a
  // link to the wrong route entirely.
  return (
    isNonEmptyString(value.slug) &&
    typeof value.title === "string" &&
    isNullableString(value.coverImageUrl)
  );
}

export function parsePublicCampaignPayload(data: unknown): PublicCampaignPayload | null {
  if (!isRecord(data)) return null;
  if (!isNonEmptyString(data.id)) return null;
  if (typeof data.name !== "string") return null;
  if (!isNullableString(data.description)) return null;

  // Unlock state gates what the page offers, so a missing/garbled boolean must
  // NOT be coerced — `Boolean(undefined)` would silently present a locked
  // campaign as unlocked (or vice versa).
  if (typeof data.isUnlocked !== "boolean") return null;
  if (typeof data.hasRedeemedQrWarning !== "boolean") return null;

  const brand = data.brand;
  if (brand !== null && brand !== undefined) {
    if (!isRecord(brand)) return null;
    if (!isNonEmptyString(brand.id)) return null;
    if (typeof brand.name !== "string") return null;
    if (typeof brand.slug !== "string") return null;
    if (!isNullableString(brand.logoUrl)) return null;
  }

  if (!Array.isArray(data.experiences)) return null;
  if (data.experiences.length > MAX_PUBLIC_PRODUCTS) return null;
  if (!data.experiences.every(isCampaignExperienceCard)) return null;

  return {
    id: data.id,
    name: data.name,
    description: (data.description ?? null) as string | null,
    brand: isRecord(brand)
      ? {
          id: brand.id as string,
          name: brand.name as string,
          slug: brand.slug as string,
          logoUrl: (brand.logoUrl ?? null) as string | null,
        }
      : null,
    experiences: data.experiences as PublicCampaignExperienceCard[],
    isUnlocked: data.isUnlocked,
    hasRedeemedQrWarning: data.hasRedeemedQrWarning,
  };
}
